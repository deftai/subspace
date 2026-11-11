"""NDJSON: one JSON value per line, over a byte channel."""

from __future__ import annotations

import codecs
import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

from .channel import Channel, pipe_channel


@dataclass(frozen=True)
class FramingDiagnostic:
    """Something on the wire that was skipped instead of delivered."""

    kind: Literal["invalid-json", "too-large"]
    #: Size of the skipped line in characters (close to bytes for ASCII).
    size: int
    #: The start of the skipped line, for logs. At most 200 characters.
    preview: str
    error: BaseException | None = None


DEFAULT_MAX_LINE = 32 * 1024 * 1024


def _no_constant(name: str) -> Any:
    # NaN and Infinity are not JSON.
    raise ValueError(f"{name} is not JSON")


class NdjsonDecoder:
    """Split bytes into JSON values, one per line.

    - UTF-8 is decoded incrementally, so a character split across chunks survives.
    - Each byte is looked at a bounded number of times, so long lines cost O(n).
    - Lines that are not JSON are skipped and reported, not fatal.
    - CRLF line endings and blank lines are accepted.
    """

    def __init__(
        self,
        *,
        max_line_length: int = DEFAULT_MAX_LINE,
        on_diagnostic: Callable[[FramingDiagnostic], None] | None = None,
    ) -> None:
        self._max = max_line_length
        self._on_diagnostic = on_diagnostic
        # utf-8-sig: a byte order mark at the very start is skipped, as TextDecoder does.
        self._decoder = codecs.getincrementaldecoder("utf-8-sig")(errors="replace")
        self._pieces: list[str] = []
        self._pending = 0
        self._skipping = False  # inside an over-long line; drop until the next newline

    def _report(self, diagnostic: FramingDiagnostic) -> None:
        if self._on_diagnostic is None:
            return
        try:
            self._on_diagnostic(diagnostic)
        except Exception:  # noqa: BLE001 - a broken diagnostics hook must not break the stream
            pass

    def _emit(self, line: str, out: list[Any]) -> None:
        text = line[:-1] if line.endswith("\r") else line
        if not text.strip():
            return
        try:
            out.append(json.loads(text, parse_constant=_no_constant))
        except ValueError as error:
            self._report(FramingDiagnostic("invalid-json", len(text), text[:200], error))

    def _take(self, text: str, out: list[Any]) -> None:
        start = 0
        while True:
            newline = text.find("\n", start)
            if newline == -1:
                break
            tail = text[start:newline]
            if self._skipping:
                self._skipping = False
            elif self._pending + len(tail) > self._max:
                first = self._pieces[0] if self._pieces else tail
                self._report(FramingDiagnostic("too-large", self._pending + len(tail), first[:200]))
            else:
                self._emit("".join(self._pieces) + tail if self._pieces else tail, out)
            self._pieces = []
            self._pending = 0
            start = newline + 1
        rest = text[start:]
        if rest and not self._skipping:
            if self._pending + len(rest) > self._max:
                first = self._pieces[0] if self._pieces else rest
                self._report(FramingDiagnostic("too-large", self._pending + len(rest), first[:200]))
                self._pieces = []
                self._pending = 0
                self._skipping = True
            else:
                self._pieces.append(rest)
                self._pending += len(rest)

    def feed(self, chunk: bytes) -> list[Any]:
        out: list[Any] = []
        self._take(self._decoder.decode(chunk), out)
        return out

    def flush(self) -> list[Any]:
        out: list[Any] = []
        self._take(self._decoder.decode(b"", final=True), out)
        # A final line without a newline still counts.
        if not self._skipping and self._pieces:
            self._emit("".join(self._pieces), out)
            self._pieces = []
            self._pending = 0
        return out


class NdjsonEncoder:
    """JSON values as lines of UTF-8. A value that cannot be serialized is dropped and reported."""

    def __init__(self, *, on_error: Callable[[BaseException, Any], None] | None = None) -> None:
        self._on_error = on_error

    def feed(self, value: Any) -> Iterable[bytes]:
        try:
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError, RecursionError) as error:
            if self._on_error is not None:
                self._on_error(error, value)
            return ()
        return ((text + "\n").encode("utf-8"),)

    def flush(self) -> Iterable[bytes]:
        return ()


def ndjson_decoder(
    *, max_line_length: int = DEFAULT_MAX_LINE, on_diagnostic: Callable[[FramingDiagnostic], None] | None = None
) -> NdjsonDecoder:
    return NdjsonDecoder(max_line_length=max_line_length, on_diagnostic=on_diagnostic)


def ndjson_encoder(*, on_error: Callable[[BaseException, Any], None] | None = None) -> NdjsonEncoder:
    return NdjsonEncoder(on_error=on_error)


def ndjson(
    channel: Channel[bytes],
    *,
    max_line_length: int = DEFAULT_MAX_LINE,
    on_diagnostic: Callable[[FramingDiagnostic], None] | None = None,
) -> Channel[Any]:
    """A byte channel (stdio, a socket) as a channel of JSON values."""
    return pipe_channel(
        channel,
        read=NdjsonDecoder(max_line_length=max_line_length, on_diagnostic=on_diagnostic),
        write=NdjsonEncoder(),
    )
