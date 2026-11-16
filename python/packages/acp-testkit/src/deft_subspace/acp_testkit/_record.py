"""Recording: keep a connection's traffic as a kernel trace (JSON Lines).

    rec = recorder(peer="client", label="plain turn")
    client = await AcpClient.connect(channel, tap=rec.tap)
    ...
    Path("plain.trace.jsonl").write_text(rec.text())

For a channel without an RpcPeer (an official-SDK peer, a proxy), wrap the
channel instead: `tap_channel(channel, rec.tap)`.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, Generic, Literal, TypeVar

from deft_subspace.kernel import Channel, TraceRecord, TraceTap, format_trace, trace_tap

T = TypeVar("T")
Direction = Literal["in", "out"]
_NO_DATA: Any = object()


class Recorder:
    """A trace being recorded: pass `tap` to an RpcPeer, an AcpClient, or `tap_channel()`."""

    def __init__(self, **options: Any) -> None:
        #: Header first, then one record per message or note, as they happen.
        self.records: list[TraceRecord] = []
        self.tap: TraceTap = trace_tap(self.records.append, **options)

    def note(self, text: str, data: Any = _NO_DATA) -> None:
        """Add a note at the current time. `data=None` is recorded as null; leave it out for no data."""
        if data is _NO_DATA:
            self.tap.note(text)
        else:
            self.tap.note(text, data)

    def text(self) -> str:
        """The trace as JSON Lines."""
        return format_trace(self.records)

    def __repr__(self) -> str:
        return f"<Recorder {len(self.records)} records>"


def recorder(
    *,
    peer: str,
    label: str | None = None,
    meta: dict[str, Any] | None = None,
    redact: Callable[[Any, Direction], Any] | None = None,
    clock: Any = None,
) -> Recorder:
    """A recorder writing records as the `peer` side sees them ("client" or "agent")."""
    return Recorder(peer=peer, label=label, meta=meta, redact=redact, clock=clock)


class TappedChannel(Generic[T]):
    """A channel that reports every message to `tap`."""

    def __init__(self, channel: Channel[T], tap: Callable[[Direction, T], Any]) -> None:
        self._channel = channel
        self._tap = tap

    def _observe(self, direction: Direction, message: T) -> None:
        try:
            self._tap(direction, message)
        except Exception:  # noqa: BLE001 - taps observe; they never change the traffic
            pass

    async def receive(self) -> T:
        message = await self._channel.receive()
        self._observe("in", message)
        return message

    async def send(self, item: T) -> None:
        self._observe("out", item)
        await self._channel.send(item)

    async def close(self) -> None:
        await self._channel.close()

    async def abort(self) -> None:
        abort = getattr(self._channel, "abort", None)
        await (abort() if abort is not None else self._channel.close())


def tap_channel(channel: Channel[T], tap: Callable[[Direction, T], Any]) -> Channel[T]:
    """A channel that reports every message to `tap`: what is received is `in`, what is
    sent is `out`, as seen by whoever holds the returned channel. A tap that raises is ignored."""
    return TappedChannel(channel, tap)


def replace_strings(pairs: Iterable[tuple[str | re.Pattern[str], str]]) -> Callable[..., Any]:
    """A `redact` function for `recorder()`: replaces every occurrence of each string (or
    compiled pattern, every match) in every string of a message, e.g. a temp directory or a
    home path, so traces can be committed."""
    rules = list(pairs)

    def fix(text: str) -> str:
        for old, new in rules:
            if isinstance(old, str):
                if old:
                    text = text.replace(old, new)
            else:
                text = old.sub(new, text)
        return text

    def walk(value: Any) -> Any:
        if isinstance(value, str):
            return fix(value)
        if isinstance(value, list):
            return [walk(v) for v in value]
        if isinstance(value, dict):
            return {k: walk(v) for k, v in value.items()}
        return value

    def redact(message: Any, _direction: Direction | None = None) -> Any:
        return walk(message)

    return redact


def redact_keys(keys: Iterable[str], replacement: Any = "[redacted]") -> Callable[..., Any]:
    """A `redact` function that replaces the value of every property with one of these names, at any depth."""
    names = set(keys)

    def walk(value: Any) -> Any:
        if isinstance(value, list):
            return [walk(v) for v in value]
        if isinstance(value, dict):
            return {k: replacement if k in names else walk(v) for k, v in value.items()}
        return value

    def redact(message: Any, _direction: Direction | None = None) -> Any:
        return walk(message)

    return redact


def messages_of(records: Sequence[Mapping[str, Any]], as_peer: str | None = None) -> list[dict[str, Any]]:
    """The message records of a trace as `{"t", "dir", "msg"}`, flipped to `as_peer`'s view if
    the trace was recorded by the other side."""
    header = records[0] if records and records[0].get("kind") == "header" else None
    flip = as_peer is not None and header is not None and header.get("peer") != as_peer
    out: list[dict[str, Any]] = []
    for r in records:
        if r.get("kind") != "message":
            continue
        direction = r.get("dir")
        if flip:
            direction = "out" if direction == "in" else "in"
        out.append({"t": r.get("t", 0), "dir": direction, "msg": r.get("msg")})
    return out
