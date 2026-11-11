"""A turn: one prompt and everything the agent does about it.

    turn = session.prompt("Fix the failing test")
    async for event in turn:
        render(event)
    result = await turn          # or: await turn.done

- The result is ready only after the last event has been delivered, on v1 and v2.
- Iterate as many times as you like; each iteration starts from the first event.
- Each message, thought and user message is followed by a `*_end` event once
  something else arrives or the turn ends.
- `cancel()` tells the agent, answers its open permission questions with
  `cancelled`, and ends the turn if the agent does not confirm in time.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Generator
from typing import Any

from .handlers import TextTracker, TurnHandlers, dispatch
from .model import (
    MessageEndEvent,
    MessageEvent,
    PermissionEvent,
    PlanEvent,
    TerminalEvent,
    TextEvent,
    ThoughtEndEvent,
    ThoughtEvent,
    ToolCall,
    ToolCallEvent,
    TurnEvent,
    TurnResult,
    UserMessageEndEvent,
    UserMessageEvent,
)

_TEXT = (MessageEvent, ThoughtEvent, UserMessageEvent)
#: What ends an open message: other text, or content. Usage, state, title and other notices do not.
_ENDS = (*_TEXT, ToolCallEvent, PlanEvent, PermissionEvent, TerminalEvent)
_END_OF = {MessageEvent: MessageEndEvent, ThoughtEvent: ThoughtEndEvent, UserMessageEvent: UserMessageEndEvent}


def _handler_error(error: BaseException) -> BaseException:
    """What the turn raises for a failed handler: its error, or, for a cancelled one, an error that
    does not look like the awaiting task being cancelled."""
    if not isinstance(error, asyncio.CancelledError):
        return error
    failure = RuntimeError("A turn handler was cancelled")
    failure.__cause__ = error
    return failure


class TurnView:
    """What the turn knows so far, for `text` and `tool_calls`."""

    def __init__(self, text: Callable[[], str], tool_calls: Callable[[], list[ToolCall]]) -> None:
        self.text = text
        self.tool_calls = tool_calls


class Turn:
    def __init__(
        self,
        turn_id: str,
        on_cancel: Callable[[], Awaitable[None]],
        view: TurnView | None = None,
        spawn: Callable[[Coroutine[Any, Any, Any]], Any] | None = None,
    ) -> None:
        self.id = turn_id
        self._events: list[TurnEvent] = []
        self._waiters: list[asyncio.Future[None]] = []
        self._finished: tuple[bool, Any] | None = None
        self._on_cancel = on_cancel
        self._view = view
        self._cancelling: asyncio.Task[None] | None = None
        #: Runs work the turn starts itself (the session's task spawner), keeping a reference to it.
        self._spawn = spawn or self._keep
        self._tasks: set[asyncio.Task[Any]] = set()
        loop = asyncio.get_running_loop()
        self._done: asyncio.Future[TurnResult] = loop.create_future()
        # Iterating without awaiting the result must not log "exception was never retrieved".
        self._done.add_done_callback(lambda f: f.cancelled() or f.exception())
        #: Runs the turn's handlers; the result waits for it.
        self._observer: asyncio.Task[None] | None = None
        self._handler_failed: list[BaseException] = []
        #: Events the observer has finished dispatching.
        self._dispatched = 0
        self._progress: list[Callable[[], None]] = []
        #: The message being streamed, as its latest event.
        self._open: TextEvent | None = None

    # ---- state -------------------------------------------------------------

    @property
    def is_done(self) -> bool:
        return self._finished is not None

    @property
    def history(self) -> list[TurnEvent]:
        """Events so far."""
        return list(self._events)

    @property
    def text(self) -> str:
        """Agent message text so far (the whole turn's, once done)."""
        if self._finished and self._finished[0]:
            return self._finished[1].text
        return self._view.text() if self._view else ""

    @property
    def tool_calls(self) -> list[ToolCall]:
        """Tool calls so far, each with every update merged in."""
        if self._finished and self._finished[0]:
            return self._finished[1].tool_calls
        return self._view.tool_calls() if self._view else []

    @property
    def done(self) -> Awaitable[TurnResult]:
        """The result. Cancelling a task that awaits it does not cancel the turn (use `cancel()`)."""
        return asyncio.shield(self._done)

    def __await__(self) -> Generator[Any, None, TurnResult]:
        return asyncio.shield(self._done).__await__()

    async def cancel(self) -> None:
        """Ask the agent to stop. Returns once the request is sent; await the turn for the end."""
        if self._finished is not None:
            return
        if self._cancelling is None:
            self._cancelling = asyncio.ensure_future(self._on_cancel())
        await asyncio.shield(self._cancelling)

    @property
    def cancel_requested(self) -> bool:
        return self._cancelling is not None

    async def __aiter__(self) -> AsyncIterator[TurnEvent]:
        index = 0
        while True:
            while index < len(self._events):
                event = self._events[index]
                index += 1
                yield event
            if self._finished is not None:
                ok, value = self._finished
                if not ok:
                    raise value
                return
            waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            await waiter

    # ---- internal ------------------------------------------------------------

    def push(self, *events: TurnEvent) -> None:
        if self._finished is not None or not events:
            return
        for event in events:
            current = self._open
            if (
                current is not None
                and isinstance(event, _ENDS)
                and not (isinstance(event, _TEXT) and type(event) is type(current) and event.message_id == current.message_id)
            ):
                self._close(True)
            if isinstance(event, _TEXT):
                self._open = event
            self._events.append(event)
        self._wake()

    def _close(self, complete: bool) -> None:
        """End the open message, if any."""
        current = self._open
        if current is None:
            return
        self._open = None
        self._events.append(_END_OF[type(current)](current.message_id, current.text, complete))

    def finish(self, result: TurnResult) -> None:
        if self._finished is not None:
            return
        self._close(result.stop_reason == "end_turn" and not result.cancelled)
        self._finished = (True, result)
        self._wake()
        self._settle(lambda: self._done.done() or self._done.set_result(result))

    def fail(self, error: BaseException) -> None:
        if self._finished is not None:
            return
        self._close(False)
        self._finished = (False, error)
        self._wake()
        self._settle(lambda: self._done.done() or self._done.set_exception(error))

    def observe(self, handlers: TurnHandlers) -> None:
        """Run `handlers` for every event, in order, one at a time. The result is ready after
        the last one ran; a handler that raises cancels the turn, and the turn raises its error."""
        if self._observer is not None:
            return

        async def run() -> None:
            tracker = TextTracker()
            try:
                async for event in self:
                    await dispatch(event, handlers, tracker)
                    self._dispatched += 1
                    for notify in list(self._progress):
                        notify()
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as error:  # noqa: BLE001
                task = asyncio.current_task()
                # This task being cancelled is handled when it ends (`ended`).
                if isinstance(error, asyncio.CancelledError) and task is not None and task.cancelling():
                    raise
                # The turn's own failure ends the loop too; only a handler's error is kept.
                if self._finished is None or self._finished[0] or self._finished[1] is not error:
                    self._handler_failed.append(_handler_error(error))
                    self._spawn(self.cancel())

        def ended(task: asyncio.Task[None]) -> None:
            # Handlers that will never run again are a failure, as a handler's error is.
            if task.cancelled() and not self._handler_failed:
                self._handler_failed.append(_handler_error(asyncio.CancelledError()))
                if self._finished is None:
                    self._spawn(self.cancel())
            # Nothing waits for handlers that will not run again.
            for notify in list(self._progress):
                notify()

        self._observer = asyncio.get_running_loop().create_task(run(), name=f"{self.id}:handlers")
        self._observer.add_done_callback(ended)

    async def caught_up(self, max_ms: float = 1000) -> None:
        """Wait until the handlers have run for every event so far (at most `max_ms`), so that
        a question to the user comes after what the agent said before asking it."""
        observer = self._observer
        if observer is None or observer.done() or self._finished is not None:
            return
        target = len(self._events)
        if self._dispatched >= target:
            return
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        def check() -> None:
            if (self._dispatched >= target or self._finished is not None or observer.done()) and not future.done():
                future.set_result(None)

        self._progress.append(check)
        try:
            await asyncio.wait_for(future, max_ms / 1000)
        except asyncio.TimeoutError:
            pass
        finally:
            if check in self._progress:
                self._progress.remove(check)

    def _settle(self, complete: Callable[[], Any]) -> None:
        observer = self._observer
        if observer is None:
            complete()
            return

        def after(_task: asyncio.Task[None]) -> None:
            if self._handler_failed:
                if not self._done.done():
                    self._done.set_exception(self._handler_failed[0])
            else:
                complete()

        observer.add_done_callback(after)

    def _keep(self, coroutine: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _wake(self) -> None:
        waiters, self._waiters = self._waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)
        for notify in list(self._progress):
            notify()
