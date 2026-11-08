# Design note: a raw agent endpoint, with `serveAgent` as layers on it

Status: proposal, second draft (2026-11-08), revised after two reviews.
Branch `experiment/agent-layers`. Nothing here is built yet.

## Why

`serveAgent` is an opinionated agent API: it answers `initialize` with
capabilities from its options, owns the session table, turns `session/prompt`
into an `AgentTurn`, and refuses any method it doesn't know (except `methods`
and typed `extensions`). That is the right shape for writing an agent, and
the wrong shape for:

- **a proxy** (ACP client → proxy → ACP agent) that must pass on what the
  downstream agent offers, forward methods and notifications it has never
  heard of, and carry the agent's requests (permissions, fs, terminals) back
  up;
- **a pipeline or graph** that wants every message as data and decides per
  message what to do;
- **an agent that is mostly ours but has methods of its own.**

The kernel already has the pieces: `RpcPeer` takes `'*'` request and
notification handlers, per-request signals, error replies and middleware. So:
a raw endpoint as the foundation, and `serveAgent` rebuilt as a stack of
optional layers on it, with the same options and behaviour.

**Scope.** This is protocol composition, not a general graph framework. A
graph or pipeline builds on the raw endpoint; it does not live in these
layers.

**An important caution.** Today's `serveAgent` is not a set of independent
handlers. It is a coordinated session-and-turn runtime: session close aborts
the turn, cancels queued prompts, closes background work and MCP
connections, then calls `closeSession`, in that order; a v1 prompt and a v2
prompt have different lifecycles (below). The extraction has to make those
coordination contracts explicit, or it will change behaviour.

## Goals

1. A raw endpoint that hands every inbound request and notification, as sent,
   to the code below it, and lets that code send anything to the client.
2. Each opinion of `serveAgent` as a layer that can be used alone or left out.
3. `serveAgent(channel, options)` unchanged for its users: same options, same
   wire behaviour, same teardown order, all existing tests passing without
   edits.
4. A proxy or pipeline can take only some layers (for example negotiate and
   tracing) and handle everything else itself.

## The contract (locked before any extraction)

1. **A call and a reply are different types.** A call is
   `{ method, params, id? }`. A reply is `{ id, result }` or
   `{ id, error: { code, message, data? } }`.
2. **Continuation.** `next()` forwards the current call; `next(call)` forwards
   a replacement. A continuation may be called **at most once**; a second
   call throws. Dispatch uses the method after any inbound rewrite, and the
   handler receives the rewritten params. A retry is a separate, explicit
   layer, and it may not wrap `session/prompt`.
3. **Handler maps are exclusive.** Two layers answering the same request or
   notification method is an error when the stack is built. Hooks stack;
   handlers don't.
4. **State is per endpoint.** A layer is a factory: building an endpoint
   calls it, and the state it makes belongs to that endpoint. Reusing one
   configured layer on two endpoints never shares a session table or
   negotiated capabilities. Every hook (inbound, outbound, close) receives the
   endpoint context.
5. **`normalize` rewrites shapes only.** Field names, content representation,
   capability shapes. v1 and v2 turn lifecycles stay in `turns`.
6. **Session teardown order is part of `serveAgent`'s compatibility promise**
   and has a test.
7. **The first proxy test** forwards an unknown request and an unknown
   notification, carries a permission request from the agent up to the
   client, and returns a downstream `RpcError` with its code and data intact.
   Client-side pass-through for that test is in scope (below).

## The raw endpoint

```ts
import { agentEndpoint } from '@deft-subspace/acp';

const endpoint = agentEndpoint(channel, {
  name: 'my-proxy',
  layers: [tracing(otel), negotiate({ initialize: async (params) => downstreamInitialize(params) })],
  // Everything no layer answered:
  async request(call, ctx) {
    return downstream.request(call.method, call.params, { signal: ctx.signal });
  },
  notification(call, ctx) {
    void downstream.notify(call.method, call.params);
  },
});
endpoint.peer; // the RpcPeer
```

- `ctx` carries `signal` (this inbound RPC: `$/cancel_request` or the
  connection closing), `protocol` (once negotiated), `client` (send requests
  and notifications to the client), and endpoint state from the layers
  (`ctx.get(key)`).
- A handler's return value becomes the result; a thrown `RpcError` becomes
  the error reply with its code and data. That is enough for a pass-through
  proxy; it does not need a wire-rewriting API.
- With no `request` handler, anything unhandled is "method not found"; with
  no `notification` handler, unhandled notifications are dropped (as now).

## Layers

```ts
interface AgentLayer<State = unknown> {
  name: string;
  /** Called once per endpoint: this layer's state for that endpoint. */
  create?(ctx: EndpointContext): State;
  /** Methods this layer answers (exclusive across the stack). */
  requests?: Record<string, (call: Call, ctx: LayerContext<State>, next: Next) => unknown>;
  notifications?: Record<string, (call: Call, ctx: LayerContext<State>, next: NextNotification) => void>;
  /** Wraps every inbound call before dispatch: watch, rewrite, refuse. */
  inbound?(call: Call, ctx: LayerContext<State>, next: Next): unknown;
  /** Wraps calls this endpoint makes to the client (requests, notifications) and, for requests, their reply. */
  outbound?(call: Call, ctx: LayerContext<State>, next: (call: Call) => Promise<Reply | void>): Promise<Reply | void>;
  provides?: StateKey<unknown>[];
  requires?: StateKey<unknown>[];
  /** The connection closed. */
  closed?(info: CloseInfo, ctx: LayerContext<State>): void | Promise<void>;
}
```

**Two hook kinds, named honestly.**

- **Call middleware** (`inbound`, `outbound`) wraps one invocation and, for a
  request, its reply. That is what the kernel's middleware does today.
- **Wire hooks** see and may transform every envelope going out, replies and
  errors to inbound requests included. The kernel does not have these today:
  handler results, error replies and `sendRaw()` are written straight to the
  stream. They are needed by `normalize` (which must rewrite replies), not by
  the first proxy, and they come with `normalize` (plan step 5), through a
  kernel change rather than a second RPC layer.

**Layers may call each other only through services.** `sessions` attaches the
MCP servers that arrive on `session/new`; `turns` cancels work that `mcp` and
background work own. Those are explicit services on the context (below), not
calls into "the next layer down".

### The layers

| Layer | Answers | Provides | Requires | Notes |
| --- | --- | --- | --- | --- |
| `tracing(otel)` | nothing | — | — | `otelTap`. Until wire hooks exist (plan step 5) it uses the peer's wire tap, which sees every message including replies; call middleware alone would miss the replies |
| `negotiate(opts)` | `initialize` | protocol, client capabilities | — | `initialize` may be a function of the client's request returning the **whole** result (version, agent info, capabilities, auth methods, `_meta`); today's options are the shortcut. Other requests wait until it has answered; before any `initialize` they are rejected, and notifications are dropped with a diagnostic |
| `normalize()` | nothing | — | protocol | shapes only (see the contract); needs wire hooks |
| `sessions(opts)` | `session/new`, `load`, `resume`, `close` | session lifecycle service | protocol, client capabilities | `newSession`, `loadSession`, `closeSession` hooks as today |
| `turns(opts)` | `session/prompt`, `session/cancel`, `tool_call/cancel`, `terminal/cancel` | — | session lifecycle service, protocol, client capabilities | `AgentTurn`, queueing, background work, v1 and v2 turn lifecycles |
| `mcp(opts)` | nothing | MCP connections per session | session lifecycle service, protocol | `turn.mcp()`, `mcpConnector`, `mcpTransports`; registers with the session lifecycle |
| `extensions(list)` | the listed `_name/...` methods | — | — | typed extensions, and today's `methods` |

### The session lifecycle service

`sessions` provides it; `mcp`, `turns` and background work register with it.
It defines, in order:

- **create and attach**: a session is created, then each registered part
  attaches (MCP servers connected lazily, background work set up). If an
  attach fails, the parts already attached are released and the request
  fails.
- **load and resume**: the same, with replay where asked; servers that
  changed are closed and reattached.
- **turn start and end**: `turns` marks a turn running and finished, for
  cancel and close.
- **close**: abort the running turn, cancel queued prompts, close background
  work, delete the session, close MCP connections, then call `closeSession`.
  This order is today's, and a test pins it.
- **connection close**: close every session as above.

## The v1 / v2 turn lifecycles

These are different protocols, not different field names:

- **v1** `session/prompt` waits for the turn and answers `{ stopReason }`; a
  failure is a JSON-RPC error.
- **v2** `session/prompt` answers `{ messageId }` at once; the turn runs
  after (today on a `setTimeout`), reports `running`, and ends with an idle
  state update; a failure becomes an idle update with an error.

Both stay in `turns`. `normalize` does not try to make them equivalent.

## Cancellation

Five different things, documented and tested separately:

1. **`$/cancel_request` for one RPC**: aborts `ctx.signal` for that call. A
   proxy that passes `ctx.signal` to the downstream request cancels downstream
   only if that peer sends cancel requests (`cancelOutbound`); a raw `RpcPeer`
   does not by default. Cancelling an RPC does not undo side effects.
2. **`session/cancel`**: aborts the session's turn and its queued prompts.
3. **`tool_call/cancel` and `terminal/cancel`**: stop one piece of
   background work.
4. **Connection close**: everything above, for every session.
5. **Work that outlives its call**: a v2 turn keeps running after its
   `session/prompt` was answered; background work outlives its turn.

**Unchanged behaviour.** Today the prompt path uses
`AbortSignal.any([session controller, connection])` and ignores the inbound
request's own signal, so `$/cancel_request` on `session/prompt` does nothing
and cancel goes through `session/cancel`. The extraction keeps that exactly.

## Ordering

- **Mechanism.** Notifications for one session are serialized after the
  outbound hooks: each send waits for the previous one's hooks before it
  writes, so a slow hook on notification A cannot let B reach the stream
  first. Today `SessionWork` has no send queue and only the stream's write
  order is guaranteed; the queue is new.
- **Hook order.** As in the kernel's middleware chain: the first layer in
  the stack runs first on the way in and last on the way back. For outbound
  calls that means the first layer sees the call first and its reply last;
  for wire hooks (step 5) the layer nearest the wire is the last to transform
  what is written.
- **Executable example** in the spec tests: two notifications, the first
  through a hook that awaits a timer; the wire shows them in order. A second
  test fixes which layer sees what first in each direction. **The tests are
  the definition of hook order;** the prose above is a summary.

## Performance

The bar: a streaming turn (chunks per second) is not visibly slower than
today's `serveAgent`, measured before and after. Rules: a layer that has no
hook or handler for a message costs nothing for it (no allocation), and no
layer copies a chunk it does not change.

## The client side

A faithful proxy needs a downstream half that passes the agent's requests up.
Today `AcpClient` sends its own `initialize`, registers fixed handlers for
`session/request_permission`, `fs/*`, `terminal/*` and `elicitation/*`, and
answers any other request from the agent with "method not found". It exposes
`client.peer`.

For the first proxy (plan step 3), a documented adapter on `client.peer`
passes unknown requests and notifications up, and the agent's permission and
fs requests too. A `'*'` handler is not enough: `AcpClient` already
registers `session/request_permission`, `fs/*` and `terminal/*`, and a
wildcard only sees methods with no handler. The adapter **replaces** those
handlers on the peer with pass-through ones, and adds `'*'` for the rest. A polished `clientEndpoint` with layers, with `AcpClient` as
its preset, comes later.

## Plan

1. **Specify** this contract in tests first: continuation rules, exclusive
   handlers, per-endpoint state, close and teardown order, the `negotiate`
   wait rule, ordering.
2. **The raw endpoint** on the existing kernel: `agentEndpoint`, the layer
   interface, state keys, call middleware. Tests of the endpoint alone.
3. **A two-way proxy example and test** (`examples/proxy.ts`): client, proxy,
   agent; the contract's point 7, plus client capabilities reaching the agent
   and cancel across both hops (with `cancelOutbound` on the downstream peer).
4. **Extract the layers** one at a time with the whole suite after each:
   `negotiate`, `sessions` (with the lifecycle service), `mcp`, `turns`,
   `extensions`, `tracing` (on the wire tap). `serveAgent` becomes the
   preset.
5. **Wire hooks** in the kernel, then `normalize` (shapes only).
6. **Focused tests**: ordering, the five kinds of cancel, failed setup,
   isolation between endpoints, and the performance comparison.
7. Docs ("Writing an agent" gains "Layers" and "Proxies") and `EXPERIMENT.md`.
8. Later: `clientEndpoint`.
