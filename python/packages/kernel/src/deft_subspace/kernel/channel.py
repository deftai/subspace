"""Channels: read what the other side sent, send what you send.

Bytes on the edges (stdio, sockets), structured messages in process.

    message = await channel.receive()   # raises EndOfChannel when the other side has ended
    await channel.send(message)
    await channel.close()               # end our side; the other side reads EndOfChannel

A channel may also have `abort()`: close at once, dropping unsent data. The
peer uses it when a write is stuck; without it, it calls `close()`.

`channel_pair()` connects two in-process ends; `stream_channel()` wraps
asyncio streams; `pipe_channel()` applies a transform to each direction (that
is how `ndjson()` turns bytes into JSON values).
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator, Iterable
from typing import Any, Generic, Protocol, TypeVar

T = TypeVar("T")
A = TypeVar("A")
B = TypeVar("B")
In = TypeVar("In", contravariant=True)
Out = TypeVar("Out", covariant=True)


class EndOfChannel(Exception):
    """The other side ended its stream: nothing more will arrive."""


class ChannelClosed(Exception):
    """Sending on a channel whose sending side was closed (or whose reader went away)."""


class Channel(Protocol[T]):
    async def receive(self) -> T:
        """The next item. Raises `EndOfChannel` once the other side has ended."""
        ...

    async def send(self, item: T) -> None:
        """Send an item, in order with earlier sends. Raises `ChannelClosed` when it cannot."""
        ...

    async def close(self) -> None:
        """End this side's stream. Idempotent."""
        ...


async def iterate(channel: Channel[T]) -> AsyncIterator[T]:
    """Every item until the other side ends."""
    while True:
        try:
            yield await channel.receive()
        except EndOfChannel:
            return


class _Pipe(Generic[T]):
    """One direction: items in order, then the end."""

    def __init__(self) -> None:
        self.items: deque[T] = deque()
        self.ended = False
        # Every receive() waiting for an item. All are woken; each takes one or waits again.
        self.waiters: list[asyncio.Future[None]] = []

    def put(self, item: T) -> None:
        if self.ended:
            raise ChannelClosed("channel closed")
        self.items.append(item)
        self._wake()

    def end(self) -> None:
        self.ended = True
        self._wake()

    def _wake(self) -> None:
        waiters, self.waiters = self.waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)

    async def get(self) -> T:
        while not self.items:
            if self.ended:
                raise EndOfChannel()
            waiter = asyncio.get_running_loop().create_future()
            self.waiters.append(waiter)
            try:
                await waiter
            finally:
                if waiter in self.waiters:
                    self.waiters.remove(waiter)
        return self.items.popleft()


class MemoryChannel(Generic[T]):
    """One end of an in-process pair."""

    def __init__(self, inbox: _Pipe[T], outbox: _Pipe[T]) -> None:
        self._inbox = inbox
        self._outbox = outbox

    async def receive(self) -> T:
        return await self._inbox.get()

    async def send(self, item: T) -> None:
        self._outbox.put(item)

    async def close(self) -> None:
        self._outbox.end()

    async def abort(self) -> None:
        self._outbox.end()


def channel_pair() -> tuple[MemoryChannel[Any], MemoryChannel[Any]]:
    """Two connected channels in one process: what `a` sends, `b` receives, and the other way round.

    No bytes, no JSON. Use it to run a client and an agent together in tests or in one app.
    """
    a_to_b: _Pipe[Any] = _Pipe()
    b_to_a: _Pipe[Any] = _Pipe()
    return MemoryChannel(b_to_a, a_to_b), MemoryChannel(a_to_b, b_to_a)


class StreamChannel:
    """asyncio streams (a socket, a child's stdio) as a byte channel."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter | Any, *, chunk_size: int = 65536) -> None:
        self._reader = reader
        self._writer = writer
        self._chunk = chunk_size
        self._closed = False

    async def receive(self) -> bytes:
        data = await self._reader.read(self._chunk)
        if not data:
            raise EndOfChannel()
        return data

    async def send(self, item: bytes) -> None:
        if self._closed or self._writer.is_closing():
            raise ChannelClosed("stream closed")
        try:
            self._writer.write(item)
            await self._writer.drain()
        except (ConnectionError, RuntimeError) as error:  # BrokenPipe, reset, closed transport
            raise ChannelClosed(str(error)) from error

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._writer.can_write_eof():
                self._writer.write_eof()
            else:
                self._writer.close()
        except (OSError, RuntimeError):
            pass

    async def abort(self) -> None:
        """Close at once, dropping anything not yet written."""
        self._closed = True
        transport = getattr(self._writer, "transport", None)
        try:
            if transport is not None:
                transport.abort()
            else:
                self._writer.close()
        except (OSError, RuntimeError):
            pass


def stream_channel(reader: asyncio.StreamReader, writer: asyncio.StreamWriter | Any) -> StreamChannel:
    return StreamChannel(reader, writer)


class Transform(Protocol[In, Out]):
    """Turns items into items, keeping state between them (a decoder, a re-chunker)."""

    def feed(self, item: In, /) -> Iterable[Out]: ...

    def flush(self) -> Iterable[Out]:
        """What is left once the input has ended."""
        ...


class _Piped(Generic[A, B]):
    def __init__(self, channel: Channel[A], read: Transform[A, B], write: Transform[B, A]) -> None:
        self._channel = channel
        self._read = read
        self._write = write
        self._ready: deque[B] = deque()
        self._ended = False

    async def receive(self) -> B:
        while not self._ready:
            if self._ended:
                raise EndOfChannel()
            try:
                item = await self._channel.receive()
            except EndOfChannel:
                self._ended = True
                self._ready.extend(self._read.flush())
                continue
            self._ready.extend(self._read.feed(item))
        return self._ready.popleft()

    async def send(self, item: B) -> None:
        for out in self._write.feed(item):
            await self._channel.send(out)

    async def close(self) -> None:
        try:
            for out in self._write.flush():
                await self._channel.send(out)
        except ChannelClosed:
            pass
        await self._channel.close()

    async def abort(self) -> None:
        abort = getattr(self._channel, "abort", None)
        await (abort() if abort is not None else self._channel.close())


def pipe_channel(channel: Channel[A], *, read: Transform[A, B], write: Transform[B, A]) -> Channel[B]:
    """Apply a transform to each direction of a channel."""
    return _Piped(channel, read, write)


class Identity(Generic[T]):
    def feed(self, item: T) -> Iterable[T]:
        return (item,)

    def flush(self) -> Iterable[T]:
        return ()
