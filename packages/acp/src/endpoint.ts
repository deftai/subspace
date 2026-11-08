/**
 * `agentEndpoint()`: the raw agent side of an ACP connection. Every inbound
 * request and notification goes, as sent, through the layers you choose and
 * then to your `request` / `notification` handlers; nothing is answered for
 * you. For proxies, pipelines, and agents with methods of their own. See
 * `docs/AGENT-LAYERS.md`.
 *
 *   const endpoint = agentEndpoint(channel, {
 *     name: 'proxy',
 *     async request(call, ctx) { return downstream.request(call.method, call.params, { signal: ctx.signal }); },
 *     notification(call) { void downstream.notify(call.method, call.params); },
 *   });
 *
 * A handler's return value is the result; a thrown `RpcError` is the error
 * reply, code and data kept.
 */
import {
  cancelRequest,
  RpcError,
  RpcPeer,
  type Channel,
  type CloseInfo,
  type JsonRpcId,
  type RequestOptions,
  type RpcPeerOptions,
} from '@deft-subspace/kernel';

/** An inbound or outbound method call (not a reply). */
export interface EndpointCall {
  method: string;
  params: unknown;
  /** Present for inbound requests. */
  id?: JsonRpcId;
}

/** A JSON-RPC reply (for wire hooks; call middleware sees results and thrown errors). */
export type EndpointReply =
  | { id: JsonRpcId; result: unknown }
  | { id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

/** Typed slot for state one layer provides to the layers after it. */
export interface StateKey<T> {
  readonly name: string;
  /** Type marker only. */
  readonly __type?: T;
}
export const stateKey = <T>(name: string): StateKey<T> => ({ name });

/** Send to the client, through the layers' outbound hooks. */
export interface EndpointClient {
  request<Result = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<Result>;
  /** Notifications keep their order: each waits for the previous one's hooks and write. */
  notify(method: string, params?: unknown): Promise<void>;
}

/** What every hook and handler gets, for this endpoint. */
export interface EndpointContext {
  readonly name: string;
  readonly peer: RpcPeer;
  readonly client: EndpointClient;
  /** A value a layer earlier in the stack provided. Throws if it was never set. */
  get<T>(key: StateKey<T>): T;
  /** The value, or undefined if not set yet (e.g. before `initialize`). */
  peek<T>(key: StateKey<T>): T | undefined;
  /** Set a value this layer declared in `provides`. */
  set<T>(key: StateKey<T>, value: T): void;
}

/** One inbound call: the endpoint context plus this call's signal. */
export interface CallContext extends EndpointContext {
  /** Aborted by `$/cancel_request` for this request, or when the connection closes. */
  readonly signal: AbortSignal;
}

/** Continue with the current call, or a replacement. At most once. */
export type Next = (call?: EndpointCall) => Promise<unknown>;

export interface AgentLayer<State = unknown> {
  name: string;
  /** Called once per endpoint: this layer's state there. */
  create?(ctx: EndpointContext): State;
  /** Methods this layer answers. Exclusive: two layers may not answer the same method. `next` goes to the endpoint's handler. */
  requests?: Record<string, (call: EndpointCall, ctx: CallContext, state: State, next: Next) => unknown>;
  notifications?: Record<string, (call: EndpointCall, ctx: CallContext, state: State, next: Next) => unknown>;
  /** Wraps every inbound call before dispatch: watch, rewrite (`next(call)`), or refuse (throw). */
  inbound?(call: EndpointCall & { kind: 'request' | 'notification' }, ctx: CallContext, state: State, next: Next): unknown;
  /** Wraps every call to the client; for requests, `next` resolves with the result (or throws the error). */
  outbound?(call: EndpointCall & { kind: 'request' | 'notification' }, ctx: EndpointContext, state: State, next: Next): Promise<unknown>;
  provides?: Array<StateKey<unknown>>;
  requires?: Array<StateKey<unknown>>;
  /** The connection closed. */
  closed?(info: CloseInfo, ctx: EndpointContext, state: State): void | Promise<void>;
}

export interface AgentEndpointOptions {
  name: string;
  /** First layer = outermost: first to see an inbound call, last to see its result. */
  layers?: AgentLayer<any>[];
  /** Requests no layer answered. Default: method not found. */
  request?(call: EndpointCall, ctx: CallContext): unknown;
  /** Notifications no layer answered. Default: dropped. */
  notification?(call: EndpointCall, ctx: CallContext): unknown;
  /** Peer options (`tap`, `onDiagnostic`, `timeoutMs`, ...). `$/cancel_request` is on unless you pass your own cancel options. */
  peer?: Omit<RpcPeerOptions, 'name' | 'inbound' | 'outbound'>;
}

export interface AgentEndpoint {
  readonly peer: RpcPeer;
  readonly client: EndpointClient;
  readonly context: EndpointContext;
}

/** Calls `step` with a continuation that may run once; a second call throws. */
function once(name: string, run: (call: EndpointCall) => Promise<unknown>, current: EndpointCall): Next {
  let used = false;
  return (call?: EndpointCall) => {
    if (used) return Promise.reject(new Error(`${name}: next() called twice`));
    used = true;
    return run(call ?? current);
  };
}

/** Check the stack before anything runs: exclusive methods, and requires met by an earlier layer. */
function checkStack(name: string, layers: AgentLayer<any>[]): void {
  const requests = new Map<string, string>();
  const notifications = new Map<string, string>();
  const provided = new Set<string>();
  for (const layer of layers) {
    for (const key of layer.requires ?? []) {
      if (!provided.has(key.name)) throw new Error(`${name}: layer "${layer.name}" requires "${key.name}", which no earlier layer provides`);
    }
    for (const [kind, seen, map] of [
      ['request', requests, layer.requests],
      ['notification', notifications, layer.notifications],
    ] as const) {
      for (const method of Object.keys(map ?? {})) {
        const other = seen.get(method);
        if (other) throw new Error(`${name}: layers "${other}" and "${layer.name}" both answer the ${kind} ${method}`);
        seen.set(method, layer.name);
      }
    }
    for (const key of layer.provides ?? []) provided.add(key.name);
  }
}

export function agentEndpoint(channel: Channel<unknown>, options: AgentEndpointOptions): AgentEndpoint {
  const layers = options.layers ?? [];
  checkStack(options.name, layers);

  const peerOptions = options.peer ?? {};
  const peer = new RpcPeer(channel, {
    ...('cancelInbound' in peerOptions || 'cancelOutbound' in peerOptions ? {} : cancelRequest),
    ...peerOptions,
    name: options.name,
  });

  const values = new Map<string, unknown>();
  const owners = new Map<string, string>();
  for (const layer of layers) for (const key of layer.provides ?? []) owners.set(key.name, layer.name);

  // Notifications are serialized: hooks then write, one at a time.
  let notifyTail: Promise<unknown> = Promise.resolve();

  const outboundChain = (kind: 'request' | 'notification', call: EndpointCall, send: (call: EndpointCall) => Promise<unknown>) => {
    const hooks = layers.filter((l) => l.outbound);
    const dispatch = (index: number, current: EndpointCall): Promise<unknown> => {
      const layer = hooks[index];
      if (!layer) return send(current);
      const next = once(`${options.name}/${layer.name} outbound`, (c) => dispatch(index + 1, c), current);
      return layer.outbound!({ ...current, kind }, context, states.get(layer), next);
    };
    return dispatch(0, call);
  };

  const client: EndpointClient = {
    request<Result>(method: string, params?: unknown, requestOptions?: RequestOptions) {
      return outboundChain('request', { method, params }, (c) => peer.request(c.method, c.params, requestOptions)) as Promise<Result>;
    },
    notify(method: string, params?: unknown) {
      const run = () => outboundChain('notification', { method, params }, (c) => peer.notify(c.method, c.params));
      const sent = notifyTail.then(run, run);
      notifyTail = sent.catch(() => {});
      return sent as Promise<void>;
    },
  };

  const context: EndpointContext = {
    name: options.name,
    peer,
    client,
    get<T>(key: StateKey<T>): T {
      if (!values.has(key.name)) throw new Error(`${options.name}: "${key.name}" is not set yet`);
      return values.get(key.name) as T;
    },
    peek<T>(key: StateKey<T>): T | undefined {
      return values.get(key.name) as T | undefined;
    },
    set<T>(key: StateKey<T>, value: T): void {
      if (!owners.has(key.name)) throw new Error(`${options.name}: no layer provides "${key.name}"`);
      values.set(key.name, value);
    },
  };

  // Per-endpoint state, created once each layer's turn comes.
  const states = new Map<AgentLayer<any>, unknown>();
  for (const layer of layers) states.set(layer, layer.create?.(context));

  const handle = (kind: 'request' | 'notification', call: EndpointCall, ctx: CallContext): Promise<unknown> => {
    const hooks = layers.filter((l) => l.inbound);
    const dispatchMethod = async (current: EndpointCall): Promise<unknown> => {
      for (const layer of layers) {
        const handler = (kind === 'request' ? layer.requests : layer.notifications)?.[current.method];
        if (handler) {
          const next = once(`${options.name}/${layer.name} ${current.method}`, (c) => fallback(kind, c, ctx), current);
          return handler(current, ctx, states.get(layer), next);
        }
      }
      return fallback(kind, current, ctx);
    };
    const dispatch = async (index: number, current: EndpointCall): Promise<unknown> => {
      const layer = hooks[index];
      if (!layer) return dispatchMethod(current);
      const next = once(`${options.name}/${layer.name} inbound`, (c) => dispatch(index + 1, c), current);
      return layer.inbound!({ ...current, kind }, ctx, states.get(layer), next);
    };
    return dispatch(0, call);
  };

  const fallback = async (kind: 'request' | 'notification', call: EndpointCall, ctx: CallContext): Promise<unknown> => {
    if (kind === 'request') {
      if (!options.request) throw RpcError.methodNotFound(call.method);
      return options.request(call, ctx);
    }
    return options.notification?.(call, ctx);
  };

  const callContext = (signal: AbortSignal): CallContext => ({ ...context, signal });

  peer.onRequest('*', (params, inbound) =>
    handle('request', { method: inbound.method, params, id: inbound.id }, callContext(inbound.signal))
  );
  // Request cancellation is protocol mechanics: the peer aborts the request's
  // signal; the call is not passed on (its id means nothing elsewhere).
  const cancelMethod = ('cancelInbound' in peerOptions ? peerOptions.cancelInbound : cancelRequest.cancelInbound)?.method;
  peer.onNotification('*', (params, inbound) => {
    if (inbound.method === cancelMethod) return;
    // The peer reports a throwing notification handler as a diagnostic.
    return handle('notification', { method: inbound.method, params }, callContext(inbound.signal)) as unknown as void;
  });

  void peer.closed.then(async (info) => {
    for (const layer of layers) {
      try {
        await layer.closed?.(info, context, states.get(layer));
      } catch {
        // A layer's cleanup must not stop the others.
      }
    }
  });

  peer.start();
  return { peer, client, context };
}
