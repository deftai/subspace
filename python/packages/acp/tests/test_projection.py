"""TurnProjection storage: snapshots stay as they were, and what a turn keeps grows linearly."""

from __future__ import annotations

import base64
from dataclasses import asdict

from deft_subspace.acp import TerminalEvent, terminal_text
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
