"""Client turn states against an agent written by hand, for timings serve_agent will not produce."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from deft_subspace.acp.client import AcpClient, Timeouts
from deft_subspace.kernel import RpcPeer, channel_pair


class Fake:
    def __init__(self, protocol: int, on_prompt: Any, capabilities: dict[str, Any] | None = None) -> None:
        self.protocol = protocol
        self.on_prompt = on_prompt
        self.capabilities = capabilities or {}
        self.cancels: list[Any] = []
        self.count = 0

    async def start(self, wrap: Any = None, **client: Any) -> tuple[AcpClient, RpcPeer]:
        a, b = channel_pair()
        agent = RpcPeer(b, name="fake")
        agent.on_request("initialize", lambda _p, _c: {"protocolVersion": self.protocol, "agentCapabilities": self.capabilities, "capabilities": self.capabilities})
        agent.on_request("session/new", lambda _p, _c: {"sessionId": "s1"})

        async def prompt(params: Any, _context: Any) -> Any:
            self.count += 1
            return await self.on_prompt(agent, params, self.count)

        agent.on_request("session/prompt", prompt)
        agent.on_notification("session/cancel", lambda _p, _c: None)
        agent.on_notification("$/cancel_request", lambda p, _c: self.cancels.append(p))
        agent.start()
        options = {"protocol": self.protocol, "timeouts": Timeouts(cancel_grace_ms=50), **client}
        return await AcpClient.connect(wrap(a) if wrap else a, **options), agent


async def update(agent: RpcPeer, u: dict[str, Any]) -> None:
    await agent.notify("session/update", {"sessionId": "s1", "update": u})


def chunk(text: str) -> dict[str, Any]:
    return {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}


def later(delay: float, coroutine: Any) -> None:
    async def run() -> None:
        await asyncio.sleep(delay)
        await coroutine

    tasks.add(asyncio.ensure_future(run()))


tasks: set[asyncio.Future[Any]] = set()


async def test_v2_a_force_ended_turns_late_updates_and_idle_do_not_land_in_the_next_turn():
    async def on_prompt(agent: RpcPeer, _params: Any, n: int) -> Any:
        async def confirm() -> None:
            await update(agent, chunk("late "))
            await update(agent, {"sessionUpdate": "state_update", "state": "idle", "stopReason": "cancelled"})

        async def answer() -> None:
            await update(agent, chunk("second turn answer"))
            await update(agent, {"sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn"})

        # The first confirms the cancel late: after the grace period, before the drain gives up.
        later(0.08, confirm()) if n == 1 else later(0.02, answer())
        return {}

    client, _agent = await Fake(2, on_prompt).start()
    session = await client.new_session("/")
    first = session.prompt("one")
    await asyncio.sleep(0.01)
    await first.cancel()
    second = session.prompt("two", queue=True)
    r1 = await first
    assert r1.forced
    assert not session.busy
    r2 = await second
    assert (r2.stop_reason, r2.text) == ("end_turn", "second turn answer")
    await client.close()


async def test_v1_queued_prompts_wait_for_a_force_ended_turns_answer():
    order: list[str] = []

    async def on_prompt(agent: RpcPeer, _params: Any, n: int) -> Any:
        order.append(f"prompt {n}")
        if n == 1:
            await asyncio.sleep(0.08)
            await update(agent, chunk("late "))
            await update(agent, {"sessionUpdate": "tool_call", "toolCallId": "old", "title": "old", "status": "pending"})
            order.append("answer 1")
            return {"stopReason": "cancelled"}
        await update(agent, chunk("second"))
        return {"stopReason": "end_turn"}

    client, _agent = await Fake(1, on_prompt).start()
    session = await client.new_session("/")
    first = session.prompt("one")
    await asyncio.sleep(0.01)
    await first.cancel()
    second = session.prompt("two", queue=True)
    assert (await first).forced
    r2 = await second
    assert r2.text == "second"
    assert r2.tool_calls == []
    assert order == ["prompt 1", "answer 1", "prompt 2"]
    assert "old" in session.tool_calls, "the late tool call is kept with the session"
    await client.close()


async def test_v1_a_force_ended_prompt_the_agent_never_answers_is_given_up_on():
    async def on_prompt(_agent: RpcPeer, _params: Any, n: int) -> Any:
        if n == 1:
            await asyncio.sleep(30)
        return {"stopReason": "end_turn"}

    fake = Fake(1, on_prompt)
    client, _agent = await fake.start()
    session = await client.new_session("/")
    first = session.prompt("one")
    await asyncio.sleep(0.01)
    await first.cancel()
    assert (await first).forced
    assert (await session.prompt("two", queue=True)).stop_reason == "end_turn"
    assert len(fake.cancels) == 1, "the first prompt request was cancelled"
    assert client.peer.pending_count == 0
    await client.close()


async def test_a_cancel_interrupted_while_it_tells_the_agent_still_ends_the_turn():
    async def on_prompt(_agent: RpcPeer, _params: Any, _n: int) -> Any:
        return {}

    client, _agent = await Fake(2, on_prompt).start()
    session = await client.new_session("/")
    turn = session.prompt("go")
    await asyncio.sleep(0.01)
    # The caller gives up on cancel() at once (a timeout, a task group being cancelled).
    task = asyncio.ensure_future(session.cancel())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await asyncio.wait_for(turn.done, 2)
    assert result.forced and result.cancelled
    await client.close()
