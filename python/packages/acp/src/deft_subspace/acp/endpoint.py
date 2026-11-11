"""`agent_endpoint()`: the raw agent side of an ACP connection. Every inbound
request and notification goes, as sent, through the layers you choose and
then to your `request` / `notification` handlers; nothing is answered for
you. For proxies, pipelines, and agents with methods of their own. See
`docs/AGENT-LAYERS.md`.

    async def forward(call, ctx):
        return await downstream.request(call.method, call.params, signal=ctx.signal)

    endpoint = agent_endpoint(
        channel,
        name="proxy",
        request=forward,
        notification=lambda call, ctx: asyncio.ensure_future(downstream.notify(call.method, call.params)),
    )

A handler's return value is the result; a raised `RpcError` is the error
reply, code and data kept. Handlers, hooks and `create` may be plain or
coroutine functions (`create` must be plain).
"""

from __future__ import annotations

import asyncio
import inspect
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field, replace
from typing import Any, Generic, Literal, TypeVar

from deft_subspace.kernel import AbortSignal, Channel, CloseInfo, InboundContext, JsonRpcId, RpcError, RpcPeer, cancel_request

T = TypeVar("T")
S = TypeVar("S")

CallKind = Literal["request", "notification"]


@dataclass(frozen=True)
class EndpointCall:
    """An inbound or outbound method call (not a reply)."""

    method: str
    params: Any = None
    #: Present for inbound requests.
    id: JsonRpcId = None
    #: Set on what hooks and handlers see.
    kind: CallKind | None = None


@dataclass(frozen=True, eq=False)
class StateKey(Generic[T]):
    """Typed slot for state one layer provides to the layers after it."""

    name: str


def state_key(name: str) -> StateKey[Any]:
    """A new state slot. Annotate it for its type: `SESSIONS: StateKey[Sessions] = state_key("sessions")`."""
    return StateKey(name)


Next = Callable[..., Awaitable[Any]]
"""Continue with the current call, or a replacement: `await next()` or `await next(call)`. At most once."""

LayerMethod = Callable[[EndpointCall, "CallContext", Any, Next], Any]
InboundHook = Callable[[EndpointCall, "CallContext", Any, Next], Any]
OutboundHook = Callable[[EndpointCall, "EndpointContext", Any, Next], Any]
Handler = Callable[[EndpointCall, "CallContext"], Any]


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class EndpointClient:
    """Send to the client, through the layers' outbound hooks."""

    def __init__(self, endpoint: _Endpoint) -> None:
        self._endpoint = endpoint

    async def request(self, method: str, params: Any = None, *, signal: AbortSignal | None = None, timeout_ms: float | None = None) -> Any:
        peer = self._endpoint.peer

        async def send(call: EndpointCall) -> Any:
            return await peer.request(call.method, call.params, signal=signal, timeout_ms=timeout_ms)

        return await self._endpoint.outbound_chain("request", EndpointCall(method, params), send)

    def notify(self, method: str, params: Any = None) -> Awaitable[None]:
        """Notifications keep their order: each waits for the previous one's hooks and write.

        Sending starts now; the result is awaitable (and need not be awaited)."""
        return self._endpoint.notify(method, params)


class EndpointContext:
    """What every hook and handler gets, for this endpoint."""

    def __init__(self, name: str, peer: RpcPeer, client: EndpointClient, values: dict[str, Any], owners: dict[str, str]) -> None:
        self.name = name
        self.peer = peer
        self.client = client
        self._values = values
        self._owners = owners

    def get(self, key: StateKey[T]) -> T:
        """A value a layer earlier in the stack provided. Raises if it was never set."""
        if key.name not in self._values:
            raise RuntimeError(f'{self.name}: "{key.name}" is not set yet')
        return self._values[key.name]

    def peek(self, key: StateKey[T]) -> T | None:
        """The value, or None if not set yet (e.g. before `initialize`)."""
        return self._values.get(key.name)

    def set(self, key: StateKey[T], value: T) -> None:
        """Set a value this layer declared in `provides`."""
        if key.name not in self._owners:
            raise RuntimeError(f'{self.name}: no layer provides "{key.name}"')
        self._values[key.name] = value


class CallContext(EndpointContext):
    """One inbound call: the endpoint context plus this call's signal."""

    def __init__(self, base: EndpointContext, signal: AbortSignal) -> None:
        super().__init__(base.name, base.peer, base.client, base._values, base._owners)
        #: Aborted by `$/cancel_request` for this request, or when the connection closes.
        self.signal = signal


@dataclass(eq=False)
class AgentLayer(Generic[S]):
    name: str
    #: Called once per endpoint: this layer's state there.
    create: Callable[[EndpointContext], S] | None = None
    #: Methods this layer answers. Exclusive: two layers may not answer the same method. `next` goes to the endpoint's handler.
    requests: dict[str, LayerMethod] = field(default_factory=dict)
    notifications: dict[str, LayerMethod] = field(default_factory=dict)
    #: Wraps every inbound call before dispatch: watch, rewrite (`next(call)`), or refuse (raise).
    inbound: InboundHook | None = None
    #: Wraps every call to the client; for requests, `next` returns the result (or raises the error).
    outbound: OutboundHook | None = None
    provides: list[StateKey[Any]] = field(default_factory=list)
    requires: list[StateKey[Any]] = field(default_factory=list)
    #: The connection closed: `closed(info, ctx, state)`.
    closed: Callable[[CloseInfo, EndpointContext, S], Any] | None = None


@dataclass(frozen=True)
class AgentEndpoint:
    peer: RpcPeer
    client: EndpointClient
    context: EndpointContext


def _once(name: str, run: Callable[[EndpointCall], Coroutine[Any, Any, Any]], current: EndpointCall) -> Next:
    """A continuation that may run once; a second call raises (when awaited)."""
    used = False

    def next_(call: EndpointCall | None = None) -> Awaitable[Any]:
        nonlocal used
        if used:
            return _fail(RuntimeError(f"{name}: next() called twice"))
        used = True
        return run(call if call is not None else current)

    return next_


async def _fail(error: BaseException) -> Any:
    raise error


def _check_stack(name: str, layers: list[AgentLayer[Any]]) -> None:
    """Check the stack before anything runs: exclusive methods, and requires met by an earlier layer."""
    requests: dict[str, str] = {}
    notifications: dict[str, str] = {}
    provided: set[str] = set()
    for layer in layers:
        for key in layer.requires:
            if key.name not in provided:
                raise ValueError(f'{name}: layer "{layer.name}" requires "{key.name}", which no earlier layer provides')
        for kind, seen, methods in (("request", requests, layer.requests), ("notification", notifications, layer.notifications)):
            for method in methods:
                other = seen.get(method)
                if other:
                    raise ValueError(f'{name}: layers "{other}" and "{layer.name}" both answer the {kind} {method}')
                seen[method] = layer.name
        for key in layer.provides:
            provided.add(key.name)


_tasks: set[asyncio.Task[Any]] = set()


def _spawn(coroutine: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
    task = asyncio.get_running_loop().create_task(coroutine)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


def _quiet(task: asyncio.Future[Any]) -> None:
    if not task.cancelled():
        task.exception()


class _Endpoint:
    def __init__(
        self,
        channel: Channel[Any],
        name: str,
        layers: list[AgentLayer[Any]],
        request: Handler | None,
        notification: Handler | None,
        peer_options: dict[str, Any],
    ) -> None:
        self.name = name
        self.layers = layers
        self._request = request
        self._notification = notification
        cancel_defaults = {} if "cancel_inbound" in peer_options or "cancel_outbound" in peer_options else cancel_request
        self.peer = RpcPeer(channel, **{**cancel_defaults, **peer_options, "name": name})

        values: dict[str, Any] = {}
        owners: dict[str, str] = {}
        for layer in layers:
            for key in layer.provides:
                owners[key.name] = layer.name

        # Notifications are serialized: hooks then write, one at a time, by one sender task
        # that runs while any are queued.
        self._notify_queue: deque[tuple[str, Any, asyncio.Future[None]]] = deque()
        self._notify_sender: asyncio.Task[None] | None = None
        self._outbound_hooks = [l for l in layers if l.outbound is not None]
        self._inbound_hooks = [l for l in layers if l.inbound is not None]

        self.client = EndpointClient(self)
        self.context = EndpointContext(name, self.peer, self.client, values, owners)

        # Per-endpoint state, created once each layer's turn comes.
        self._states: dict[int, Any] = {}
        for layer in layers:
            self._states[id(layer)] = layer.create(self.context) if layer.create is not None else None

        # Which layer answers each method (exclusive, checked above).
        self._answering: dict[CallKind, dict[str, AgentLayer[Any]]] = {"request": {}, "notification": {}}
        for layer in layers:
            for method in layer.requests:
                self._answering["request"][method] = layer
            for method in layer.notifications:
                self._answering["notification"][method] = layer

        self.peer.on_request("*", self._on_request)
        # Request cancellation is protocol mechanics: the peer aborts the request's
        # signal; the call is not passed on (its id means nothing elsewhere).
        cancel_inbound = peer_options["cancel_inbound"] if "cancel_inbound" in peer_options else cancel_request["cancel_inbound"]
        self._cancel_method: str | None = cancel_inbound.method if cancel_inbound is not None else None
        self.peer.on_notification("*", self._on_notification)
        _spawn(self._watch_close())
        self.peer.start()

    def state(self, layer: AgentLayer[Any]) -> Any:
        return self._states.get(id(layer))

    # ---- outbound ------------------------------------------------------------

    async def outbound_chain(self, kind: CallKind, call: EndpointCall, send: Callable[[EndpointCall], Awaitable[Any]]) -> Any:
        hooks = self._outbound_hooks
        if not hooks:
            return await send(call)

        async def dispatch(index: int, current: EndpointCall) -> Any:
            if index >= len(hooks):
                return await send(current)
            layer = hooks[index]
            assert layer.outbound is not None
            next_ = _once(f"{self.name}/{layer.name} outbound", lambda c: dispatch(index + 1, c), current)
            return await _resolve(layer.outbound(replace(current, kind=kind), self.context, self.state(layer), next_))

        return await dispatch(0, call)

    def notify(self, method: str, params: Any) -> Awaitable[None]:
        # No hooks, nothing to reorder: the peer writes in call order.
        if not self._outbound_hooks:
            return self.peer.notify(method, params)
        sent: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        sent.add_done_callback(_quiet)
        self._notify_queue.append((method, params, sent))
        if self._notify_sender is None or self._notify_sender.done():
            self._notify_sender = _spawn(self._send_notifications())
        return sent

    async def _send_notifications(self) -> None:
        peer = self.peer

        async def send(call: EndpointCall) -> None:
            await peer.notify(call.method, call.params)

        queue = self._notify_queue
        try:
            while queue:
                method, params, sent = queue[0]
                # One its caller cancelled before its turn is not sent.
                if not sent.done():
                    try:
                        await self.outbound_chain("notification", EndpointCall(method, params), send)
                    except Exception as error:  # noqa: BLE001
                        if not sent.done():
                            sent.set_exception(error)
                    else:
                        if not sent.done():
                            sent.set_result(None)
                queue.popleft()
        except asyncio.CancelledError:
            # The sender itself was cancelled (the loop is shutting down): nothing more goes out.
            while queue:
                queue.popleft()[2].cancel()
            raise

    # ---- inbound -------------------------------------------------------------

    def _fallback(self, kind: CallKind, call: EndpointCall, ctx: CallContext) -> Any:
        if kind == "request":
            if self._request is None:
                raise RpcError.method_not_found(call.method)
            return self._request(call, ctx)
        return self._notification(call, ctx) if self._notification is not None else None

    def _dispatch_method(self, kind: CallKind, current: EndpointCall, ctx: CallContext) -> Any:
        # Synchronous until a handler awaits: no extra steps when there are no hooks.
        if current.kind != kind:
            current = replace(current, kind=kind)
        layer = self._answering[kind].get(current.method)
        if layer is None:
            return self._fallback(kind, current, ctx)
        handler = (layer.requests if kind == "request" else layer.notifications)[current.method]

        async def run(c: EndpointCall) -> Any:
            return await _resolve(self._fallback(kind, c, ctx))

        next_ = _once(f"{self.name}/{layer.name} {current.method}", run, current)
        return handler(current, ctx, self.state(layer), next_)

    def _handle(self, kind: CallKind, call: EndpointCall, ctx: CallContext) -> Any:
        hooks = self._inbound_hooks
        if not hooks:
            return self._dispatch_method(kind, call, ctx)

        async def dispatch(index: int, current: EndpointCall) -> Any:
            if index >= len(hooks):
                return await _resolve(self._dispatch_method(kind, current, ctx))
            layer = hooks[index]
            assert layer.inbound is not None
            next_ = _once(f"{self.name}/{layer.name} inbound", lambda c: dispatch(index + 1, c), current)
            return await _resolve(layer.inbound(replace(current, kind=kind), ctx, self.state(layer), next_))

        return dispatch(0, call)

    def _on_request(self, params: Any, inbound: InboundContext) -> Any:
        call = EndpointCall(inbound.method, params, inbound.id, "request")
        return self._handle("request", call, CallContext(self.context, inbound.signal))

    def _on_notification(self, params: Any, inbound: InboundContext) -> Any:
        if inbound.method == self._cancel_method:
            return None
        # The peer reports a raising notification handler as a diagnostic.
        call = EndpointCall(inbound.method, params, None, "notification")
        return self._handle("notification", call, CallContext(self.context, inbound.signal))

    async def _watch_close(self) -> None:
        info = await self.peer.closed
        for layer in self.layers:
            if layer.closed is None:
                continue
            try:
                await _resolve(layer.closed(info, self.context, self.state(layer)))
            except Exception:  # noqa: BLE001 - a layer's cleanup must not stop the others
                pass


def agent_endpoint(
    channel: Channel[Any],
    *,
    name: str,
    layers: list[AgentLayer[Any]] | None = None,
    request: Handler | None = None,
    notification: Handler | None = None,
    peer: dict[str, Any] | None = None,
) -> AgentEndpoint:
    """The raw agent side of a connection. Needs a running event loop.

    - `layers`: first = outermost: first to see an inbound call, last to see its result.
    - `request(call, ctx)`: requests no layer answered. Default: method not found.
    - `notification(call, ctx)`: notifications no layer answered. Default: dropped.
    - `peer`: RpcPeer keyword arguments (`tap`, `on_diagnostic`, `timeout_ms`, ...).
      `$/cancel_request` is on unless you pass your own cancel options.
    """
    layers = list(layers or [])
    _check_stack(name, layers)
    endpoint = _Endpoint(channel, name, layers, request, notification, dict(peer or {}))
    return AgentEndpoint(endpoint.peer, endpoint.client, endpoint.context)
