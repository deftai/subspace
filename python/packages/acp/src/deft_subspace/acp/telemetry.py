"""OpenTelemetry spans for an ACP connection, from the messages it carries.

    client = await AcpClient.connect(channel, telemetry=otel_tap())   # a client
    serve_agent(channel, ..., telemetry=otel_tap())                   # or an agent

    # Spans on this side only, without carrying the trace across:
    tap = otel_tap();  ... tap=tap ...;  tap.close()

- Every request is a span (CLIENT when this side sent it, SERVER when it
  received it), named by its method, with the RPC semantic-convention
  attributes. A `session/prompt` span is the turn: it ends when the turn does
  (v1: the answer; v2: the answer and the idle state), with `acp.stop_reason`.
- Inside a turn: each tool call is a span, and so is every request about the
  session (permission questions, file and terminal requests). Cancels, plans
  and usage are events and attributes on the turn.
- Requests start under the context that is active when they are sent, so a
  turn nests under your own span.
- Nothing from the conversation is recorded by default: no prompt or message
  text, and no tool titles (they can hold commands and paths). Opt in to
  titles with `titles=True`.
- Needs `opentelemetry-api` (the `otel` extra). Without a configured SDK its
  tracer does nothing.
- Across the connection: with `telemetry=` on the client, the agent or
  `start()` (rather than `tap=`), each request carries the W3C trace context
  in `_meta` (`traceparent`, `tracestate`, `baggage`, the keys ACP reserves for
  it), a request that carries one continues that trace, and handlers run inside
  their request's span, so your own spans nest under it.

`spans_from_trace()` makes the same spans from a saved trace.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from deft_subspace.kernel import Call, InboundContext, InboundMiddleware, OutboundMiddleware, TraceRecord

Attributes = dict[str, Any]


def _ns(ms: float) -> int:
    return int(ms * 1_000_000)


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


@dataclass
class _Open:
    span: Any
    method: str
    session_id: str | None = None


@dataclass
class _OpenTurn:
    span: Any
    key: str
    answered: dict[str, str] | None = None
    idle: dict[str, str] | None = None
    tools: dict[str, Any] = field(default_factory=dict)
    background: set[str] = field(default_factory=set)


class _Spans:
    """The span builder; `otel_tap` gives it the time now, `spans_from_trace` the trace's (ms)."""

    def __init__(self, tracer_provider: Any, tracer: str, attributes: Attributes | None, titles: bool) -> None:
        from opentelemetry import context, propagate, trace
        from opentelemetry.trace import SpanKind, Status, StatusCode

        self._trace = trace
        self._context = context
        self._propagate = propagate
        self._kind = SpanKind
        self._status = Status
        self._error = StatusCode.ERROR
        self._tracer = trace.get_tracer(tracer, tracer_provider=tracer_provider)
        self._attributes = attributes or {}
        self._titles = titles
        self._requests: dict[str, _Open] = {}
        #: Spans started by `outbound` before the message is sent, by the identity of its params.
        self._sending: dict[int, tuple[dict[str, Any], Any]] = {}
        self._turns: dict[str, _OpenTurn] = {}
        self._protocol = 1

    def handle(self, direction: Literal["in", "out"], message: Any, ms: float) -> None:
        if not isinstance(message, dict):
            return
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        assert isinstance(params, dict)
        method = _str(message.get("method"))
        has_id = message.get("id") is not None
        if method and has_id:
            self._request(direction, str(message["id"]), method, params, ms)
        elif method:
            self._notification(direction, method, params, ms)
        elif has_id:
            self._response(direction, str(message["id"]), message, ms)

    def close(self, ms: float) -> None:
        for session_id in list(self._turns):
            self._end_turn(session_id, ms, unfinished=True)
        for key, open_ in list(self._requests.items()):
            open_.span.set_attribute("acp.unfinished", True)
            open_.span.end(end_time=_ns(ms))
            del self._requests[key]

    def stamp(self, method: str, params: Any, ms: float) -> Any:
        """Before a request is sent: its span, and params with the trace context in `_meta`."""
        if not isinstance(params, dict):
            return params
        span = self._request_span("out", method, params, None, ms)
        carrier: dict[str, str] = {}
        self._propagate.inject(carrier, context=self._trace.set_span_in_context(span, self._context.get_current()))
        if not carrier:
            span.end(end_time=_ns(ms))
            return params
        meta = params.get("_meta")
        stamped = {**params, "_meta": {**(meta if isinstance(meta, dict) else {}), **carrier}}
        self._sending[id(stamped)] = (stamped, span)
        return stamped

    def unsent(self, params: Any, error: BaseException, ms: float) -> None:
        """A stamped request that was never sent (the connection closed, or it was aborted first)."""
        entry = self._sending.pop(id(params), None)
        if entry is None or entry[0] is not params:
            return
        span = entry[1]
        span.set_status(self._status(self._error, str(error)))
        span.set_attribute("acp.unsent", True)
        span.end(end_time=_ns(ms))

    def context_of(self, request_id: str) -> Any:
        """The context of a received request's span, for running its handler."""
        open_ = self._requests.get(f"in:{request_id}")
        return self._trace.set_span_in_context(open_.span, self._context.get_current()) if open_ else None

    def _start(
        self,
        name: str,
        kind: Any,
        attributes: Attributes,
        ms: float,
        session_id: str | None = None,
        remote: dict[str, Any] | None = None,
        sent: bool = False,
    ) -> Any:
        """Under what: a received request continues the trace it carries, else goes in its session's
        turn. Something this side sends goes under the span active when it is sent (e.g. the agent's
        own work inside the turn), else in the turn."""
        turn = self._turns.get(session_id) if session_id else None
        parent = self._context.get_current()
        active = self._trace.get_current_span(parent) if sent else None
        active_is_real = active is not None and active.get_span_context().is_valid
        if remote is not None and isinstance(remote.get("traceparent"), str):
            parent = self._propagate.extract(remote, context=parent)
        elif turn is not None and not active_is_real:
            parent = self._trace.set_span_in_context(turn.span, parent)
        return self._tracer.start_span(name, context=parent, kind=kind, attributes={**self._attributes, **attributes}, start_time=_ns(ms))

    def _request_span(self, direction: str, method: str, params: dict[str, Any], request_id: str | None, ms: float) -> Any:
        session_id = _str(params.get("sessionId"))
        attributes: Attributes = {"rpc.system": "jsonrpc", "rpc.method": method}
        if request_id is not None:
            attributes["rpc.jsonrpc.request_id"] = request_id
        if session_id:
            attributes["acp.session_id"] = session_id
        remote = params.get("_meta") if direction == "in" and isinstance(params.get("_meta"), dict) else None
        kind = self._kind.CLIENT if direction == "out" else self._kind.SERVER
        # A prompt is the turn: it starts under the caller's context, not an earlier turn.
        return self._start(method, kind, attributes, ms, None if method == "session/prompt" else session_id, remote, direction == "out")

    def _request(self, direction: Literal["in", "out"], request_id: str, method: str, params: dict[str, Any], ms: float) -> None:
        session_id = _str(params.get("sessionId"))
        entry = self._sending.pop(id(params), None) if direction == "out" else None
        stamped = entry[1] if entry is not None and entry[0] is params else None
        span = stamped if stamped is not None else self._request_span(direction, method, params, request_id, ms)
        if stamped is not None:
            span.set_attribute("rpc.jsonrpc.request_id", request_id)
        key = f"{direction}:{request_id}"
        self._requests[key] = _Open(span, method, session_id)
        if method == "session/prompt" and session_id:
            if session_id in self._turns:
                self._end_turn(session_id, ms, unfinished=True)
            self._turns[session_id] = _OpenTurn(span, key)

    def _notification(self, direction: str, method: str, params: dict[str, Any], ms: float) -> None:
        session_id = _str(params.get("sessionId"))
        if method == "$/cancel_request":
            # The canceller sends it about a request it sent itself.
            open_ = self._requests.get(f"{direction}:{params.get('requestId')}")
            if open_:
                open_.span.add_event("cancel requested", {}, timestamp=_ns(ms))
            return
        turn = self._turns.get(session_id) if session_id else None
        if method == "session/cancel":
            if turn:
                turn.span.add_event("session/cancel", {}, timestamp=_ns(ms))
            return
        if method == "session/update" and session_id and isinstance(params.get("update"), dict):
            self._update(session_id, params["update"], ms)

    def _response(self, direction: str, request_id: str, message: dict[str, Any], ms: float) -> None:
        # A response travels the other way from its request.
        key = f"{'out' if direction == 'in' else 'in'}:{request_id}"
        open_ = self._requests.get(key)
        if open_ is None:
            return
        span, method, session_id = open_.span, open_.method, open_.session_id
        result = message.get("result") if isinstance(message.get("result"), dict) else {}
        assert isinstance(result, dict)
        error = message.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            span.set_attribute("rpc.jsonrpc.error_code", code if isinstance(code, int) else -1)
            span.set_attribute("rpc.jsonrpc.error_message", str(error.get("message") or ""))
            span.set_status(self._status(self._error, str(error.get("message") or "")))
        elif method == "initialize":
            version = result.get("protocolVersion")
            if isinstance(version, int) and not isinstance(version, bool):
                self._protocol = version
                span.set_attribute("acp.protocol_version", version)
            # v1 calls it agentInfo, v2 info.
            agent = result.get("agentInfo") if isinstance(result.get("agentInfo"), dict) else result.get("info") if isinstance(result.get("info"), dict) else None
            if isinstance(agent, dict) and _str(agent.get("name")):
                span.set_attribute("acp.agent.name", str(agent["name"]))
            if isinstance(agent, dict) and _str(agent.get("version")):
                span.set_attribute("acp.agent.version", str(agent["version"]))
        elif method == "session/new" and _str(result.get("sessionId")):
            span.set_attribute("acp.session_id", str(result["sessionId"]))
        elif method == "session/request_permission" and isinstance(result.get("outcome"), dict):
            outcome = result["outcome"]
            span.set_attribute("acp.permission.outcome", str(outcome.get("outcome")))
            if _str(outcome.get("optionId")):
                span.set_attribute("acp.permission.option_id", str(outcome["optionId"]))
        turn = self._turns.get(session_id) if session_id else None
        if method == "session/prompt" and turn is not None and turn.key == key and session_id:
            stop = _str(result.get("stopReason"))
            turn.answered = {"stopReason": stop} if stop else {}
            # v2 ends a turn with the idle state; the answer can come first.
            if isinstance(error, dict) or self._protocol < 2 or turn.idle is not None:
                self._end_turn(session_id, ms)
            return
        del self._requests[key]
        span.end(end_time=_ns(ms))

    def _update(self, session_id: str, update: dict[str, Any], ms: float) -> None:
        turn = self._turns.get(session_id)
        kind = str(update.get("sessionUpdate"))
        if kind in ("tool_call", "tool_call_update", "tool_call_content_chunk"):
            call_id = _str(update.get("toolCallId"))
            if not call_id or turn is None:
                return
            span = turn.tools.get(call_id)
            if span is None:
                attributes: Attributes = {"acp.session_id": session_id, "acp.tool_call.id": call_id}
                if _str(update.get("kind")):
                    attributes["acp.tool_call.kind"] = str(update["kind"])
                if self._titles and _str(update.get("title")):
                    attributes["acp.tool_call.title"] = str(update["title"])
                span = self._start("tool_call", self._kind.INTERNAL, attributes, ms, session_id)
                turn.tools[call_id] = span
            if _str(update.get("kind")):
                span.set_attribute("acp.tool_call.kind", str(update["kind"]))
            if self._titles and _str(update.get("title")):
                span.set_attribute("acp.tool_call.title", str(update["title"]))
            status = _str(update.get("status"))
            if status:
                span.set_attribute("acp.tool_call.status", status)
                if status == "failed":
                    span.set_status(self._status(self._error, "failed"))
                if status in ("completed", "failed"):
                    span.end(end_time=_ns(ms))
                    del turn.tools[call_id]
            return
        if turn is None:
            return
        if kind == "usage_update":
            for key in ("used", "size"):
                value = update.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    turn.span.set_attribute(f"acp.usage.{key}", value)
        elif kind in ("plan", "plan_update"):
            entries = update.get("entries") if kind == "plan" else update["plan"].get("entries") if isinstance(update.get("plan"), dict) else None
            turn.span.add_event("plan", {"acp.plan.entries": len(entries) if isinstance(entries, list) else 0}, timestamp=_ns(ms))
        elif kind == "state_update":
            background = update.get("background") if isinstance(update.get("background"), list) else []
            assert isinstance(background, list)
            turn.background = {
                str(b["toolCallId"]) for b in background if isinstance(b, dict) and b.get("type") == "tool_call" and _str(b.get("toolCallId"))
            }
            if update.get("state") == "idle":
                stop = _str(update.get("stopReason"))
                turn.idle = {"stopReason": stop} if stop else {}
                if turn.answered is not None:
                    self._end_turn(session_id, ms)

    def _end_turn(self, session_id: str, ms: float, unfinished: bool = False) -> None:
        """End a turn's span, and its tool calls still open (except background work)."""
        turn = self._turns.pop(session_id, None)
        if turn is None:
            return
        self._requests.pop(turn.key, None)
        stop = (turn.idle or {}).get("stopReason") or (turn.answered or {}).get("stopReason")
        if stop is None and (turn.answered is not None or turn.idle is not None):
            stop = "end_turn"
        if stop:
            turn.span.set_attribute("acp.stop_reason", stop)
        if unfinished:
            turn.span.set_attribute("acp.unfinished", True)
        for call_id, span in turn.tools.items():
            span.set_attribute("acp.unfinished", True)
            if call_id in turn.background:
                span.set_attribute("acp.tool_call.background", True)
            span.end(end_time=_ns(ms))
        turn.span.end(end_time=_ns(ms))


class OtelTap:
    """A peer `tap` that makes OpenTelemetry spans; see the module docstring."""

    def __init__(self, spans: _Spans) -> None:
        self._spans = spans
        from opentelemetry import context

        self._context = context

    def __call__(self, direction: Literal["in", "out"], message: Any) -> None:
        self._spans.handle(direction, message, time.time() * 1000)

    def close(self) -> None:
        """End every span still open (marked `acp.unfinished`), e.g. when the connection closed."""
        self._spans.close(time.time() * 1000)

    async def outbound(self, call: Call, nxt: Callable[[Any], Awaitable[Any]]) -> Any:
        """Peer middleware: puts the trace context in each request's `_meta` (the `telemetry` option sets it)."""
        if call.kind != "request":
            return await nxt(call.params)
        params = self._spans.stamp(call.method, call.params, time.time() * 1000)
        try:
            return await nxt(params)
        except BaseException as error:
            self._spans.unsent(params, error, time.time() * 1000)
            raise

    async def inbound(self, call: Call, nxt: Callable[[], Awaitable[Any]], _context: InboundContext) -> Any:
        """Peer middleware: runs each request's handler inside its span (the `telemetry` option sets it)."""
        ctx = self._spans.context_of(str(call.id)) if call.kind == "request" and call.id is not None else None
        if ctx is None:
            return await nxt()
        token = self._context.attach(ctx)
        try:
            return await nxt()
        finally:
            self._context.detach(token)


def otel_tap(*, tracer_provider: Any = None, tracer: str = "deft-subspace-acp", attributes: Attributes | None = None, titles: bool = False) -> OtelTap:
    """OpenTelemetry for a connection. `attributes` are added to every span (e.g.
    `{"acp.agent": "claude"}`); `titles` records tool call titles, which can hold commands and paths."""
    return OtelTap(_Spans(tracer_provider, tracer, attributes, titles))


def spans_from_trace(
    records: Sequence[TraceRecord],
    *,
    tracer_provider: Any = None,
    tracer: str = "deft-subspace-acp",
    attributes: Attributes | None = None,
    titles: bool = False,
) -> None:
    """The same spans from a saved trace, at the times it recorded. Spans still open at the end are ended there."""
    spans = _Spans(tracer_provider, tracer, attributes, titles)
    header = next((r for r in records if r.get("kind") == "header"), None)
    base = datetime.fromisoformat(str(header["started"]).replace("Z", "+00:00")).timestamp() * 1000 if header else 0.0
    last = base
    for record in records:
        if record.get("kind") != "message":
            continue
        last = base + float(record["t"])
        spans.handle(record["dir"], record["msg"], last)
    spans.close(last)


def with_telemetry(
    tap: Callable[[Literal["in", "out"], Any], None] | None,
    telemetry: OtelTap | None,
    *,
    inbound: list[InboundMiddleware] | None = None,
    outbound: list[OutboundMiddleware] | None = None,
) -> dict[str, Any]:
    """Peer options (`tap`, `inbound`, `outbound`) for a `tap` and/or `telemetry`."""
    if telemetry is None:
        out: dict[str, Any] = {}
        if tap is not None:
            out["tap"] = tap
        if inbound:
            out["inbound"] = inbound
        if outbound:
            out["outbound"] = outbound
        return out
    tel = telemetry

    def both(direction: Literal["in", "out"], message: Any) -> None:
        if tap is not None:
            tap(direction, message)
        tel(direction, message)

    # Inbound outermost: the other middleware run inside the span too. Outbound innermost: the
    # trace context goes on the params as finally sent.
    return {"tap": both, "inbound": [tel.inbound, *(inbound or [])], "outbound": [*(outbound or []), tel.outbound]}
