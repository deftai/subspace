"""The client and the agent side together: the same app-visible behaviour on v1 and v2."""

import asyncio

import pytest

from link import connect

from deft_subspace.acp.client import Timeouts
from deft_subspace.acp.model import (
    MessageEndEvent,
    MessageEvent,
    PermissionEvent,
    ToolCallEvent,
    TurnLimits,
    turn_end,
)
from deft_subspace.kernel import LocalError, RpcError


def shape(events):
    """Events without ids, for comparing protocols."""
    out = []
    for e in events:
        if isinstance(e, MessageEvent):
            out.append(("message", e.delta))
        elif isinstance(e, MessageEndEvent):
            out.append(("message_end", e.text, e.complete))
        elif isinstance(e, ToolCallEvent):
            out.append(("tool_call", e.tool_call.title, e.tool_call.status, e.created))
        elif isinstance(e, PermissionEvent):
            out.append(("permission", e.outcome.outcome, e.outcome.allowed))
        elif e.type == "plan":
            out.append(("plan", len(e.entries)))
    return out


async def scripted(turn):
    await turn.say("Looking.")
    await turn.plan([{"content": "Read", "status": "in_progress"}])
    await turn.tool("Read a.txt", lambda _call: "a", kind="read")
    await turn.say("Done.")


@pytest.mark.parametrize("protocol", [1, 2])
async def test_turn_basics(protocol):
    client = await connect({"prompt": scripted, "protocols": [protocol]})
    assert client.protocol == protocol
    session = await client.new_session("/tmp")
    turn = session.prompt("go")
    events = [e async for e in turn]
    result = await turn
    assert result.stop_reason == "end_turn"
    assert result.text == "Looking.\n\nDone."
    assert [c.status for c in result.tool_calls] == ["completed"]
    assert turn_end(result) == "completed"
    assert ("message_end", "Done.", True) in shape(events)
    await client.close()


async def test_v1_and_v2_give_the_same_events():
    shapes = []
    for protocol in (1, 2):
        client = await connect({"prompt": scripted, "protocols": [protocol]})
        session = await client.new_session("/tmp")
        turn = session.prompt("go")
        shapes.append(shape([e async for e in turn]))
        await client.close()
    assert shapes[0] == shapes[1]


@pytest.mark.parametrize("protocol", [1, 2])
async def test_ask_refused_ends_normally_and_counts_as_refused(protocol):
    async def prompt(turn):
        await turn.tool("Delete build/", lambda _c: "gone", kind="delete", ask=True)

    client = await connect({"prompt": prompt, "protocols": [protocol]})
    session = await client.new_session("/tmp")
    result = await session.prompt("go")
    assert result.stop_reason == "end_turn"
    assert result.refused == 1
    assert [c.status for c in result.tool_calls] == ["failed"]
    allowed = await session.prompt("go", on_permission="allow")
    assert [c.status for c in allowed.tool_calls] == ["completed"]
    assert allowed.refused == 0
    await client.close()


@pytest.mark.parametrize("protocol", [1, 2])
async def test_cancel_answers_open_questions_and_ends_cancelled(protocol):
    asked = asyncio.Event()

    async def prompt(turn):
        await turn.say("about to ask")
        answer = await turn.request_permission("Run it?")
        await turn.say(f"answer {answer.outcome}")
        await turn.signal.wait()

    async def slow_answer(_request, signal):
        asked.set()
        await signal.wait()
        return "allow"

    client = await connect({"prompt": prompt, "protocols": [protocol]}, on_permission=slow_answer)
    session = await client.new_session("/tmp")
    turn = session.prompt("go")
    await asked.wait()
    await turn.cancel()
    result = await turn
    assert result.cancelled and result.stop_reason == "cancelled"
    assert turn_end(result) == "cancelled"
    assert result.refused == 0, "a question answered cancelled by our cancel is not a refusal"
    permission = next(e for e in turn.history if isinstance(e, PermissionEvent))
    assert permission.outcome.outcome == "cancelled"
    await client.close()


async def test_a_cancel_the_agent_ignores_ends_the_turn_here_after_the_grace_period():
    async def prompt(turn):
        await turn.tool_call("Long job", status="in_progress")
        await asyncio.sleep(30)

    client = await connect({"prompt": prompt}, timeouts=Timeouts(cancel_grace_ms=50))
    session = await client.new_session("/tmp")
    turn = session.prompt("go")
    while not turn.tool_calls:
        await asyncio.sleep(0.01)
    await turn.cancel()
    result = await turn
    assert result.forced and result.cancelled
    assert [c.status for c in result.tool_calls] == ["failed"]
    await client.close()


async def test_prompting_an_unknown_session_is_resource_not_found():
    client = await connect({"prompt": scripted})
    session = await client.new_session("/tmp")
    await session.prompt("go")
    from deft_subspace.acp.client import Session

    ghost = Session(client, "ghost", {})
    client._sessions["ghost"] = ghost
    with pytest.raises(RpcError) as info:
        await ghost.prompt("hi")
    assert info.value.code == -32002
    await client.close()


async def test_if_the_agent_goes_away_mid_turn_the_turn_fails_closed():
    started = asyncio.Event()

    async def prompt(turn):
        started.set()
        await asyncio.sleep(30)

    for protocol in (1, 2):
        client = await connect({"prompt": prompt, "protocols": [protocol]})
        session = await client.new_session("/tmp")
        turn = session.prompt("go")
        await started.wait()
        started.clear()
        await client.peer.close()
        with pytest.raises(LocalError) as info:
            await turn
        assert info.value.kind == "closed"


async def test_queued_prompts_run_in_order_and_a_busy_session_raises():
    async def prompt(turn):
        await asyncio.sleep(0.02)
        await turn.say(turn.text)

    client = await connect({"prompt": prompt, "queue_prompts": True})
    session = await client.new_session("/tmp")
    first = session.prompt("one")
    with pytest.raises(RuntimeError):
        session.prompt("two")
    second = session.prompt("two", queue=True)
    assert session.queued_count == 1
    assert (await first).text == "one"
    assert (await second).text == "two"
    await client.close()


async def test_limits_tool_calls_and_duration():
    async def many(turn):
        for i in range(5):
            await turn.tool(f"step {i}", lambda _c: "ok")

    client = await connect({"prompt": many})
    session = await client.new_session("/tmp")
    result = await session.prompt("go", limits=TurnLimits(max_tool_calls=2))
    assert result.exhausted is not None and result.exhausted.limit == "toolCalls"
    assert turn_end(result) == "limit"

    async def forever(turn):
        await turn.signal.wait()

    client2 = await connect({"prompt": forever}, limits=TurnLimits(max_duration_ms=50))
    session2 = await client2.new_session("/tmp")
    result2 = await session2.prompt("go")
    assert result2.exhausted is not None and result2.exhausted.limit == "duration"
    await client.close()
    await client2.close()


async def test_handlers_run_in_order_and_a_raising_handler_cancels_the_turn():
    async def prompt(turn):
        await turn.say("a")
        await turn.say("b")
        await turn.signal.wait()

    client = await connect({"prompt": prompt})
    session = await client.new_session("/tmp")
    seen = []

    async def on_message(delta, info, _event):
        seen.append((delta, info.index, info.first))
        if delta == "b":
            raise ValueError("stop here")

    with pytest.raises(ValueError, match="stop here"):
        await session.prompt("go", on_message=on_message)
    assert seen == [("a", 0, True), ("b", 0, False)]
    await client.close()


async def test_a_signal_cancels_the_turn():
    from deft_subspace.kernel import AbortController

    async def prompt(turn):
        await turn.signal.wait()

    client = await connect({"prompt": prompt})
    session = await client.new_session("/tmp")
    controller = AbortController()
    turn = session.prompt("go", signal=controller.signal)
    await asyncio.sleep(0.01)
    controller.abort()
    assert (await turn).cancelled
    await client.close()


async def test_unknown_handler_names_are_refused():
    client = await connect({"prompt": scripted})
    session = await client.new_session("/tmp")
    with pytest.raises(TypeError, match="on_mesage"):
        session.prompt("go", on_mesage=print)
    await client.close()


@pytest.mark.parametrize("protocol", [1, 2])
async def test_elicitation_on_question(protocol):
    async def prompt(turn):
        answer = await turn.elicit("Name?", requested_schema={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
        await turn.say(f"{answer.action} {answer.content}")

    client = await connect({"prompt": prompt, "protocols": [protocol]}, on_question=lambda _r, _s: {"action": "accept", "content": {"name": "Ada"}})
    session = await client.new_session("/tmp")
    assert (await session.prompt("go")).text == "accept {'name': 'Ada'}"
    # A form answer that does not fit is declined, not sent.
    bad = await session.prompt("go", on_question=lambda _r, _s: {"action": "accept", "content": {"name": 3}})
    assert bad.text == "decline None"
    await client.close()
