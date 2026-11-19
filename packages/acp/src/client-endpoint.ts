/**
 * `clientEndpoint()`: the raw client side of an ACP connection, mirroring
 * `agentEndpoint()`. Every inbound request and notification from the agent
 * goes, as sent, through the layers you choose and then to your `request` /
 * `notification` handlers; nothing is answered for you.
 *
 *   const endpoint = clientEndpoint(channel, {
 *     name: 'my-client',
 *     layers: [myLayer],
 *     async request(call, ctx) { ... },
 *     notification(call, ctx) { ... },
 *   });
 *
 * See `docs/AGENT-LAYERS.md`.
 */
import {
  cancelRequest,
  RpcError,
  RpcPeer,
  type Channel,
  type CloseInfo,
  type RequestOptions,
  type RpcPeerOptions,
} from '@deft-subspace/kernel';
import type { AuthMethod } from './auth.ts';
import type { AgentSupport } from './capabilities.ts';
import {
  stateKey,
  type EndpointCall,
  type Next,
  type StateKey,
} from './endpoint.ts';
import type { ProtocolVersion } from './model.ts';

/** Send to the agent, through the layers' outbound hooks. */
export interface EndpointAgent {
  request<Result = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<Result>;
  /** Notifications keep their order: each waits for the previous one's hooks and write. */
  notify(method: string, params?: unknown): Promise<void>;
}

/** What every client hook and handler gets, for this endpoint. */
export interface ClientEndpointContext {
  readonly name: string;
  readonly peer: RpcPeer;
  readonly agent: EndpointAgent;
  /** A value a layer earlier in the stack provided. Throws if it was never set. */
  get<T>(key: StateKey<T>): T;
  /** The value, or undefined if not set yet (e.g. before `initialize`). */
  peek<T>(key: StateKey<T>): T | undefined;
  /** Set a value this layer declared in `provides`. */
  set<T>(key: StateKey<T>, value: T): void;
}

/** One inbound call from the agent: the endpoint context plus this call's signal. */
export interface ClientCallContext extends ClientEndpointContext {
  /** Aborted by `$/cancel_request` for this request, or when the connection closes. */
  readonly signal: AbortSignal;
}

export interface ClientLayer<State = unknown> {
  name: string;
  /** Called once per endpoint: this layer's state there. */
  create?(ctx: ClientEndpointContext): State;
  /** Methods this layer answers. Exclusive: two layers may not answer the same method. `next` goes to the endpoint's handler. */
  requests?: Record<string, (call: EndpointCall, ctx: ClientCallContext, state: State, next: Next) => unknown>;
  notifications?: Record<string, (call: EndpointCall, ctx: ClientCallContext, state: State, next: Next) => unknown>;
  /** Wraps every inbound call before dispatch: watch, rewrite (`next(call)`), or refuse (throw). */
  inbound?(call: EndpointCall & { kind: 'request' | 'notification' }, ctx: ClientCallContext, state: State, next: Next): unknown;
  /** Wraps every call to the agent; for requests, `next` resolves with the result (or throws the error). */
  outbound?(call: EndpointCall & { kind: 'request' | 'notification' }, ctx: ClientEndpointContext, state: State, next: Next): Promise<unknown>;
  provides?: Array<StateKey<unknown>>;
  requires?: Array<StateKey<unknown>>;
  /** The connection closed. */
  closed?(info: CloseInfo, ctx: ClientEndpointContext, state: State): void | Promise<void>;
}

export interface ClientEndpointOptions {
  name: string;
  /** First layer = outermost: first to see an inbound/outbound call, last to see its result. */
  layers?: ClientLayer<any>[];
  /** Requests from the agent that no layer answered. Default: method not found. */
  request?(call: EndpointCall, ctx: ClientCallContext): unknown;
  /** Notifications from the agent that no layer answered. Default: dropped. */
  notification?(call: EndpointCall, ctx: ClientCallContext): unknown;
  /** Peer options (`tap`, `onDiagnostic`, `timeoutMs`, ...). `$/cancel_request` is on unless you pass your own cancel options. */
  peer?: Omit<RpcPeerOptions, 'name'>;
}

export interface ClientEndpoint {
  readonly peer: RpcPeer;
  readonly agent: EndpointAgent;
  readonly context: ClientEndpointContext;
}

/**
 * The agent's negotiated identity, capabilities (including `_meta`), and auth
 * methods, populated by `AcpClient`'s negotiate layer once `initialize` returns.
 */
export interface NegotiatedAgent {
  readonly protocol: ProtocolVersion;
  readonly info: { readonly name?: string; readonly title?: string; readonly version?: string };
  /** The agent's capabilities as returned by `initialize`, including `_meta`. */
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly supports: AgentSupport;
  readonly authMethods: readonly AuthMethod[];
  /** The full `initialize` result as returned by the agent. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** State key through which layers read the agent's negotiated info and capabilities after `initialize`. */
export const NEGOTIATED_AGENT: StateKey<NegotiatedAgent> = stateKey<NegotiatedAgent>('acp:negotiated-agent');

/**
 * Expand a map of vendor extension handlers so every declared method is
 * registered under both its bare spelling (`name`) and its `_`-prefixed
 * spelling (`_name`). Accepts either bare or `_`-prefixed keys.
 *
 * Throws if both spellings of the same name are supplied with different
 * handlers, or if a method name is empty (or just `"_"`).
 */
export function bothSpellings<H>(handlers: Record<string, H>): Record<string, H> {
  const expanded: Record<string, H> = {};
  for (const [rawName, handler] of Object.entries(handlers)) {
    const bare = rawName.startsWith('_') ? rawName.slice(1) : rawName;
    if (!bare) {
      throw new Error(`Invalid vendor extension method name: "${rawName}"`);
    }
    const prefixed = `_${bare}`;
    if (bare in expanded && expanded[bare] !== handler) {
      throw new Error(`Duplicate vendor extension handler for "${bare}" and "${prefixed}"`);
    }
    expanded[bare] = handler;
    expanded[prefixed] = handler;
  }
  return expanded;
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
function checkStack(name: string, layers: ClientLayer<any>[]): void {
  const requests = new Map<string, string>();
  const notifications = new Map<string, string>();
  const provided = new Set<string>();
  for (const layer of layers) {
    for (const key of layer.requires ?? []) {
      if (!provided.has(key.name)) {
        throw new Error(`${name}: layer "${layer.name}" requires "${key.name}", which no earlier layer provides`);
      }
    }
    for (const [kind, seen, map] of [
      ['request', requests, layer.requests],
      ['notification', notifications, layer.notifications],
    ] as const) {
      for (const method of Object.keys(map ?? {})) {
        const other = seen.get(method);
        if (other) {
          throw new Error(`${name}: layers "${other}" and "${layer.name}" both answer the ${kind} ${method}`);
        }
        seen.set(method, layer.name);
      }
    }
    for (const key of layer.provides ?? []) provided.add(key.name);
  }
}

export function clientEndpoint(channel: Channel<unknown>, options: ClientEndpointOptions): ClientEndpoint {
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

  const outboundHooks = layers.filter((l) => l.outbound);
  const inboundHooks = layers.filter((l) => l.inbound);

  const outboundChain = (
    kind: 'request' | 'notification',
    call: EndpointCall,
    send: (call: EndpointCall) => Promise<unknown>,
  ) => {
    const hooks = outboundHooks;
    if (!hooks.length) return send(call);
    const dispatch = (index: number, current: EndpointCall): Promise<unknown> => {
      const layer = hooks[index];
      if (!layer) return send(current);
      const next = once(`${options.name}/${layer.name} outbound`, (c) => dispatch(index + 1, c), current);
      return layer.outbound!({ ...current, kind }, context, states.get(layer), next);
    };
    return dispatch(0, call);
  };

  const agent: EndpointAgent = {
    request<Result>(method: string, params?: unknown, requestOptions?: RequestOptions) {
      return outboundChain('request', { method, params }, (c) =>
        peer.request(c.method, c.params, requestOptions),
      ) as Promise<Result>;
    },
    notify(method: string, params?: unknown) {
      if (!outboundHooks.length) return peer.notify(method, params);
      const run = () => outboundChain('notification', { method, params }, (c) => peer.notify(c.method, c.params));
      const sent = notifyTail.then(run, run);
      notifyTail = sent.catch(() => {});
      return sent as Promise<void>;
    },
  };

  const context: ClientEndpointContext = {
    name: options.name,
    peer,
    agent,
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

  // Per-endpoint state, created once per layer.
  const states = new Map<ClientLayer<any>, unknown>();
  for (const layer of layers) states.set(layer, layer.create?.(context));

  // Exclusive method dispatch maps.
  const answering = {
    request: new Map<string, ClientLayer<any>>(),
    notification: new Map<string, ClientLayer<any>>(),
  };
  for (const layer of layers) {
    for (const method of Object.keys(layer.requests ?? {})) answering.request.set(method, layer);
    for (const method of Object.keys(layer.notifications ?? {})) answering.notification.set(method, layer);
  }

  const dispatchMethod = (kind: 'request' | 'notification', current: EndpointCall, ctx: ClientCallContext): unknown => {
    const layer = answering[kind].get(current.method);
    if (!layer) return fallback(kind, current, ctx);
    const handler = (kind === 'request' ? layer.requests : layer.notifications)![current.method]!;
    const next = once(
      `${options.name}/${layer.name} ${current.method}`,
      (c) => Promise.resolve(fallback(kind, c, ctx)),
      current,
    );
    return handler(current, ctx, states.get(layer), next);
  };

  const handle = (kind: 'request' | 'notification', call: EndpointCall, ctx: ClientCallContext): unknown => {
    if (!inboundHooks.length) return dispatchMethod(kind, call, ctx);
    const dispatch = (index: number, current: EndpointCall): Promise<unknown> => {
      const layer = inboundHooks[index];
      if (!layer) return Promise.resolve().then(() => dispatchMethod(kind, current, ctx));
      const next = once(`${options.name}/${layer.name} inbound`, (c) => dispatch(index + 1, c), current);
      return Promise.resolve(layer.inbound!({ ...current, kind }, ctx, states.get(layer), next));
    };
    return dispatch(0, call);
  };

  const fallback = (kind: 'request' | 'notification', call: EndpointCall, ctx: ClientCallContext): unknown => {
    if (kind === 'request') {
      if (!options.request) throw RpcError.methodNotFound(call.method);
      return options.request(call, ctx);
    }
    return options.notification?.(call, ctx);
  };

  const callContext = (signal: AbortSignal): ClientCallContext => ({ ...context, signal });

  peer.onRequest('*', (params, inbound) =>
    handle('request', { method: inbound.method, params, id: inbound.id }, callContext(inbound.signal)),
  );
  const cancelMethod = ('cancelInbound' in peerOptions ? peerOptions.cancelInbound : cancelRequest.cancelInbound)?.method;
  peer.onNotification('*', (params, inbound) => {
    if (inbound.method === cancelMethod) return;
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
  return { peer, agent, context };
}
