"""One side of a JSON-RPC 2.0 connection.

Every outbound request has exactly one owner, the peer, and ends exactly once,
in `_settle()`: with the answer, or with a `LocalError` saying why we stopped
waiting (`aborted`, `timeout`, `closed`). Late answers are reported, never
delivered.

Inbound requests run concurrently, so a handler that waits on a call back to
the other side never stops other messages from being read. Notification
handlers start in arrival order (a synchronous handler runs to completion
before the next message is read).

Handlers and middleware may be plain functions or coroutine functions.
"""

from __future__ import annotations

import asyncio
import inspect
import math
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .abort import AbortController, AbortSignal
from .channel import Channel, ChannelClosed, EndOfChannel
from .clock import Clock, system_clock
from .errors import ErrorCode, LocalError, RpcError

JsonRpcId = str | int | float | None
"""JSON-RPC ids are opaque. `0` and `""` are as valid as any other id, and
JSON-RPC 2.0 also allows `null` (discouraged) for requests we receive.
Requests we send always get an int."""


@dataclass
class InboundContext:
    method: str
    #: Fires when the other side cancels this request, or the connection closes.
    signal: AbortSignal
    #: The peer, for calling back to the other side while handling.
    peer: RpcPeer
    #: The request's id. `None` for notifications (see `is_request`); a request's id may also be None.
    id: JsonRpcId = None
    is_request: bool = False


RequestHandler = Callable[[Any, InboundContext], Any]
NotificationHandler = Callable[[Any, InboundContext], Any]


@dataclass
class Call:
    """A message as middleware sees it."""

    kind: Literal["request", "notification"]
    method: str
    params: Any
    id: JsonRpcId = None


InboundMiddleware = Callable[[Call, Callable[[], Awaitable[Any]], InboundContext], Awaitable[Any]]
"""Wraps inbound handling. Await `next()` to run the handler (and inner middleware)."""
OutboundMiddleware = Callable[[Call, Callable[[Any], Awaitable[Any]]], Awaitable[Any]]
"""Wraps outbound calls. `await next(params)` sends; it returns the result (requests) or None (notifications)."""

DiagnosticKind = Literal["invalid-message", "late-response", "handler-failed", "duplicate-request-id"]


@dataclass(frozen=True)
class PeerDiagnostic:
    kind: DiagnosticKind
    message: str
    detail: Any = None


@dataclass(frozen=True)
class CloseInfo:
    """`local`: close() was called. `remote-ended`: the other side's stream ended. `error`: the stream failed."""

    reason: Literal["local", "remote-ended", "error"]
    error: BaseException | None = None


@dataclass(frozen=True)
class CancelOutbound:
    method: str
    params: Callable[[JsonRpcId], Any]


@dataclass(frozen=True)
class CancelInbound:
    method: str
    id: Callable[[Any], Any]
    """The id of the request to cancel, or `NO_ID`."""


class _NoId:
    def __repr__(self) -> str:
        return "NO_ID"


NO_ID: Any = _NoId()


def _cancel_request_id(params: Any) -> Any:
    request_id = params.get("requestId", NO_ID) if isinstance(params, dict) else NO_ID
    return request_id if request_id is None or isinstance(request_id, (str, int, float)) and not isinstance(request_id, bool) else NO_ID


cancel_request: dict[str, Any] = {
    "cancel_outbound": CancelOutbound("$/cancel_request", lambda request_id: {"requestId": request_id}),
    "cancel_inbound": CancelInbound("$/cancel_request", _cancel_request_id),
}
"""Request cancellation as ACP and LSP do it: `$/cancel_request` with `{requestId}`, both ways.

    RpcPeer(channel, **cancel_request)
"""


def _is_id(value: Any) -> bool:
    if value is None or isinstance(value, str):
        return True
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


@dataclass
class _Pending:
    method: str
    future: asyncio.Future[Any]
    cleanups: list[Callable[[], None]] = field(default_factory=list)


def _id_key(value: Any) -> Any:
    # 1 and 1.0 are the same JSON number; "1" is not.
    if isinstance(value, float) and value.is_integer():
        return ("n", int(value))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return ("n", value)
    return ("s", value)


class RpcPeer:
    def __init__(
        self,
        channel: Channel[Any],
        *,
        name: str = "peer",
        clock: Clock | None = None,
        timeout_ms: float | None = None,
        cancel_outbound: CancelOutbound | None = None,
        cancel_inbound: CancelInbound | None = None,
        inbound: list[InboundMiddleware] | None = None,
        outbound: list[OutboundMiddleware] | None = None,
        tap: Callable[[Literal["in", "out"], Any], None] | None = None,
        on_diagnostic: Callable[[PeerDiagnostic], None] | None = None,
    ) -> None:
        """Options:

        - `timeout_ms`: default timeout for outbound requests. Default: none.
        - `cancel_outbound`: how to tell the other side we stopped waiting (abort or timeout),
          e.g. `$/cancel_request` (see `cancel_request`). Default: nothing is sent.
        - `cancel_inbound`: which inbound notification cancels one of our handlers, and how to find its id.
        - `tap`: sees every message in both directions, e.g. for tracing. Must not raise.
        """
        self.name = name
        self._channel = channel
        self._clock = clock or system_clock
        self._timeout_ms = timeout_ms
        self._cancel_outbound = cancel_outbound
        self._cancel_inbound = cancel_inbound
        self._inbound_chain = list(inbound or [])
        self._outbound_chain = list(outbound or [])
        self._tap_fn = tap
        self._on_diagnostic = on_diagnostic
        self._request_handlers: dict[str, RequestHandler] = {}
        self._notification_handlers: dict[str, NotificationHandler] = {}
        self._pending: dict[Any, _Pending] = {}
        self._inbound: dict[Any, AbortController] = {}
        self._connection = AbortController()
        self._next_id = 0
        self._started = False
        self._close_info: CloseInfo | None = None
        self._closed_future: asyncio.Future[CloseInfo] | None = None
        self._close_listeners: list[Callable[[CloseInfo], None]] = []
        self._read_task: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        # Writes go out in the order they were made, one at a time.
        self._outbox: deque[tuple[dict[str, Any], asyncio.Future[None]]] = deque()
        self._writer_task: asyncio.Task[None] | None = None
        self._writer_wake: asyncio.Event | None = None

    # ---- state ---------------------------------------------------------------

    @property
    def is_closed(self) -> bool:
        """True once the connection has closed for any reason."""
        return self._close_info is not None

    @property
    def close_info(self) -> CloseInfo | None:
        return self._close_info

    @property
    def pending_count(self) -> int:
        """Outbound requests still waiting for an answer."""
        return len(self._pending)

    @property
    def signal(self) -> AbortSignal:
        """Aborted when the connection closes."""
        return self._connection.signal

    @property
    def closed(self) -> asyncio.Future[CloseInfo]:
        """Resolves with the CloseInfo once the connection has closed."""
        if self._closed_future is None:
            self._closed_future = asyncio.get_running_loop().create_future()
            if self._close_info is not None:
                self._closed_future.set_result(self._close_info)
        return self._closed_future

    def on_close(self, listener: Callable[[CloseInfo], None]) -> None:
        """Call `listener(info)` when the connection closes (at once, if it has)."""
        if self._close_info is not None:
            listener(self._close_info)
        else:
            self._close_listeners.append(listener)

    # ---- handlers ------------------------------------------------------------

    def on_request(self, method: str, handler: RequestHandler) -> RpcPeer:
        """Handle a request. `'*'` handles every method without its own handler (see `context.method`)."""
        self._request_handlers[method] = handler
        return self

    def on_notification(self, method: str, handler: NotificationHandler) -> RpcPeer:
        """Handle a notification. `'*'` handles every method without its own handler."""
        self._notification_handlers[method] = handler
        return self

    def start(self) -> RpcPeer:
        """Start reading. Register handlers first. Needs a running event loop."""
        if self._started:
            return self
        self._started = True
        self._read_task = asyncio.get_running_loop().create_task(self._read_loop(), name=f"{self.name}:read")
        return self

    # ---- outbound ------------------------------------------------------------

    async def request(
        self,
        method: str,
        params: Any = None,
        *,
        signal: AbortSignal | None = None,
        timeout_ms: float | None = None,
    ) -> Any:
        """Send a request and wait for its result.

        Stops waiting (with a LocalError) when `signal` fires (`aborted`), after `timeout_ms`
        (`timeout`; overrides the peer's default; 0 or infinity means no limit), or when the
        connection closes (`closed`). Cancelling the awaiting task also gives up on the request
        (and tells the other side), then re-raises CancelledError.
        """
        call = Call("request", method, params)
        return await self._run_outbound(call, lambda final: self._send_request(method, final, signal, timeout_ms))

    async def notify(self, method: str, params: Any = None) -> None:
        call = Call("notification", method, params)

        async def send(final: Any) -> None:
            await self._write(self._message(method=method, params=final))

        await self._run_outbound(call, send)

    async def send_raw(self, message: dict[str, Any]) -> None:
        """Write a message exactly as given (`jsonrpc: '2.0'` is added if missing), outside request tracking.

        For proxies and adapters, e.g. answering an id this peer did not receive.
        """
        await self._write(message if "jsonrpc" in message else {"jsonrpc": "2.0", **message})

    async def close(self) -> CloseInfo:
        """Close the connection. Pending requests fail with `closed`; running handlers are aborted."""
        self._finish(CloseInfo("local"))
        task = self._read_task
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except BaseException:  # noqa: BLE001
                pass
        writer = self._writer_task
        if writer is not None and not writer.done() and writer is not asyncio.current_task():
            try:
                await asyncio.wait_for(asyncio.shield(writer), 1.0)
            except BaseException:  # noqa: BLE001
                pass
        return self._close_info  # type: ignore[return-value]

    def _run_outbound(self, call: Call, send: Callable[[Any], Awaitable[Any]]) -> Awaitable[Any]:
        chain = self._outbound_chain

        def dispatch(index: int, params: Any) -> Awaitable[Any]:
            if index >= len(chain):
                return send(params)
            middleware = chain[index]
            return middleware(Call(call.kind, call.method, params, call.id), lambda nxt: dispatch(index + 1, nxt))

        return dispatch(0, call.params)

    async def _send_request(self, method: str, params: Any, signal: AbortSignal | None, timeout_ms: float | None) -> Any:
        if self._close_info is not None:
            raise LocalError("closed", f"{self.name}: connection closed before {method} was sent", method=method)
        if signal is not None and signal.aborted:
            raise LocalError("aborted", f"{self.name}: {method} aborted before it was sent", method=method, cause=signal.reason)

        request_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        pending = _Pending(method, future)
        key = _id_key(request_id)
        self._pending[key] = pending

        limit = self._timeout_ms if timeout_ms is None else timeout_ms
        if limit is not None and limit > 0 and math.isfinite(limit):

            def on_timeout() -> None:
                self._give_up(request_id, LocalError("timeout", f"{self.name}: {method} timed out after {limit:g} ms", method=method))

            handle = self._clock.set_timeout(on_timeout, limit)
            pending.cleanups.append(lambda: self._clock.clear_timeout(handle))

        if signal is not None:
            sig = signal

            def on_abort(reason: Any) -> None:
                self._give_up(request_id, LocalError("aborted", f"{self.name}: {method} aborted", method=method, cause=reason))

            pending.cleanups.append(sig.add_listener(on_abort))

        message = self._message(id=request_id, method=method)
        if params is not None:
            message["params"] = params

        def on_written(written: asyncio.Future[None]) -> None:
            error = written.exception() if not written.cancelled() else None
            if error is not None:
                self._settle(request_id, error=LocalError("send-failed", f"{self.name}: could not send {method}", method=method, cause=error))

        self._write(message).add_done_callback(on_written)
        try:
            return await future
        except asyncio.CancelledError:
            if key in self._pending:
                self._give_up(request_id, LocalError("aborted", f"{self.name}: {method} aborted", method=method))
            raise

    def _give_up(self, request_id: JsonRpcId, error: LocalError) -> None:
        """We stopped waiting: settle, then tell the other side if configured."""
        if not self._settle(request_id, error=error):
            return
        cancel = self._cancel_outbound
        if cancel is not None and self._close_info is None:
            self._write_quiet(self._message(method=cancel.method, params=cancel.params(request_id)))

    _UNSET: Any = object()

    def _settle(self, request_id: Any, value: Any = _UNSET, error: BaseException | None = None) -> bool:
        """The only place a pending request ends. Returns False if it had already ended."""
        pending = self._pending.pop(_id_key(request_id), None)
        if pending is None:
            return False
        for cleanup in pending.cleanups:
            try:
                cleanup()
            except Exception:  # noqa: BLE001
                pass
        if not pending.future.done():
            if error is not None:
                pending.future.set_exception(error)
            else:
                pending.future.set_result(value)
        return True

    # ---- inbound -------------------------------------------------------------

    async def _read_loop(self) -> None:
        try:
            while True:
                try:
                    message = await self._channel.receive()
                except EndOfChannel:
                    break
                self._receive(message)
            self._finish(CloseInfo("remote-ended"))
        except asyncio.CancelledError:
            self._finish(self._close_info or CloseInfo("local"))
            raise
        except Exception as error:  # noqa: BLE001
            self._finish(self._close_info or CloseInfo("error", error))

    def _receive(self, message: Any) -> None:
        self._tap("in", message)
        if not isinstance(message, dict):
            self._diagnose("invalid-message", "Message is not a JSON object", message)
            if isinstance(message, list):
                self._reply_error(None, ErrorCode.INVALID_REQUEST, "Batches are not supported")
            return
        method = message.get("method")
        has_id = "id" in message
        message_id = message.get("id")
        if isinstance(method, str):
            if has_id:
                if _is_id(message_id):
                    self._handle_request(message_id, method, message.get("params"))
                else:
                    self._reply_error(None, ErrorCode.INVALID_REQUEST, "Request id must be a string, number or null")
                return
            self._handle_notification(method, message.get("params"))
            return
        if has_id and ("result" in message or "error" in message):
            self._handle_response(message)
            return
        self._diagnose("invalid-message", "Message is not a request, notification or response", message)
        if has_id and _is_id(message_id):
            self._reply_error(message_id, ErrorCode.INVALID_REQUEST, "Invalid request")

    def _handle_response(self, message: dict[str, Any]) -> None:
        message_id = message.get("id")
        key = _id_key(message_id) if _is_id(message_id) and message_id is not None else None
        if key is None or key not in self._pending:
            self._diagnose("late-response", f"Response for unknown or finished request {message_id!r}", message)
            return
        error = message.get("error")
        if error is not None:
            if (
                isinstance(error, dict)
                and isinstance(error.get("code"), int)
                and not isinstance(error.get("code"), bool)
                and isinstance(error.get("message"), str)
            ):
                rpc = RpcError(error["code"], error["message"], error["data"]) if "data" in error else RpcError(error["code"], error["message"])
                self._settle(message_id, error=rpc)
            else:
                method = self._pending[key].method
                self._settle(
                    message_id,
                    error=LocalError("invalid-response", f"{self.name}: malformed error for {method}", method=method, cause=error),
                )
            return
        self._settle(message_id, value=message.get("result"))

    def _handle_request(self, request_id: JsonRpcId, method: str, params: Any) -> None:
        key = _id_key(request_id)
        if key in self._inbound:
            self._diagnose("duplicate-request-id", f"Request id {request_id!r} reused while in flight")
        controller = AbortController()
        remove_close = self._connection.signal.add_listener(lambda _reason: controller.abort(LocalError("closed", "connection closed")))
        self._inbound[key] = controller
        context = InboundContext(method=method, signal=controller.signal, peer=self, id=request_id, is_request=True)

        async def run() -> None:
            try:
                handler = self._request_handlers.get(method) or self._request_handlers.get("*")

                async def handle() -> Any:
                    if handler is None:
                        raise RpcError.method_not_found(method)
                    return await _resolve(handler(params, context))

                result = await self._run_inbound(Call("request", method, params, request_id), context, handle)
                await self._write(self._message(id=request_id, result=result))
            except asyncio.CancelledError:
                if self._close_info is None:
                    self._reply_error(request_id, ErrorCode.REQUEST_CANCELLED, "Request cancelled")
                raise
            except BaseException as error:  # noqa: BLE001
                if self._close_info is not None:
                    return
                if isinstance(error, RpcError):
                    self._write_quiet(self._message(id=request_id, error=error.to_json()))
                elif controller.signal.aborted:
                    self._reply_error(request_id, ErrorCode.REQUEST_CANCELLED, "Request cancelled")
                else:
                    self._diagnose("handler-failed", f"Handler for {method} raised", error)
                    self._reply_error(request_id, ErrorCode.INTERNAL_ERROR, str(error) or type(error).__name__)
            finally:
                if self._inbound.get(key) is controller:
                    del self._inbound[key]
                remove_close()

        self._spawn(run(), f"{self.name}:{method}")

    def _handle_notification(self, method: str, params: Any) -> None:
        cancel = self._cancel_inbound
        if cancel is not None and method == cancel.method:
            target = cancel.id(params)
            if target is not NO_ID:
                controller = self._inbound.get(_id_key(target))
                if controller is not None:
                    controller.abort(LocalError("aborted", "cancelled by the other side"))
        handler = self._notification_handlers.get(method) or self._notification_handlers.get("*")
        if handler is None:
            return
        context = InboundContext(method=method, signal=self._connection.signal, peer=self)

        def fail(error: BaseException) -> None:
            self._diagnose("handler-failed", f"Notification handler for {method} raised", error)

        if not self._inbound_chain:
            # No middleware: a plain handler runs now, in arrival order.
            try:
                result = handler(params, context)
            except Exception as error:  # noqa: BLE001
                fail(error)
                return
            if inspect.isawaitable(result):
                self._spawn(self._guard(result, fail), f"{self.name}:{method}")
            return

        async def handle() -> Any:
            return await _resolve(handler(params, context))

        self._spawn(self._guard(self._run_inbound(Call("notification", method, params), context, handle), fail), f"{self.name}:{method}")

    @staticmethod
    async def _guard(awaitable: Awaitable[Any], fail: Callable[[BaseException], None]) -> None:
        try:
            await awaitable
        except Exception as error:  # noqa: BLE001
            fail(error)

    async def _run_inbound(self, call: Call, context: InboundContext, handle: Callable[[], Awaitable[Any]]) -> Any:
        chain = self._inbound_chain

        async def dispatch(index: int) -> Any:
            if index >= len(chain):
                return await handle()
            return await chain[index](call, lambda: dispatch(index + 1), context)

        return await dispatch(0)

    # ---- plumbing ------------------------------------------------------------

    def _spawn(self, coroutine: Any, name: str) -> asyncio.Task[Any]:
        task = asyncio.get_running_loop().create_task(coroutine, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    @staticmethod
    def _message(**body: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", **body}

    def _reply_error(self, request_id: JsonRpcId, code: int, message: str) -> None:
        self._write_quiet(self._message(id=request_id, error={"code": code, "message": message}))

    def _write(self, message: dict[str, Any]) -> asyncio.Future[None]:
        """Queue a message. The future settles once it was handed to the channel (or could not be)."""
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        if self._close_info is not None:
            future.set_exception(LocalError("closed", f"{self.name}: connection closed"))
            return future
        self._tap("out", message)
        self._outbox.append((message, future))
        self._ensure_writer()
        return future

    def _write_quiet(self, message: dict[str, Any]) -> None:
        future = self._write(message)
        future.add_done_callback(lambda f: f.cancelled() or f.exception())

    def _ensure_writer(self) -> None:
        if self._writer_wake is None:
            self._writer_wake = asyncio.Event()
        self._writer_wake.set()
        if self._writer_task is None or self._writer_task.done():
            self._writer_task = asyncio.get_running_loop().create_task(self._write_loop(), name=f"{self.name}:write")

    async def _write_loop(self) -> None:
        wake = self._writer_wake
        assert wake is not None
        while True:
            while self._outbox:
                message, future = self._outbox.popleft()
                try:
                    await self._channel.send(message)
                except asyncio.CancelledError:
                    if not future.done():
                        future.set_exception(LocalError("closed", f"{self.name}: connection closed"))
                    raise
                except BaseException as error:  # noqa: BLE001
                    if not future.done():
                        future.set_exception(error if isinstance(error, Exception) else ChannelClosed(str(error)))
                else:
                    if not future.done():
                        future.set_result(None)
            if self._close_info is not None:
                try:
                    await self._channel.close()
                except Exception:  # noqa: BLE001
                    pass
                return
            wake.clear()
            await wake.wait()

    def _tap(self, direction: Literal["in", "out"], message: Any) -> None:
        if self._tap_fn is None:
            return
        try:
            self._tap_fn(direction, message)
        except Exception:  # noqa: BLE001 - taps are observers; they never change behaviour
            pass

    def _diagnose(self, kind: DiagnosticKind, message: str, detail: Any = None) -> None:
        if self._on_diagnostic is None:
            return
        try:
            self._on_diagnostic(PeerDiagnostic(kind, message, detail))
        except Exception:  # noqa: BLE001
            pass

    def _finish(self, info: CloseInfo) -> None:
        if self._close_info is not None:
            return
        self._close_info = info
        self._connection.abort(LocalError("closed", f"{self.name}: connection closed"))
        if info.reason == "remote-ended":
            text = f"{self.name}: the other side closed the connection"
        elif info.reason == "error":
            text = f"{self.name}: the connection failed"
        else:
            text = f"{self.name}: connection closed"
        for key in list(self._pending):
            pending = self._pending.get(key)
            if pending is None:
                continue
            method = pending.method
            self._settle_key(key, LocalError("closed", f"{text} while waiting for {method}", method=method, cause=info.error))
        # Flush what was queued, then end our side.
        try:
            self._ensure_writer()
        except RuntimeError:
            pass
        if self._closed_future is not None and not self._closed_future.done():
            self._closed_future.set_result(info)
        listeners, self._close_listeners = self._close_listeners, []
        for listener in listeners:
            try:
                listener(info)
            except Exception:  # noqa: BLE001
                pass

    def _settle_key(self, key: Any, error: BaseException) -> None:
        pending = self._pending.pop(key, None)
        if pending is None:
            return
        for cleanup in pending.cleanups:
            try:
                cleanup()
            except Exception:  # noqa: BLE001
                pass
        if not pending.future.done():
            pending.future.set_exception(error)

