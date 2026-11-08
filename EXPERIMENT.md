# Experiment: deft-subspace prototype

**Branch:** `experiment/deft-subspace-prototype`. This is an experiment. If it fails, drop the branch. Nothing on `main` changes.

## The idea

The official SDKs own the wire. `@agentclientprotocol/sdk` has about 8.3M downloads a week, and its types are generated from the spec's source schema. Subspace builds on those types and owns what apps hand-write above the wire today:

- a small kernel whose request handling is correct;
- turns you can await to a definite end;
- cancellation that actually works;
- permissions that fail closed;
- one model across ACP v1 and v2.

The original `@deft/*` packages from `main`, with their tests and developer guide, are in `legacy/`, outside the pnpm workspace. The guide for the current packages is [`docs/GUIDE.md`](./docs/GUIDE.md).

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
- **A deadline keeps the process alive until it fires or is cleared** (request timeouts, turn limits, the cancel grace). Earlier they were unref'd, so with nothing else pending (an in-process agent, a script) Node exited before the timeout was reported (exit 13, unsettled top-level await). `test/deadlines.test.ts` runs that case in a child process.
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
pnpm test             # every package (proto:test still works)
pnpm run typecheck
pnpm run build         # emits dist/ with .js imports (proto:build still works)
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
   - MCP servers: `mcpTransports` advertises the transports the agent takes (v1 `mcpCapabilities`, v2 `session.mcp`; a v2 agent no longer implies stdio). Session hooks get `servers`, typed, and turns `turn.mcpServers`. `turn.mcp(name)` calls an `acp` server the client serves: `listTools()` (following pages), `callTool()`, `discover()`, `request()`. Each call is one stateless MCP 2026-07-28 request with its own metadata; progress goes to the call's `onNotification`; inner errors throw `McpError`; cancelling the turn cancels its calls (`$/cancel_request`). Tested against our `serveMcp()` (v1 and v2) and the official SDK's `McpOverAcpProvider`. Still to do: a real MCP client for the agent's stdio and http servers.
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
   - A higher layer (DX pass): handler options on any turn (`onMessage`, `onToolCall`, `onPermission`, `onQuestion`, `onEvent`, ...; `done` settles after they ran, a throwing handler cancels the turn) and client-wide `handlers`; `start()` / `run()` in `./node` with presets for claude, codex, grok, gemini and opencode in their ask-first modes, one `cwd`, a ready session, one login retry, Ctrl-C handling and `await using`, and a required permission answer; `serveStdio()` (console to stderr) and `turn.tool(init, run)` with `PermissionDenied` on the agent side. Checked live (2026-11-07): `examples/first-turn.ts` with `start('claude')` read the README with one tool call and answered, `end_turn`. `examples/ask-before-writing.ts`: Claude asked before writing; refused, the file was not written (`completed`, 1 refused: Claude finishes a refused turn normally); allowed, it was written. `examples/one-liner.ts` with `run('codex', ...)` answered after reading files. Seen there: streamed deltas of two messages run together unless the app watches `messageId`. Whole messages (2026-11-07): `message_end`, `thought_end` and `user_message_end` events, with `onMessageEnd`, `onThoughtEnd` and `onUserMessageEnd`, give each message's final text once other text, a tool call, a plan, a permission question or a terminal follows it, or the turn ends (`complete: false` if it ended early). ACP has no end signal, so this is inferred; a message resumed under the same id ends again. Fixed alongside: for messages without an id, a notice between chunks (e.g. `available_commands_update`) split the message in two, in `result.text` too; now only content (a tool call, a plan, a terminal) splits one, the same things that end one.
   - DX, second pass: permission rules (`readOnly`, `allow`, `reject`, `allowInside`, `firstOf`; `onPermission` also takes 'allow' / 'reject'), `terminal()` and `askInTerminal()`, `start({ trace })`, install and login hints in errors, `text()` / `stream()` / `json()` (Standard Schema) on started agents, `file()` and `image()` (text fallback for embedded files), `signal` / `timeoutMs` on prompts; `tool()` with `turn.useTool()` and `client.serveTools()`; `modelAgent()` and `@deft-subspace/claude` (Claude Opus 5.5 by default, adaptive thinking, refusal fallbacks); the `subspace` command (`@deft-subspace/cli`); `create-subspace` (checked end to end: the agent template generated, installed, typechecked and run through `subspace run`); a cookbook on the site. The model adapter is tested against a fake SDK client, and was checked live (2026-11-07, `examples/claude-agent.ts` through `subspace run`, an `ant auth login` profile): two turns, a tool call each, summarized thoughts, `end_turn`; the API accepted the request as built (fallbacks beta, `thinking.display`, effort, tool results and thinking blocks sent back). On the way: API errors now end the turn with one readable line, `run` and `chat` print error stops, each turn is drawn with a fresh terminal view, and thoughts are labelled when there is no color.
   - The agent catalog (`agents.ts`, `catalog.ts`; site: Client > The agents file): the ACP registry (a bundled snapshot, refreshed by `subspace agents --refresh`), then built-in definitions with their quirks, then `~/.config/subspace/agents.toml`, the nearest `subspace.toml`, `$SUBSPACE_AGENTS` and `--agents-file`, each layer overriding field by field. A quirk has a summary, a fix, settings it applies (`mode`, `args`, `env`), the checks it waives, where it was seen and where it is reported upstream (Codex's refused-turn ending: codex-acp#556). `start()` and `subspace run/chat/check/agents` use it. Checked live (2026-11-07) by driving `subspace chat` in a terminal with a fixture and with Claude; that found and fixed three bugs: `readOnly` refused instead of leaving other requests to the next rule (so `firstOf(readOnly, ask)` never asked), a permission question could be shown before the text that came before it, and Ctrl-C left a question pending.
   - Registry binaries: `subspace agents install <name>` (`installAgent()` in `./node`) downloads the archive for this machine, only when the registry lists a sha256 and the download matches it, unpacks it (tar, or unzip for zips on Linux) into `~/.cache/subspace/bin/<id>/<version>`, and the catalog then runs it by absolute path. Never on start. Checked against the live registry (2026-11-07): Goose (tar.bz2) and opencode (zip) installed and resolved, Cursor refused (no checksum). Of 22 binary agents, 17 have checksums for every platform. Install hints (2026-11-07): the registry's hint now beats a built-in one when Subspace can install or has installed the binary (opencode's built-in hint hid both), an `install` from your own file beats both, and only this machine's download counts as installable. The bundled registry snapshot predated keeping checksums, so it had none and `agents install` refused everything until a refresh; regenerated.
   - v2 background work (the "Background work" RFD). Client: `session.background` (the latest list; undefined when not reported), `cancellable` on tool calls and terminals, `session.cancelToolCall()` and `session.cancelTerminal()`, `paused` and `cancelled` statuses, `session.toolCalls` for earlier turns' tool calls (later updates to background work patch them, not the current turn), `session/cancel` sparing listed work, and permission questions about listed work answered with no turn running. Agent: `cancellable` and `detach()` on tool calls, `turn.showTerminal()` (agent terminals: write, replace, exit, detach), the `background` list on every state update once anything is detached, `tool_call/cancel` and `terminal/cancel` (-32602 for unknown, finished or uncancellable), and `session/close` stopping it all.
   - MCP servers for sessions: typed `mcpServers` (`stdio`, `http`, `sse`, `acp`), written in the agent's protocol (v1 stdio has no type; v2 stdio needs an absolute command) and checked against its transports before `session/new`. `client.supports.mcp` now has `acp`, and v2 `stdio` only when advertised.
   - MCP-over-ACP (the "MCP-over-ACP" RFD, MCP 2026-07-28): `client.serveMcp({ name, handler })` serves tools over the ACP connection. The handler has the official SDK's `McpRequestHandler` shape, so `fromMcpServer()` plugs in. Validation and error codes follow the SDK's provider (-33001 unknown server, -33000 limit, -33002 backend failure, -32800 cancelled; inner errors in the outcome). Tested against the SDK's `McpOverAcpCaller`. No real agent advertises the `acp` transport yet (Claude and Codex: stdio and http; Grok: http and sse).
4. **Journal kit (`experiment/acp-journal`, first cut done, 16 tests):** parked for the future (2026-11-07). When something needs it: v2 `session/resume`, a permission left open by a dead process recorded as interrupted on load, and cursors that are not plain sequence numbers. Kept generic: nothing specific to a private project goes in.
5. **Testkit (`packages/testkit`, merged, first cut done):**
   - built: recording and replay, fault injection, `checkAgent` and `checkClient`, and a corpus of 9 traces: a plain turn, a cancel and a refused write each for Grok (1.0.77), Claude (claude-agent-acp 0.101.0) and Codex (codex-acp 2.5.0), with accounts redacted;
   - every quirk in the agent catalog that a trace can show has a corpus test (`test/corpus.test.ts`): the refusal endings, the starting modes, Codex's `cancel` option, the redacted auth status, Grok's `_x.ai` notifications. Not from traces: Grok's `follows-always-approve` (a user setting) and `unknown-session-32602` (seen by `subspace check`, waived there);
   - Grok's `-32602` for an unknown session is a known quirk, waived from the catalog (`waives: ['session.unknown']`); `--strict` turns it into a failure;
   - re-record with `scripts/record-claude-codex.sh` when an adapter version changes, and check the catalog's `seen` fields;
   - the old `@deft/acp-testkit` is now in `legacy/`, so this folder could be renamed `packages/acp-testkit` to match its package name.
6. **Devtools (`packages/devtools`, merged, 15 tests):**
   - built: the trace analyzer, a standalone HTML viewer and the CLI;
   - done (2026-11-07): an answer after a `$/cancel_request` is not a problem (LSP expects one); ids seen only in failed requests are not sessions; checked in a browser on the Claude, Codex and Grok corpus traces, and it looked right;
   - OpenTelemetry (2026-11-07): `otelTap(otel)` in `@deft-subspace/acp`, an `RpcPeerOptions.tap` for a client or an agent, makes a span per request (CLIENT or SERVER), the `session/prompt` span is the turn (ends with the turn on v1 and v2, `acp.stop_reason`), with tool calls and the session's requests (permission questions, fs, terminals) inside it; cancels and plans are events. Requests start under the active context, so a turn nests under the app's span. No dependency (the app passes `@opentelemetry/api`); no conversation content, and tool titles only with `titles: true`. `spansFromTrace()` makes the same spans from a saved trace. Checked with the real SDK (sdk-trace-base 2.12, in-memory exporter, async-hooks context) on v1 and v2: one trace, the turn under the app's span. In Bridge: on both its ACP server and the MCP front's agent connections, with a test against the real SDK. Not done: passing the trace context to the agent in `_meta` (W3C `traceparent`), so an agent's own spans can join.
7. **Bounded turns:** done. `session.prompt(input, { limits })`, or the client's `limits` option, takes `maxDurationMs`, `idleMs`, `maxToolCalls` and `maxUsage`. A limit cancels the turn the normal way, pushes an `exhausted` event, and sets `result.exhausted` to `{ limit, max, value }`. 11 tests cover v1 and v2. In `bridge mcp`: the `prompt` tool takes `max_turn_seconds`, `idle_seconds` and `max_tool_calls`, `[mcp.limits]` sets the defaults, and the report says which limit fired.
8. **CI:** Node 22, 24 and 26, plus Bun, Deno and the browser for the kernel.
