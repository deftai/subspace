"""Record a session, replay it; ids, divergences, pace, redaction (replay.test.ts)."""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from deft_subspace.acp import AcpClient, AgentTurn, serve_agent
from deft_subspace.acp_testkit import (
    ReplayDivergence,
    load_trace,
    normalize_turn,
    record_agent,
    recorder,
    redact_keys,
    replace_strings,
    replay_agent,
    save_trace,
    tap_channel,
)
from deft_subspace.kernel import LocalError, RpcError, RpcPeer, channel_pair, parse_trace
from testkit_helpers import ByteLink


async def scripted(turn: AgentTurn) -> str:
    await turn.say("Reading ")
    call = await turn.tool_call("Read a.txt", kind="read")
    answer = await turn.request_permission("Read a.txt", tool_call_id=call.id)
    if answer.allowed:
        await call.complete()
    else:
        await call.fail()
    await turn.say("done" if answer.allowed else "denied")
    return "end_turn"


async def record_scripted(protocol: int):
    """Run one turn of `scripted` and record it from the client's side, and the channel's."""
    link = ByteLink()
    serve_agent(link.agent, name="scripted", protocols=[protocol], prompt=scripted)
    rec = recorder(peer="client", label=f"scripted v{protocol}")
    wire = recorder(peer="client")
    client = await AcpClient.connect(tap_channel(link.client, wire.tap), permissions="allow", tap=rec.tap)
    session = await client.new_session("/tmp/project")
    result = normalize_turn(await session.prompt("read a.txt"))
    await client.close()
    return rec, wire, result


def _at(direction: str, msg: Any, t: float = 0) -> str:
    return json.dumps({"v": 1, "kind": "message", "t": t, "dir": direction, "msg": msg})


HEADER = json.dumps({"v": 1, "kind": "header", "started": "1970-01-01T00:00:00.000Z", "peer": "client"})


@pytest.mark.parametrize("protocol", [1, 2])
async def test_record_a_session_then_replay_it_to_a_fresh_client_with_the_same_result(protocol):
    rec, wire, result = await record_scripted(protocol)
    records = parse_trace(rec.text())
    assert records[0]["kind"] == "header"
    methods = [r["msg"]["method"] for r in records if r["kind"] == "message" and r["dir"] == "out" and "method" in r["msg"]]
    assert methods == ["initialize", "session/new", "session/prompt"]

    # A channel tap sees the same messages as the peer's tap.
    def strip(rs):
        return [(r["dir"], r["msg"]) for r in rs if r["kind"] == "message"]

    assert strip(wire.records) == strip(rec.records)

    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, records)
    client = await AcpClient.connect(client_end, permissions="allow")
    assert client.protocol == protocol
    session = await client.new_session("/elsewhere")  # different params are fine
    replayed = normalize_turn(await session.prompt("something else"))
    assert replayed == result
    assert replayed.text == "Reading \n\ndone"
    await replay.done
    await client.close()


async def test_ids_are_remapped_both_ways():
    # A hand-written trace whose ids look nothing like the live client's.
    text = "\n".join(
        [
            HEADER,
            _at("out", {"jsonrpc": "2.0", "id": "init-a", "method": "initialize", "params": {}}),
            _at(
                "in",
                {"jsonrpc": "2.0", "id": "init-a", "result": {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}},
            ),
            _at("out", {"jsonrpc": "2.0", "id": "new-b", "method": "session/new", "params": {}}),
            _at("in", {"jsonrpc": "2.0", "id": "new-b", "result": {"sessionId": "s"}}),
            _at("out", {"jsonrpc": "2.0", "id": 99, "method": "session/prompt", "params": {}}),
            _at(
                "in",
                {
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": "s",
                        "toolCall": {"toolCallId": "t", "title": "Run"},
                        "options": [{"optionId": "y", "name": "Yes", "kind": "allow_once"}],
                    },
                },
            ),
            _at("out", {"jsonrpc": "2.0", "id": 0, "result": {"outcome": {"outcome": "selected", "optionId": "y"}}}),
            _at(
                "in",
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "s",
                        "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "ran"}},
                    },
                },
            ),
            _at("in", {"jsonrpc": "2.0", "id": 99, "result": {"stopReason": "end_turn"}}),
        ]
    )
    agent_end, client_end = channel_pair()
    seen: list[Any] = []
    replay = replay_agent(tap_channel(agent_end, lambda d, m: seen.append(m) if d == "out" else None), text)
    client = await AcpClient.connect(client_end, permissions="allow")
    session = await client.new_session("/tmp")
    result = await session.prompt("go")
    assert result.text == "ran"
    await replay.done
    ids = [m["id"] for m in seen if "id" in m]
    # Answers carry the live client's ids (0, 1, 2); the agent's request got a fresh id.
    assert ids == [0, 1, 0, 2]
    await client.close()


async def test_a_trace_recorded_on_the_agent_side_replays_too():
    a, b = channel_pair()
    rec = recorder(peer="agent")

    async def echo(turn: AgentTurn) -> None:
        await turn.say(f"echo: {turn.text}")

    serve_agent(a, name="echo", peer={"tap": rec.tap}, prompt=echo)
    live = await AcpClient.connect(b)
    await (await live.new_session("/tmp")).prompt("hi")
    await live.close()

    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, rec.records)
    client = await AcpClient.connect(client_end)
    result = await (await client.new_session("/tmp")).prompt("bye")
    assert result.text == "echo: hi", "the recorded answer, whatever was asked"
    await replay.done
    await client.close()


async def test_a_different_request_is_a_divergence_the_request_gets_an_error_naming_both_and_the_connection_closes():
    rec, _wire, _result = await record_scripted(1)
    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, rec.records)
    peer = RpcPeer(client_end).start()
    await peer.request("initialize", {"protocolVersion": 1})
    with pytest.raises(RpcError) as raised:
        await peer.request("session/load", {"sessionId": "x"})
    assert re.search(r'expected the client to send request "session/new", got request "session/load"', raised.value.message)
    with pytest.raises(ReplayDivergence) as diverged:
        await replay.done
    assert diverged.value.step == 3
    assert diverged.value.expected["method"] == "session/new"
    assert diverged.value.got["method"] == "session/load"
    closed = await peer.closed
    assert closed.reason == "remote-ended"


async def test_requests_sent_together_may_arrive_in_another_order_check_sees_the_recorded_message_with_live_ids():
    text = "\n".join(
        [
            HEADER,
            _at("out", {"jsonrpc": "2.0", "id": "r-a", "method": "x/a", "params": {"n": 1}}),
            _at("out", {"jsonrpc": "2.0", "id": "r-b", "method": "x/b", "params": {"n": 2}}),
            _at("out", {"jsonrpc": "2.0", "method": "x/note", "params": {}}),
            _at("in", {"jsonrpc": "2.0", "id": "r-a", "result": {"a": True}}),
            _at("in", {"jsonrpc": "2.0", "id": "r-b", "result": {"b": True}}),
        ]
    )
    agent_end, client_end = channel_pair()
    checked: list[tuple[Any, Any]] = []
    replay = replay_agent(
        agent_end, text, check=lambda expected, got: checked.append((expected.get("id"), got.get("id"))) and None
    )
    peer = RpcPeer(client_end).start()
    # Recorded a, b, note; sent note, b, a.
    await peer.notify("x/note", {})
    b = asyncio.ensure_future(peer.request("x/b", {"n": 2}))
    a = asyncio.ensure_future(peer.request("x/a", {"n": 1}))
    assert await asyncio.gather(a, b) == [{"a": True}, {"b": True}]
    await replay.done
    assert len(checked) == 3
    for expected, got in checked:
        assert expected == got
    await peer.close()


async def test_a_client_that_never_sends_what_was_recorded_fails_within_wait_ms_instead_of_hanging():
    rec, _wire, _result = await record_scripted(1)
    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, rec.records, wait_ms=50)
    client = await AcpClient.connect(client_end, permissions="allow")
    # The recording continues with session/new; this client just waits.
    with pytest.raises(ReplayDivergence, match=r'expected the client to send request "session/new", got nothing within 50 ms'):
        await replay.done
    await client.peer.closed
    with pytest.raises(LocalError) as raised:
        await client.new_session("/tmp")
    assert raised.value.kind == "closed"


async def test_requests_after_the_end_of_the_recording_get_an_error():
    rec, _wire, _result = await record_scripted(1)
    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, rec.records)
    client = await AcpClient.connect(client_end, permissions="allow")
    session = await client.new_session("/tmp")
    await session.prompt("go")
    await replay.done
    with pytest.raises(RpcError, match=r"Replay has ended; nothing was recorded for session/new"):
        await client.new_session("/tmp")
    await client.close()


async def test_check_makes_params_matter_when_you_want_them_to():
    rec, _wire, _result = await record_scripted(1)
    agent_end, client_end = channel_pair()

    def check(expected: dict[str, Any], got: dict[str, Any]) -> str | None:
        if expected.get("method") == "session/new" and expected.get("params") != got.get("params"):
            return f"session/new params differ: {json.dumps(got.get('params'))}"
        return None

    replay = replay_agent(agent_end, rec.records, check=check)
    client = await AcpClient.connect(client_end)
    with pytest.raises(RpcError, match=r"session/new params differ"):
        await client.new_session("/other")
    with pytest.raises(ReplayDivergence):
        await replay.done
    await client.close()


async def test_the_agents_cancel_request_names_its_own_request_by_the_live_id():
    text = "\n".join(
        [
            HEADER,
            _at("in", {"jsonrpc": "2.0", "id": "permission-7", "method": "x/ask", "params": {}}),
            _at("in", {"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": "permission-7"}}),
            _at("out", {"jsonrpc": "2.0", "id": "permission-7", "error": {"code": -32800, "message": "cancelled"}}),
        ]
    )
    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, text)
    ask = await client_end.receive()
    assert ask["method"] == "x/ask"
    assert ask["id"] != "permission-7"
    cancel = await client_end.receive()
    assert cancel["method"] == "$/cancel_request"
    assert cancel["params"]["requestId"] == ask["id"]
    await client_end.send({"jsonrpc": "2.0", "id": ask["id"], "error": {"code": -32800, "message": "cancelled"}})
    await replay.done
    await client_end.close()


@pytest.mark.parametrize("answer", ["yes", "no"])
async def test_check_sees_the_clients_answers_to_the_agents_requests_with_live_ids(answer: str):
    text = "\n".join(
        [
            HEADER,
            _at("in", {"jsonrpc": "2.0", "id": "perm-1", "method": "x/ask", "params": {}}),
            _at("out", {"jsonrpc": "2.0", "id": "perm-1", "result": {"answer": "yes"}}),
        ]
    )
    agent_end, client_end = channel_pair()
    checked: list[tuple[Any, Any]] = []

    def check(expected: dict[str, Any], got: dict[str, Any]) -> str | None:
        checked.append((expected.get("id"), got.get("id")))
        if "method" in expected:
            return None
        return None if expected.get("result") == got.get("result") else f"answered {json.dumps(got.get('result'))}"

    replay = replay_agent(agent_end, text, check=check)
    peer = RpcPeer(client_end)
    peer.on_request("x/ask", lambda _params, _context: {"answer": answer})
    peer.start()
    if answer == "yes":
        await replay.done
    else:
        with pytest.raises(ReplayDivergence, match=r'answered \{"answer": "no"\}'):
            await replay.done
    assert len(checked) == 1
    assert checked[0][0] != "perm-1"
    assert checked[0][0] == checked[0][1]
    await peer.close()


async def test_pace_keeps_the_recorded_gaps():
    records = [
        {"v": 1, "kind": "header", "started": "1970-01-01T00:00:00.000Z", "peer": "client"},
        {"v": 1, "kind": "message", "t": 0, "dir": "out", "msg": {"jsonrpc": "2.0", "id": 0, "method": "ping"}},
        {"v": 1, "kind": "message", "t": 300, "dir": "in", "msg": {"jsonrpc": "2.0", "id": 0, "result": "pong"}},
    ]
    # A gap long enough to tell apart from a slow machine; asyncio may fire a timer one clock tick (16 ms on Windows) early.
    for pace, low, high in [(0, 0, 250), (1, 270, 5000)]:
        agent_end, client_end = channel_pair()
        replay_agent(agent_end, records, pace=pace)
        peer = RpcPeer(client_end).start()
        started = time.monotonic()
        assert await peer.request("ping") == "pong"
        took = (time.monotonic() - started) * 1000
        assert low <= took < high, f"pace {pace} took {took} ms"
        await peer.close()


def test_replace_strings_and_redact_keys_redact_at_any_depth():
    redact = replace_strings([("/tmp/abc", "/workspace"), (re.compile(r"token-\w+"), "token-x")])
    assert redact({"cwd": "/tmp/abc", "list": ["see /tmp/abc/a.txt", 3, {"t": "token-123 token-9"}]}) == {
        "cwd": "/workspace",
        "list": ["see /workspace/a.txt", 3, {"t": "token-x token-x"}],
    }
    assert redact_keys(["hostname"])({"_meta": [{"hostname": "my-mac", "keep": 1}]}) == {
        "_meta": [{"hostname": "[redacted]", "keep": 1}]
    }


async def test_a_recorder_redacts_and_keeps_notes():
    rec = recorder(peer="client", redact=replace_strings([("/home/me", "~")]))
    rec.tap("out", {"cwd": "/home/me/project"})
    rec.note("checkpoint", {"n": 1})
    rec.note("no data")
    records = parse_trace(rec.text())
    assert records[1]["msg"] == {"cwd": "~/project"}
    assert records[2]["data"] == {"n": 1} and "data" not in records[3]


async def test_record_a_real_agent_save_and_load_the_trace_and_replay_it(tmp_path):
    writer = Path(__file__).parent / "fixtures" / "writer_agent.py"
    folder = str(tmp_path)
    agent = await record_agent(
        sys.executable,
        args=[str(writer)],
        cwd=folder,
        workspace=folder,
        permissions="allow",
        label="writer",
        meta={"prompt": "write a.txt hi"},
        redact=replace_strings([(folder, "/workspace")]),
    )
    session = await agent.client.new_session(folder)
    live = normalize_turn(await session.prompt("write a.txt hi"))
    await agent.close()
    assert live.text == "Wrote a.txt." and [c.status for c in live.tool_calls] == ["completed"]
    path = tmp_path / "traces" / "writer.trace.jsonl"
    await save_trace(path, agent.recorder.records)
    records = await load_trace(path)
    assert records[0]["label"] == "writer" and records[0]["meta"]["command"].endswith("writer_agent.py")
    assert folder not in json.dumps(records[1:])

    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, records)
    client = await AcpClient.connect(client_end, permissions="allow")
    replayed = normalize_turn(await (await client.new_session("/workspace")).prompt("anything"))
    assert replayed == live
    await replay.done
    await client.close()
