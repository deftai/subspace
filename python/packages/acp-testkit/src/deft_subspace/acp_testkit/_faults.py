"""Faults to put on a channel, to see how a peer copes with a bad wire.

    flaky = fault_channel(client_end, read=[delay(5), close_when(is_update("agent_message_chunk"))])

Message faults (`delay`, `disconnect_after`, `close_when`) work on any channel,
counting items; on a byte channel an item is a chunk, not a message. Byte
faults (`rechunk`, `merge`, `coalesce`, `inject_lines`) go below `ndjson()`.
The kernel's `merge(n)` holds chunks until it has `n`, so it stalls a
conversation; use `coalesce(ms)` there. Any kernel `Transform` (an object with
`feed()` and `flush()`) can be used as a fault too.

Each direction runs its faults in order, each in its own task, with a queue
between them, as TypeScript's `pipeThrough` does: a fault that holds an item
(`delay`) holds the ones behind it, and a fault that ends the stream ends
everything after it.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable, Sequence
from typing import Any, Generic, Protocol, TypeVar, runtime_checkable

from deft_subspace.kernel import Channel, ChannelClosed, EndOfChannel
from deft_subspace.kernel.testing import merge, rechunk

T = TypeVar("T")

__all__ = [
    "Fault",
    "FaultController",
    "close_when",
    "coalesce",
    "delay",
    "disconnect_after",
    "fault_channel",
    "inject_lines",
    "is_update",
    "merge",
    "rechunk",
]


class FaultController(Generic[T]):
    """What a fault may do with its stream: pass items on, or end it."""

    def __init__(self, out: asyncio.Queue[Any]) -> None:
        self._out = out
        self._terminated = False

    @property
    def terminated(self) -> bool:
        return self._terminated

    def enqueue(self, item: T) -> None:
        """Pass an item on. Raises ChannelClosed once the stream has ended."""
        if self._terminated:
            raise ChannelClosed("the stream was ended by a fault")
        self._out.put_nowait(item)

    def terminate(self) -> None:
        """End the stream after what was passed on, as a dropped connection would."""
        if not self._terminated:
            self._terminated = True
            self._out.put_nowait(_END)


@runtime_checkable
class Fault(Protocol[T]):
    """A fault: `transform(item, controller)` for each item (plain or async), and optionally
    `start(controller)` and `flush(controller)` (at the end of the input)."""

    def transform(self, item: T, controller: FaultController[T], /) -> Any: ...


class _Transform(Protocol):
    def feed(self, item: Any, /) -> Any: ...

    def flush(self) -> Any: ...


class _FromTransform:
    """A kernel Transform (feed/flush), such as `rechunk()` and `merge()`, as a fault."""

    def __init__(self, transform: _Transform) -> None:
        self._t = transform

    def transform(self, item: Any, controller: FaultController[Any]) -> None:
        for out in self._t.feed(item):
            controller.enqueue(out)

    def flush(self, controller: FaultController[Any]) -> None:
        for out in self._t.flush():
            controller.enqueue(out)


class _End:
    def __repr__(self) -> str:
        return "END"


_END: Any = _End()


def _retrieve(task: asyncio.Future[Any]) -> None:
    if not task.cancelled():
        task.exception()


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _as_fault(fault: Any) -> Any:
    if hasattr(fault, "transform"):
        return fault
    if hasattr(fault, "feed") and hasattr(fault, "flush"):
        return _FromTransform(fault)
    raise TypeError(f"not a fault: {fault!r} (needs transform(), or feed() and flush())")


class _Pipeline:
    """Faults in a row, each in its own task, joined by queues. `put()` feeds the first;
    `get()` reads what the last passed on (`_END` once it has ended)."""

    def __init__(self, faults: Sequence[Any]) -> None:
        self._faults = [_as_fault(f) for f in faults]
        self._queues: list[asyncio.Queue[Any]] = [asyncio.Queue() for _ in range(len(self._faults) + 1)]
        self._tasks: list[asyncio.Task[None]] = []
        #: Set when a fault ended the stream: nothing more is taken in.
        self.stopped = asyncio.Event()
        self._started = False
        self._input_ended = False

    def _start(self) -> None:
        if self._started:
            return
        self._started = True
        for index, fault in enumerate(self._faults):
            self._tasks.append(asyncio.ensure_future(self._run(fault, self._queues[index], self._queues[index + 1])))

    async def _run(self, fault: Any, inbox: asyncio.Queue[Any], outbox: asyncio.Queue[Any]) -> None:
        controller: FaultController[Any] = FaultController(outbox)
        try:
            start = getattr(fault, "start", None)
            if start is not None:
                await _maybe(start(controller))
            while not controller.terminated:
                item = await inbox.get()
                if item is _END:
                    flush = getattr(fault, "flush", None)
                    if flush is not None:
                        await _maybe(flush(controller))
                    break
                await _maybe(fault.transform(item, controller))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a broken fault ends its stream, like an errored TransformStream
            pass
        finally:
            if controller.terminated or not self._input_ended:
                self.stopped.set()
            controller.terminate()

    def put(self, item: Any) -> None:
        self._start()
        self._queues[0].put_nowait(item)

    def end(self) -> None:
        if not self._input_ended:
            self._input_ended = True
            self.put(_END)

    async def get(self) -> Any:
        self._start()
        return await self._queues[-1].get()

    def cancel(self) -> None:
        for task in self._tasks:
            task.cancel()


class FaultyChannel(Generic[T]):
    """A channel whose reads and writes go through faults. Made by `fault_channel()`."""

    def __init__(self, channel: Channel[T], read: Sequence[Any], write: Sequence[Any]) -> None:
        self._channel = channel
        self._read = _Pipeline(read) if read else None
        self._write = _Pipeline(write) if write else None
        self._source: asyncio.Task[None] | None = None
        self._sink: asyncio.Task[None] | None = None
        self._read_ended = False
        self._write_ended = False
        self._closing: asyncio.Future[None] | None = None

    # ---- reading -----------------------------------------------------------------

    async def _pump_in(self, pipeline: _Pipeline) -> None:
        async def stop_when_ended() -> None:
            await pipeline.stopped.wait()

        stopper = asyncio.ensure_future(stop_when_ended())
        try:
            while not pipeline.stopped.is_set():
                receive = asyncio.ensure_future(self._channel.receive())
                # Read below when it matters; once the stream has ended, what it read is dropped.
                receive.add_done_callback(_retrieve)
                done, _ = await asyncio.wait({receive, stopper}, return_when=asyncio.FIRST_COMPLETED)
                if receive not in done:
                    receive.cancel()
                    return
                try:
                    item = receive.result()
                except EndOfChannel:
                    break
                except Exception:  # noqa: BLE001 - a failed read ends the stream
                    break
                pipeline.put(item)
            pipeline.end()
        finally:
            stopper.cancel()

    async def receive(self) -> T:
        if self._read is None:
            return await self._channel.receive()
        if self._read_ended:
            raise EndOfChannel()
        if self._source is None:
            self._source = asyncio.ensure_future(self._pump_in(self._read))
        item = await self._read.get()
        if item is _END:
            self._read_ended = True
            raise EndOfChannel()
        return item

    # ---- writing -----------------------------------------------------------------

    async def _pump_out(self, pipeline: _Pipeline) -> None:
        try:
            while True:
                item = await pipeline.get()
                if item is _END:
                    break
                try:
                    await self._channel.send(item)
                except Exception:  # noqa: BLE001 - the other side is gone; later sends fail here
                    self._write_ended = True
                    pipeline.stopped.set()
                    return
        finally:
            self._write_ended = True
        try:
            await self._channel.close()
        except Exception:  # noqa: BLE001
            pass

    async def send(self, item: T) -> None:
        if self._write is None:
            await self._channel.send(item)
            return
        if self._write_ended or self._write.stopped.is_set() or self._closing is not None:
            raise ChannelClosed("channel closed")
        if self._sink is None:
            self._sink = asyncio.ensure_future(self._pump_out(self._write))
        self._write.put(item)

    async def close(self) -> None:
        """End the writing side: what the faults hold is passed on first."""
        if self._write is None:
            await self._channel.close()
            return
        if self._closing is None:
            self._closing = asyncio.ensure_future(self._close_write(self._write))
        await asyncio.shield(self._closing)

    async def _close_write(self, pipeline: _Pipeline) -> None:
        if self._sink is None:
            self._sink = asyncio.ensure_future(self._pump_out(pipeline))
        pipeline.end()
        await self._sink

    async def abort(self) -> None:
        """Close at once, dropping what the faults hold."""
        for pipeline in (self._read, self._write):
            if pipeline is not None:
                pipeline.cancel()
        for task in (self._source, self._sink):
            if task is not None:
                task.cancel()
        self._write_ended = True
        abort = getattr(self._channel, "abort", None)
        try:
            await (abort() if abort is not None else self._channel.close())
        except Exception:  # noqa: BLE001
            pass


def fault_channel(channel: Channel[T], *, read: Sequence[Any] = (), write: Sequence[Any] = ()) -> Channel[T]:
    """Apply faults, in order, to what is received from and sent to a channel."""
    return FaultyChannel(channel, read, write)


class _Coalesce:
    def __init__(self, ms: float) -> None:
        self._ms = ms
        self._held: list[bytes] = []
        self._timer: asyncio.TimerHandle | None = None

    def _release(self, controller: FaultController[bytes]) -> None:
        if self._timer is not None:
            self._timer.cancel()
        self._timer = None
        if not self._held:
            return
        out = b"".join(self._held)
        self._held = []
        try:
            controller.enqueue(out)
        except ChannelClosed:
            pass  # the stream was ended meanwhile

    def transform(self, chunk: bytes, controller: FaultController[bytes]) -> None:
        self._held.append(chunk)
        if self._timer is None:
            self._timer = asyncio.get_running_loop().call_later(self._ms / 1000, self._release, controller)

    def flush(self, controller: FaultController[bytes]) -> None:
        self._release(controller)


def coalesce(ms: float) -> Fault[bytes]:
    """Merge the chunks that arrive within `ms` of the first into one."""
    return _Coalesce(ms)


class _Delay(Generic[T]):
    def __init__(self, ms: float | Callable[[T], float]) -> None:
        self._ms = ms

    async def transform(self, item: T, controller: FaultController[T]) -> None:
        wait = self._ms(item) if callable(self._ms) else self._ms
        if wait > 0:
            await asyncio.sleep(wait / 1000)
        controller.enqueue(item)


def delay(ms: float | Callable[[Any], float]) -> Fault[Any]:
    """Hold each item for `ms` (or `ms(item)`) milliseconds before passing it on. Order is kept."""
    return _Delay(ms)


class _DisconnectAfter:
    def __init__(self, count: int) -> None:
        self._count = count
        self._passed = 0

    def start(self, controller: FaultController[Any]) -> None:
        if self._count <= 0:
            controller.terminate()

    def transform(self, item: Any, controller: FaultController[Any]) -> None:
        controller.enqueue(item)
        self._passed += 1
        if self._passed >= self._count:
            controller.terminate()


def disconnect_after(count: int) -> Fault[Any]:
    """Pass `count` items, then end the stream as a dropped connection would."""
    return _DisconnectAfter(count)


class _CloseWhen:
    def __init__(self, matches: Callable[[Any], bool], including: bool) -> None:
        self._matches = matches
        self._including = including

    def transform(self, item: Any, controller: FaultController[Any]) -> None:
        if not self._matches(item):
            controller.enqueue(item)
            return
        if self._including:
            controller.enqueue(item)
        controller.terminate()


def close_when(matches: Callable[[Any], bool], *, including: bool = True) -> Fault[Any]:
    """End the stream at the first item that matches, e.g. mid-turn. `including` (default)
    passes the matching item first."""
    return _CloseWhen(matches, including)


def is_update(kind: str | None = None) -> Callable[[Any], bool]:
    """Matches a `session/update` message of the given kind (any kind if omitted)."""

    def matches(message: Any) -> bool:
        if not isinstance(message, dict) or message.get("method") != "session/update":
            return False
        if kind is None:
            return True
        params = message.get("params")
        update = params.get("update") if isinstance(params, dict) else None
        return isinstance(update, dict) and update.get("sessionUpdate") == kind

    return matches


class _InjectLines:
    def __init__(self, noise: bytes, every: int) -> None:
        self._noise = noise
        self._every = every
        self._started = False
        self._newlines = 0

    def transform(self, chunk: bytes, controller: FaultController[bytes]) -> None:
        if not self._started:
            self._started = True
            controller.enqueue(self._noise)
        start = 0
        at = chunk.find(b"\n")
        while at != -1:
            self._newlines += 1
            if self._newlines % self._every == 0:
                controller.enqueue(chunk[start : at + 1])
                controller.enqueue(self._noise)
                start = at + 1
            at = chunk.find(b"\n", at + 1)
        if start < len(chunk):
            controller.enqueue(chunk[start:])


def inject_lines(lines: Sequence[str] = ("Welcome to the agent!", "warning: not JSON"), *, every: int = 1) -> Fault[bytes]:
    """Put lines that are not JSON (banners, logs) into a byte stream: before the first chunk,
    and after every `every`-th newline. A good reader skips them."""
    # 0 would never inject: say so instead.
    if isinstance(every, bool) or not isinstance(every, int) or every < 1:
        raise ValueError(f"inject_lines: every must be a whole number of at least 1, not {every}")
    return _InjectLines("".join(f"{line}\n" for line in lines).encode("utf-8"), every)
