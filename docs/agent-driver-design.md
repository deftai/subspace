# Agent drivers: the interfaces, settled

Version 3, 2026-11-18 (after Viz's review and the legal review). Phase 0 deliverable. Written by the Specifier; crosses the
clean-room wall (see `docs/clean-room-log.md`). Behaviour and types only. Where this
document and the implementer brief's sketch (brief §6) differ, this document wins.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED,
MAY and OPTIONAL in this document are to be interpreted as described in RFC 2119 and
RFC 8174 when, and only when, they appear in capitals.

Companion: `docs/agent-events-mapping.md` (rows M01 to M46), which says when each event,
ask and service call happens.

---

## 1. Scope

This document gives:

- the full types of `@deft-subspace/agent-driver` (sections 3 to 5 and 8): every `…` in the
  brief's sketch filled in, and the additions;
- what each vendor layer does (section 6);
- the observable behaviour of a driver over ACP (section 7), which the transcripts pin;
- the role of handlers and wires (section 9);
- the in-process test of the interfaces (section 10);
- Viz's decisions on the questions Phase 0 raised (section 11).

The type sketches are TypeScript for precision. They fix names, shapes and meaning. The
Implementer decides everything they leave open (file layout, helpers, internal types,
how layers are composed), within the brief.

Names that the brief fixes are unchanged. Additions are marked **(added)**.

**What this document does not do.** It does not restate how any existing client handles a
case. Where behaviour is required by the ACP specification, or is already Subspace's own
(its client, projection and session model), this document says so and follows it. Where
the only source of a detail is an existing client's code, this document states the
outcome a user or an agent can observe and leaves the detail to the transcripts, which are
recorded from the running application (brief §4). Where Subspace and the existing client
differ in such a detail, Subspace's behaviour is the vocabulary; the existing client is
adapted to it on Console's side.

## 2. Packages and dependencies

- `@deft-subspace/agent-driver` holds sections 3 to 5, 8 and 9: types, the fake workbench and
  the conformance runner. It imports **types only** from `@deft-subspace/acp`. No Node API
  outside a `./node` entry.
- `@deft-subspace/acp` gains `clientEndpoint` and `ClientLayer` (brief §7).
- `@deft-subspace/acp-vendors` holds the three vendor layers (section 6).
- The driver over `AcpClient` (section 7) lives where the Implementer decides, in Subspace,
  and depends on `@deft-subspace/acp`, `@deft-subspace/acp-vendors` and the types of
  `@deft-subspace/agent-driver`.

## 3. Plain data

Everything in this section MUST be structured-cloneable: no functions, no class
instances, no getters that compute on read. `Uint8Array` is allowed.

From `@deft-subspace/acp` (types only): `TurnEvent`, `ToolCall`, `PermissionOption`,
`PermissionOutcome`, `ContentBlock`, `StopReason`, `PromptInput`, `ConfigOption`,
`SessionMode`.

### 3.1 `AgentEvent`

```ts
/** A permission request with nothing protocol-specific in it. */
export interface PermissionAskRequest {
  /** The session that asks: the main session's id, or a child's on a child workbench. */
  sessionId: string;
  title: string;
  /** The tool call this is about, with the request's fields merged into what was known of it. */
  toolCall?: ToolCall;
  /** The command a command permission asks to run, when the request says. */
  command?: { command: string; cwd: string };
  options: PermissionOption[];
  /** The request as it arrived, for diagnostics only. A workbench MUST NOT depend on it. */
  raw?: unknown;
}

/** TurnEvent, except that `permission` carries a PermissionAskRequest. */
export type CoreEvent =
  | Exclude<TurnEvent, { type: 'permission' }>
  | { type: 'permission'; request: PermissionAskRequest; outcome: PermissionOutcome };

export type AgentEvent = CoreEvent | AgentEventAddition;
```

The change to `permission` is the only change to `TurnEvent`. Subspace's
`PermissionRequest` has a required `protocol` (1 or 2) and `raw`; a driver that embeds an
SDK has neither, and would have to invent a protocol version (section 10). A driver over
`AcpClient` builds a `PermissionAskRequest` from its `PermissionRequest` by leaving
`protocol` out.

`TurnEvent` `update` (anything else, unchanged) stays in the vocabulary for updates no row
of the mapping covers. A workbench MAY ignore it; it MUST NOT need it to show anything the
mapping lists.

### 3.2 The additions

```ts
export type AgentEventAddition =
  /** M04: non-text content in the agent's reply (image, resource, resource_link). */
  | { type: 'agent_content'; block: ContentBlock }
  /** M14, M15: what one turn used. `usage` as the agent reported it; `cost` when known. */
  | { type: 'prompt_usage'; usage: Readonly<Record<string, unknown>>; cost?: Cost }
  /** M10: the agent's commands, the full list. */
  | { type: 'commands'; commands: AgentCommand[] }
  /** M17: the session's modes, the full state. */
  | { type: 'modes'; current: string | null; available: SessionMode[] }
  /** M18: the session's config options, the complete list. */
  | { type: 'config_options'; options: ConfigOption[] }
  /** M12: the agent's guess at the next prompt; "" clears it. */
  | { type: 'prompt_suggestion'; text: string }
  /** M19: a saved session was reopened without its history. */
  | { type: 'resumed_without_history' }
  /** M21, M22: a sub-agent announced or changed. Absent fields are unchanged. */
  | {
      type: 'subagent';
      sessionId: string;
      title?: string;
      description?: string;
      status?: WorkState;
      stats?: SubagentStats;
      cancellable?: boolean;
      cwd?: string;
    }
  /** M23: background work the agent runs. Absent fields are unchanged. */
  | { type: 'background_work'; taskId: string; title?: string; subtitle?: string; status?: WorkState; cwd?: string }
  /** M24: a message between sessions. Exactly one of `patch` and `append`. */
  | { type: 'session_message'; messageId: string; patch?: SessionMessagePatch; append?: ContentBlock }
  /** M28: a link question finished on the agent's side. */
  | { type: 'question_completed'; elicitationId: string }
  /** M46: the turn failed with an error from the agent; the agent is still running. */
  | { type: 'turn_failed'; reason: string }
  /** M45: the connection ended while the driver was not stopping. Emitted once. */
  | { type: 'connection_closed'; message: string };

export interface Cost { amount: number; currency: string }

/** ACP's available command, as plain data. */
export interface AgentCommand { name: string; description: string; input?: { hint: string } | null }

export interface WorkState {
  state: 'working' | 'blocked' | 'idle' | 'done' | 'error';
  /** For `blocked`: what it waits for. */
  blockedKind?: 'permission' | 'question' | 'auth';
  /** Shown with the state ("Finished", "Cancelled", an error). */
  message?: string;
}

export interface SubagentStats {
  turns?: number; toolCalls?: number; tokens?: number;
  contextPercent?: number; durationMs?: number; errors?: number;
}

/** The fields a `session_message` upsert carried; null clears. */
export interface SessionMessagePatch {
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  senderMessageId?: string | null;
  recipientMessageId?: string | null;
  content?: ContentBlock[] | null;
}
```

`usage` (`TurnEvent`) carries `cost` as a `Cost` when the agent gave both an amount and a
currency (mapping M13).

### 3.3 `AgentInfo` and `AgentSessionList`

```ts
export interface AgentInfo {
  /** The agent's name as the application knows it (from AgentDriverOptions.agent). */
  name: string;
  /** What the agent said about itself, when it did. */
  title?: string;
  version?: string;
  /** The driver's kind, for example "acp-subspace". */
  driver: string;
  /** The protocol in use, when there is one, for example "acp/1". Absent for in-process drivers. */
  protocol?: string;
}

export interface AgentSessionList {
  /** Each as the agent described it; every one has a non-empty sessionId. */
  sessions: Array<Readonly<Record<string, unknown>> & { sessionId: string }>;
  /** Why (the rest of) the list could not be had, or null. */
  error: string | null;
  /** There were more than the driver asks for. */
  truncated: boolean;
}
```

### 3.4 Prompts and stop reasons

`PromptInput` and `StopReason` are Subspace's. The application builds the prompt's content
blocks (file mentions, attached images) from `capabilities.promptContent`; the driver
sends them as given.

### 3.5 `StartFailure`

```ts
/** Why the agent could not be started or its session opened (M44). Plain data. */
export interface StartFailure {
  kind: 'failed' | 'not_signed_in' | 'cannot_reopen' | 'restarting' | 'stopped';
  /** One line, shown as the failure's title. */
  message: string;
  /** More, shown under it. May be "". */
  details: string;
}
```

`start()` rejects with an `Error` whose `failure` property is an `StartFailure` (the error
itself need not be cloneable; its `failure` MUST be). `restarting`: the user signed in by a
route that starts a new agent (ask `sign_in_outside`); the application ignores this failure.
`stopped`: `stop()` was called before the agent was ready; the application ignores it too.

## 4. Asks

```ts
export interface Ask<Request, Answer> {
  readonly kind: string;
  readonly request: Request;
}
export type Cancelled = { outcome: 'cancelled' };
```

`ask(ask, { signal })` resolves with the answer or `{ outcome: 'cancelled' }`, and never
stays pending (section 4.8). The kinds below are the whole vocabulary of asks. A workbench
that is given a kind it does not know MUST resolve it `cancelled` at once.

Each section gives the request, the answer, and what a cancel means on the wire (the
mapping row says the rest).

### 4.1 `permission` (M25)

- Request: `PermissionAskRequest` (section 3.1).
- Answer: `{ optionId: string }`, one of the request's options.
- The driver then emits `TurnEvent` `permission` with `outcome`
  `{ outcome: 'selected', optionId, allowed }` (`allowed` is true for options of kind
  `allow_once` or `allow_always`) or `{ outcome: 'cancelled' }`.

### 4.2 `question` (M26, M27, M28, and Antigravity's sign-in)

- Request: `{ mode: 'form' | 'url'; message: string; requestedSchema?: object; url?: string;
  elicitationId?: string; toolCallId?: string; source?: string }`. `source` says who asks,
  when it is not the agent itself (an MCP server, a sign-in).
- Answer: `{ action: 'accept'; content?: Record<string, unknown> } | { action: 'decline' }
  | { action: 'cancel' }`. A user's own "cancel" and a cancelled ask are answered to the
  agent the same way.

### 4.3 `choices` (M29)

- Request: `{ toolCallId: string; planning: boolean; questions: ChoiceQuestion[] }` where
  `ChoiceQuestion` is `{ question: string; id?: string; header?: string; multiSelect:
  boolean; options: { label: string; id?: string; description?: string; preview?: string }[] }`.
  `planning` is true when Grok's `mode` is `plan`. `multiSelect` is true when Grok's
  `multiSelect` or `multi_select` is true.
- Answer: one of
  - `{ outcome: 'accepted'; answers: Record<string, string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }`
    (keyed by question text; the labels chosen);
  - `{ outcome: 'chat_about_this' | 'skip_interview'; partialAnswers: Record<string, string> }`
    (planning only).
- On the wire (Grok's shapes): `accepted` → `{ outcome: "accepted", answers,
  annotations? }`; the other two → `{ outcome, partial_answers }`; cancelled →
  `{ outcome: "cancelled" }`.

### 4.4 `plan_approval` (M30)

- Request: `{ toolCallId: string; plan: string | null }`.
- Answer: `{ decision: 'approve' | 'keep_planning' | 'abandon' }`.
- On the wire: `approved`, `cancelled`, `abandoned`; a cancelled ask is `cancelled`.

### 4.5 `key` (M31)

- Request: `{ message: string; keys: { key: string; label: string }[] }`: one to nine
  keys, each a single printable character other than space, no two alike.
- Answer: `{ key: string }`, one of the keys.

### 4.6 `sign_in` (M32)

- Request: `{ methods: AuthMethod[]; message: string }`, where `AuthMethod` is the agent's
  method as plain data (`id`, `name`, `description?`, `type?`, and for `env_var` its
  `vars`, for `terminal` its `args` and `env`). Only methods of type `agent`,
  `terminal` or `env_var` are offered (a method without a type is an `agent` method).
  `message` is why (the agent's error text), or `""`.
- Answer: `{ methodId: string } | { methodId: null }` (the user declined: "Not now").
  Declined and cancelled both mean "not signed in".

### 4.7 `sign_in_outside` (M33)

- Request: `{ method: AuthMethod }`, a `terminal` or `env_var` method.
- Answer: `{ signedIn: boolean }`. The application does the sign-in. When it answers
  `signedIn: true` it has started (or will start) a new agent, with a new driver, and
  will stop this one. `false`: it did not finish; the driver asks `sign_in` again with the
  message "Signing in didn't finish.". Cancelled: the user gave up while it was under
  way; signing in stops (section 7.4).

### 4.8 When asks settle (W2, W3)

- **One registry.** A workbench has exactly one registry of open asks. A child workbench
  (section 8.2) shares its parent's registry.
- **Which turn an ask belongs to.** An ask opened on a workbench while a turn is open (between
  `turnStarted` and `turnEnded`) belongs to that turn. An ask opened on a child belongs to
  the parent's open turn, if any. Otherwise it belongs to no turn. An ask opened with
  `detached: true` belongs to no turn even while one is open: a driver MUST open a
  permission question about work running in the background (protocol v2: a tool call or
  terminal the agent lists as background work) detached, because that work outlives the
  turn.
- **Settled `cancelled`:**
  - when its `signal` aborts;
  - when its turn ends (`turnEnded`);
  - when the workbench closes (the application tears the conversation down);
  - for asks of every turn and of no turn: when the driver cancels (see below) or stops.
- **Drivers MUST pass a signal.** Every ask a driver or handler opens MUST carry a signal
  that aborts when: the agent withdraws the request it answers (`$/cancel_request`); the
  user cancels the turn (`cancel()`); the driver stops; the connection closes. `cancel()`
  aborts every open ask, of the turn and of no turn, **before** it tells the agent
  (ACP requires a cancelled turn's open permission requests to be answered `cancelled`).
- An ask that settles `cancelled` is answered to the agent as its section says.

## 5. The driver

```ts
export interface AgentDriver {
  /** Resolves when the agent is ready for a prompt. Rejects with an StartFailure (3.5). */
  start(): Promise<void>;
  /** Idempotent. Settles every open ask and every pending call (V3). */
  stop(): Promise<void>;
  readonly info: AgentInfo;
  readonly capabilities: AgentDriverCapabilities;
  /** The main session's id once known; null before, and when there is none. */
  readonly sessionId: string | null;
  /** The process the application started for this agent, if it said; never signalled by the driver. */
  readonly pid: number | null;
  sendPrompt(prompt: PromptInput): Promise<StopReason | null>;
  cancel(): Promise<boolean>;
  setMode(modeId: string): Promise<string | null>;
  setConfigOption(id: string, value: string | boolean): Promise<string | null>;
  listSessions(cwd: string): Promise<AgentSessionList | null>;
  deleteSession(sessionId: string): Promise<string | null>;
  /** The session's title changed (by the user, or the application applying the agent's). */
  setSessionTitle(title: string, byUser?: boolean): Promise<void>;
  logout(): Promise<string | null>;
  stopTerminal(toolCallId: string): Promise<string | null>;
  cancelSubagent(childSessionId: string): Promise<boolean>;
}

export interface AgentDriverCapabilities {
  logout: boolean;
  stopTerminals: boolean;
  emptyPrompts: boolean;
  /** The driver can reopen a saved session and replay its history (ACP `loadSession`). */
  loadSession: boolean;
  /** The driver can reopen a saved session without replay (ACP session `resume`). */
  resumeSession: boolean;
  listSessions: boolean;
  deleteSessions: boolean;
  modes: boolean;
  configOptions: boolean;
  /** Session capabilities in ACP's names ("list", "delete", "resume", "close", …), including ones a vendor layer supplies. */
  sessionCapabilities: readonly string[];
  /** (added) What a prompt may carry besides text and resource links. */
  promptContent: { image: boolean; audio: boolean; embeddedContext: boolean };
}

export type AgentDriverFactory = (workbench: AgentWorkbench, options: AgentDriverOptions) => AgentDriver;

/** (added) What every driver is given. A driver kind MAY extend it. */
export interface AgentDriverOptions {
  /** The application's record of the agent. */
  agent: { name: string; identity: string | null };
  /** How the application names itself to the agent. */
  client: { name: string; title?: string; version: string };
  /** Reopen this saved session instead of opening a new one. */
  session?: {
    sessionId: string;
    /** The session's working directory as saved. */
    cwd: string;
    /** The conversation is already on screen (a new connection for an open conversation). */
    reconnect: boolean;
  };
  /** The process the application started for this agent, if any (reported as `pid`). */
  pid?: number | null;
}

/** (added) The driver over AcpClient also takes the agent's connection. */
export interface AcpDriverOptions extends AgentDriverOptions {
  /** JSON-RPC messages to and from the agent (use ndjson() over a byte channel). */
  channel: Channel<unknown>;
  /** Passed to AcpClient's `protocol` option unchanged; AcpClient's default when absent. */
  protocol?: 'auto' | 1 | 2;
}
```

`capabilities` MUST be correct once `start()` has resolved. Before that it MAY report
everything false.

### 5.1 "Can't" and "not done" results

A method that cannot do what it is asked MUST return this, not throw. After `stop()`,
every method returns the same "not done" value at once, and every call still pending
settles with it.

| Method | "Can't" / "not done" |
|---|---|
| `sendPrompt` | `null` |
| `cancel` | `false` |
| `setMode` | `"This agent has no modes"` (when `capabilities.modes` is false and the driver refuses locally; an ACP driver sends the request anyway and reports the agent's answer, section 7.6) |
| `setConfigOption` | `"This agent has no session options"`; with no session, `"No session"` |
| `listSessions` | `null` |
| `deleteSession` | `"This agent can't delete sessions"` |
| `setSessionTitle` | resolves |
| `logout` | `"This agent doesn't support signing out"` |
| `stopTerminal` | `"The agent can't stop its commands"` |
| `cancelSubagent` | `false` |
| `start` | rejects, `kind: 'stopped'` after `stop()` |

A `string` result is a message for the user; `null` means done.

## 6. Vendor layers

Each vendor layer is one `ClientLayer` in `@deft-subspace/acp-vendors` (X1). The vendors'
messages are described in `docs/agent-vendor-protocols.md`. It acts only
through the workbench and the layer context (X2). Everything specific to the vendor is in
its layer (X3). Detection (X4) governs what the layer advertises, calls and reports; an
inbound vendor method is answered whenever it arrives (an agent that sends it speaks that
vendor's protocol), as today (Viz's decision, section 11).

The answers to inbound vendor methods MUST be registered under both spellings, `name` and
`_name` (C6). Where the client calls a vendor method and the vendor has used both
spellings, the layer tries the prefixed one first and, on "method not found", the other.

### 6.1 Deft (`deft.co`)

Applies to every agent for what it advertises (the client cannot know the agent before
`initialize`), and to agents whose `_meta["deft.co"]` says so for the rest.

- **Advertises**, in `initialize`, under `clientCapabilities._meta["deft.co"]`:
  `waitForKey: {}`; `display:` what `workbench.presentation.capabilities()` returns;
  `tools:` what `workbench.tools.list()` returns, only when it is not `null`.
- **Reads** the agent's `agentCapabilities._meta["deft.co"]`: `emptyPrompt` (an object)
  → `capabilities.emptyPrompts`; `stopTerminal` (an object) → `capabilities.stopTerminals`;
  `tools` (an object) → the agent takes the application's tools over ACP, so the
  application's MCP servers (`tools.mcpServers()`) MUST NOT also be attached to its
  sessions.
- **Answers** `deft.co/wait_for_key` (M31): keep the `keys` entries that are objects whose
  `key` is one printable character other than space, the first of each key only, with
  `label` (or the key when the label is empty); if none remain, an error reply (internal
  error) saying a single-character key is needed; else ask `key` with the first nine and
  `message` (or `""`).
- **Answers** `deft.co/call_tool` (`sessionId`, `name`, `arguments`), in this order:
  tools turned off (`tools.list()` is `null`) → error reply; `sessionId` not the main
  session → invalid-params error naming the main session (sub-agents' calls are refused
  for now); `name` not among `tools.list()` → invalid-params error naming the tool;
  `arguments` neither an object nor null → invalid-params error; else `tools.call(name, arguments ?? {}, { signal })` and reply `{ ok, message }`.
  The signal aborts when the turn is cancelled or the agent withdraws the request; the
  tool then resolves `{ ok: false, message }` with the application's message.
- **Calls** `_deft.co/stop_terminal` `{ sessionId, toolCallId }` for
  `driver.stopTerminal(toolCallId)`: when the agent cannot, or there is no session,
  `"The agent can't stop its commands"`; an error reply → its message, or "The agent
  didn't stop the command"; success → `null` (the command's terminal ends when the agent
  reports its exit).

### 6.2 xAI (Grok Build, `x.ai`)

Detected when `agentCapabilities._meta` has a key starting `x.ai/` or `_x.ai/`.

- **Answers** `x.ai/ask_user_question` (M29), `x.ai/exit_plan_mode` (M30),
  `x.ai/mcp/elicit` (M27), `x.ai/mcp/elicit_complete` (M28), `x.ai/models/update`
  (M16), and `x.ai/session_notification` (M15, M22, M23; other kinds of update in it are
  ignored). A question whose `sessionId` is a child session is asked on that child's
  workbench.
- **Supplies** the session capability `delete` when detected, and deletes with
  `_x.ai/session/delete` `{ sessionId }` (then `x.ai/session/delete`), within 30 seconds:
  timeout → `"The agent didn't answer"`; error −32002 → deleted; another error → its
  message or `"The agent refused"`; neither spelling known → `"This agent can't delete
  sessions"`; a result with `success: true` → deleted; otherwise the result's `error`, or
  `message`, or `"The agent refused"`.
- **Cancels sub-agents it saw spawned** and not yet finished, with
  `_x.ai/subagent/cancel` `{ subagentId }` (then `x.ai/subagent/cancel`): any other error,
  or neither spelling known → `false`; a result with `cancelled: false` → `false`; else
  `true`. For other sub-agents it does not answer, and the driver's own way applies.

### 6.3 Antigravity

Detected when the application's agent identity is `antigravity.google`, or
`agentCapabilities._meta.antigravity` is an object.

- **System prompt.** When the agent's `_meta.antigravity.systemPrompt.append` is `true`
  and it does not offer the standard session `systemPrompt`, the text the application
  wants appended (section 7.3) goes in `session/new`, `session/load` and `session/resume`
  as `_meta.antigravity.systemPrompt.append`.
- **Sign-in with an API key.** When the user picks the method `gemini-api-key` of a
  detected agent:
  1. If `GEMINI_API_KEY` is set (in `workbench.project.env`), trimmed and non-empty:
     `authenticate` `{ methodId, _meta: { apiKey } }`. Success → signed in.
  2. Else (or if that failed): ask `question`, mode `form`, `message` the method's
     description or "Enter your Gemini Developer API key.", `source` "Sign in to *agent
     name*" (or "Antigravity"), and a schema of one required string `apiKey` titled
     `GEMINI_API_KEY` with `format: "password"`, the schema titled with the method's name
     or "Gemini API key".
  3. Cancelled → signing in is cancelled (section 7.4). Declined → back to the choice of
     method. An empty key → back to the choice with "Signing in failed: No API key
     entered". `authenticate` fails → back to the choice with "Signing in failed:
     *detail*". Success → `project.rememberEnv("GEMINI_API_KEY", key)`, signed in.

### 6.4 What a vendor layer may take over

The base behaviour (section 7) MUST consult the vendor layers for these, through services
or hooks around the base's own handling (C3), never through a second handler for the same
method. A layer either takes the operation (its answer is final) or declines it (the base
goes on).

| Operation | Taken over by | Base behaviour when no layer takes it |
|---|---|---|
| Whether a session capability is supported | xAI (`delete`) | the agent's `sessionCapabilities` |
| Deleting a session that the agent does not offer `session/delete` for | xAI | `"This agent can't delete sessions"` |
| Cancelling a sub-agent | xAI (sub-agents it saw spawned) | `session/cancel` on the child session |
| Running an `agent` sign-in method | Antigravity (`gemini-api-key`) | `authenticate` `{ methodId }` |
| Appending to the system prompt when the standard field is not offered | Antigravity | nothing appended |
| Whether prompts may be empty; whether commands can be stopped; stopping one | Deft | false; `"The agent can't stop its commands"` |
| Which MCP servers go with a session | Deft (leaves out the application's tool servers) | `tools.mcpServers()` |

## 7. The driver over ACP: what it does

This is behaviour the transcripts check. "Error" below means a JSON-RPC error reply.

### 7.1 Initialise

`initialize` as `AcpClient` sends it for the `protocol` option (section 5; Console
registers the driver with 1, section 11), with `clientInfo` from `options.client`
(`name`, `title`, `version`). For protocol 1, `clientCapabilities` are:
`fs: { readTextFile: true, writeTextFile: true }`, `terminal: true`,
`session: { configOptions: { boolean: {} } }`, `elicitation: { form: {}, url: {} }`,
`auth: { terminal: true }`, `subagents: {}`, and `_meta`: `terminal_output: true`,
`terminal_output_delta: true`, `promptSuggestions: true`, and what the vendor layers add
(Deft's `deft.co`). For protocol 2, the v2 equivalents of the same capabilities, as
`AcpClient` spells them. The agent's capabilities, info and auth methods, `_meta`
included, are kept for the layers (C7).

### 7.2 Open the session

- **New** (no `options.session`): `session/new` with `cwd` = `workbench.project.path`,
  `mcpServers` (section 7.3), and the system prompt (section 7.3).
- **Reopen** (`options.session`), with the saved `cwd`:
  - reconnecting and the agent offers `resume` → `session/resume`, no `resumed_without_history`;
  - else the agent offers `loadSession` → `session/load` (replay per mapping §1.1);
  - else the agent offers `resume` → `session/resume`, then `resumed_without_history`;
  - else fail with `kind: 'cannot_reopen'`.
- After the answer: `config_options` if it has `configOptions`, then `modes` if it has
  `modes`. Then `sessions.opened({ sessionId, cwd, how, reopenable })` where
  `reopenable` = the agent offers load or resume; for a reopened session,
  `sessions.used({ sessionId })`.
- Each of these requests goes through sign-in (section 7.4).
- If `initialize` or opening the session fails, `start()` rejects with a `StartFailure`:
  `not_signed_in` when the agent requires sign-in and the user did not sign in (section
  7.4); `stopped` when `stop()` came first; `failed` otherwise. `message` and `details`
  explain the failure to the user, using what the agent's error says where it says
  something. The texts for each case are pinned by the transcripts.

### 7.3 System prompt and MCP servers

- `workbench.presentation.systemPrompt()` gives text to append, or `null`. When it gives
  text and the agent offers `sessionCapabilities.systemPrompt`, `session/new`, `load` and
  `resume` carry `systemPrompt: { mode: "append", content: [{ type: "text", text }] }`;
  otherwise a vendor layer may carry it (Antigravity). If the request fails with −32602,
  it is sent once more without the system prompt (standard or vendor).
- `mcpServers` is `workbench.tools.mcpServers()` unless a layer leaves them out (Deft).

### 7.4 Sign-in

When a request in 7.2 or `session/prompt` fails with −32000:

1. Offer the agent's `agent`, `terminal` and `env_var` methods: ask `sign_in` with the
   error's text as the message. With none to offer, the request's error stands.
2. Declined or cancelled: the error stands (for `session/prompt`: as an agent error, M46).
3. A `terminal` or `env_var` method: ask `sign_in_outside`. Cancelled → **signing in
   cancelled**: `start()` fails `not_signed_in`; `sendPrompt` resolves `"cancelled"`.
   `signedIn: true` → `start()` fails `restarting`; `sendPrompt` resolves `null`.
   `false` → back to 1, message "Signing in didn't finish.".
4. An `agent` method: a vendor layer may take it (6.3). Otherwise `authenticate`
   `{ methodId }`; an error → back to 1, message "Signing in failed: *detail*".
5. Signed in: send the original request again.

### 7.5 Prompts and cancelling

- `sendPrompt(blocks)`: `turnStarted(turnId)`, then `session/prompt`. Events of the turn
  are emitted as they arrive. On the answer: `prompt_usage` if it has `usage`,
  `prompt_suggestion` if its `_meta` says (M12), then `turnEnded(turnId, stopReason)` and
  resolve the stop reason. An agent error: `turn_failed` (reason per mapping §3.5), then
  `turnEnded(turnId, "error")`, resolve `null`.
- `cancel()`: settle every open ask `cancelled` (section 4.8), then send `session/cancel`
  for the main session. The result says whether the cancel was sent and accepted.
- An ask the agent opened during the turn and that is still open when the turn ends
  settles `cancelled` (W3).

### 7.6 The other methods

- `setMode(id)`: `session/set_mode`. If the agent answers with an error, a message for the
  user, using what the error says where it says something (the transcripts pin the text);
  otherwise `null`.
- `setConfigOption(id, value)`: `session/set_config_option` with `configId` and `value`,
  plus `type: "boolean"` when the value is a boolean. An error → its message, or "The
  agent refused the change". A result with `configOptions` → `config_options`. `null`.
- `listSessions(cwd)`: `null` unless `list` is supported. `session/list` `{ cwd }`, then
  `{ cwd, cursor }` while there is a `nextCursor`, at most 200 pages, each within 30
  seconds. Timeout → the list so far with error "The agent didn't answer"; an error → the
  list so far with its message, or "The agent couldn't list its sessions"; more than 200
  pages → `truncated`. Entries without a `sessionId` are left out.
- `deleteSession(id)`: unless `delete` is supported, the "can't" result. With the
  standard capability: `session/delete` within 30 seconds; −32002 counts as deleted;
  timeout → "The agent didn't answer"; another error → its message or "The agent refused".
  Otherwise a vendor layer (6.2). When deleted: `sessions.deleted({ sessionId })`, `null`.
- `logout()`: unless the agent offers `auth.logout`, the "can't" result. Else `logout`;
  an error → its message; `null`.
- `setSessionTitle(title, byUser)`: `sessions.titled({ sessionId, title, byUser })`
  when there is a session. Nothing on the wire.
- `cancelSubagent(id)`: a vendor layer may take it (6.2); else `session/cancel` for that
  session: an error → `false`, else `true`.
- `stopTerminal(toolCallId)`: Deft (6.1); else the "can't" result.

### 7.7 Stop, and the connection closing

- `stop()`: settle every open ask `cancelled`; if a reopenable session was opened,
  `sessions.used`; if the agent offers `close`, `session/close` for the main session
  within one second (−32002 counts as closed; any failure is ignored); close the
  connection. The driver MUST NOT signal or kill a process. No event is emitted.
- The connection closing while not stopping: settle every open ask, settle pending calls
  with their "not done" values, emit `connection_closed` with "Agent connection closed".

### 7.8 Requests the agent withdraws

When the agent sends `$/cancel_request` for a request it made that is still being
answered, the ask (or tool call) answering it is aborted, and the request is answered with
error −32800 "Request cancelled" (what Subspace's kernel already sends).

## 8. The workbench

```ts
export interface AgentWorkbench {
  emit(event: AgentEvent): void;
  /** `detached` (added): the ask belongs to no turn even while one is open (section 4.8). */
  ask<Request, Answer>(ask: Ask<Request, Answer>, options?: { signal?: AbortSignal; detached?: boolean }): Promise<Answer | Cancelled>;
  turnStarted(turnId: string): void;
  turnEnded(turnId: string, stopReason: string): void;
  readonly files: WorkbenchFiles;
  readonly terminals: WorkbenchTerminals;
  readonly tools: WorkbenchTools;
  readonly sessions: WorkbenchSessions;
  readonly project: WorkbenchProject;
  /** (added) What the application can show, and what it asks the agent to keep in mind. */
  readonly presentation: WorkbenchPresentation;
  /** (added) The application's record of which agent this is. */
  readonly agent: { readonly name: string; readonly identity: string | null };
  child(childSessionId: string): AgentWorkbench;
}
```

Every service call takes plain data and resolves plain data. A service MAY reject; the
driver turns a rejection into an error reply (or the method's "can't" result) and MUST NOT
let it escape. `emit` MUST NOT throw.

### 8.1 Services

```ts
export interface WorkbenchFiles {
  /** `line` is 1-based; `limit` is a number of lines. */
  readText(request: { sessionId: string; path: string; line?: number | null; limit?: number | null }): Promise<string>;
  writeText(request: { sessionId: string; path: string; content: string }): Promise<void>;
}

export interface WorkbenchTerminals {
  create(request: {
    sessionId: string; command: string; args?: string[]; cwd?: string | null;
    env?: Readonly<Record<string, string>>; outputByteLimit?: number | null;
  }): Promise<{ terminalId: string }>;
  output(request: { sessionId: string; terminalId: string }): Promise<{
    output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null };
  }>;
  waitForExit(request: { sessionId: string; terminalId: string }): Promise<{ exitCode: number | null; signal: string | null }>;
  kill(request: { sessionId: string; terminalId: string }): Promise<void>;
  release(request: { sessionId: string; terminalId: string }): Promise<void>;
}

export interface WorkbenchTools {
  /** The application's tools (MCP's tool shape: name, description, inputSchema, annotations), or null when turned off. */
  list(): Promise<ToolDescriptor[] | null>;
  /** Run one. Never rejects for a tool's own failure: `ok: false` and what to tell the model. */
  call(name: string, args: Readonly<Record<string, unknown>>, options?: { signal?: AbortSignal }): Promise<{ ok: boolean; message: string }>;
  /** (added) MCP servers that offer the same tools, to attach to sessions; [] when none. */
  mcpServers(): Promise<McpServerDeclaration[]>;
}
export interface ToolDescriptor { name: string; description: string; inputSchema: object; annotations?: object }
/** An ACP `McpServer` (stdio, http or sse), as plain data. */
export type McpServerDeclaration = Readonly<Record<string, unknown>> & { name: string };

export interface WorkbenchSessions {
  opened(record: { sessionId: string; cwd: string; how: 'new' | 'load' | 'resume'; reopenable: boolean }): Promise<void>;
  titled(record: { sessionId: string; title: string; byUser: boolean }): Promise<void>;
  used(record: { sessionId: string }): Promise<void>;
  /** (added) The agent deleted it; the application forgets it too. */
  deleted(record: { sessionId: string }): Promise<void>;
}

export interface WorkbenchProject {
  readonly path: string;
  /** The environment the agent runs with (the application's and the agent's own variables). */
  readonly env: Readonly<Record<string, string>>;
  setting(key: string): unknown;
  /** (added) Keep a variable for this agent's later starts (a key the user gave to sign in). */
  rememberEnv(name: string, value: string): Promise<void>;
}

export interface WorkbenchPresentation {
  /** What the application can show (diagrams, images, a browser view, its theme), as plain data. */
  capabilities(): Promise<Readonly<Record<string, unknown>>>;
  /** Text to append to the agent's system prompt for each session, or null. */
  systemPrompt(): Promise<string | null>;
}
```

No driver behaviour in this document depends on a `setting` key; settings that change
what is offered (tools on or off, the system prompt on or off) are applied by the
application inside `tools` and `presentation`. W4: no service, event or ask names a
protocol method.

### 8.2 Child workbenches (D5)

`child(id)` returns the workbench for that child session; the same object for the same
id. Its events and asks are scoped to the child (the application shows them in the
sub-agent's conversation). It shares its parent's ask registry (4.8), services and
project; its service calls carry the child's `sessionId`. `turnStarted` and `turnEnded`
on a child are not called by an ACP driver (the agent runs a sub-agent's turns itself).

### 8.3 The fake workbench (W5)

The fake records, in one ordered list, every `emit`, every `ask` (with how it settled),
every service call (with its arguments and result) and every turn boundary, on itself
and on its children, each entry saying which workbench it was. A test scripts the answer
to each ask (by kind and order, or with a function) and the result of each service call;
an ask with no scripted answer settles `cancelled`.

## 9. Handlers and wires

`AgentHandler<Wire>` is one unit of protocol knowledge: `attach(workbench, wire)` sets it
up for one connection and may return a function that detaches it. For ACP, a handler
**is** a `ClientLayer` and the wire **is** the `ClientLayer` context (brief §4); the
vendor layers are such handlers. A handler MUST act only through the workbench and its
wire.

## 10. The in-process test (V6)

A sketch of a driver that embeds an agent SDK in the application's process: no channel,
no child process, no JSON-RPC. It exists to check that every member of `AgentDriver` and
`AgentWorkbench` can be implemented honestly by such a driver. It is not to be built.

The SDK it assumes, in the abstract:

```ts
interface EmbeddedSdk {
  open(options: {
    cwd: string;
    resume?: string;
    appendSystemPrompt?: string;
    tools: Array<{ name: string; description: string; inputSchema: object; run(args: object, signal: AbortSignal): Promise<{ ok: boolean; message: string }> }>;
    /** Asked before each tool the SDK runs; must resolve. */
    canUseTool(tool: { id: string; name: string; input: unknown }, signal: AbortSignal): Promise<'allow' | 'allow_always' | 'deny'>;
  }): Promise<SdkSession>;
}
interface SdkSession {
  readonly id: string;
  send(content: ContentBlock[], signal: AbortSignal): AsyncIterable<SdkMessage>; // text, thinking, tool use, tool result, usage, result, sub-agent messages
  setPermissionMode(mode: string): Promise<void>;
  setModel(model: string): Promise<void>;
  close(): Promise<void>;
}
```

Member by member:

| Member | How the in-process driver does it |
|---|---|
| `start()` | `sdk.open(...)` with `cwd` = `project.path`, `resume` from `options.session`, `appendSystemPrompt` from `presentation.systemPrompt()`, `tools` wrapping `tools.list()` / `tools.call()`. Resolves when open; a sign-in failure rejects `not_signed_in`. |
| `stop()` | Aborts the running turn's signal and the asks' signals, `session.close()`. |
| `info` | `{ name, driver: "in-process", version }`; no `protocol`. |
| `capabilities` | From what the SDK offers; `promptContent` from the SDK's input types. |
| `sessionId` | `session.id` once open. An SDK that names its session only after the first message leaves it `null` until then and calls `sessions.opened` when it learns it. |
| `pid` | `null`. |
| `sendPrompt` | `turnStarted`, iterate `send()`: text → `message`, thinking → `thought`, tool use → `tool_call` (created), tool result → `tool_call` (updated), usage → `usage` / `prompt_usage`, sub-agent messages → the child workbench; `turnEnded`; the SDK's result mapped to a `StopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`). An SDK error → `turn_failed`, `null`. |
| `cancel()` | Aborts the turn's signal (which settles its asks), resolves `true`. |
| `setMode`, `setConfigOption` | `setPermissionMode`, `setModel`; or the "can't" results. |
| `listSessions`, `deleteSession` | From the SDK's saved sessions if it has them; else `null` / "can't". |
| `setSessionTitle` | `sessions.titled`. |
| `logout` | The "can't" result, or the SDK's own sign-out. |
| `stopTerminal`, `cancelSubagent` | The SDK's own stop, if it has one; else the "can't" results. |
| `ask` (from `canUseTool`) | Ask `permission` with a `PermissionAskRequest` built from the tool use: `title`, `toolCall`, options allow once / allow always / reject (`raw` left out). Then emits `permission`. |
| `files`, `terminals` | Not used: the SDK reads files and runs commands itself. A driver need not call every service. |
| `tools` | Offered to the SDK as in-process tools. |
| `presentation` | As above. |
| `child()` | For the SDK's sub-agent messages. |
| `AgentHandler<Wire>` | The wire is the SDK session and its message stream. |

Result: every member can be implemented. Two points needed a change, and both are made
above:

1. `TurnEvent` `permission` required a protocol version and the raw request. The
   vocabulary's `permission` event carries a `PermissionAskRequest` without them (3.1).
2. A session id may not be known when `start()` resolves. `sessionId` is `null` until
   known (section 5).

## 11. Decisions (Viz, 2026-11-18)

1. **Protocol version.** The driver passes `AcpClient`'s `protocol` option through
   (`AcpDriverOptions.protocol`). Console registers it with protocol 1, which is what its
   current client asks for, so Phase 5 compares like with like. Agents move to protocol 2
   one at a time, with a per-agent setting; each difference that shows is listed for Viz.
2. **The `permission` event** differs from `TurnEvent`'s as section 3.1 says. Accepted;
   `TurnEvent` does not change.
3. **Vendor detection (X4).** A vendor's inbound methods are answered whenever they
   arrive. Detection governs what a layer advertises and starts. Deft's capabilities are
   advertised to every agent. The brief's X4 says so.
4. **Asks at turn end (W3).** The stricter rule holds: a turn's open asks settle when it
   ends. Exception: asks opened `detached` (permission questions about background work)
   belong to no turn (section 4.8).
5. **Start-up.** Starting the agent's program, and anything before it (such as offering to
   download a runtime), is the application's. A driver receives a channel.
6. **Names.** Names are those of the ACP specification where it has one:
   `setSessionTitle` (ACP's `title`), capabilities `loadSession` and `resumeSession`, and
   `AgentSessionList`.
7. **Strings.** Messages a user of the application can see may be specified word for
   word, because the new driver must show the same; the transcripts carry them. Messages
   only an agent receives (error replies) are not; the Implementer words them.
8. **Vendor source does not cross.** The vendor extensions' source is not given to the
   Implementer and is not in this repository. `docs/agent-vendor-protocols.md` describes
   the vendors' messages instead.
9. **Outcomes, not handling.** Where a detail's only source is an existing client's code,
   the documents state the observable outcome and the transcripts pin it (section 1).
