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
| `@deft-subspace/acp-journal` | Serves journal-first agents (Ideal) over ACP: the event log owns history and the agent fills a slot. Projection with replay, message coalescing, tool calls, a permission broker, idempotent admission, a session registry. |

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

### Live, against the real Claude adapter (`npx -y @agentclientprotocol/claude-agent-acp`, 0.101.0)

The operator ran this one.

- **Protocol v2 end to end.** The adapter chose **protocol v2**, the first real v2 agent we've seen. The turn streamed the message, `usage` and the `state` updates, and ended `end_turn` with `text="SUBSPACE_OK"`. The process exited 0 on close.
- **Same code for both.** The client code that handled Grok on v1 handled this without changes, and produced the same model.
- **Not modelled yet:** v2 echoes the prompt back as `user_message`, and also sends `session_info_update`. Both still arrive as raw `update` events.

### Bridge as the first real user (Bridge branch `experiment/subspace-client`)

`bridge mcp` (`packages/mcp-front`) now runs its agents on Subspace, in two steps:

1. **Kernel.** `AcpConnection` became an adapter over `spawnProcess`, `ndjson` and `RpcPeer`. Two new tests fail on the old code: stopping an agent now stops the processes it started, and a reply written just before exit is delivered.
2. **ACP.** `SessionManager` drives `AcpClient`, `Session`, `Turn` and a `PermissionHandler` that feeds its own host and user permission queues.
   - **Net size:** `AcpConnection`, its tests and four hand-written wire types are gone, and `mcp-front/src` is 292 lines smaller.
   - **One changed behaviour:** `fs/write_text_file` now answers `{}`, the spec's object, instead of `null`.

**Results:**
- All 1220 Bridge tests pass, and `mcp-front`'s pass 10 runs out of 10.
- The live check (`pnpm test:live`) passes 8 of 8 against each of the three real agents:
  - Grok, run by us;
  - Claude (`claude-agent-acp` 0.101.0, mode `default`), run by the operator;
  - Codex (`codex-acp` 2.5.0, mode `read-only`), run by the operator.
- The eight checks are: a plain reply, asking before a write, writing after approval, tool details in `get_output`, asking before a delete, a denied delete keeping the file, cancel, and the session being usable after cancel.
- The live check doesn't report the protocol each agent used. Claude's adapter chose v2 in the direct run, so its mode was probably set through a v2 config option. Adding `protocol` to the session report would confirm it.

**What Bridge needed added:**
- session modes as one API over v1 modes and v2 config options;
- `turn.text` and `turn.toolCalls` while the turn runs;
- a permission request with no turn running answered `cancelled`;
- raw updates for listeners between turns;
- `stop(graceMs)`;
- `./package.json` exports.

**What Bridge's tests caught in Subspace:**
- text after a tool call first seen in a permission request wasn't separated;
- an extra blank line after text that already ends a line;
- updates sent right after `session/new` could be dropped, both before the session existed and before its listener was added.

### Bridge's ACP server side

Bridge's `StdioTransport`, the transport `bridge` uses to serve editors, is now an adapter over `RpcPeer`.

- **Message order:** a client request stays open until Bridge answers it, and `sendResponse` resolves only once the answer is written, so message order is kept.
- **Changed behaviour:**
  - requests to the client have no fixed 120-second timeout any more;
  - the client's error codes and data are kept.
- **Results:**
  - All 1221 unit tests and 23 integration tests pass.
  - Live: a Subspace client talked to `bridge` over this transport, `bridge` used its Grok backend, and a real Grok turn completed end to end.
- **What Bridge's tests and lint caught in the kernel:**
  - requests with a `null` id, which JSON-RPC 2.0 allows, were rejected;
  - an unserializable message could break the output stream;
  - handler params were typed `any`.

  All three are fixed. New API: `RpcPeer.sendRaw`, and a `cancelRequest` preset.

### Journal-first agents: `@deft-subspace/acp-journal` (16 tests)

For agents like Ideal, where an append-only journal is the record. The agent implements `JournaledSession` (`head`, `subscribe(fromSeq)`, `prompt`, `cancel`, `allow`, `deny`, optional `rewind`, `busy` and `close`). The kit keeps no fold and no state machine of its own.

```ts
const registry = new SessionRegistry({ open, exists, closeJournal });
serveJournal(channel, registry, { name: 'ideal', permissions: 'ask' });
```

- **Projection.** Each event is projected once. A seq at or below the high-water mark renders nothing. Every update carries `_meta.journal = { seq, headSeq }`.
  - `session/new` is live from head+1.
  - `session/load` replays from seq 1 and then sends `_journal/cursor { headSeq, rewindToSeq? }`.
  - Replay equals the live stream, plus the user's own messages.
- **Messages.** When the journal stores deltas followed by the full message, only the part of the full message not already sent goes out. A final message that disagrees with what was sent is reported, not sent.
- **Tool calls.** A result re-sends the input's content, because ACP content replaces rather than appends. Calls still open on cancel, close or rewind end `failed`.
- **Permissions.** One gate per session, and only live requests are asked. The broker fails closed, and a client answer of `cancelled` cancels the turn. The gate closes when the journal records an answer from elsewhere (for example a slash command), or on cancel, close or rewind: the client's question is withdrawn and its late answer ignored. `auto-allow` is opt-in.
- **Retries.** Requests carrying `_meta.journal.requestId` run once, including `session/new`. A reused id with different params gets -32602, and a failure is a receipt too. Receipts live in the registry, so a retry on a new connection is still safe.
- **Rewind convention.** `_journal/rewind { sessionId, toSeq }` asks for a rewind. Clients are told with `_journal/rewind { headSeq, toSeq }`, after the failed tool calls.
- **Registry.**
  - Unknown, closing and closed ids get -32002.
  - `close` cancels a busy session, then closes it.
  - `dispose` closes all sessions, then the journal.
  - A connection that drops detaches without cancelling anything.

Tests use an in-memory journal with Ideal's event names. The AcpClient end-to-end tests cover streamed text shown once, tool calls and permissions as TurnEvents, deny, and cancel mid-gate. Other tests cover:
- load replay equal to live;
- a retried prompt and `session/new` with the same receipt, also across connections;
- both orders of the race between a slash `/allow` or `/deny` and the client's answer;
- rewind invalidation.

This covers protocol v1 only; v2 `session/resume` is not done.

## Try it

`packages/acp/examples/quickstart.ts` writes an agent and a client against each other in one process: streaming, a tool call, a permission question, and a cancel. It runs on v2, or on v1 with `PROTOCOL=1`.

```bash
pnpm install
node --conditions=source packages/acp/examples/quickstart.ts
pnpm proto:test        # kernel + acp
pnpm proto:typecheck
pnpm proto:build       # emits dist/ with .js imports
node --conditions=source packages/acp/examples/live-turn.ts grok --permission-mode default agent stdio
PROMPT="Count to 400" CANCEL_AFTER_MS=300 node --conditions=source packages/acp/examples/live-turn.ts grok --permission-mode default agent stdio
```

Tests run the TypeScript sources directly. Node strips the types, and the `source` export condition points package imports at `src/`. The build emits `dist/` for npm.

## Not done yet (next steps, if this direction holds)

1. **Bridge:** done for `bridge mcp` (see above). The server-side transport is also on the kernel (see above). Remaining: Bridge's request handling on `serveAgent`, and reporting the protocol in `bridge mcp`'s session report.
2. **Agent side:**
   - `session/load` and `session/resume`;
   - several turns queued per session;
   - typed `_vendor` extension methods.
3. **Client side:**
   - terminal handlers;
   - elicitation;
   - session config options (v1 modes and v2 config options as one API);
   - capability-typed peers;
   - first-class events for v2 `user_message` and `session_info_update` (title).
4. **Journal projection kit for Ideal:** first pass done (see above). Remaining:
   - v2 (`session/resume`, `state_update`);
   - asking again about a gate still open at load time;
   - fold-based (compacted) replay for long journals;
   - Ideal implementing `JournaledSession` directly.
5. **Testkit:**
   - record and replay NDJSON traces;
   - a quirks corpus of real agents;
   - conformance checks for both agents and clients.
6. **Devtools:** OpenTelemetry spans per request and per turn, and a browser trace viewer.
7. **CI:** Node 22, 24 and 26, plus Bun, Deno and the browser for the kernel.
