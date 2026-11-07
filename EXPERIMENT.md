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
| `@deft-subspace/acp-testkit` (`packages/testkit`) | Record and replay traces, faults, conformance checks for agents and clients, and a corpus of real agents' traces. See its README. |
| `@deft-subspace/devtools` | `analyzeTrace` (requests paired with answers, turns, tool calls, permissions, cancels, problems) and `renderTraceHtml`, a self-contained browser viewer for kernel traces. CLI: `deft-subspace-trace`. |

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

### Testkit (33 tests)

- **Record and replay** in the kernel trace format. A replayed agent remaps ids both ways, matches the client's calls by method, and fails with expected vs got instead of hanging.
- **Faults:** banner lines, odd and coalesced chunks, delay, disconnect after N messages, close mid-turn.
- **Conformance:** `checkAgent` (10 checks) passes against `serveAgent` and official-SDK agents, v1 and v2, and catches a broken agent. `checkClient` (4 checks) passes against `AcpClient`, v1 and v2, and catches a careless official-SDK client.
- **Quirks corpus:** three real Grok traces (plain, write rejected, cancel) replay to `AcpClient` with the same `TurnResult` as live.
- **Live `checkAgent` against Grok:** initialize, session/new and cancel pass. An unknown session is answered `-32602`, not `-32002`.

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

### Bridge's request handling on `serveAgent` (opt in)

With `BRIDGE_ACP_SERVER=subspace`, `bridge` serves its built-in backends (OpenAI, Anthropic, Grok) through `serveAgent`. The module is `packages/cli/src/agent-server.ts` on Bridge's branch. Ideal keeps the classic server.

- **One handler for both protocols:** a single prompt handler runs Bridge's pipeline and maps it onto `AgentTurn` for v1 and v2.
- **Review findings fixed:**
  - cancel now stops the turn (finding 6);
  - the working-directory message always survives the history window (finding 3);
  - an unknown session gets -32002 (finding 13).
- **Live, with the Grok backend:**
  - `bridge` served ACP **v2** for the first time, and the turn completed end to end;
  - a cancel was confirmed in 2 ms, and the turn ended `cancelled` without being forced.
- **What `serveAgent` gained for this:**
  - `methods` (extra handlers) and `capabilities`;
  - `newSession` receives the full params;
  - `turn.clientCapabilities`;
  - `turn.request()` for calls back to the client, aborted with the turn;
  - `turn.toolCallUpdate()` for pipeline-shaped tool updates;
  - `turn.sendUpdate()`.

## Try it

`packages/acp/examples/quickstart.ts` writes an agent and a client against each other in one process: streaming, a tool call, a permission question, and a cancel. It runs on v2, or on v1 with `PROTOCOL=1`.

```bash
pnpm install
node --conditions=source packages/acp/examples/quickstart.ts
pnpm proto:test        # kernel + acp
pnpm proto:typecheck
pnpm proto:build       # emits dist/ with .js imports
node --conditions=source packages/devtools/examples/sample-trace.ts   # writes packages/devtools/samples/sample-v{1,2}.html
node --conditions=source packages/devtools/src/cli.ts some.trace.jsonl [-o out.html] [--summary]
node --conditions=source packages/acp/examples/live-turn.ts grok --permission-mode default agent stdio
PROMPT="Count to 400" CANCEL_AFTER_MS=300 node --conditions=source packages/acp/examples/live-turn.ts grok --permission-mode default agent stdio
```

Tests run the TypeScript sources directly. Node strips the types, and the `source` export condition points package imports at `src/`. The build emits `dist/` for npm.

## Not done yet (next steps, if this direction holds)

1. **Bridge:** done for `bridge mcp` (see above). The server-side transport is also on the kernel (see above). `bridge mcp` reports the protocol in its session report. Bridge's request handling also runs on `serveAgent`, opt in (see below).
2. **Agent side:** done:
   - `loadSession` handles v1 `session/load` with a replay writer, v1 `session/resume`, and v2 `session/resume` (it replays when asked);
   - `session/close`, with a `closeSession` hook;
   - `turn.terminal()` and `turn.elicit()`, which check the client's capabilities;
   - `turn.userMessage()`.

   - prompt queueing (`queuePrompts`): prompts run in order, and `session/cancel` cancels the queued ones too;
   - `turn.clientSupports`, plus `turn.readFile()`, `turn.writeFile()` and `turn.completeElicitation()`;
   - typed extensions (`extensions`, `turn.call()`, `turn.notify()`).
3. **Client side:** done:
   - `client.loadSession()` returns the replayed events, using v1 load or v2 resume from the start;
   - `client.resumeSession()` and `session.close()`;
   - `TerminalHandlers`, with `workspaceTerminals(root)` in `./node`: process groups, a working directory inside the workspace, merged output capped at `outputByteLimit`, kill, and an `allow` hook;
   - an `ElicitationHandler` that fails closed and gives `cancel` when the turn is cancelled;
   - `user_message` and `session_info` events, with `session.info.title`;
   - session modes as one API (done earlier).

   - `client.supports`: one capability shape for v1 and v2, with `CapabilityError` thrown before any request the agent can't answer, including prompt content it doesn't accept;
   - `client.listSessions()`;
   - queued prompts (`{ queue }`); cancelling a queued prompt means it is never sent;
   - typed extensions (`extensionRequest`, `extensionNotification`, `handle`): names start with `_`, and optional validators check params where they arrive and results where they return;
   - `onElicitationComplete`.
   - logging in: `client.authMethods` (one shape for v1 and v2), `client.authenticate(id)` (v1 `authenticate`, v2 `auth/login`), `client.logout()`, and `terminalAuth` to advertise that the app can run a `terminal` login method;
   - `client.deleteSession(id)` (`session/delete`);
   - config options: `session.configOptions`, `session.setConfigOption(id, value)` for select and on/off options, and `session.model` / `session.setModel()` (the option with category `model`). Values the agent did not offer are refused before any request.
   - v2 agent terminals (`terminal_update`, `terminal_output_chunk`): `terminal` turn events (a snapshot, the appended bytes, whether a snapshot replaced the output) and `session.terminals`, kept across turns since a terminal can outlive its turn and its updates can come before the tool call that shows it. Output is bytes, capped at 1 MB per terminal; `terminalText()` decodes it. Display only, as the proposal says.
4. **Journal kit (`experiment/acp-journal`, first cut done, 16 tests):** a second pass is planned.
5. **Testkit (`packages/testkit`, merged, first cut done, 33 tests):**
   - built: recording and replay, fault injection, `checkAgent` and `checkClient`, and a corpus of 3 Grok traces;
   - still to do: Claude and Codex traces (the operator records them, since they need `npx`);
   - still to do: whether Grok's `-32602` for an unknown session counts as a known quirk or a failure;
   - still to do: move the package to `packages/acp-testkit` once the old package is retired.
6. **Devtools (`packages/devtools`, merged, first cut done, 14 tests):**
   - built: the trace analyzer, a standalone HTML viewer and the CLI;
   - published as a private page for review;
   - still to do: an answer that arrives after a `$/cancel_request` is flagged as a problem, though LSP expects one;
   - still to do: sessions seen only in error replies count as real sessions;
   - still to do: anything found when looking at it in a browser;
   - still to do: OpenTelemetry spans per request and per turn.
7. **Bounded turns:** done. `session.prompt(input, { limits })`, or the client's `limits` option, takes `maxDurationMs`, `idleMs`, `maxToolCalls` and `maxUsage`. A limit cancels the turn the normal way, pushes an `exhausted` event, and sets `result.exhausted` to `{ limit, max, value }`. 11 tests cover v1 and v2. In `bridge mcp`: the `prompt` tool takes `max_turn_seconds`, `idle_seconds` and `max_tool_calls`, `[mcp.limits]` sets the defaults, and the report says which limit fired.
8. **CI:** Node 22, 24 and 26, plus Bun, Deno and the browser for the kernel.
