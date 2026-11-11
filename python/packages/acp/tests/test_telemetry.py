"""OpenTelemetry spans from a connection's messages: live on either side, from a saved trace, and across the connection."""

from pathlib import Path

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode

from link import byte_link

from deft_subspace.acp.agent import serve_agent
from deft_subspace.acp.client import AcpClient
from deft_subspace.acp.telemetry import otel_tap, spans_from_trace
from deft_subspace.kernel import parse_trace


@pytest.fixture
def otel():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider, exporter


def named(spans, name):
    return [s for s in spans if s.name == name]


def one(spans, name):
    found = named(spans, name)
    assert len(found) == 1, f"one {name} span ({[s.name for s in spans]})"
    return found[0]


async def scripted(turn):
    await turn.plan([{"content": "Read", "status": "in_progress"}])
    await turn.tool("Read secret.txt", lambda _c: "a", kind="read")
    await turn.tool("Delete secret.txt", lambda _c: "x", kind="delete", ask=True)
    await turn.say("Done.")


@pytest.mark.parametrize("protocol", [1, 2])
async def test_client_requests_are_spans_and_the_prompt_is_the_turn(otel, protocol):
    provider, exporter = otel
    client_end, agent_end = byte_link()
    serve_agent(agent_end, name="spans", version="1.0.0", protocols=[protocol], prompt=scripted)
    tap = otel_tap(tracer_provider=provider, attributes={"acp.agent": "spans"})
    client = await AcpClient.connect(client_end, tap=tap, permissions="allow")
    session = await client.new_session("/w")
    with provider.get_tracer("app").start_as_current_span("app request") as app:
        await session.prompt("go")
    await client.close()
    spans = exporter.get_finished_spans()

    init = one(spans, "initialize")
    assert init.kind == SpanKind.CLIENT
    assert init.attributes["acp.protocol_version"] == protocol
    assert init.attributes["acp.agent.name"] == "spans"
    assert one(spans, "session/new").attributes["acp.session_id"] == session.id

    turn = one(spans, "session/prompt")
    assert turn.parent is not None and turn.parent.span_id == app.get_span_context().span_id
    assert turn.attributes["acp.stop_reason"] == "end_turn"
    assert turn.attributes["acp.agent"] == "spans", "the attributes option is on every span"
    assert "plan" in [e.name for e in turn.events]

    tools = named(spans, "tool_call")
    assert [(t.parent.span_id, t.attributes["acp.tool_call.kind"], t.attributes["acp.tool_call.status"]) for t in tools] == [
        (turn.context.span_id, "read", "completed"),
        (turn.context.span_id, "delete", "completed"),
    ]
    assert all("acp.tool_call.title" not in t.attributes for t in tools), "no titles unless asked"
    asked = one(spans, "session/request_permission")
    assert asked.kind == SpanKind.SERVER
    assert asked.parent.span_id == turn.context.span_id
    assert asked.attributes["acp.permission.outcome"] == "selected"
    assert all(s.status.status_code != StatusCode.ERROR for s in spans)


async def test_agent_side_with_titles(otel):
    provider, exporter = otel
    client_end, agent_end = byte_link()
    serve_agent(agent_end, name="spans", protocols=[1], prompt=scripted, peer={"tap": otel_tap(tracer_provider=provider, titles=True)})
    client = await AcpClient.connect(client_end, permissions="reject")
    session = await client.new_session("/w")
    await session.prompt("go")
    await client.close()
    spans = exporter.get_finished_spans()
    turn = one(spans, "session/prompt")
    assert turn.kind == SpanKind.SERVER
    assert one(spans, "session/request_permission").kind == SpanKind.CLIENT
    deleted = next(t for t in named(spans, "tool_call") if t.attributes["acp.tool_call.kind"] == "delete")
    assert deleted.attributes["acp.tool_call.title"] == "Delete secret.txt"
    assert deleted.status.status_code == StatusCode.ERROR


async def test_telemetry_carries_the_trace_across_the_connection(otel):
    provider, exporter = otel
    client_end, agent_end = byte_link()
    seen = {}

    async def prompt(turn):
        seen["trace"] = trace.get_current_span().get_span_context().trace_id
        await turn.say("hi")

    serve_agent(agent_end, name="spans", prompt=prompt, telemetry=otel_tap(tracer_provider=provider))
    client = await AcpClient.connect(client_end, telemetry=otel_tap(tracer_provider=provider))
    session = await client.new_session("/w")
    await session.prompt("go")
    await client.close()
    prompts = named(exporter.get_finished_spans(), "session/prompt")
    assert len(prompts) == 2, "one span on each side"
    assert len({p.context.trace_id for p in prompts}) == 1, "the agent continued the client's trace"
    assert seen["trace"] == prompts[0].context.trace_id, "the handler ran inside its request's span"


def test_from_a_saved_trace(otel):
    provider, exporter = otel
    path = Path(__file__).parents[4] / "packages" / "acp-testkit" / "corpus" / "claude-cancel.trace.jsonl"
    records = parse_trace(path.read_text())
    spans_from_trace(records, tracer_provider=provider)
    spans = exporter.get_finished_spans()
    turn = one(spans, "session/prompt")
    assert turn.attributes["acp.stop_reason"] == "cancelled"
    assert "session/cancel" in [e.name for e in turn.events]
    assert turn.end_time > turn.start_time


def test_errors_mark_the_span_and_close_ends_what_is_open(otel):
    provider, exporter = otel
    tap = otel_tap(tracer_provider=provider)
    tap("out", {"jsonrpc": "2.0", "id": 1, "method": "session/load", "params": {"sessionId": "s", "cwd": "/w"}})
    tap("in", {"jsonrpc": "2.0", "id": 1, "error": {"code": -32002, "message": "Resource not found"}})
    tap("out", {"jsonrpc": "2.0", "id": 2, "method": "session/prompt", "params": {"sessionId": "s", "prompt": []}})
    tap("in", {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "t", "kind": "execute", "status": "in_progress"}}})
    tap("out", {"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": 2}})
    tap.close()
    spans = exporter.get_finished_spans()
    load = one(spans, "session/load")
    assert load.status.status_code == StatusCode.ERROR and load.attributes["rpc.jsonrpc.error_code"] == -32002
    turn = one(spans, "session/prompt")
    assert "cancel requested" in [e.name for e in turn.events]
    assert turn.attributes["acp.unfinished"] is True
    assert one(spans, "tool_call").attributes["acp.unfinished"] is True
