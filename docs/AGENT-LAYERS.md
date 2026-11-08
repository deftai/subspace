# Design note: a raw agent endpoint, with `serveAgent` as layers on it

Status: proposal, for review (2026-11-08). Branch `experiment/agent-layers`.
Nothing here is built yet.

## Why

`serveAgent` is an opinionated agent API: it answers `initialize` with
capabilities from its options, owns the session table, turns
`session/prompt` into an `AgentTurn`, and refuses any method it doesn't know
(except `methods` and typed `extensions`). That is the right shape for writing
an agent. It is the wrong shape for:

- **a proxy** (ACP client → proxy → ACP agent) that must pass on the
  downstream agent's capabilities, forward methods and notifications it has
  never heard of (other vendors' `_name/...` extensions, newer ACP methods),
  and carry the agent's requests (permissions, fs, terminals) back up;
- **a filter graph or pipeline** that wants every message as data, decides
  per message what to do, and uses only some of Subspace's conveniences;
- **an agent that is mostly ours but has a few methods of its own**, where
  "method not found" for anything unregistered is a surprise.

The kernel already has what a raw endpoint needs: `RpcPeer` takes `'*'`
request and notification handlers (`context.method` names the method), and
inbound and outbound middleware.

So: make a raw endpoint the foundation, and rebuild today's `serveAgent` as a
stack of optional layers on it, with the same options and behaviour.

## Goals

1. A raw endpoint that hands every inbound request and notification, as sent,
   to the code below it, and lets that code send anything to the client.
2. Each opinion of `serveAgent` as a layer that can be used alone or left out.
3. `serveAgent(channel, options)` unchanged for its users: same options, same
   wire behaviour, all existing tests passing without edits.
4. Proxies and pipelines can take some layers (e.g. negotiate + tracing) and
   handle everything else themselves.

Not goals: changing ACP behaviour, new wire features, the client side (see
"Later: the client side").

## The raw endpoint

```ts
import { agentEndpoint } from '@deft-subspace/acp';

const endpoint = agentEndpoint(channel, {
  name: 'my-proxy',
  layers: [tracing(otel), negotiate({ capabilities: async (init) => downstreamCaps(init) })],
  // Everything no layer handled:
  async request(call, ctx) {
    return downstream.request(call.method, call.params, { signal: ctx.signal });
  },
  notification(call, ctx) {
    void downstream.notify(call.method, call.params);
  },
});
endpoint.peer;      // the RpcPeer, as today
endpoint.client;    // send to the client: request(method, params, opts), notify(method, params)
```

- `call` is `{ method, params, id? }` exactly as received (or as normalized, if
  a `normalize` layer is above; see below).
- `ctx` carries `signal` (cancelled by `$/cancel_request` or the connection
  closing), `protocol` (once negotiated), `client` (send to the client), and
  the shared state of the layers above (`ctx.get(key)`).
- With no `request` handler, anything unhandled is "method not found"; with
  no `notification` handler, unhandled notifications are dropped (as now).
- Outbound traffic (responses, notifications and requests to the client) goes
  through the layers' outbound hooks, so tracing and rewriting layers see
  both directions.

## Layers

A layer handles some methods, passes the rest down, and may watch or rewrite
traffic in both directions:

```ts
interface AgentLayer {
  name: string;
  /** Methods this layer answers. Others go to the next layer down. */
  requests?: Record<string, (call: Call, ctx: LayerContext, next: Next) => unknown>;
  notifications?: Record<string, (call: Call, ctx: LayerContext, next: Next) => void>;
  /** Every inbound message, before method dispatch (watch, rewrite, refuse). */
  inbound?(call: Call, ctx: LayerContext, next: Next): unknown;
  /** Every outbound message (watch, rewrite). */
  outbound?(call: Call, next: (params: unknown) => Promise<unknown>): Promise<unknown>;
  /** State this layer adds for the layers below it, and what it needs from above. */
  provides?: StateKey<unknown>[];
  requires?: StateKey<unknown>[];
  /** The connection closed. */
  closed?(info: CloseInfo): void | Promise<void>;
}
```

A handler can answer, call `next()` to pass the call down (and optionally
change the result on the way back), or throw an `RpcError`. Per-method maps
keep dispatch cheap and let a stack list what it answers (useful for docs,
traces and editors).

Today's `serveAgent`, split up:

| Layer | Answers | Provides | Notes |
|---|---|---|---|
| `tracing(otel)` | nothing | — | `otelTap` as a layer; watches both directions |
| `negotiate(opts)` | `initialize` | protocol, client capabilities | `capabilities` may be a function of the client's `initialize`, so a proxy can pass on (and tweak) the downstream agent's. `protocols` and `info` as today (`authMethods` is always empty today; a function would let a proxy pass on the agent's) |
| `normalize()` | nothing | — | rewrites v1 and v2 wire shapes into one model inbound and back outbound. Layers below it see one shape; without it they see the wire |
| `sessions(opts)` | `session/new`, `load`, `resume`, `close` | the session table | `newSession`, `loadSession`, `closeSession` hooks as today |
| `turns(opts)` | `session/prompt`, `session/cancel`, `tool_call/cancel`, `terminal/cancel` | — | `AgentTurn`, queueing, `SessionWork`, `turn.say/tool/elicit/terminal/readFile/...` |
| `mcp(opts)` | nothing | MCP connections per session | `turn.mcp()`, `mcpConnector`, `mcpTransports`; closes with the session and the connection |
| `extensions(list)` | the listed `_name/...` methods | — | typed extensions; also today's `methods` |

`serveAgent(channel, options)` becomes:

```ts
agentEndpoint(channel, {
  name: options.name,
  layers: [tracing(...), negotiate(...), normalize(), sessions(...), mcp(...), turns(...), extensions(...)],
  // unhandled: method not found, as today
}).peer;
```

## Points to settle

1. **Shared state.** `turns` needs the session table; `mcp` needs sessions and
   the client's capabilities. Proposal: typed keys (`const Sessions =
   stateKey<SessionTable>('sessions')`), a layer declares `provides` /
   `requires`, and `agentEndpoint` checks the order when the stack is built
   (a layer that requires a key no layer above provides is an error at start,
   not a crash mid-turn).
2. **Raw or normalized below `normalize`.** Every layer says which it expects.
   `sessions` and `turns` expect normalized; a proxy usually leaves
   `normalize` out and works on the wire. A pipeline can put `normalize` in
   and still see `call.raw` for the original message.
3. **Outbound order.** Notifications for one session keep their order through
   outbound hooks (today `SessionWork` and the peer's write order guarantee
   it). Hooks run in stack order, outermost last, so `tracing` sees exactly
   what goes on the wire.
4. **Cancel.** `ctx.signal` is the kernel's per-request signal, so a proxy
   that passes it on to the downstream request cancels downstream too.
   `session/cancel` stays a notification the `turns` layer handles; without
   `turns`, it falls through like any other notification.
5. **Requests back to the client.** `ctx.client.request()` is how any layer
   (or the code below) asks the client something: a permission, a file, a
   terminal. `turns` uses it for `turn.tool()` and friends; a proxy uses it to
   carry the downstream agent's requests up.
6. **What a layer may assume about the ones below.** Nothing: a layer that
   passes a call down gets whatever the next one answers, or "method not
   found" at the bottom.
7. **Performance.** One extra function call per layer per message, plus the
   per-method map lookup. Measure against today's `serveAgent` on a
   streaming turn (chunks per second) before and after; the refactor should
   not be visibly slower.

## Later: the client side

A proxy's downstream half needs the same split. Today `AcpClient`:

- sends its own `initialize` with capabilities from its options (a proxy has
  to send the upstream client's, possibly tweaked);
- registers fixed handlers for `session/request_permission` (always), the
  `fs/*` and `terminal/*` methods (when their options are given) and
  `elicitation/*`, plus typed extensions; any other request from the agent is
  "method not found";
- exposes `client.peer`, so a caller can add `'*'` handlers today, but there
  is no supported way to pass the agent's requests up unchanged.

The same plan applies: a raw `clientEndpoint` with layers, and `AcpClient` as
the preset. That is a second step, after the agent side lands.

## Plan

1. `agentEndpoint`, the layer interface and state keys, with tests of the raw
   endpoint alone (pass-through, unknown methods, notifications, cancel,
   outbound hooks, order checks).
2. Move `serveAgent`'s parts into layers one at a time, running the whole
   suite after each: `negotiate`, `sessions`, `turns`, `mcp`, `extensions`,
   `tracing`, then `normalize` (today the v1/v2 handling is spread through the
   others; pulling it into one layer is the last and riskiest move).
3. A proxy example (`examples/proxy.ts`): a client, a proxy that passes on
   capabilities and adds one tweak, and an agent, run with the other examples.
4. Docs: "Writing an agent" gains "Layers" and "Proxies"; `EXPERIMENT.md`
   notes.
5. Later: the client side.
