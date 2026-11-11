"""Terminals the agent runs and shows (v2 `terminal_update`, `terminal_output_chunk`).

Display only: the client cannot control them. A tool call refers to one with
content `{"type": "terminal", "terminalId": ...}`; look it up with
`session.terminals.get(terminal_id)`. Updates and the tool call may arrive in
either order, and a terminal can outlive its turn, so the session keeps them.

    async for event in turn:
        if event.type == "terminal":
            render(event.terminal.id, event.appended or event.terminal.output)

Output is bytes (it may split a UTF-8 character or an escape sequence);
`terminal_text()` decodes it for a plain transcript.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Any

from .lazy import Lazy, LazyField, stored


@dataclass(frozen=True)
class TerminalExit:
    exit_code: int | None = None
    signal: str | None = None


@dataclass(frozen=True)
class TerminalSize:
    cols: int
    rows: int


#: Segment size: small writes share one segment, so a chunk is not an object of its own.
_SEGMENT = 64 * 1024


class _Span:
    """Where a terminal's output was at one moment: a view of the log's segments, never a copy."""

    __slots__ = ("segments", "fills", "start", "start_offset", "end", "end_fill", "length")

    def __init__(self, segments: list[bytearray], fills: list[int], start: int, start_offset: int, end: int, end_fill: int, length: int) -> None:
        self.segments = segments
        #: Bytes written into each segment; frozen for every segment but the last.
        self.fills = fills
        self.start = start
        self.start_offset = start_offset
        self.end = end
        self.end_fill = end_fill
        self.length = length


class _OutputLog:
    """Output as a list of append-only segments.

    Appending copies only the new bytes; a snapshot is a span over the segments; bytes
    are joined only when read. Bytes a span covers are never written again: appends go
    past its end, and dropping old output (the cap) or a replacement starts new lists.
    """

    def __init__(self, max_bytes: int) -> None:
        self._max = max_bytes
        self._segments: list[bytearray] = []
        self._fills: list[int] = []
        self._start = 0
        self._start_offset = 0
        self.size = 0
        self._current: _Span | None = None
        #: The last span read, and its bytes.
        self._cache: tuple[_Span, bytes] | None = None

    def stats(self) -> tuple[int, int]:
        """(segments, capacity in bytes) kept, for tests."""
        live = self._segments[self._start :]
        return len(live), sum(len(s) for s in live)

    def append(self, data: bytes) -> None:
        if not data:
            return
        source = memoryview(data)
        # Past the cap, only the last max bytes can survive.
        if len(source) > self._max:
            source = source[len(source) - self._max :]
        written = 0
        last = len(self._segments) - 1
        if last >= self._start:
            fill = self._fills[last]
            written = min(len(self._segments[last]) - fill, len(source))
            if written:
                self._segments[last][fill : fill + written] = source[:written]
                self._fills[last] = fill + written
        if written < len(source):
            rest = source[written:]
            # Segments grow with the output, up to _SEGMENT, so a short output stays small.
            segment = bytearray(max(len(rest), min(_SEGMENT, max(1024, self.size))))
            segment[: len(rest)] = rest
            self._segments.append(segment)
            self._fills.append(len(rest))
        self.size += len(source)
        self._current = None
        self._drop()

    def reset(self, data: bytes) -> None:
        """Replace everything kept so far."""
        self._segments = []
        self._fills = []
        self._start = 0
        self._start_offset = 0
        self.size = 0
        self._current = None
        self.append(data)

    def span(self) -> _Span:
        """The output as it is now. Spans stay valid however the log changes later."""
        if self._current is None:
            end = len(self._segments)
            self._current = _Span(self._segments, self._fills, self._start, self._start_offset, end, self._fills[end - 1] if end else 0, self.size)
        return self._current

    def read(self, span: _Span | None = None) -> bytes:
        span = span if span is not None else self.span()
        if self._cache is not None and self._cache[0] is span:
            return self._cache[1]
        parts: list[memoryview] = []
        for i in range(span.start, span.end):
            start = span.start_offset if i == span.start else 0
            end = span.end_fill if i == span.end - 1 else span.fills[i]
            parts.append(memoryview(span.segments[i])[start:end])
        out = b"".join(parts)
        self._cache = (span, out)
        return out

    def _drop(self) -> None:
        """Drop output from the front past the cap."""
        excess = self.size - self._max
        if excess <= 0:
            return
        self.size -= excess
        while excess > 0:
            available = self._fills[self._start] - self._start_offset
            if available <= excess:
                excess -= available
                self._start += 1
                self._start_offset = 0
            else:
                self._start_offset += excess
                excess = 0
        # New lists once most entries are dropped: spans keep the old ones.
        if self._start > 32 and self._start * 2 > len(self._segments):
            self._segments = self._segments[self._start :]
            self._fills = self._fills[self._start :]
            self._start = 0


class _LazyOutput(Lazy):
    """A terminal's output, read from its log when asked for."""

    __slots__ = ("log", "span")

    def __init__(self, log: _OutputLog, span: _Span | None) -> None:
        self.log = log
        #: None: the output as it is now (a live terminal's, read each time).
        self.span = span

    @property
    def once(self) -> bool:  # type: ignore[override]
        return self.span is not None

    def read(self) -> bytes:
        return self.log.read(self.span)


class _OutputField(LazyField):
    """`TerminalState.output`: bytes, or read from the terminal's log when looked at.

    Assigning to a live terminal's output replaces what is kept, as a `terminal_update`
    with output does; on a snapshot it sets the snapshot's own bytes.
    """

    def __set__(self, obj: Any, value: Any) -> None:
        current = obj.__dict__.get("output")
        if isinstance(current, _LazyOutput) and current.span is None:
            current.log.reset(bytes(value))
        else:
            obj.__dict__["output"] = value


@dataclass
class TerminalState:
    id: str
    #: Every byte the agent wants shown, so far (the last million by default). Joined
    #: from the stored chunks when read, so an event's snapshot costs nothing until
    #: you look.
    output: bytes = b""
    command: str | None = None
    #: Absolute.
    cwd: str | None = None
    #: The size the command runs with, in character cells.
    size: TerminalSize | None = None
    #: Present once the command has exited.
    exit_status: TerminalExit | None = None
    #: The agent lets the client stop it (`session.cancel_terminal()`).
    cancellable: bool = False

    def snapshot(self) -> TerminalState:
        """A copy that later updates do not change. Output kept in a log is not copied."""
        copy = TerminalState(self.id, b"", self.command, self.cwd, self.size, self.exit_status, self.cancellable)
        source = stored(self, "output", b"")
        if isinstance(source, _LazyOutput):
            source = _LazyOutput(source.log, source.span if source.span is not None else source.log.span())
        copy.__dict__["output"] = source
        return copy


# The dataclass keeps `output` as an init argument and field; reads go through the log.
setattr(TerminalState, "output", _OutputField("output", b""))


def _bytes(data: Any) -> bytes:
    """RFC 4648 base64 to bytes. Undecodable data gives no bytes."""
    if not isinstance(data, str):
        return b""
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return b""


def terminal_text(terminal: TerminalState) -> str:
    """The output as text, for a transcript (invalid UTF-8 becomes U+FFFD; escape sequences are kept)."""
    return terminal.output.decode("utf-8", errors="replace")


@dataclass(frozen=True)
class AppliedTerminal:
    terminal: TerminalState
    replaced: bool
    appended: bytes | None = None


class Terminals:
    def __init__(self, max_bytes: int = 1_000_000) -> None:
        self._by_id: dict[str, TerminalState] = {}
        self._logs: dict[str, _OutputLog] = {}
        #: Bytes kept per terminal; older output is dropped from the front past this.
        self._max = max_bytes

    def get(self, terminal_id: str) -> TerminalState | None:
        return self._by_id.get(terminal_id)

    @property
    def all(self) -> list[TerminalState]:
        return list(self._by_id.values())

    def storage(self, terminal_id: str) -> tuple[int, int, int] | None:
        """(bytes, segments, capacity) of a terminal's stored output, for tests."""
        log = self._logs.get(terminal_id)
        return (log.size, *log.stats()) if log is not None else None

    def __len__(self) -> int:
        return len(self._by_id)

    def __iter__(self):
        return iter(list(self._by_id.values()))

    def apply(self, update: dict[str, Any]) -> AppliedTerminal | None:
        """Apply a `terminal_update` or `terminal_output_chunk`.

        Returns the terminal after it and, for a chunk, the bytes appended; None if the
        update had no `terminalId`.
        """
        terminal_id = update.get("terminalId")
        if not isinstance(terminal_id, str) or not terminal_id:
            return None
        terminal = self._by_id.get(terminal_id)
        log = self._logs.get(terminal_id)
        if terminal is None or log is None:
            log = _OutputLog(self._max)
            terminal = TerminalState(id=terminal_id)
            terminal.__dict__["output"] = _LazyOutput(log, None)
            self._by_id[terminal_id] = terminal
            self._logs[terminal_id] = log
        if update.get("sessionUpdate") == "terminal_output_chunk":
            appended = _bytes(update.get("data"))
            log.append(appended)
            return AppliedTerminal(terminal, False, appended)
        # terminal_update: an omitted field is unchanged, null clears it, a value replaces it.
        if "command" in update:
            terminal.command = update["command"] if isinstance(update["command"], str) else None
        if "cwd" in update:
            terminal.cwd = update["cwd"] if isinstance(update["cwd"], str) else None
        if "size" in update:
            size = update["size"]
            ok = isinstance(size, dict) and isinstance(size.get("cols"), int) and isinstance(size.get("rows"), int)
            terminal.size = TerminalSize(size["cols"], size["rows"]) if ok else None
        replaced = False
        if "output" in update:
            # A snapshot replaces everything kept so far.
            output = update["output"]
            log.reset(_bytes(output.get("data")) if isinstance(output, dict) else b"")
            replaced = True
        if "exitStatus" in update:
            status = update["exitStatus"]
            terminal.exit_status = (
                TerminalExit(
                    exit_code=status["exitCode"] if isinstance(status.get("exitCode"), int) and not isinstance(status.get("exitCode"), bool) else None,
                    signal=status["signal"] if isinstance(status.get("signal"), str) else None,
                )
                if isinstance(status, dict)
                else None
            )
        # capabilities: null clears, an object replaces.
        if "capabilities" in update:
            caps = update["capabilities"]
            terminal.cancellable = isinstance(caps, dict) and caps.get("cancel") is not None
        return AppliedTerminal(terminal, replaced)
