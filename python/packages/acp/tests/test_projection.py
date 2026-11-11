"""TurnProjection storage: snapshots stay as they were, and what a turn keeps grows linearly."""

from __future__ import annotations

import base64
from dataclasses import asdict
from typing import Any

from deft_subspace.acp import MessageEvent, TerminalEvent, ToolCallEvent, terminal_text
from deft_subspace.acp.projection import TurnProjection
from deft_subspace.acp.terminals import Terminals


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
    assert "_output" in events[0].terminal.__dict__ and not isinstance(events[0].terminal.__dict__["_output"], bytes)
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
    assert not isinstance(events[0].__dict__["_text"], str)
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
