# Agent events: the vocabulary, mapped

Version 3, 2026-11-18 (after Viz's review and the legal review). Phase 0 deliverable. Written by the Specifier; crosses the
clean-room wall (see `docs/clean-room-log.md`). Behaviour only.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED,
MAY and OPTIONAL in this document are to be interpreted as described in RFC 2119 and
RFC 8174 when, and only when, they appear in capitals.

## 1. What this is

This document lists **everything Deft Console shows, asks or does because of an agent**,
by what can be observed (what arrives on the wire, what the user sees, what is answered),
and says what each becomes in the protocol-neutral vocabulary of
`@deft-subspace/agent-driver`:

- an **event** (`workbench.emit(event)`): something the agent did, as plain data;
- an **ask** (`workbench.ask(ask)`): a question to the user that has an answer;
- a **service call** (`workbench.files`, `.terminals`, `.tools`, `.sessions`, `.project`,
  `.presentation`): the agent needs the application to do something and answer;
- a **driver result**: the return value or rejection of an `AgentDriver` method;
- **application-side**: the application does it itself; it does not cross the driver
  boundary.

Rows are numbered (M01 to M46). The numbers are this document's own. Each row says what
happens on the wire (named as in the ACP specification, or as the vendor names it), what
the user sees, and where it lands in the vocabulary. The types named here (`AgentEvent`,
the ask kinds, the services) are defined in `docs/agent-driver-design.md`.

Like the design document (its §1), this document states outcomes, not how an existing
client handles them; where Subspace already turns a protocol message into an event, the
row follows Subspace.

`TurnEvent` is Subspace's (`packages/acp/src/model.ts`). Where a row says
"`TurnEvent` `x`", the event is that member of `TurnEvent` unchanged, with one exception:
the `permission` event (M25) carries a request without `protocol` and with `raw`
optional (design document, section 3.1).

### 1.1 Conventions that hold for every row

- **Sessions.** One driver serves one main session. Traffic that names another session on
  the same connection (a sub-agent's child session) goes to `workbench.child(id)`, never
  to the main workbench (M20), except the sub-agent and background-work announcements of M21 to M23, which go to the
  main workbench whichever session they name.
- **Any time.** Events are not only emitted during a turn. Updates that arrive between
  turns (commands, modes, titles, usage, a sub-agent finishing) MUST be emitted when they
  arrive.
- **Order.** Events MUST be emitted in the order their causes arrived on the wire. An ask
  is opened at the point its request arrived; events that arrived before it are emitted
  first.
- **Plain data.** Every event, ask request and ask answer MUST be structured-cloneable.
  Lazy or computed fields MUST be materialised before `emit`.
- **Replay.** When a saved session is opened with `session/load`, the agent replays its
  history as `session/update`s before it answers. Those replayed updates MUST be emitted
  as events (the user sees the conversation again), except when the driver was told the
  transcript is already on screen (`options.session.reconnect`, design §5): then the
  transcript kinds (user, agent and thought chunks, tool calls and their updates, plans,
  session messages) MUST NOT be emitted during the load; other kinds still are.

## 2. The rows

### 2.1 What the agent says and does

| Row | On the wire | What the user sees | Kind | Becomes |
|---|---|---|---|---|
| M01 | `session/update` `agent_message_chunk` whose content is text. | The agent's reply text, streamed, appended to the current reply. | event | `TurnEvent` `message` (and `message_end` when it stops). |
| M02 | `session/update` `agent_thought_chunk` whose content is text. | The agent's thinking, streamed, in its own block. Reply text after a thought goes in a new block. | event | `TurnEvent` `thought` (and `thought_end`). |
| M03 | `session/update` `user_message_chunk` whose content is text. | The user's message as the agent echoes or replays it. The application suppresses the echo of a prompt it already shows. | event | `TurnEvent` `user_message` (and `user_message_end`), as Subspace's client produces it. |
| M04 | `session/update` `agent_message_chunk` whose content is `image`, `resource` or `resource_link`. | The image (or the resource, shown as an image when it is one) as its own block; reply text after it goes below it. Content of other types (for example audio) is not shown. | event | **Addition** `agent_content` `{ block }`: the content block as sent. Only those three content types are emitted. |
| M05 | `session/update` `plan` with `entries`. | The plan, replacing the plan shown last if it is the latest block; plan progress on the session. | event | `TurnEvent` `plan`. |
| M06 | `session/update` `tool_call`. | A new tool call block. | event | `TurnEvent` `tool_call` with `created: true`. |
| M07 | `session/update` `tool_call_update` for a tool call already seen. | The tool call block changes (status, content, diff, locations). | event | `TurnEvent` `tool_call` with `created: false`; `toolCall` is the tool call's state after the update, as Subspace's client keeps it. |
| M08 | `session/update` `tool_call_update` for a tool call **not** seen before. | A new tool call block, as if it had been created. | event | `TurnEvent` `tool_call` with `created: true`, as Subspace's client produces it for an update with no earlier tool call. An empty title is the application's to fill. |
| M09 | A tool call whose `_meta` carries the output of a command the agent runs itself (the `terminal_info` / `terminal_output` / `terminal_exit` convention, which the client asks for with `_meta.terminal_output` and `terminal_output_delta` in its capabilities); in protocol v2, `terminal_update` and `terminal_output_chunk`. | A live terminal under the tool call, showing the command's output, ending when the command exits. | event | `TurnEvent` `terminal`. (Subspace's client already does this for v1 and v2.) |
| M10 | `session/update` `available_commands_update`. | The agent's slash commands, offered in the prompt. | event | **Addition** `commands` `{ commands }`: the full list, replacing the previous one. |
| M11 | `session/update` `session_info_update` with a `title`. | The session's name changes, unless the user named the session themselves. Leading and trailing whitespace is dropped; a blank title changes nothing. | event | `TurnEvent` `session_info`. `title` MUST be present only when it is non-blank after trimming, and MUST then be the trimmed text. Whether the user named the session is the application's knowledge; the driver does not filter on it. |
| M12 | `_meta.promptSuggestions` on a `session_info_update` (in the update's `_meta`, else in the notification's `_meta`), or in the `_meta` of the `session/prompt` result. The client advertises `_meta.promptSuggestions: true` in its capabilities. | The agent's guess at the user's next prompt, offered as a ghost suggestion in the prompt; an empty one clears it. | event | **Addition** `prompt_suggestion` `{ text }`. Absent key: no event. `null`: `text: ""`. An object whose `suggestions` is a list: the first item (a string, or an object with a string `text`) that is non-blank, trimmed; if none, `""`. Anything else: no event. When both a title and a suggestion arrive in one update, the title event comes first. |
| M13 | `session/update` `usage_update` with `used` and `size` (and optionally `cost` `{ amount, currency }`). | Context use on the status line (and the cost when given), and in the session's statistics. | event | `TurnEvent` `usage` with `used`, `size`, and `cost` as `{ amount, currency }` when the agent sent both fields. The status line text is derived by the application (M42). |
| M14 | The `usage` of a `session/prompt` result. | The session's token totals grow (input, output, cached, total). | event | **Addition** `prompt_usage` `{ usage }`, `usage` as the agent sent it (ACP's `inputTokens`, `outputTokens`, `totalTokens`, `cachedReadTokens`, …). Emitted after the turn's last update and before `sendPrompt` resolves. |
| M15 | Grok: its vendor session notification with `turn_completed` and a `usage` object (cost in `costUsdTicks`, 10¹⁰ per US dollar); and with `response_completed` (tokens of one model call). Only for the main session. | Session cost and token totals; context use. | event | `turn_completed`: **addition** `prompt_usage` `{ usage, cost? }`, `cost` = `{ amount: ticks / 10¹⁰, currency: "USD" }` when ticks is a number. `response_completed`: `TurnEvent` `usage` with `used` = input + cache-read + cache-creation tokens (those that are integers), `size` = the context window, only when input tokens is an integer **and** the context window is known (M16). xAI layer. |
| M16 | Grok: `x.ai/models/update` with `availableModels`. | Nothing directly; it tells the client the context window. | none (state) | The xAI layer keeps the context window: the one `totalContextTokens` (under each model's `_meta`) that every model shares, ignoring models without it; unknown when they differ or none has it. |

### 2.2 Sessions, modes and options

| Row | On the wire | What the user sees | Kind | Becomes |
|---|---|---|---|---|
| M17 | `modes` in the result of `session/new`, `session/load` or `session/resume`; later `session/update` `current_mode_update`. | The mode selector: which modes exist and which is current. | event | **Addition** `modes` `{ current, available }`, always the full state. Emitted after a session is opened when the result has `modes`, and on every `current_mode_update` (with the stored list and the new current id). Modes MUST NOT be inferred from config options here: the selector shows the agent's `modes` only. |
| M18 | `configOptions` in the result of `session/new`, `session/load`, `session/resume` or `session/set_config_option`; `session/update` `config_option_update`. | The session's options (model, reasoning level, switches): complete and current. | event | **Addition** `config_options` `{ options }`, always the complete list, in Subspace's `ConfigOption` shape. Emitted after a session is opened (before `modes`), on every `config_option_update`, and after a successful `setConfigOption` whose result carries them. |
| M19 | A saved session is reopened with `session/resume`, which does not replay history, and the conversation is not already on screen. | A note that earlier messages are not shown. | event | **Addition** `resumed_without_history` `{}`. Not emitted when reconnecting to a conversation already on screen. |

### 2.3 Sub-agents and background work

| Row | On the wire | What the user sees | Kind | Becomes |
|---|---|---|---|---|
| M20 | Any `session/update` (or request) naming a session other than the main one, on the same connection: a sub-agent's child session. | The sub-agent's own conversation (opened from its card); its card's activity and counters. | events on the child | Every event and ask for that session goes to `workbench.child(sessionId)`, with the same mapping as for the main session. |
| M21 | `session/update` `subagent_update` (the ACP sub-agent sessions proposal; the client advertises `subagents: {}`), whichever session the notification names. | A card for the sub-agent in the parent's conversation, with title, description, state, and whether it can be cancelled. Later updates patch it. | event | **Addition** `subagent` on the **main** workbench: `{ sessionId, title?, description?, status?, cancellable?, cwd? }`, patch semantics (absent = unchanged). `status` from `state` per §3.1. `cancellable` is set only when `capabilities` is an object: true when it has a `cancel` key. |
| M22 | Grok: its vendor session notification with `subagent_spawned`, `subagent_progress` or `subagent_finished` (child id in `child_session_id`, else `subagent_id`). | As M21, plus counters (turns, tool calls, tokens, context %, duration, errors). | event | **Addition** `subagent` per §3.2, on the main workbench. xAI layer. A spawned sub-agent is remembered as cancellable through Grok's own method until it finishes (design §6). |
| M23 | Grok: its vendor session notification with `task_backgrounded`, or `task_completed` with a `task_snapshot`. | A background task (a command, a monitor) under the session, working, then done or failed. | event | **Addition** `background_work` per §3.3, on the main workbench. xAI layer. |
| M24 | `session/update` `session_message` (an upsert) or `session_message_chunk` (appends one content block): messages between this session and another (the sub-agent sessions proposal). | "To …" / "From …" message blocks between the session and its sub-agents, updated in place. | event | **Addition** `session_message` `{ messageId, patch?, append? }` per §3.4. |

### 2.4 Questions to the user

| Row | On the wire | What the user sees | Kind | Becomes |
|---|---|---|---|---|
| M25 | `session/request_permission`. | A permission question about a tool call (for a sub-agent, naming the sub-agent), with the agent's options. | ask, then event | Ask `permission` (design §4.1). Answer `{ optionId }` → reply `{ outcome: { outcome: "selected", optionId } }`; cancelled → reply `{ outcome: { outcome: "cancelled" } }`. After the reply, `TurnEvent` `permission` with the request and the outcome. The ask carries the tool call as Subspace's `PermissionRequest` already gives it (the request's details merged into what is known of the tool call). A question about work running in the background (protocol v2) is opened `detached`: it belongs to no turn (design §4.8). |
| M26 | `elicitation/create` in mode `form` or `url`. The client advertises `elicitation: { form: {}, url: {} }`. | A form to fill in, or a link to open, saying who asks (for a sub-agent, naming it). | ask | Ask `question` (design §4.2). A mode other than `form` or `url`: reply `{ action: "decline" }` without asking. Answer `accept` (with content) → `{ action: "accept", content }`; `accept` without content → `{ action: "accept" }`; `decline` → `{ action: "decline" }`; cancelled → `{ action: "cancel" }`. |
| M27 | Grok: `x.ai/mcp/elicit` (an MCP server's question, forwarded by Grok), with `serverName`. | As M26, saying "*server* (MCP server)" asks ("an MCP server" if unnamed). | ask | Ask `question` with `source` `"<server> (MCP server)"`. Reply uses Grok's key `outcome` instead of `action`: `{ outcome: "accept", content }`, `{ outcome: "decline" }`, `{ outcome: "cancel" }`; unknown mode → `{ outcome: "decline" }`. xAI layer. |
| M28 | `elicitation/complete` with `elicitationId`; Grok's `x.ai/mcp/elicit_complete`. | The open link question with that id goes away without an answer, and a brief "done in the browser" note. | event (and the ask settles) | The open `question` ask with that `elicitationId` is aborted (it settles `cancelled`, and its request is answered as M26/M27 say for a cancel), then **addition** `question_completed` `{ elicitationId }` is emitted whether or not such an ask was open. |
| M29 | Grok: `x.ai/ask_user_question` with `questions`, `toolCallId`, `mode` (`default` or `plan`). | One or more multiple-choice questions (tabs, multi-select, previews); in plan mode, also "chat about this" and "skip interview". For a sub-agent, in its own conversation. | ask | Ask `choices` (design §4.3). An empty `questions` list → reply `{ outcome: "cancelled" }` without asking. Cancelled → `{ outcome: "cancelled" }`. Otherwise the answer is the reply (Grok's shapes, §4.3). xAI layer. |
| M30 | Grok: `x.ai/exit_plan_mode` with `toolCallId`, `planContent`. | "The agent is ready to leave plan mode", the plan, and three choices: approve and start, keep planning, abandon. | ask | Ask `plan_approval` (design §4.4). Reply `{ outcome: "approved" \| "cancelled" \| "abandoned" }`; a cancelled ask is `cancelled` (keep planning). xAI layer. |
| M31 | Deft: `deft.co/wait_for_key` with `message` and `keys`. | The keys, with labels, in place of the prompt; pressing one answers. | ask | Ask `key` (design §4.5). Reply `{ outcome: "pressed", key }`; cancelled → `{ outcome: "cancelled" }`. Deft layer. |
| M32 | An auth-required error (code −32000) from `session/new`, `session/load`, `session/resume` or `session/prompt`, when the agent lists sign-in methods of type `agent`, `terminal` or `env_var`. | "Sign in": the agent's message (or "*Agent* needs you to sign in."), the methods with their descriptions, and "Not now". | ask | Ask `sign_in` (design §4.6). The sign-in procedure is in design §7.4. |
| M33 | The user chose a `terminal` or `env_var` sign-in method. | Console runs the agent's login in a terminal, or asks for the method's variables (secret ones masked); on success the agent is started again with them; otherwise "Not signed in". | ask | Ask `sign_in_outside` (design §4.7). The application does the sign-in and, on success, starts a new agent (and a new driver); this driver is then stopped. |
| M34 | The agent's program needs Node.js and there is none. | "*Agent* runs on Node.js…", offering to download it. | application-side | Not part of the vocabulary. Starting the agent's program is the application's business: this happens before a driver has a channel. |

### 2.5 Things the agent asks the application to do

| Row | On the wire | What the user sees | Kind | Becomes |
|---|---|---|---|---|
| M35 | `terminal/create` (`command`, `args`, `cwd`, `env` as name/value pairs, `outputByteLimit`, `sessionId`). | A terminal in the conversation running the command (for a sub-agent, in its conversation). | service | `terminals.create` (on the child workbench for a child session). Reply `{ terminalId }`. A failure → error reply. |
| M36 | `terminal/output`. | Nothing new. | service | `terminals.output` → reply `{ output, truncated, exitStatus? }`; `exitStatus` `{ exitCode, signal }` only once the command has exited. |
| M37 | `terminal/wait_for_exit`. | Nothing new. | service | `terminals.waitForExit` → reply `{ exitCode, signal }`. |
| M38 | `terminal/kill`. | The terminal's command stops. | service | `terminals.kill` → reply `{}`. |
| M39 | `terminal/release`. | The terminal stays on screen; the agent no longer uses it. | service | `terminals.release` → reply `{}`. |
| M40 | `fs/read_text_file`, `fs/write_text_file`. (Listed for completeness.) | Nothing (a write may be visible in a diff the agent sends). | service | `files.readText` → `{ content }`; `files.writeText` → `{}`. A service failure → error reply. |
| M41 | Console's display tools, called by the agent: show a diagram, show an image (inline or beside), show a page in the browser view, the terminal-pane tools, the worker-session tools. Reached either through an MCP server the application runs (offered in `mcpServers`), or through Deft's `deft.co/call_tool`. | The diagram, the image, the page, the pane or worker session; for tools that need the user, their question. | service | `tools.call(name, args, { signal })` → `{ ok, message }`. What each tool shows and asks is the application's. Through ACP it is the Deft layer that calls it (design §6.1); through the MCP server, the driver never sees it. |

### 2.6 The agent's state as a whole

| Row | What happens | What the user sees | Kind | Becomes |
|---|---|---|---|---|
| M42 | Context use changed (M13, M15). | The status line text. | application-side | Derived by the application from `TurnEvent` `usage`. No event of its own. |
| M43 | The agent is ready: initialised, its session open. | The prompt becomes usable. | driver result | `start()` resolves. |
| M44 | The agent could not be started or its session could not be opened: no run command, the program failed to start, the agent refused `initialize`, the user is not signed in, signing in was cancelled, or the saved session cannot be reopened by this agent. | "Failed to start agent" (or the reason), the details, and help (a different help for "can't resume"). | driver result | `start()` rejects with an `StartFailure` (design §3.5). The process-related reasons (no run command, failed to spawn, exit code and stderr) are the application's, which starts the program. |
| M45 | The connection to the agent ended while the driver was not stopping. | "Agent connection closed" (or the program's exit code and stderr, which the application knows). | event | **Addition** `connection_closed` `{ message }`. Emitted once. Open asks settle `cancelled`; the driver's open calls settle with their "not done" values. |
| M46 | A `session/prompt` failed with an error from the agent; the agent is still running. | The turn ends with the error's explanation; the conversation goes on. | event and driver result | **Addition** `turn_failed` `{ reason }` (§3.5), then `sendPrompt` resolves `null`. |

## 3. Details

### 3.1 Sub-agent state from `subagent_update` (M21)

`state` is an object with `state` (and, when idle, `stopReason` and maybe `error`):

| `state.state` | `stopReason` / `error` | `status` |
|---|---|---|
| `running` | | `{ state: "working" }` |
| `requires_action` | | `{ state: "blocked", blockedKind: "permission" }` |
| `idle` | `stopReason` is `error`, or `error` is set | `{ state: "error", message: error or "Failed" }` |
| `idle` | `stopReason` is `cancelled` | `{ state: "idle", message: "Cancelled" }` |
| `idle` | any other `stopReason` | `{ state: "done", message: "Finished" }` |
| `idle` | none | `{ state: "idle" }` |
| `unknown` | | `{ state: "idle", message: "State unknown" }` |
| any other string *s* | | `{ state: "idle", message: "State: s" }` |
| absent or not an object | | `status` absent |

### 3.2 Grok sub-agent notifications (M22)

| Grok update | `subagent` event |
|---|---|
| `subagent_spawned` | `title`: its `description`, else its `subagent_type`, else `"sub-agent"`; `description`: its `subagent_type` or `"sub-agent"`; `status` working; `cancellable: true`. |
| `subagent_progress` | `status` working; `stats` from the counters present. |
| `subagent_finished` | `status` from its `status`: `failed`/`error` → error (message: its `error`, else "Failed"); `cancelled`/`canceled`/`killed` → idle "Cancelled"; absent, `completed`, `complete`, `success`, `succeeded`, `done` → done "Finished"; anything else → idle with that value as the message. `stats` from the counters present; `cancellable: false`. |

Counters (only those that are numbers): Grok's `turn_count` or `turns` → `turns`;
`tool_call_count` or `tool_calls` → `toolCalls`; `tokens_used` → `tokens`;
`context_usage_pct` → `contextPercent`; `duration_ms` → `durationMs`; `error_count` →
`errors`.

### 3.3 Grok background tasks (M23)

- `task_backgrounded` with a `task_id`: `background_work` `{ taskId, title, subtitle,
  status: working, cwd }`; `title` is its `description`, else `monitor_description`, else
  the command; `subtitle` is the command (or `""`).
- `task_completed` whose `task_snapshot` has `task_id` (else `id`): `{ taskId, status }`,
  error when the snapshot's `status` is `failed` or `error`, or its `exit_code` is
  present and not zero; else done.

### 3.4 Session messages (M24)

Each transcript (main or child) keeps its own messages, keyed by `messageId`.
`session_message` is an upsert: a field left out is unchanged, `null` clears it, a value
replaces it (`content: []` clears the content). The fields it patches are
`senderSessionId`, `recipientSessionId`, `senderMessageId`, `recipientMessageId` and
`content`. `session_message_chunk` appends one content block. The event carries the patch
(`patch`, with exactly the fields the update had) or the block (`append`). Whether a
message is "to" or "from" is the application's reading of sender and recipient.

### 3.5 A failed prompt's reason (M46)

The most readable explanation the error has, in this order: `data.details`,
`data.message`, `data.error` (each either a string or an object whose `message` is a
string), or `data` itself when it is a string. The first that is a non-blank string wins,
trimmed; if it looks like JSON (starts with `{`) and parses, the reason is its
`error.message`, else its `message`, else the text as it was. With none of those, the
error's own message, unless it is "internal error" or "unknown error" (in any case),
which count as none. With none at all: "*Agent name* returned an error".

## 4. Not in the vocabulary

- **Program start-up** (M34, and the process parts of M44): the application starts the
  agent's program and gives the driver a channel.
- **What the display tools show** (M41): the application's.
- **The status line** (M42): derived by the application.
- **Whether the user named the session** (M11): the application's; it decides whether an
  agent's title replaces the shown name, and calls `setSessionTitle`.
- **The prompt's content blocks**: the application builds them (mentions of files,
  images) from the agent's `capabilities.promptContent`, and passes them to `sendPrompt`.

## 5. Coverage

The Specifier keeps, outside Subspace, a key that checks this list against Console:
every behaviour it found has a row here or is listed in §4, and none is "unknown".
