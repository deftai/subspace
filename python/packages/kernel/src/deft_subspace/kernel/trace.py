"""Traces: every JSON-RPC message on a connection, with time and direction, as JSON Lines.

One format for recording, replay, and the trace viewer, the same as the
TypeScript packages write.

    records = []
    peer = RpcPeer(channel, tap=trace_tap(records.append, peer="client"))
    ...
    Path("session.trace.jsonl").write_text(format_trace(records))

Line 1 is a header. Then one record per message (and optional notes).
`t` is milliseconds since the header's `started`.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from typing import Any, Literal

from .clock import Clock, system_clock

TRACE_VERSION = 1

TraceRecord = dict[str, Any]
"""`{"v": 1, "kind": "header" | "message" | "note", ...}`; see the module docstring."""


_NO_DATA: Any = object()


def _iso(ms: float) -> str:
    stamp = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{stamp.microsecond // 1000:03d}Z"


class TraceTap:
    """A peer `tap` that records a trace. The header is written at once."""

    def __init__(
        self,
        write: Callable[[TraceRecord], None],
        *,
        peer: str,
        label: str | None = None,
        meta: dict[str, Any] | None = None,
        clock: Clock | None = None,
        redact: Callable[[Any, Literal["in", "out"]], Any] | None = None,
    ) -> None:
        """`redact` may change a message or drop it (return None) before it is recorded, e.g. to remove secrets."""
        self._write = write
        self._clock = clock or system_clock
        self._redact = redact
        self._start = self._clock.now()
        header: TraceRecord = {"v": TRACE_VERSION, "kind": "header", "started": _iso(self._start), "peer": peer}
        if label:
            header["label"] = label
        if meta:
            header["meta"] = meta
        write(header)

    def __call__(self, direction: Literal["in", "out"], message: Any) -> None:
        msg = self._redact(message, direction) if self._redact else message
        if msg is None:
            return
        # Copy, so later mutation of the message does not change the record.
        self._write({"v": TRACE_VERSION, "kind": "message", "t": self._elapsed(), "dir": direction, "msg": copy.deepcopy(msg)})

    def note(self, text: str, data: Any = _NO_DATA) -> None:
        """Add a note at the current time. `data=None` is recorded as null; leave it out for no data."""
        record: TraceRecord = {"v": TRACE_VERSION, "kind": "note", "t": self._elapsed(), "text": text}
        if data is not _NO_DATA:
            record["data"] = data
        self._write(record)

    def _elapsed(self) -> float:
        elapsed = self._clock.now() - self._start
        return int(elapsed) if float(elapsed).is_integer() else elapsed


def trace_tap(write: Callable[[TraceRecord], None], **options: Any) -> TraceTap:
    return TraceTap(write, **options)


def format_trace(records: Sequence[TraceRecord]) -> str:
    """Records as JSON Lines."""
    return "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in records)


def parse_trace(text: str) -> list[TraceRecord]:
    """Parse JSON Lines. Raises ValueError on a malformed line, naming it; skips blank lines."""
    records: list[TraceRecord] = []
    for index, line in enumerate(text.split("\n")):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as error:
            raise ValueError(f"Trace line {index + 1} is not JSON") from error
        if not isinstance(record, dict) or record.get("v") != TRACE_VERSION or record.get("kind") not in ("header", "message", "note"):
            raise ValueError(f"Trace line {index + 1} is not a version {TRACE_VERSION} trace record")
        records.append(record)
    if not records or records[0].get("kind") != "header":
        raise ValueError("A trace starts with a header record")
    return records
