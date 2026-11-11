"""Time, as something tests can control.

Every timer in the kernel goes through a Clock, so a test can fake it and
check timeout behaviour without waiting. Times are milliseconds.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any, Protocol


class Clock(Protocol):
    def now(self) -> float:
        """Milliseconds since the epoch."""
        ...

    def set_timeout(self, callback: Callable[[], None], ms: float) -> Any:
        """Run `callback` after `ms`; returns a handle for `clear_timeout`."""
        ...

    def clear_timeout(self, handle: Any) -> None: ...


class SystemClock:
    def now(self) -> float:
        return time.time() * 1000

    def set_timeout(self, callback: Callable[[], None], ms: float) -> asyncio.TimerHandle:
        return asyncio.get_running_loop().call_later(max(0.0, ms) / 1000, callback)

    def clear_timeout(self, handle: Any) -> None:
        if handle is not None:
            handle.cancel()


system_clock: Clock = SystemClock()
