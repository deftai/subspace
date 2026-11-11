"""TurnProjection storage: snapshots stay as they were, and what a turn keeps grows linearly."""

from __future__ import annotations

import asyncio
import base64
import copy
import pickle
from dataclasses import FrozenInstanceError, asdict, replace
from typing import Any

import pytest

from deft_subspace.acp import MessageEvent, TerminalEvent, ToolCallEvent, TurnResult, UsageEvent, terminal_text
from deft_subspace.acp.projection import TurnProjection
from deft_subspace.acp.terminals import Terminals
from deft_subspace.acp.turn import Turn


def _b64(data: bytes | str) -> str:
    return base64.b64encode(data.encode() if isinstance(data, str) else data).decode()


def test_terminal_output_is_stored_once_and_events_share_it():
    cap = 64 * 1024
    terminals = Terminals(cap)
    projection = TurnProjection("t", terminals)

    def chunk(i: int) -> bytes:
        return bytes([48 + i % 10]) * 1000

    events: list[TerminalEvent] = []
    for i in range(500):
        for event in projection.apply({"sessionUpdate": "terminal_output_chunk", "terminalId": "T", "data": _b64(chunk(i))})[0]:
            assert isinstance(event, TerminalEvent)
            events.append(event)
    # The event's output is read from the shared store, not a copy per event.
    assert not isinstance(events[0].terminal.__dict__["output"], bytes)
    # Kept output is capped and stored in a few segments, not one buffer per chunk.
    size, segments, capacity = terminals.storage("T") or (0, 0, 0)
    assert size == cap
    assert segments <= 4 and capacity <= 3 * cap

    def expected(n: int) -> bytes:
        return b"".join(chunk(i) for i in range(n))[-cap:]

    # Every snapshot still has the output as it was then, capped from the front.
    for n in (1, 2, 65, 66, 300, 500):
        assert events[n - 1].terminal.output == expected(n), n
    live = terminals.get("T")
    assert live is not None and live.output == expected(500)
    # A snapshot compares, converts and copies like a plain dataclass.
    assert asdict(events[0].terminal)["output"] == chunk(0)
    assert events[0].terminal == events[0].terminal.snapshot()
    # A replacing snapshot starts over; earlier events keep theirs.
    projection.apply({"sessionUpdate": "terminal_update", "terminalId": "T", "output": {"data": _b64("fresh")}})
    assert terminal_text(live) == "fresh"
    assert events[499].terminal.output == expected(500)
    # One chunk larger than the cap keeps its tail.
    projection.apply({"sessionUpdate": "terminal_output_chunk", "terminalId": "T", "data": _b64(b"x" * (70 * 1024))})
    assert len(live.output) == cap and live.output.endswith(b"x")


async def test_turn_history_a_number_keeps_the_last_events_none_keeps_none_a_running_reader_misses_nothing():
    def usage(n: int) -> UsageEvent:
        return UsageEvent(used=n, size=100)

    async def nothing() -> None:
        return None

    capped = Turn("a", nothing, history=3)
    for i in range(10):
        capped.push(usage(i))
    assert [e.used for e in capped.history if isinstance(e, UsageEvent)] == [7, 8, 9]
    # A reader that is behind holds events until it has had them; then they go.
    turn = Turn("b", nothing, history="none")
    seen: list[float] = []

    async def read() -> None:
        async for event in turn:
            assert isinstance(event, UsageEvent)
            seen.append(event.used)

    reader = asyncio.ensure_future(read())
    await asyncio.sleep(0)
    for i in range(200):
        turn.push(usage(i))
    assert turn.history, "the reader has not run yet"
    await asyncio.sleep(0)
    turn.push(usage(200))
    turn.finish(TurnResult(stop_reason="end_turn", text="", tool_calls=[], cancelled=False))
    await reader
    assert seen == list(range(201))
    assert turn.history == [] and len(turn._events) < 100
    # The default keeps everything.
    everything = Turn("c", nothing)
    for i in range(10):
        everything.push(usage(i))
    assert len(everything.history) == 10
    with pytest.raises(ValueError):
        Turn("d", nothing, history=-1)


async def test_turn_history_an_iteration_abandoned_mid_turn_stops_holding_events_once_collected():
    import gc

    async def nothing() -> None:
        return None

    turn = Turn("a", nothing, history=3)
    turn.push(UsageEvent(used=0, size=100))
    # Suspended at a yield, then dropped without aclose(): asyncio closes it once collected,
    # which runs its `finally` and lets the events go.
    iterator = turn.__aiter__()
    await iterator.__anext__()
    del iterator
    gc.collect()
    for _ in range(3):
        await asyncio.sleep(0)
    for i in range(1, 100):
        turn.push(UsageEvent(used=i, size=100))
    assert len(turn.history) == 3


def _text(t: str) -> dict[str, Any]:
    return {"type": "content", "content": {"type": "text", "text": t}}


def test_tool_call_snapshots_do_not_change_when_content_chunks_append():
    projection = TurnProjection("t")
    events: list[ToolCallEvent] = []

    def apply(update: dict[str, Any]) -> None:
        events.extend(e for e in projection.apply(update)[0] if isinstance(e, ToolCallEvent))

    apply({"sessionUpdate": "tool_call_update", "toolCallId": "c", "title": "x", "status": "in_progress", "content": [_text("a")]})
    for i in range(100):
        apply({"sessionUpdate": "tool_call_content_chunk", "toolCallId": "c", "content": _text(str(i))})
    assert [len(events[i].tool_call.content) for i in (0, 1, 100)] == [1, 2, 101]
    # Snapshots do not share a list with the live tool call or with each other.
    live = projection.tool_calls["c"]
    assert events[100].tool_call.content is not live.content
    assert events[99].tool_call.content is not events[100].tool_call.content
    events[100].tool_call.content.append({"mine": True})
    assert len(live.content) == 101 and len(events[99].tool_call.content) == 100
    # A replacing update starts a new list; earlier snapshots keep theirs.
    apply({"sessionUpdate": "tool_call_update", "toolCallId": "c", "content": [_text("new")]})
    assert events[-1].tool_call.content == [_text("new")]
    assert len(events[50].tool_call.content) == 51
    # A snapshot compares and converts like a plain dataclass.
    assert asdict(events[0].tool_call)["content"] == [_text("a")]
    assert events[0].tool_call == events[0].tool_call.snapshot()
    failed = projection.fail_open_tool_calls()
    assert [e.tool_call.status for e in failed if isinstance(e, ToolCallEvent)] == ["failed"]
    assert events[-1].tool_call.status == "in_progress"


def test_message_events_read_their_text_from_the_message_without_a_copy_each():
    projection = TurnProjection("t")
    events: list[MessageEvent] = []

    def apply(update: dict[str, Any]) -> None:
        events.extend(e for e in projection.apply(update)[0] if isinstance(e, MessageEvent))

    for i in range(50):
        apply({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": f"{i} "}})
    # `text` is read from the message's log, not stored on each event.
    assert not isinstance(events[0].__dict__["text"], str)
    assert events[0].text == "0 " and events[2].text == "0 1 2 "
    whole = "".join(f"{i} " for i in range(50))
    assert events[49].text == whole == projection.text
    assert events[1] == MessageEvent("t:message:1", "1 ", "0 1 ")
    assert asdict(events[1])["text"] == "0 1 "
    # A v2 whole-message rewrite starts over; earlier events keep their text.
    for text in ("hello", "hello world", "bye"):
        apply({"sessionUpdate": "agent_message", "messageId": "m", "content": [{"type": "text", "text": text}]})
    assert [(e.delta, e.text) for e in events[-3:]] == [("hello", "hello"), (" world", "hello world"), ("bye", "bye")]
    assert events[49].text == whole
    # The turn's text is cached until a message changes.
    assert projection.text == f"{whole}\n\nbye"
    apply({"sessionUpdate": "agent_message_chunk", "messageId": "m", "content": {"type": "text", "text": "!"}})
    assert projection.text == f"{whole}\n\nbye!"


def test_event_snapshots_own_their_copy_once_read_and_assign_as_on_main():
    projection = TurnProjection("t")
    tools: list[ToolCallEvent] = []
    messages: list[MessageEvent] = []
    terminals: list[TerminalEvent] = []

    def apply(update: dict[str, Any]) -> None:
        for e in projection.apply(update)[0]:
            if isinstance(e, ToolCallEvent):
                tools.append(e)
            elif isinstance(e, MessageEvent):
                messages.append(e)
            elif isinstance(e, TerminalEvent):
                terminals.append(e)

    # Two snapshots at the same content length (a status change adds no content).
    apply({"sessionUpdate": "tool_call_update", "toolCallId": "c", "title": "x", "status": "pending", "content": [_text("a")]})
    apply({"sessionUpdate": "tool_call_update", "toolCallId": "c", "status": "in_progress"})
    one, two = (e.tool_call for e in tools)
    assert one.content is one.content
    one.content.append({"mine": True})
    assert len(two.content) == 1 and len(projection.tool_calls["c"].content) == 1
    # A snapshot of another tool call in between does not lose the change.
    apply({"sessionUpdate": "tool_call_update", "toolCallId": "d", "title": "d", "content": [_text("d")]})
    assert len(tools[-1].tool_call.content) == 1
    assert len(one.content) == 2
    apply({"sessionUpdate": "tool_call_update", "toolCallId": "c", "title": "y"})
    assert len(tools[-1].tool_call.content) == 1
    # Tool calls are not frozen: assignment works, as on main.
    two.content = []
    assert two.content == []
    # Once read, the field is a plain value in the instance.
    assert vars(one)["content"] is one.content
    # Message events are frozen, as on main; a read value is stored plainly.
    apply({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}})
    message = messages[0]
    with pytest.raises(FrozenInstanceError):
        message.text = "changed"  # type: ignore[misc]
    assert message.text == "hi" and vars(message)["text"] == "hi"
    # Terminal output (bytes): snapshots are independent and assignable.
    apply({"sessionUpdate": "terminal_output_chunk", "terminalId": "term", "data": _b64("abc")})
    apply({"sessionUpdate": "terminal_update", "terminalId": "term", "command": "ls"})
    second = terminals[1].terminal
    second.output = b"x"
    assert second.output == b"x" and terminals[0].terminal.output == b"abc"
    live = projection.terminals.get("term")
    assert live is not None and live.output == b"abc"
    # Events pickle, deep-copy, compare and convert like plain dataclasses, read or not.
    other = TurnProjection("u")
    other.apply({"sessionUpdate": "tool_call_update", "toolCallId": "e", "title": "e", "content": [_text("e")]})
    other.apply({"sessionUpdate": "terminal_output_chunk", "terminalId": "T", "data": _b64("out")})
    unread = [*other.apply({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "yo"}})[0]]
    unread += other.apply({"sessionUpdate": "tool_call_update", "toolCallId": "e", "status": "completed"})[0]
    unread += other.apply({"sessionUpdate": "terminal_update", "terminalId": "T", "command": "c"})[0]
    for event in unread:
        again = pickle.loads(pickle.dumps(event))
        assert again == event and asdict(again) == asdict(event)
        assert copy.deepcopy(event) == event
    assert pickle.loads(pickle.dumps(unread[0])).text == "yo"
    assert replace(unread[0], delta="x").text == "yo"
    assert unread[0] == MessageEvent("u:message:1", "yo", "yo")
    for event in (messages[0], tools[-1], terminals[0]):
        assert pickle.loads(pickle.dumps(event)) == event and copy.deepcopy(event) == event
