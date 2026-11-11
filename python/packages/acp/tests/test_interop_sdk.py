"""The client against an agent built with the official Python ACP SDK, over a real process."""

import sys
from pathlib import Path

import pytest

from deft_subspace.acp.client import AcpClient
from deft_subspace.acp.model import MessageEndEvent, MessageEvent, PermissionEvent, ToolCallEvent
from deft_subspace.kernel import ndjson, spawn_process

AGENT = Path(__file__).parent / "fixtures" / "sdk_agent.py"


@pytest.fixture
async def sdk_agent():
    child = await spawn_process(sys.executable, args=[str(AGENT)], kill_grace_ms=500)
    yield child
    await child.stop()


async def connect(child, **options) -> AcpClient:
    return await AcpClient.connect(ndjson(child.channel), name="interop", **options)


async def test_echo_turn_streams_and_ends(sdk_agent):
    client = await connect(sdk_agent)
    assert client.protocol == 1
    assert client.agent.name == "sdk-echo"
    session = await client.new_session(str(Path.cwd()))
    turn = session.prompt("hello there")
    events = [event async for event in turn]
    result = await turn
    assert result.stop_reason == "end_turn"
    assert result.text == "echo: hellothere" or result.text == "echo: hello there"
    deltas = [e.delta for e in events if isinstance(e, MessageEvent)]
    assert "".join(deltas) == result.text
    ends = [e for e in events if isinstance(e, MessageEndEvent)]
    assert len(ends) == 1 and ends[0].complete
    await client.close()


async def test_permission_is_answered_by_the_policy(sdk_agent):
    client = await connect(sdk_agent, permissions="allow")
    session = await client.new_session(str(Path.cwd()))
    turn = session.prompt("ask")
    events = [event async for event in turn]
    result = await turn
    assert result.text == "chose yes"
    permission = next(e for e in events if isinstance(e, PermissionEvent))
    assert permission.request.tool_call is not None
    assert permission.request.tool_call.title == "Delete build/"
    assert permission.outcome.allowed
    assert any(isinstance(e, ToolCallEvent) and e.created for e in events)
    await client.close()


async def test_default_policy_rejects(sdk_agent):
    client = await connect(sdk_agent)
    session = await client.new_session(str(Path.cwd()))
    result = await session.prompt("ask")
    assert result.text == "chose no"
    assert result.refused == 1
    await client.close()


async def test_per_turn_handlers(sdk_agent):
    client = await connect(sdk_agent)
    session = await client.new_session(str(Path.cwd()))
    seen: list[str] = []
    result = await session.prompt(
        "ask",
        on_permission=lambda request, _signal: {"optionId": "yes"},
        on_message=lambda delta, info, _event: seen.append(info.separator + delta),
    )
    assert result.text == "chose yes"
    assert "".join(seen) == result.text
    await client.close()


async def test_cancel_reaches_the_agent(sdk_agent):
    client = await connect(sdk_agent)
    session = await client.new_session(str(Path.cwd()))
    turn = session.prompt("slow")
    await turn.cancel()
    result = await turn
    assert result.cancelled
    assert result.stop_reason == "cancelled"
    assert not result.forced
    await client.close()
