"""Client turn states against an agent written by hand, for timings serve_agent will not produce."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from link import connect

from deft_subspace.acp.client import AcpClient, Timeouts
from deft_subspace.acp.model import MessageEvent
from deft_subspace.acp.turn import Turn
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

        # The first confirms the cancel late: after the grace period and one more, before the drain gives up.
        later(0.25, confirm()) if n == 1 else later(0.02, answer())
        return {}

    client, _agent = await Fake(2, on_prompt).start(timeouts=Timeouts(cancel_grace_ms=100))
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
            await asyncio.sleep(0.16)
            await update(agent, chunk("late "))
            await update(agent, {"sessionUpdate": "tool_call", "toolCallId": "old", "title": "old", "status": "pending"})
            order.append("answer 1")
            return {"stopReason": "cancelled"}
        await update(agent, chunk("second"))
        return {"stopReason": "end_turn"}

    client, _agent = await Fake(1, on_prompt).start(timeouts=Timeouts(cancel_grace_ms=100))
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


async def test_a_tool_call_id_the_agent_reuses_in_a_later_turn_belongs_to_that_turn():
    async def on_prompt(agent: RpcPeer, _params: Any, n: int) -> Any:
        await update(agent, {"sessionUpdate": "tool_call", "toolCallId": "call_1", "title": f"turn {n}", "status": "pending"})
        await update(agent, {"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "completed"})
        return {"stopReason": "end_turn"}

    client, _agent = await Fake(1, on_prompt).start()
    session = await client.new_session("/")
    r1 = await session.prompt("a")
    r2 = await session.prompt("b")
    assert [len(r1.tool_calls), len(r2.tool_calls)] == [1, 1]
    assert (r2.tool_calls[0].title, r2.tool_calls[0].status) == ("turn 2", "completed")
    await client.close()


async def test_the_clients_on_question_answers_questions_outside_a_turn():
    async def on_prompt(_agent: RpcPeer, _params: Any, _n: int) -> Any:
        return {}

    client, agent = await Fake(2, on_prompt).start(on_question=lambda _r, _s: {"action": "accept", "content": {"name": "Ada"}})
    schema = {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}
    no_session = await agent.request("elicitation/create", {"mode": "form", "message": "Name?", "requestedSchema": schema})
    assert no_session == {"action": "accept", "content": {"name": "Ada"}}
    await client.new_session("/")
    between = await agent.request("elicitation/create", {"sessionId": "s1", "mode": "form", "message": "Name?", "requestedSchema": schema})
    assert between == {"action": "accept", "content": {"name": "Ada"}}
    await client.close()


async def test_updates_for_a_session_closed_here_are_dropped_not_replayed_by_a_later_load():
    async def on_prompt(_agent: RpcPeer, _params: Any, _n: int) -> Any:
        return {"stopReason": "end_turn"}

    client, agent = await Fake(1, on_prompt, {"loadSession": True}).start()
    agent.on_request("session/load", lambda _p, _c: {})
    session = await client.new_session("/")
    await session.close()
    await update(agent, chunk("after close"))
    await asyncio.sleep(0.01)
    _session, replayed = await client.load_session("s1", "/")
    assert replayed == []
    await client.close()


async def test_a_handler_raising_cancelled_error_fails_the_turn():
    async def prompt(turn):
        for i in range(5):
            await turn.say(f"part{i} ")
            await asyncio.sleep(0.02)
        await turn.signal.wait()

    client = await connect({"prompt": prompt})
    session = await client.new_session("/tmp")
    seen: list[str] = []

    async def on_message(delta, _info, _event):
        seen.append(delta)
        if len(seen) == 2:
            inner = asyncio.ensure_future(asyncio.sleep(10))
            inner.cancel()
            await inner

    turn = session.prompt("go", on_message=on_message)
    # Raised as an error of its own: a CancelledError would look like the awaiting task being cancelled.
    with pytest.raises(RuntimeError, match="handler was cancelled"):
        await asyncio.wait_for(turn.done, 3)
    assert turn.cancel_requested, "a failed handler cancels the turn"
    assert len(seen) == 2
    await client.close()


async def test_caught_up_stops_waiting_once_the_handlers_have_failed_and_leaves_nothing_behind():
    async def on_cancel() -> None:
        pass

    turn = Turn("t", on_cancel)
    release = asyncio.Event()

    async def on_message(delta, _info, _event):
        if delta == "slow":
            await release.wait()
        raise ValueError("handler failed")

    from deft_subspace.acp.handlers import merge_handlers

    handlers = merge_handlers(None, {"on_message": on_message})
    assert handlers is not None
    turn.observe(handlers)
    turn.push(MessageEvent("m", "slow", "slow"))
    await turn.caught_up(20)
    assert turn._progress == []
    release.set()
    await asyncio.sleep(0.01)
    turn.push(MessageEvent("m", " more", "slow more"))
    started = time.monotonic()
    await turn.caught_up()
    assert time.monotonic() - started < 0.5, "no handler will run again: nothing to wait for"


async def test_a_mode_change_replaces_session_modes_instead_of_changing_the_object_an_app_holds():
    async def on_prompt(_agent: RpcPeer, _params: Any, _n: int) -> Any:
        return {"stopReason": "end_turn"}

    client, agent = await Fake(1, on_prompt).start()
    modes = {"currentModeId": "auto", "availableModes": [{"id": "auto", "name": "Auto"}, {"id": "plan", "name": "Plan"}]}
    agent.on_request("session/new", lambda _p, _c: {"sessionId": "s1", "modes": modes})
    agent.on_request("session/set_mode", lambda _p, _c: {})
    session = await client.new_session("/")
    before = session.modes
    await session.set_mode("plan")
    assert session.modes is not None and session.modes.current == "plan"
    after_set = session.modes
    await update(agent, {"sessionUpdate": "current_mode_update", "currentModeId": "auto"})
    await asyncio.sleep(0.01)
    assert session.modes is not None and session.modes.current == "auto"
    assert before is not None and before.current == "auto", "unchanged since it was read"
    assert after_set.current == "plan", "unchanged since it was read"
    await client.close()
