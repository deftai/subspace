/**
 * OpenTelemetry spans for an ACP connection, from the messages it carries.
 *
 *   import * as otel from '@opentelemetry/api';
 *   const client = await AcpClient.connect(channel, { telemetry: otelTap(otel) });  // a client
 *   serveAgent(channel, { ..., telemetry: otelTap(otel) });                         // or an agent
 *
 *   // Spans on this side only, without carrying the trace across:
 *   const tap = otelTap(otel);  ... { tap } ...  tap.close();
 *
 * - Every request is a span (CLIENT when this side sent it, SERVER when it
 *   received it), named by its method, with the RPC semantic-convention
 *   attributes. A `session/prompt` span is the turn: it ends when the turn
 *   does (v1: the answer; v2: the answer and the idle state), with
 *   `acp.stop_reason`.
 * - Inside a turn: each tool call is a span, and so is every request about
 *   the session (permission questions, file and terminal requests).
 *   Cancels, plans and usage are events and attributes on the turn.
 * - Requests start under the context that is active when they are sent, so a
 *   turn nests under your own span.
 * - Nothing from the conversation is recorded by default: no prompt or message
 *   text, and no tool titles (they can hold commands and paths). Opt in to
 *   titles with `{ titles: true }`.
 * - No dependency: pass the `@opentelemetry/api` module. Without a registered
 *   SDK, its tracer does nothing.
 *
 * - Across the connection: with `telemetry` on the client, the agent or
 *   `start()` (rather than `tap`), each request carries the W3C trace context
 *   in `_meta` (`traceparent`, `tracestate`, `baggage`, the keys ACP reserves
 *   for it), a request that carries one continues that trace, and handlers
 *   run inside their request's span, so your own spans nest under it.
 *
 * `spansFromTrace()` makes the same spans from a saved trace.
 */
import type { InboundMiddleware, OutboundMiddleware, TraceRecord } from '@deft-subspace/kernel';

type Attributes = Record<string, string | number | boolean>;

/** The part of an OpenTelemetry span this uses. */
export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  addEvent(name: string, attributes?: Attributes, time?: number): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(time?: number): void;
}

/** The part of the `@opentelemetry/api` module this uses; pass the module itself. */
export interface OtelApi {
  trace: {
    getTracer(name: string, version?: string): {
      startSpan(name: string, options?: { kind?: number; attributes?: Attributes; startTime?: number }, context?: never): OtelSpan;
    };
    setSpan(context: never, span: never): unknown;
    /** The span in a context, if any. */
    getSpan?(context: never): unknown;
  };
  context: {
    active(): unknown;
    /** Run `fn` in `context`: for handlers inside their request's span. */
    with?(context: never, fn: () => never): unknown;
  };
  /** W3C trace context in and out of `_meta`, with the registered propagator. */
  propagation?: {
    inject(context: never, carrier: never): void;
    extract(context: never, carrier: never): unknown;
  };
}

export interface OtelTapOptions {
  /** Tracer name. Default `@deft-subspace/acp`. */
  tracer?: string;
  /** Added to every span, e.g. `{ 'acp.agent': 'claude' }`. */
  attributes?: Attributes;
  /** Record tool call titles (`acp.tool_call.title`). They can hold commands and paths. Default false. */
  titles?: boolean;
}

export interface OtelTap {
  (direction: 'in' | 'out', message: unknown): void;
  /** End every span still open (marked `acp.unfinished`), e.g. when the connection closed. */
  close(): void;
  /** Peer middleware: puts the trace context in each request's `_meta` (the `telemetry` option sets it). */
  outbound: OutboundMiddleware;
  /** Peer middleware: runs each request's handler inside its span (the `telemetry` option sets it). */
  inbound: InboundMiddleware;
}

// OpenTelemetry's numbers for SpanKind and SpanStatusCode (stable API).
const INTERNAL = 0;
const SERVER = 1;
const CLIENT = 2;
const ERROR = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

interface Open {
  span: OtelSpan;
  method: string;
  sessionId?: string;
}

interface OpenTurn {
  span: OtelSpan;
  key: string;
  answered?: { stopReason?: string };
  idle?: { stopReason?: string };
  tools: Map<string, OtelSpan>;
  background: Set<string>;
}

/** The span builder; `otelTap` gives it the time now, `spansFromTrace` the trace's. */
class Spans {
  private readonly tracer: ReturnType<OtelApi['trace']['getTracer']>;
  private readonly requests = new Map<string, Open>();
  /** Spans started by `outbound` before the message is sent, by its params. */
  private readonly sending = new WeakMap<object, OtelSpan>();
  private readonly turns = new Map<string, OpenTurn>();
  private protocol = 1;
  private readonly api: OtelApi;
  private readonly options: OtelTapOptions;

  constructor(api: OtelApi, options: OtelTapOptions) {
    this.api = api;
    this.options = options;
    this.tracer = api.trace.getTracer(options.tracer ?? '@deft-subspace/acp');
  }

  handle(direction: 'in' | 'out', message: unknown, time: number): void {
    if (!isRecord(message)) return;
    const params = isRecord(message.params) ? message.params : {};
    const method = str(message.method);
    const hasId = message.id !== undefined && message.id !== null;
    if (method && hasId) this.request(direction, String(message.id), method, params, time);
    else if (method) this.notification(direction, method, params, time);
    else if (hasId) this.response(direction, String(message.id), message, time);
  }

  close(time: number): void {
    for (const sessionId of [...this.turns.keys()]) this.endTurn(sessionId, time, true);
    for (const [key, open] of this.requests) {
      open.span.setAttribute('acp.unfinished', true);
      open.span.end(time);
      this.requests.delete(key);
    }
  }

  /** Before a request is sent: its span, and params with the trace context in `_meta`. */
  stamp(method: string, params: unknown, time: number): unknown {
    if (!isRecord(params) || !this.api.propagation) return params;
    const span = this.requestSpan('out', method, params, undefined, time);
    const carrier: Record<string, string> = {};
    this.api.propagation.inject(this.api.trace.setSpan(this.api.context.active() as never, span as never) as never, carrier as never);
    if (!Object.keys(carrier).length) return params;
    const meta = isRecord(params._meta) ? params._meta : {};
    const stamped = { ...params, _meta: { ...meta, ...carrier } };
    this.sending.set(stamped, span);
    return stamped;
  }

  /** A stamped request that was never sent (the connection closed, or it was aborted first). */
  unsent(params: unknown, error: unknown, time: number): void {
    const span = isRecord(params) ? this.sending.get(params) : undefined;
    if (!span) return;
    this.sending.delete(params as object);
    span.setStatus({ code: ERROR, message: error instanceof Error ? error.message : String(error) });
    span.setAttribute('acp.unsent', true);
    span.end(time);
  }

  /** The context of a received request's span, for running its handler. */
  contextOf(id: string): unknown {
    const open = this.requests.get(`in:${id}`);
    return open ? this.api.trace.setSpan(this.api.context.active() as never, open.span as never) : undefined;
  }

  /**
   * Under what: a received request continues the trace it carries, else goes
   * in its session's turn. Something this side sends goes under the span
   * active when it is sent (e.g. the agent's own work inside the turn), else
   * in the turn.
   */
  private start(name: string, kind: number, attributes: Attributes, time: number, sessionId?: string, remote?: Record<string, unknown>, sent = false): OtelSpan {
    const turn = sessionId ? this.turns.get(sessionId) : undefined;
    let parent = this.api.context.active();
    const activeSpan = sent && this.api.trace.getSpan ? this.api.trace.getSpan(parent as never) : undefined;
    if (remote && this.api.propagation && typeof remote.traceparent === 'string') parent = this.api.propagation.extract(parent as never, remote as never);
    else if (turn && !activeSpan) parent = this.api.trace.setSpan(parent as never, turn.span as never);
    return this.tracer.startSpan(name, { kind, attributes: { ...this.options.attributes, ...attributes }, startTime: time }, parent as never);
  }

  private requestSpan(direction: 'in' | 'out', method: string, params: Record<string, unknown>, id: string | undefined, time: number): OtelSpan {
    const sessionId = str(params.sessionId);
    const attributes: Attributes = { 'rpc.system': 'jsonrpc', 'rpc.method': method };
    if (id !== undefined) attributes['rpc.jsonrpc.request_id'] = id;
    if (sessionId) attributes['acp.session_id'] = sessionId;
    const remote = direction === 'in' && isRecord(params._meta) ? params._meta : undefined;
    // A prompt is the turn: it starts under the caller's context, not an earlier turn.
    return this.start(method, direction === 'out' ? CLIENT : SERVER, attributes, time, method === 'session/prompt' ? undefined : sessionId, remote, direction === 'out');
  }

  private request(direction: 'in' | 'out', id: string, method: string, params: Record<string, unknown>, time: number): void {
    const sessionId = str(params.sessionId);
    const stamped = direction === 'out' ? this.sending.get(params) : undefined;
    if (stamped) this.sending.delete(params);
    const span = stamped ?? this.requestSpan(direction, method, params, id, time);
    if (stamped) span.setAttribute('rpc.jsonrpc.request_id', id);
    const key = `${direction}:${id}`;
    this.requests.set(key, { span, method, ...(sessionId ? { sessionId } : {}) });
    if (method === 'session/prompt' && sessionId) {
      if (this.turns.has(sessionId)) this.endTurn(sessionId, time, true);
      this.turns.set(sessionId, { span, key, tools: new Map(), background: new Set() });
    }
  }

  private notification(direction: 'in' | 'out', method: string, params: Record<string, unknown>, time: number): void {
    const sessionId = str(params.sessionId);
    if (method === '$/cancel_request') {
      // The canceller sends it about a request it sent itself.
      this.requests.get(`${direction}:${String(params.requestId)}`)?.span.addEvent('cancel requested', {}, time);
      return;
    }
    const turn = sessionId ? this.turns.get(sessionId) : undefined;
    if (method === 'session/cancel') {
      turn?.span.addEvent('session/cancel', {}, time);
      return;
    }
    if (method === 'session/update' && sessionId && isRecord(params.update)) this.update(sessionId, params.update, time);
  }

  private response(direction: 'in' | 'out', id: string, message: Record<string, unknown>, time: number): void {
    // A response travels the other way from its request.
    const key = `${direction === 'in' ? 'out' : 'in'}:${id}`;
    const open = this.requests.get(key);
    if (!open) return;
    const { span, method, sessionId } = open;
    const result = isRecord(message.result) ? message.result : {};
    if (isRecord(message.error)) {
      span.setAttribute('rpc.jsonrpc.error_code', Number(message.error.code));
      span.setAttribute('rpc.jsonrpc.error_message', String(message.error.message ?? ''));
      span.setStatus({ code: ERROR, message: String(message.error.message ?? '') });
    } else if (method === 'initialize') {
      if (typeof result.protocolVersion === 'number') {
        this.protocol = result.protocolVersion;
        span.setAttribute('acp.protocol_version', result.protocolVersion);
      }
      // v1 calls it agentInfo, v2 info.
      const agent = isRecord(result.agentInfo) ? result.agentInfo : isRecord(result.info) ? result.info : undefined;
      if (agent && str(agent.name)) span.setAttribute('acp.agent.name', String(agent.name));
      if (agent && str(agent.version)) span.setAttribute('acp.agent.version', String(agent.version));
    } else if (method === 'session/new' && str(result.sessionId)) {
      span.setAttribute('acp.session_id', String(result.sessionId));
    } else if (method === 'session/request_permission' && isRecord(result.outcome)) {
      span.setAttribute('acp.permission.outcome', String(result.outcome.outcome));
      if (str(result.outcome.optionId)) span.setAttribute('acp.permission.option_id', String(result.outcome.optionId));
    }
    const turn = sessionId ? this.turns.get(sessionId) : undefined;
    if (method === 'session/prompt' && turn?.key === key) {
      const stopReason = str(result.stopReason);
      turn.answered = stopReason ? { stopReason } : {};
      // v2 ends a turn with the idle state; the answer can come first.
      if (isRecord(message.error) || this.protocol < 2 || turn.idle) this.endTurn(sessionId!, time);
      return;
    }
    this.requests.delete(key);
    span.end(time);
  }

  private update(sessionId: string, update: Record<string, unknown>, time: number): void {
    const turn = this.turns.get(sessionId);
    const kind = String(update.sessionUpdate);
    if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_call_content_chunk') {
      const id = str(update.toolCallId);
      if (!id || !turn) return;
      let span = turn.tools.get(id);
      if (!span) {
        const attributes: Attributes = { 'acp.session_id': sessionId, 'acp.tool_call.id': id };
        if (str(update.kind)) attributes['acp.tool_call.kind'] = String(update.kind);
        if (this.options.titles && str(update.title)) attributes['acp.tool_call.title'] = String(update.title);
        span = this.start('tool_call', INTERNAL, attributes, time, sessionId);
        turn.tools.set(id, span);
      }
      if (str(update.kind)) span.setAttribute('acp.tool_call.kind', String(update.kind));
      if (this.options.titles && str(update.title)) span.setAttribute('acp.tool_call.title', String(update.title));
      const status = str(update.status);
      if (status) {
        span.setAttribute('acp.tool_call.status', status);
        if (status === 'failed') span.setStatus({ code: ERROR, message: 'failed' });
        if (status === 'completed' || status === 'failed') {
          span.end(time);
          turn.tools.delete(id);
        }
      }
      return;
    }
    if (!turn) return;
    if (kind === 'usage_update') {
      if (typeof update.used === 'number') turn.span.setAttribute('acp.usage.used', update.used);
      if (typeof update.size === 'number') turn.span.setAttribute('acp.usage.size', update.size);
    } else if (kind === 'plan' || kind === 'plan_update') {
      const entries = kind === 'plan' ? update.entries : isRecord(update.plan) ? update.plan.entries : undefined;
      turn.span.addEvent('plan', { 'acp.plan.entries': Array.isArray(entries) ? entries.length : 0 }, time);
    } else if (kind === 'state_update') {
      const background = Array.isArray(update.background) ? update.background : [];
      turn.background = new Set(background.flatMap((b) => (isRecord(b) && b.type === 'tool_call' && str(b.toolCallId) ? [String(b.toolCallId)] : [])));
      if (update.state === 'idle') {
        turn.idle = { ...(str(update.stopReason) ? { stopReason: String(update.stopReason) } : {}) };
        if (turn.answered) this.endTurn(sessionId, time);
      }
    }
  }

  /** End a turn's span, and its tool calls still open (except background work). */
  private endTurn(sessionId: string, time: number, unfinished = false): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    this.requests.delete(turn.key);
    const stopReason = turn.idle?.stopReason ?? turn.answered?.stopReason ?? (turn.answered || turn.idle ? 'end_turn' : undefined);
    if (stopReason) turn.span.setAttribute('acp.stop_reason', stopReason);
    if (unfinished) turn.span.setAttribute('acp.unfinished', true);
    for (const [id, span] of turn.tools) {
      span.setAttribute('acp.unfinished', true);
      if (turn.background.has(id)) span.setAttribute('acp.tool_call.background', true);
      span.end(time);
    }
    turn.span.end(time);
  }
}

/** An `RpcPeerOptions.tap` that makes OpenTelemetry spans; see the module comment. */
export function otelTap(api: OtelApi, options: OtelTapOptions = {}): OtelTap {
  const spans = new Spans(api, options);
  const tap = ((direction: 'in' | 'out', message: unknown) => spans.handle(direction, message, Date.now())) as OtelTap;
  tap.close = () => spans.close(Date.now());
  tap.outbound = (call, next) => {
    if (call.kind !== 'request') return next(call.params);
    const params = spans.stamp(call.method, call.params, Date.now());
    const sent = next(params);
    sent.catch((error: unknown) => spans.unsent(params, error, Date.now()));
    return sent;
  };
  tap.inbound = (call, next) => {
    const context = call.kind === 'request' && call.id !== undefined && api.context.with ? spans.contextOf(String(call.id)) : undefined;
    return context === undefined ? next() : (api.context.with!(context as never, next as never) as Promise<unknown>);
  };
  return tap;
}

/**
 * The same spans from a saved trace (`start({ trace })`, `--trace`), at the
 * times it recorded. Spans still open at the end are ended there.
 */
export function spansFromTrace(records: readonly TraceRecord[], api: OtelApi, options: OtelTapOptions = {}): void {
  const spans = new Spans(api, options);
  const header = records.find((r) => r.kind === 'header');
  const base = header ? Date.parse(header.started) : 0;
  let last = base;
  for (const record of records) {
    if (record.kind !== 'message') continue;
    last = base + record.t;
    spans.handle(record.dir, record.msg, last);
  }
  spans.close(last);
}

/** @internal Peer options for a `tap` and/or `telemetry`. */
export function withTelemetry(
  tap: ((direction: 'in' | 'out', message: unknown) => void) | undefined,
  telemetry: OtelTap | undefined,
  options: { inbound?: InboundMiddleware[]; outbound?: OutboundMiddleware[] } = {}
): { tap?: (direction: 'in' | 'out', message: unknown) => void; inbound?: InboundMiddleware[]; outbound?: OutboundMiddleware[] } {
  if (!telemetry) return { ...(tap ? { tap } : {}), ...options };
  return {
    tap: tap
      ? (direction, message) => {
          tap(direction, message);
          telemetry(direction, message);
        }
      : telemetry,
    // Inbound outermost: the other middleware run inside the span too. Outbound
    // innermost: the trace context goes on the params as finally sent.
    inbound: [telemetry.inbound, ...(options.inbound ?? [])],
    outbound: [...(options.outbound ?? []), telemetry.outbound],
  };
}
