"""Cancellation as a value, like the Web's AbortController and AbortSignal.

asyncio cancels tasks; Subspace also needs to say *why* something stopped and
to let many waiters see one cancel (a turn's cancel answers every open
permission question). A signal fires once, keeps its reason, and runs its
listeners synchronously, in the order they were added.

    controller = AbortController()
    remove = controller.signal.add_listener(lambda reason: print("stopped", reason))
    controller.abort("user pressed stop")
    await controller.signal.wait()   # returns at once now
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable
from typing import Any


class AbortError(Exception):
    """The default reason of a signal aborted without one."""

    def __init__(self, message: str = "This operation was aborted") -> None:
        super().__init__(message)


Listener = Callable[[Any], None]


class AbortSignal:
    __slots__ = ("_aborted", "_reason", "_listeners", "_dispose", "__weakref__")

    def __init__(self) -> None:
        self._aborted = False
        self._reason: Any = None
        self._listeners: list[Listener] = []
        #: For a signal from `any`: removes its listeners from the source signals.
        self._dispose: Callable[[], None] | None = None

    @property
    def aborted(self) -> bool:
        return self._aborted

    @property
    def reason(self) -> Any:
        return self._reason

    def add_listener(self, listener: Listener) -> Callable[[], None]:
        """Call `listener(reason)` once, when the signal fires. Returns a function that removes it.

        On a signal that has already fired, the listener is not called (as on the Web).
        """
        if self._aborted:
            return lambda: None
        self._listeners.append(listener)

        def remove() -> None:
            try:
                self._listeners.remove(listener)
            except ValueError:
                pass

        return remove

    def dispose(self) -> None:
        """Stop following the source signals (a signal from `any`): its listeners on them
        are removed, so a long-lived source does not keep it alive. It will not fire after
        this. A no-op for any other signal, and once it fired."""
        dispose, self._dispose = self._dispose, None
        if dispose is not None:
            dispose()

    def __enter__(self) -> AbortSignal:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.dispose()

    def throw_if_aborted(self) -> None:
        if self._aborted:
            reason = self._reason
            raise reason if isinstance(reason, BaseException) else AbortError(str(reason))

    async def wait(self) -> Any:
        """Wait until the signal fires; returns its reason."""
        if self._aborted:
            return self._reason
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

        def done(reason: Any) -> None:
            if not future.done():
                future.set_result(reason)

        remove = self.add_listener(done)
        try:
            return await future
        finally:
            remove()

    def _fire(self, reason: Any) -> None:
        if self._aborted:
            return
        self._aborted = True
        self._reason = AbortError() if reason is None else reason
        listeners, self._listeners = self._listeners, []
        for listener in listeners:
            try:
                listener(self._reason)
            except Exception:  # noqa: BLE001 - a listener must not stop the others
                pass

    @staticmethod
    def abort(reason: Any = None) -> AbortSignal:
        """A signal that has already fired."""
        signal = AbortSignal()
        signal._fire(reason)
        return signal

    @staticmethod
    def any(signals: Iterable[AbortSignal | None]) -> AbortSignal:
        """A signal that fires when the first of `signals` fires, with its reason.

        It listens on every source until one fires. When you are done with it before
        then, `dispose()` it (or use it as a context manager) so a long-lived source
        does not keep it, and whatever listens on it, alive:

            with AbortSignal.any([turn_signal, connection_signal]) as signal:
                ...
        """
        combined = AbortSignal()
        live = [s for s in signals if s is not None]
        for signal in live:
            if signal.aborted:
                combined._fire(signal.reason)
                return combined
        removers: list[Callable[[], None]] = []

        def dispose() -> None:
            for remove in removers:
                remove()
            removers.clear()

        def fire(reason: Any) -> None:
            combined.dispose()
            combined._fire(reason)

        for signal in live:
            removers.append(signal.add_listener(fire))
        combined._dispose = dispose
        return combined

    @staticmethod
    def timeout(ms: float) -> AbortSignal:
        """A signal that fires after `ms` milliseconds (needs a running loop)."""
        signal = AbortSignal()
        asyncio.get_running_loop().call_later(ms / 1000, lambda: signal._fire(TimeoutError(f"timed out after {ms} ms")))
        return signal

    def __repr__(self) -> str:
        return f"AbortSignal(aborted={self._aborted})"


class AbortController:
    __slots__ = ("signal",)

    def __init__(self) -> None:
        self.signal = AbortSignal()

    def abort(self, reason: Any = None) -> None:
        self.signal._fire(reason)
