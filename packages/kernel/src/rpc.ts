import type { Channel } from './channel.ts';
import { systemClock, type Clock } from './clock.ts';
import { ErrorCode, LocalError, RpcError } from './errors.ts';

/**
 * JSON-RPC ids are opaque. `0` and `""` are as valid as any other id, and
 * JSON-RPC 2.0 also allows `null` (discouraged) for requests we receive.
 * Requests we send always get a number.
 */
export type JsonRpcId = string | number | null;

export interface RequestOptions {
  /** Stop waiting when this fires. The peer is told, if a cancel method is configured. */
  signal?: AbortSignal;
  /** Stop waiting after this long. Overrides the peer's default. `0` or `Infinity` means no limit. */
  timeoutMs?: number;
}

export interface InboundContext {
  method: string;
  /** Present for requests, absent for notifications. */
  id?: JsonRpcId;
  /** Fires when the other side cancels this request, or the connection closes. */
  signal: AbortSignal;
  /** The peer, for calling back to the other side while handling. */
  peer: RpcPeer;
}

export type RequestHandler = (params: any, context: InboundContext) => unknown;
export type NotificationHandler = (params: any, context: InboundContext) => void;

/** A message as middleware sees it. */
export interface Call {
  kind: 'request' | 'notification';
  method: string;
  params: unknown;
  id?: JsonRpcId;
}

/** Wraps inbound handling. Call `next()` to run the handler (and inner middleware). */
export type InboundMiddleware = (call: Call, next: () => Promise<unknown>, context: InboundContext) => Promise<unknown>;
/** Wraps outbound calls. `next(params)` sends; it resolves with the result (requests) or undefined (notifications). */
export type OutboundMiddleware = (call: Call, next: (params: unknown) => Promise<unknown>) => Promise<unknown>;

export interface PeerDiagnostic {
  kind:
    | 'invalid-message'
    | 'late-response'
    | 'handler-failed'
    | 'duplicate-request-id';
  message: string;
  detail?: unknown;
}

export interface RpcPeerOptions {
  /** Shown in errors and diagnostics. */
  name?: string;
  clock?: Clock;
  /** Default timeout for outbound requests. Default: none. */
  timeoutMs?: number;
  /**
   * How to tell the other side we stopped waiting (abort or timeout), e.g.
   * ACP/LSP `$/cancel_request` with `{ requestId }`. Default: nothing is sent.
   */
  cancelOutbound?: { method: string; params: (id: JsonRpcId) => unknown };
  /** Which inbound notification cancels one of our handlers, and how to find its id. */
  cancelInbound?: { method: string; id: (params: any) => JsonRpcId | undefined };
  inbound?: InboundMiddleware[];
  outbound?: OutboundMiddleware[];
  /** Sees every message in both directions, e.g. for tracing. Must not throw. */
  tap?: (direction: 'in' | 'out', message: unknown) => void;
  onDiagnostic?: (diagnostic: PeerDiagnostic) => void;
}

export interface CloseInfo {
  /** `local`: close() was called. `remote-ended`: the other side's stream ended. `error`: the stream failed. */
  reason: 'local' | 'remote-ended' | 'error';
  error?: unknown;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanups: Array<() => void>;
}

const isId = (value: unknown): value is JsonRpcId =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One side of a JSON-RPC 2.0 connection.
 *
 * Every outbound request has exactly one owner, this peer, and ends exactly
 * once, in `settle()`: with the answer, or with a `LocalError` saying why we
 * stopped waiting (`aborted`, `timeout`, `closed`). Late answers are reported,
 * never delivered.
 *
 * Inbound requests run concurrently, so a handler that waits on a call back to
 * the other side never stops other messages from being read. Notification
 * handlers run in arrival order.
 */
export class RpcPeer {
  readonly name: string;
  readonly closed: Promise<CloseInfo>;

  private readonly clock: Clock;
  private readonly options: RpcPeerOptions;
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly inbound = new Map<JsonRpcId, AbortController>();
  private readonly connectionAbort = new AbortController();
  private readonly writer: WritableStreamDefaultWriter<unknown>;
  private reader?: ReadableStreamDefaultReader<unknown>;
  private nextId = 0;
  private started = false;
  private closeInfo?: CloseInfo;
  private resolveClosed!: (info: CloseInfo) => void;

  private readonly channel: Channel<unknown>;

  constructor(channel: Channel<unknown>, options: RpcPeerOptions = {}) {
    this.channel = channel;
    this.options = options;
    this.name = options.name ?? 'peer';
    this.clock = options.clock ?? systemClock;
    this.writer = channel.writable.getWriter();
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
  }

  /** True once the connection has closed for any reason. */
  get isClosed(): boolean {
    return this.closeInfo !== undefined;
  }

  /** Outbound requests still waiting for an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Aborted when the connection closes. */
  get signal(): AbortSignal {
    return this.connectionAbort.signal;
  }

  onRequest(method: string, handler: RequestHandler): this {
    this.requestHandlers.set(method, handler);
    return this;
  }

  onNotification(method: string, handler: NotificationHandler): this {
    this.notificationHandlers.set(method, handler);
    return this;
  }

  /** Start reading. Register handlers first. */
  start(): this {
    if (this.started) return this;
    this.started = true;
    void this.readLoop();
    return this;
  }

  request<Result = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<Result> {
    const call: Call = { kind: 'request', method, params };
    return this.runOutbound(call, (finalParams) => this.sendRequest(method, finalParams, options)) as Promise<Result>;
  }

  notify(method: string, params?: unknown): Promise<void> {
    const call: Call = { kind: 'notification', method, params };
    return this.runOutbound(call, async (finalParams) => {
      await this.write(this.message({ method, params: finalParams }));
      return undefined;
    }) as Promise<void>;
  }

  /**
   * Write a message exactly as given (`jsonrpc: '2.0'` is added if missing),
   * outside request tracking. For proxies and adapters, e.g. answering an id
   * this peer did not receive. Prefer request/notify/handlers otherwise.
   */
  sendRaw(message: Record<string, unknown>): Promise<void> {
    return this.write('jsonrpc' in message ? message : this.message(message));
  }

  /** Close the connection. Pending requests fail with `closed`; running handlers are aborted. */
  async close(): Promise<CloseInfo> {
    this.finish({ reason: 'local' });
    await this.reader?.cancel().catch(() => {});
    return this.closed;
  }

  // ---- outbound -----------------------------------------------------------

  private runOutbound(call: Call, send: (params: unknown) => Promise<unknown>): Promise<unknown> {
    const chain = this.options.outbound ?? [];
    const dispatch = (index: number, params: unknown): Promise<unknown> => {
      const middleware = chain[index];
      if (!middleware) return send(params);
      return middleware({ ...call, params }, (next) => dispatch(index + 1, next));
    };
    return dispatch(0, call.params);
  }

  private sendRequest(method: string, params: unknown, options: RequestOptions): Promise<unknown> {
    if (this.closeInfo) {
      return Promise.reject(new LocalError('closed', `${this.name}: connection closed before ${method} was sent`, { method }));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new LocalError('aborted', `${this.name}: ${method} aborted before it was sent`, { method, cause: options.signal.reason }));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject, cleanups: [] };
      this.pending.set(id, pending);

      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
      if (timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        const handle = this.clock.setTimeout(() => {
          this.giveUp(id, new LocalError('timeout', `${this.name}: ${method} timed out after ${timeoutMs} ms`, { method }));
        }, timeoutMs);
        pending.cleanups.push(() => this.clock.clearTimeout(handle));
      }

      const signal = options.signal;
      if (signal) {
        const onAbort = () =>
          this.giveUp(id, new LocalError('aborted', `${this.name}: ${method} aborted`, { method, cause: signal.reason }));
        signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanups.push(() => signal.removeEventListener('abort', onAbort));
      }

      this.write(this.message({ id, method, params })).catch((error) => {
        this.settle(id, { ok: false, error: new LocalError('send-failed', `${this.name}: could not send ${method}`, { method, cause: error }) });
      });
    });
  }

  /** We stopped waiting: settle, then tell the other side if configured. */
  private giveUp(id: JsonRpcId, error: LocalError): void {
    if (!this.settle(id, { ok: false, error })) return;
    const cancel = this.options.cancelOutbound;
    if (cancel && !this.closeInfo) {
      void this.write(this.message({ method: cancel.method, params: cancel.params(id) })).catch(() => {});
    }
  }

  /** The only place a pending request ends. Returns false if it had already ended. */
  private settle(id: JsonRpcId, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    for (const cleanup of pending.cleanups) cleanup();
    if (outcome.ok) pending.resolve(outcome.value);
    else pending.reject(outcome.error);
    return true;
  }

  // ---- inbound ------------------------------------------------------------

  private async readLoop(): Promise<void> {
    const reader = this.channel.readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.receive(value);
      }
      this.finish({ reason: 'remote-ended' });
    } catch (error) {
      this.finish(this.closeInfo ?? { reason: 'error', error });
    }
  }

  private receive(message: unknown): void {
    this.tap('in', message);
    if (!isRecord(message)) {
      this.diagnose('invalid-message', 'Message is not a JSON object', message);
      if (Array.isArray(message)) void this.replyError(null, ErrorCode.InvalidRequest, 'Batches are not supported');
      return;
    }
    const { method, id } = message;
    if (typeof method === 'string') {
      if ('id' in message) {
        if (isId(id)) this.handleRequest(id, method, message.params);
        else void this.replyError(null, ErrorCode.InvalidRequest, 'Request id must be a string, number or null');
        return;
      }
      this.handleNotification(method, message.params);
      return;
    }
    if ('id' in message && ('result' in message || 'error' in message)) {
      this.handleResponse(message);
      return;
    }
    this.diagnose('invalid-message', 'Message is not a request, notification or response', message);
    if (isId(id)) void this.replyError(id, ErrorCode.InvalidRequest, 'Invalid request');
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (!isId(id) || id === null || !this.pending.has(id)) {
      this.diagnose('late-response', `Response for unknown or finished request ${JSON.stringify(id)}`, message);
      return;
    }
    if ('error' in message && message.error !== undefined && message.error !== null) {
      const error = message.error;
      if (isRecord(error) && typeof error.code === 'number' && typeof error.message === 'string') {
        this.settle(id, { ok: false, error: new RpcError(error.code, error.message, error.data) });
      } else {
        const method = this.pending.get(id)?.method;
        this.settle(id, { ok: false, error: new LocalError('invalid-response', `${this.name}: malformed error for ${method}`, { method, cause: error }) });
      }
      return;
    }
    this.settle(id, { ok: true, value: message.result });
  }

  private handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (this.inbound.has(id)) this.diagnose('duplicate-request-id', `Request id ${JSON.stringify(id)} reused while in flight`);
    const controller = new AbortController();
    const onClose = () => controller.abort(new LocalError('closed', 'connection closed'));
    this.connectionAbort.signal.addEventListener('abort', onClose, { once: true });
    this.inbound.set(id, controller);
    const context: InboundContext = { method, id, signal: controller.signal, peer: this };

    const run = async () => {
      try {
        const handler = this.requestHandlers.get(method) ?? this.requestHandlers.get('*');
        const result = await this.runInbound({ kind: 'request', method, params, id }, context, async () => {
          if (!handler) throw RpcError.methodNotFound(method);
          return handler(params, context);
        });
        await this.write(this.message({ id, result: result === undefined ? null : result }));
      } catch (error) {
        if (this.closeInfo) return;
        if (RpcError.is(error)) {
          await this.write(this.message({ id, error: error.toJSON() })).catch(() => {});
        } else if (controller.signal.aborted) {
          await this.replyError(id, ErrorCode.RequestCancelled, 'Request cancelled');
        } else {
          this.diagnose('handler-failed', `Handler for ${method} threw`, error);
          await this.replyError(id, ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (this.inbound.get(id) === controller) this.inbound.delete(id);
        this.connectionAbort.signal.removeEventListener('abort', onClose);
      }
    };
    void run();
  }

  private handleNotification(method: string, params: unknown): void {
    const cancel = this.options.cancelInbound;
    if (cancel && method === cancel.method) {
      const target = cancel.id(params);
      if (target !== undefined) this.inbound.get(target)?.abort(new LocalError('aborted', 'cancelled by the other side'));
    }
    const handler = this.notificationHandlers.get(method) ?? this.notificationHandlers.get('*');
    if (!handler) return;
    const context: InboundContext = { method, signal: this.connectionAbort.signal, peer: this };
    const fail = (error: unknown) => this.diagnose('handler-failed', `Notification handler for ${method} threw`, error);
    try {
      const result = this.runInbound({ kind: 'notification', method, params }, context, async () => handler(params, context));
      result.catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  private runInbound(call: Call, context: InboundContext, handle: () => Promise<unknown>): Promise<unknown> {
    const chain = this.options.inbound ?? [];
    const dispatch = (index: number): Promise<unknown> => {
      const middleware = chain[index];
      return middleware ? middleware(call, () => dispatch(index + 1), context) : handle();
    };
    return dispatch(0);
  }

  // ---- plumbing -----------------------------------------------------------

  private message(body: Record<string, unknown>): Record<string, unknown> {
    return { jsonrpc: '2.0', ...body };
  }

  private replyError(id: JsonRpcId | null, code: number, message: string): Promise<void> {
    return this.write(this.message({ id, error: { code, message } })).catch(() => {});
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    if (this.closeInfo) throw new LocalError('closed', `${this.name}: connection closed`);
    this.tap('out', message);
    await this.writer.write(message);
  }

  private tap(direction: 'in' | 'out', message: unknown): void {
    try {
      this.options.tap?.(direction, message);
    } catch {
      // Taps are observers; they never change behaviour.
    }
  }

  private diagnose(kind: PeerDiagnostic['kind'], message: string, detail?: unknown): void {
    try {
      this.options.onDiagnostic?.({ kind, message, detail });
    } catch {
      // ignore
    }
  }

  private finish(info: CloseInfo): void {
    if (this.closeInfo) return;
    this.closeInfo = info;
    this.connectionAbort.abort(new LocalError('closed', `${this.name}: connection closed`));
    const error = new LocalError(
      'closed',
      info.reason === 'remote-ended'
        ? `${this.name}: the other side closed the connection`
        : info.reason === 'error'
          ? `${this.name}: the connection failed`
          : `${this.name}: connection closed`,
      { cause: info.error }
    );
    for (const id of [...this.pending.keys()]) {
      const method = this.pending.get(id)?.method;
      this.settle(id, { ok: false, error: new LocalError('closed', `${error.message} while waiting for ${method}`, { method, cause: info.error }) });
    }
    void this.writer.close().catch(() => {});
    this.resolveClosed(info);
  }
}
