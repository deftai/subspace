"""Test helpers: a clock you move by hand, and faults you can put on a byte
stream (tiny chunks, merged chunks) to prove framing does not care how bytes arrive."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable
from typing import Any


class ManualClock:
    def __init__(self, start: float = 0) -> None:
        self._now = start
        self._next = 1
        self._timers: dict[int, tuple[float, Callable[[], None]]] = {}

    def now(self) -> float:
        return self._now

    def set_timeout(self, callback: Callable[[], None], ms: float) -> int:
        handle = self._next
        self._next += 1
        self._timers[handle] = (self._now + max(0, ms), callback)
        return handle

    def clear_timeout(self, handle: Any) -> None:
        self._timers.pop(handle, None)

    def advance(self, ms: float) -> None:
        """Move time forward, running every timer that comes due, in order."""
        target = self._now + ms
        while True:
            due = [(at, handle) for handle, (at, _cb) in self._timers.items() if at <= target]
            if not due:
                break
            at, handle = min(due)
            _at, callback = self._timers.pop(handle)
            self._now = at
            callback()
        self._now = target

    @property
    def pending_timers(self) -> int:
        return len(self._timers)


def manual_clock(start: float = 0) -> ManualClock:
    return ManualClock(start)


class Rechunk:
    """Re-chunk bytes into pieces of `size` bytes (1 = byte by byte)."""

    def __init__(self, size: int) -> None:
        self._size = size

    def feed(self, chunk: bytes) -> Iterable[bytes]:
        return [chunk[i : i + self._size] for i in range(0, len(chunk), self._size)]

    def flush(self) -> Iterable[bytes]:
        return ()


class Merge:
    """Hold bytes and release them merged, every `count` chunks (and at the end)."""

    def __init__(self, count: int) -> None:
        self._count = count
        self._held: list[bytes] = []

    def feed(self, chunk: bytes) -> Iterable[bytes]:
        self._held.append(chunk)
        return self._release() if len(self._held) >= self._count else ()

    def flush(self) -> Iterable[bytes]:
        return self._release()

    def _release(self) -> list[bytes]:
        if not self._held:
            return []
        out = b"".join(self._held)
        self._held = []
        return [out]


def rechunk(size: int) -> Rechunk:
    return Rechunk(size)


def merge(count: int) -> Merge:
    return Merge(count)


async def tick(times: int = 10) -> None:
    """Let pending tasks run (a few loop iterations)."""
    for _ in range(times):
        await asyncio.sleep(0)
