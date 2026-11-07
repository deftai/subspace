# Experiment: deft-subspace prototype

**Branch:** `experiment/deft-subspace-prototype`. This is an experiment. If it fails, drop the branch. Nothing on `main` changes.

## The idea

The official SDKs own the wire. `@agentclientprotocol/sdk` has about 8.3M downloads a week, and its types are generated from the spec's source schema. Subspace builds on those types and owns what apps hand-write above the wire today:

- a small kernel whose request handling is correct;
- turns you can await to a definite end;
- cancellation that actually works;
- permissions that fail closed;
- one model across ACP v1 and v2.

The new packages sit next to the existing ones. The old packages and their tests are untouched (37 tests still pass).

| Package | What it is |
|---|---|
| `@deft-subspace/kernel` | Channels (Web Streams), NDJSON framing, `RpcPeer`, and `./node` for supervised processes. It has no dependencies, and its runtime core is about 5.7 KB gzipped. |
| `@deft-subspace/acp` | `AcpClient`, `Session`, `Turn`, `serveAgent`, and permission policies, plus `./node` with `connectAgent` and `workspaceFiles`. Its ACP types come from `@agentclientprotocol/sdk`; no wire schema is hand-written. |

## What the prototype shows

### Kernel (23 tests)

- **Request id 0 can be cancelled.** This is the MCP SDK's bug #3043.
- **Ids are opaque:** `0` and `"0"` are different requests.
- **Every request ends in exactly one place.** It ends either with the answer or with a `LocalError` saying why we stopped waiting: `aborted`, `timeout`, `closed`, `invalid-response` or `send-failed`.
  - A timeout is not reported as an abort (MCP's bug #2165).
  - A late answer is reported, never delivered.
- **Timeouts are tested with a manual clock,** with no real waiting, and no timer is left behind.
- **Inbound handlers run concurrently,** so a handler waiting on a call back to the other side doesn't block anything. Notifications keep arrival order.
- **Malformed messages:**
  - when the id can be recovered, the reply is `InvalidRequest`;
  - otherwise the message is reported as a diagnostic.
- **Framing:**
  - UTF-8 split across chunks survives;
  - byte-by-byte and merged chunks decode the same;
  - non-JSON banner lines are skipped and reported;
  - over-long lines are skipped without being buffered;
  - a 4 MB line decodes in linear time.
- **Processes:**
  - a missing program is a `SpawnError` with a hint;
  - a reply written just before exit is not lost;
  - `stop()` kills the whole process group, including a grandchild that ignores SIGTERM;
  - a tail of stderr is kept.

### ACP (17 tests)

- **One agent handler, both protocols.** The same handler runs on v1 and v2 over byte-by-byte NDJSON, and the client produces the same events for both.
- **Turn completion:**
  - `turn.done` settles after the last event;
  - iterating the turn again gives the same events.
- **Permissions fail closed:**
  - the default policy is reject;
  - a policy that throws becomes a reject;
  - an unknown option id becomes a reject.
- **Cancellation:**
  - `turn.cancel()` answers the open permission question `cancelled`;
  - the agent's `turn.signal` fires;
  - open tool calls end `failed`;
  - the turn ends `cancelled`.
  - If the agent ignores the cancel, the turn is ended here after a grace period (`forced: true`).
- **Unknown sessions** get `-32002` instead of a silently created session.
- **A connection that drops mid-turn** fails the turn with `closed`. Tests found this bug in v2, where a running turn has no request in flight.
- **v2 whole-message upserts** after streamed chunks don't repeat text.
- **Interop with the official SDK:** agents built with `@agentclientprotocol/sdk`, both v1 and `experimental/v2`, work with our client. A v1-only agent accepts our v2-first `initialize`, and we fall back to v1.
- **`workspaceFiles` stays inside the workspace:**
  - `..` can't leave it;
  - symbolic links are checked;
  - names starting with `..` are allowed.

### Live, against real Grok Build (`grok --permission-mode default agent stdio`)

Run with `packages/acp/examples/live-turn.ts`.

- **Plain turn:** Grok chose v1 from our v2-first `initialize`. The turn streamed thoughts and messages and ended `end_turn` with `text="SUBSPACE_OK"`, and the process group stopped cleanly.
- **Cancel:** Grok confirmed the cancel within about 4 ms. The turn ended `cancelled` without being forced.
- **Permission:** with the `reject` policy, Grok's file write was refused, the tool call ended `failed`, and no file was created.
  - Quirk: Grok then ended the turn as `cancelled`, not `end_turn`. That's the same "a rejection aborts the turn" behaviour acpx users report, and it belongs in a quirks corpus.

Not run live: the Claude adapter (`npx -y @agentclientprotocol/claude-agent-acp`). Downloading and running it needs the operator's go-ahead.

## Try it

```bash
pnpm install
pnpm proto:test        # kernel + acp
pnpm proto:typecheck
pnpm proto:build       # emits dist/ with .js imports
node --conditions=source packages/acp/examples/live-turn.ts grok --permission-mode default agent stdio
PROMPT="Count to 400" CANCEL_AFTER_MS=300 node --conditions=source packages/acp/examples/live-turn.ts grok --permission-mode default agent stdio
```

Tests run the TypeScript sources directly. Node strips the types, and the `source` export condition points package imports at `src/`. The build emits `dist/` for npm.

## Not done yet (next steps, if this direction holds)

1. **Bridge as the first real user,** on a Bridge branch: replace `mcp-front`'s `AcpConnection` with `connectAgent`, then run Bridge's live tests against Claude, Codex and Grok.
2. **Agent side:**
   - `session/load` and `session/resume`;
   - several turns queued per session;
   - typed `_vendor` extension methods.
3. **Client side:**
   - terminal handlers;
   - elicitation;
   - session config options (v1 modes and v2 config options as one API);
   - capability-typed peers.
4. **Journal projection kit for Ideal:**
   - stamp updates with sequence numbers and replay on load;
   - send only the unsent suffix of a message;
   - make repeated requests safe;
   - a rewind convention.
5. **Testkit:**
   - record and replay NDJSON traces;
   - a quirks corpus of real agents;
   - conformance checks for both agents and clients.
6. **Devtools:** OpenTelemetry spans per request and per turn, and a browser trace viewer.
7. **CI:** Node 22, 24 and 26, plus Bun, Deno and the browser for the kernel.
