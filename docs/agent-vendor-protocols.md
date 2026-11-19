# Vendor additions to ACP: what is on the wire

Version 1, 2026-11-18. Phase 0 deliverable. Written by the Specifier; crosses the
clean-room wall (see `docs/clean-room-log.md`). It describes three vendors' messages as
they appear between a client and an agent, and how a client must answer them. It contains
no client code. What the user sees, and which events and asks each message becomes, is in
`docs/agent-events-mapping.md`; what each vendor layer does is in
`docs/agent-driver-design.md` §6. The vendor transcripts, when they exist, are the final
word on exact shapes.

## 1. Conventions

- **Two spellings.** Some agents send a vendor method with a leading underscore and some
  without (Grok Build's Rust SDK adds the underscore). A client answers both spellings the
  same way. When a client calls a vendor method, it tries the underscore spelling first
  and, on "method not found" (−32601), the other.
- **`_meta`.** Every request below may carry a `_meta` object; a client ignores what it
  does not know.
- **Sessions.** `sessionId` names the session a message is about: the main session or a
  sub-agent's child session on the same connection.

## 2. Deft (`deft.co`)

### 2.1 Capabilities

| Where | Key | Meaning |
|---|---|---|
| Client → agent, `initialize` `clientCapabilities._meta["deft.co"]` | `waitForKey: {}` | The client answers `deft.co/wait_for_key`. |
| | `display: { … }` | What the client can show (diagrams, images, a browser view, its theme). Free-form; the application supplies it. |
| | `tools: [ … ]` | The client's tools, each in MCP's tool shape (`name`, `description`, `inputSchema`, `annotations`), callable with `deft.co/call_tool`. Absent when the client offers none. |
| Agent → client, `initialize` result `agentCapabilities._meta["deft.co"]` | `emptyPrompt: {}` | An empty prompt means something to the agent (for example "continue"); the client may send one. |
| | `stopTerminal: {}` | The agent stops a tool call's command when the client calls `_deft.co/stop_terminal`. |
| | `tools: {}` | The agent calls the client's tools with `deft.co/call_tool`, so the client need not also offer them to it as an MCP server. |

### 2.2 `deft.co/wait_for_key` (agent → client, request)

The agent waits for the user to press one of a few keys (for example between the steps of
a guided tour).

- Params: `sessionId`; `keys`: a list of `{ key, label }`, where `key` is meant to be a
  single printable character; `message` (optional): text shown above the keys.
- Result: `{ outcome: "pressed", key }`, or `{ outcome: "cancelled" }` when the question
  was cancelled (the turn was cancelled, or the agent withdrew the request).
- A request with no usable key is answered with an error.

### 2.3 `deft.co/call_tool` (agent → client, request)

The agent runs one of the client's tools.

- Params: `sessionId`, `name`, `arguments` (an object, or absent).
- Result: `{ ok, message }`. `message` is what to tell the model, whether or not the tool
  worked. A tool that needs the user waits for them; if the turn is cancelled first, `ok`
  is false.
- Errors: the tools are turned off; `sessionId` is not the main session (sub-agents may not
  call them); the tool is unknown; `arguments` is not an object.

### 2.4 `_deft.co/stop_terminal` (client → agent, request)

The client asks the agent to stop the command a tool call is running (one the agent runs
itself and shows as a terminal).

- Params: `sessionId`, `toolCallId`.
- Result: `{}` once the agent has asked for the stop. The terminal ends when the agent
  reports the command's exit. An error when that tool call has no running command.

## 3. xAI: Grok Build (`x.ai`)

### 3.1 Recognising it

The agent's `initialize` result has, in `agentCapabilities._meta`, one or more keys that
start with `x.ai/` or `_x.ai/`.

### 3.2 `x.ai/ask_user_question` (agent → client, request)

One or more multiple-choice questions.

- Params: `sessionId`; `questions`: a list of `{ question, options?, multiSelect?,
  multi_select?, id?, header? }`, each option `{ label, description?, preview?, id? }`
  (either multi-select spelling may be used); `toolCallId` (optional); `mode`: `"default"`
  or `"plan"` (optional, default `"default"`).
- Result, one of:
  - `{ outcome: "accepted", answers, annotations? }`: `answers` maps each question's text to
    the list of labels chosen; `annotations` maps a question's text to
    `{ preview?, notes? }`;
  - `{ outcome: "chat_about_this", partial_answers }` or
    `{ outcome: "skip_interview", partial_answers }` (plan mode only):
    `partial_answers` maps question text to the one label chosen so far;
  - `{ outcome: "cancelled" }`.
- An empty `questions` list is answered `{ outcome: "cancelled" }`.

### 3.3 `x.ai/exit_plan_mode` (agent → client, request)

The agent asks to leave plan mode and carry out its plan.

- Params: `sessionId`, `toolCallId` (optional), `planContent` (optional, Markdown).
- Result: `{ outcome, feedback? }`, `outcome` being `"approved"` (start), `"cancelled"`
  (keep planning) or `"abandoned"` (drop the plan).

### 3.4 `x.ai/mcp/elicit` (agent → client, request)

An MCP server's question to the user (MCP elicitation), forwarded by Grok.

- Params: `sessionId`, `message`, `mode` (`"form"` or `"url"`, default `"form"`),
  `toolCallId?`, `serverName?`, `requestedSchema?` (form), `url?` and `elicitationId?`
  (url).
- Result: `{ outcome: "accept", content }`, `{ outcome: "decline" }` or
  `{ outcome: "cancel" }`. (ACP's own `elicitation/create` uses the key `action` for the
  same values; Grok's uses `outcome`.) Another mode is declined.

### 3.5 `x.ai/mcp/elicit_complete` (agent → client, notification or request)

A link-mode question finished on the agent's side.

- Params: `sessionId`, `elicitationId`, `serverName?`. Answered with `null` when sent as a
  request.

### 3.6 `x.ai/models/update` (agent → client)

- Params: `availableModels`: a list of models, each of which may carry
  `_meta.totalContextTokens` (its context window). Answered with `null`.

### 3.7 `x.ai/session_notification` (agent → client, notification)

Grok's own session update stream.

- Params: `sessionId`, `update`: an object with a `sessionUpdate` tag. A client uses these
  tags and ignores the others:
  - `turn_completed`, with `usage` (which may include `costUsdTicks`: cost in units of
    10⁻¹⁰ US dollars);
  - `response_completed`, with `usage` carrying `input_tokens`, `cache_read_input_tokens`,
    `cache_creation_input_tokens` (one model call);
  - `subagent_spawned`, `subagent_progress`, `subagent_finished`;
  - `task_backgrounded`, `task_completed`.
- The fields of the sub-agent and task updates are listed in
  `docs/agent-events-mapping.md` §3.2 and §3.3.

### 3.8 `_x.ai/subagent/cancel` (client → agent, request)

- Params: `{ subagentId }`, a sub-agent's child session id from `subagent_spawned`.
- Result: `{ subagentId, cancelled, outcome? }`; `cancelled` may be `false`.

### 3.9 `_x.ai/session/delete` (client → agent, request)

- Params: `{ sessionId }`.
- Result: `{ success }`, and when not successful maybe `error` or `message`. Error −32002
  means the session is already gone.

## 4. Google Antigravity

### 4.1 Recognising it

The agent's `initialize` result has an object at `agentCapabilities._meta.antigravity`, or
the application's catalog names the agent `antigravity.google`.

### 4.2 System prompt

When `agentCapabilities._meta.antigravity.systemPrompt.append` is `true`, the agent
ignores ACP's standard `systemPrompt` on `session/new`, `session/load` and
`session/resume`. Text to append to its system prompt goes in those requests as
`_meta.antigravity.systemPrompt.append` (a string).

### 4.3 Signing in with an API key

The agent lists an auth method with id `gemini-api-key` (type `agent`). The client signs
in with it by sending `authenticate` with `{ methodId: "gemini-api-key", _meta: { apiKey }
}`, where `apiKey` is a Gemini Developer API key (from `GEMINI_API_KEY`, or typed by the
user). An error means the key was refused.
