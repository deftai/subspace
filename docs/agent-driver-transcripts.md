# Agent driver transcripts: format and runners

A **transcript** is a pure-JSON recording of one exchange between an application (workbench
and driver or client layer) and an agent:

- what the agent sends on the wire and what the client MUST send or answer, placed relative
  to the driver steps that cause them;
- how the fake workbench answers asks and service calls, as data;
- which events, asks, service calls and turn boundaries the workbench MUST record, in order.

The protocol-neutral schema (`RecordedDriverTranscript`, `FakeWorkbenchData`,
`ExpectedRecord`) lives in `@deft-subspace/agent-driver`, which contains no protocol code.
The ACP wire representation (`AcpWireMessage`) and replay runners (`checkAcpDriver`,
`checkClientLayer`) live in `@deft-subspace/acp-testkit`.

A complete, tested example is in
`packages/acp-testkit/transcripts/example-vendor-key.transcript.json`.

---

## 1. File shape

A transcript file (`*.transcript.json`) is a single JSON object (`RecordedDriverTranscript`)
with no functions:

```json
{
  "version": 1,
  "name": "human-readable transcript name",
  "options": {
    "agent": { "name": "grok", "identity": "x.ai" },
    "client": { "name": "deft-console", "version": "1.0.0" },
    "session": { "sessionId": "s1", "cwd": "/repo", "reconnect": false },
    "pid": null
  },
  "workbench": {
    "project": { "path": "/repo", "env": {}, "settings": {} },
    "asks": { "permission": [{ "optionId": "allow" }] },
    "services": {
      "files": { "readText": [{ "ok": "file contents" }, { "error": "ENOENT" }] },
      "presentation": { "capabilities": [{ "ok": {} }], "systemPrompt": [{ "ok": null }] },
      "tools": { "list": [{ "ok": [] }], "call": [{ "ok": { "ok": true, "message": "done" } }], "mcpServers": [{ "ok": [] }] }
    }
  },
  "steps": [ ... ],
  "expected": [ ... ],
  "expectInfo": { "name": "grok" },
  "expectCapabilities": { "deleteSessions": true },
  "expectSessionId": "s1"
}
```

### Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `version` | optional (`1`) | Format version. |
| `name` | yes | Human-readable name reported in failures. |
| `options` | yes | `AgentDriverOptions` passed to the driver factory or layer harness (`agent`, `client`, optional `session`, optional `pid`). |
| `workbench` | optional | `FakeWorkbenchData`: project config, per-kind ask answer queues, and per-service-method reply queues. |
| `steps` | yes | Ordered list of `RecordedTranscriptStep` actions. Each step may carry a `wire` array of messages exchanged during that step. |
| `wire` | optional | Top-level wire messages when not placed per step. Concatenated before step `wire` arrays. |
| `expected` | yes | Ordered list of `ExpectedRecord` entries the workbench MUST record. |
| `expectInfo`, `expectCapabilities`, `expectSessionId` | optional | Subset assertions checked on `driver` right after `start()` succeeds. |

---

## 2. Scripting the fake workbench as data (`workbench`)

`FakeWorkbench` is constructed directly from `transcript.workbench` with no code:

- **`project`**: `{ path?, env?, settings? }`. Defaults to `{ path: "/workspace", env: {}, settings: {} }`.
- **`asks`**: map from ask kind (`permission`, `question`, `choices`, `plan_approval`,
  `key`, `sign_in`, `sign_in_outside`) to an array of answers consumed in FIFO order. When
  a queue is empty or absent, the ask settles `{ "outcome": "cancelled" }`.
- **`services`**: map from service name (`files`, `terminals`, `tools`, `sessions`,
  `project`, `presentation`) to method name to an array of `ServiceReply` objects consumed
  in FIFO order:
  - `{ "ok": <value> }` resolves the service call with `<value>`;
  - `{ "error": "<message>" }` rejects the service call with `new Error("<message>")`.
  - When a queue is exhausted or omitted, `FakeWorkbench` uses its default (`[]` for
    `tools.list` / `tools.mcpServers`, `{}` for `presentation.capabilities`, `null` for
    `presentation.systemPrompt`, `undefined` for `sessions.*` / `project.rememberEnv` /
    `files.writeText` / `terminals.kill` / `terminals.release`).

---

## 3. Driver steps (`steps`)

Each step in `steps` is a plain JSON object with an `action` and an optional `wire` array:

| `action` | Additional fields |
|---|---|
| `start` | `expectFailure?: Partial<StartFailure>` |
| `sendPrompt` | `prompt: PromptInput`, `expectResult?: StopReason \| null` |
| `cancel` | `expectResult?: boolean` |
| `setMode` | `modeId: string`, `expectResult?: string \| null` |
| `setConfigOption` | `id: string`, `value: string \| boolean`, `expectResult?: string \| null` |
| `listSessions` | `cwd: string`, `expectResult?: AgentSessionList \| null` |
| `deleteSession` | `sessionId: string`, `expectResult?: string \| null` |
| `setSessionTitle` | `title: string`, `byUser?: boolean` |
| `logout` | `expectResult?: string \| null` |
| `stopTerminal` | `toolCallId: string`, `expectResult?: string \| null` |
| `cancelSubagent` | `childSessionId: string`, `expectResult?: boolean` |
| `stop` | — |
| `closeWorkbench` | — |
| `exchange` | `label?: string` — waits for the step's `wire` messages (for example, an unsolicited agent notification or vendor request between turns) without invoking a driver method. |

---

## 4. ACP wire messages (`wire`)

For ACP transcripts, each element of `wire` (on a step or at the top level) is an
`AcpWireMessage`:

```json
{
  "dir": "client",
  "msg": { "id": 0, "method": "initialize", "params": { "protocolVersion": 1 } },
  "match": {
    "params": {
      "clientCapabilities": { "_meta": { "deft.co": { "waitForKey": {} } } }
    }
  },
  "t": 0
}
```

- **`dir`**: `"client"` (expected from the client under test) or `"agent"` (sent by the
  replaying agent).
- **`msg`**: JSON-RPC 2.0 message body (`id`, `method`/`params` or `result`/`error`;
  `"jsonrpc": "2.0"` is optional and added automatically when sent). JSON-RPC ids are
  remapped both ways by `replayAgent`: client request ids and agent request ids (including
  `$/cancel_request`) do not need to match the recorded numeric ids literally.
- **`match`** *(optional, for `dir: "client"`)*: subset of fields in the live client
  message that MUST match (checked recursively with `matchSubset`).
- **Default response checking**: for any `dir: "client"` response (a message with `id` and
  `result` or `error`, and no `method`), if `match` is omitted, the runner automatically
  checks that `got.result` subset-matches `msg.result` (or that `got.error.code` equals
  `msg.error.code`). A client that sends a wrong answer fails with a `ReplayDivergence`.
- **`t`** *(optional)*: timestamp in milliseconds from start (preserved when converting
  from a `.trace.jsonl` recording via `wireFromTrace()`).

---

## 5. Expected workbench records (`expected`)

`expected` is an ordered array of `ExpectedRecord` objects, matched position-by-position
against `workbench.records` using recursive subset matching (objects match by subset,
arrays match by exact length and element-by-element subset, primitives match by `Object.is`):

- `{ "kind": "event", "workbench"?: "main" | "<childId>", "event": { ... } }`
- `{ "kind": "ask", "workbench"?: ..., "askKind": "...", "request"?: { ... }, "detached"?: boolean, "answer"?: ... }`
- `{ "kind": "service", "workbench"?: ..., "service": "...", "method": "...", "args"?: ..., "result"?: ..., "error"?: "..." }`
- `{ "kind": "turn_started", "workbench"?: ..., "turnId"?: "..." }`
- `{ "kind": "turn_ended", "workbench"?: ..., "turnId"?: "...", "stopReason"?: "..." }`

The runner also checks that every emitted event and ask request is structured-cloneable
and that `workbench.openAskCount === 0` at the end of the run.

---

## 6. Running transcripts

In `@deft-subspace/acp-testkit`:

- **Against any ACP `AgentDriver`:**
  `checkAcpDriver(factory, transcript, options?)` / `assertAcpDriverConforms(...)`
  Creates a `channelPair`, replays the agent side with `replayAgent`, runs `checkDriver`,
  and combines wire divergences with workbench record failures.
- **Against a `clientEndpoint` (or `AcpClient`) with a vendor `ClientLayer`:**
  `checkClientLayer(setup, transcript, options?)` / `assertClientLayerConforms(...)`
  Creates a `FakeWorkbench` from `transcript.workbench`, replays the agent side on a
  `channelPair`, runs the transcript's steps against the layer harness, and verifies both
  the wire exchange and `workbench.records`.
- **Parsing & converting:**
  `parseAcpTranscript(json)` parses a `.transcript.json` file; `wireFromTrace(trace)`
  converts an existing Subspace `.trace.jsonl` into `AcpWireMessage[]`.
