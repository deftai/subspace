# Implementer brief: agent drivers in Subspace

Version 3, 2026-11-18 (after Viz's review and the legal review of Phase 0). **This is the document that crosses the clean-room wall.** It is the
whole of what an Implementer is given, together with the Phase 0 documents, the
transcripts, the vendor protocol description and written answers to its questions.

It describes behaviour and requirements only. It deliberately contains no description of
how Deft Console's existing agent client is written.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED,
MAY and OPTIONAL in this document are to be interpreted as described in RFC 2119 and
RFC 8174 when, and only when, they appear in capitals.

Where it says **STOP**, you MUST stop and report instead of improvising.

---

## 1. What you are building, and why

Deft Console is a terminal application in which a user talks to coding agents. Today it
reaches an agent in one way only. It is being changed so that its conversation depends on
one interface and one event vocabulary, with each way of reaching an agent as a module
behind them.

You build the parts that live in **Deft Subspace** (`deftai/subspace`, MIT):

1. `@deft-subspace/agent-driver`: protocol-neutral interfaces, event types, a fake
   workbench for tests, and a conformance runner.
2. `clientEndpoint` and `ClientLayer` in `@deft-subspace/acp`: the client-side mirror of
   the existing `agentEndpoint` and `AgentLayer`, with `AcpClient` rebuilt on them.
3. `@deft-subspace/acp-vendors`: three vendor layers (Deft, xAI, Antigravity).
4. A driver over `AcpClient` that implements the neutral interface.

Someone else (the Specifier) does everything inside Console. You never see Console.

## 2. You are working in a clean room

- CR-A. You MUST be a fresh context: a new session that has never read, been shown or been
  told the contents of Deft Console's source (TypeScript or Python) or of Toad, the
  program it descends from. If that is not true of you, **STOP** now and say so.
- CR-B. You MUST NOT share a context window with a Specifier. You MUST NOT load memory
  files, notes, summaries or handoff documents from other sessions. Your inputs are: this
  brief; `docs/agent-events-mapping.md` and `docs/agent-driver-design.md` in Subspace;
  the transcripts in `@deft-subspace/acp-testkit`; `docs/agent-vendor-protocols.md` in
  Subspace; the Subspace repository; the ACP specification; the official ACP SDK as a
  reference. Nothing else. You MUST NOT search the web for, or write from memory of, other
  ACP clients' code (Toad and Deft Console in particular); write from these inputs.
- CR-C. You MUST work in an environment set up for this work: a machine, user account
  or container that holds a fresh clone of Subspace and nothing from Deft Console, Python
  Console or Toad. You MUST work in a checkout that contains Subspace only. If you find Console's or
  Toad's source available to you, or are sent any of it, you MUST NOT read it: **STOP**
  and report.
- CR-D. Questions go to the Specifier in writing, by appending them to
  `docs/clean-room-log.md` in Subspace. Answers come back in writing, in behavioural terms.
  You MUST NOT accept code, pseudo-code, a patch or a "suggested implementation" as an
  answer; if you are sent one, do not use it, and record that in the log.
- CR-E. Before you start, and again when you finish, you MUST write in
  `docs/clean-room-log.md`: the date, which phases you are doing, and a statement that
  you had no access to restricted material. With each, record your session's identifier
  and an environment record: the machine's name, the user, the working directory, and a
  listing of the home directory and of the checkout's parent directory. Your session's
  full transcript is kept by Viz as evidence of what you saw; do nothing to shorten or
  edit it. If your context becomes tainted by mistake, **STOP**, and record the last commit
  made before it happened.
- CR-F. Everything you add MUST be MIT, MUST be your own work written from the inputs
  above, and MUST NOT add a runtime dependency without Viz's agreement.

## 3. The repository

- `git fetch origin && git checkout -B <work-branch> origin/main` before reading anything.
- Read `README.md`, `docs/GUIDE.md`, `docs/AGENT-LAYERS.md` (the contract in it is
  binding on you), `docs/PORTING-LESSONS.md`, `EXPERIMENT.md`.
- Sources run directly (`node --conditions=subspace-source`, Node 22.19 or later).
  `pnpm run typecheck`, `pnpm test` and `pnpm run build` cover every package.
- Facts you can verify in the repository: `AcpClient.connect(channel, options)` takes a
  `Channel` (a pair of Web Streams) and `ndjson()` frames a byte channel; `TurnEvent` is in
  `packages/acp/src/model.ts`; `agentEndpoint` and `AgentLayer` are in
  `packages/acp/src/endpoint.ts`; extension helpers refuse method names that do not start
  with `_`; there is no way today to add `_meta` to `initialize`, `session/new` or a prompt.

### 3.1 Working rules

- R1. Work on a new branch per phase (`feat/agent-drivers-phase-N`). Commit after each
  unit that leaves typecheck and tests clean.
- R2. Commit as `git -c user.email=52174+visionik@users.noreply.github.com commit`, in the
  repository's style (`area: what changed`, for example `acp: …`). Commit messages MUST
  NOT contain AI attribution lines.
- R3. You MUST NOT run `git add -A`, bare `git stash`, or a force-push.
- R4. You MUST NOT push and MUST NOT open a pull request: the repository is public, and
  publishing is Viz's decision.
- R5. Nothing MUST be published to npm.
- R6. A test MUST NOT depend on wall-clock time, the checkout path or the machine.
- R7. You MUST NOT edit `python/` (Subspace's Python port). List in your report what it
  would need to follow.
- R8. After each phase, append a short report to `docs/agent-drivers-status.md` in
  Subspace: what was done, test totals, what was not done, decisions needed.

## 4. Terms

| Term | Meaning |
|---|---|
| **Workbench** (`AgentWorkbench`) | The user's side of one agent session. The application implements it. |
| **Driver** (`AgentDriver`) | One way of reaching an agent. |
| **Handler** (`AgentHandler<Wire>`) | One unit of protocol knowledge: reads a wire, acts on a workbench. For ACP a handler **is** a `ClientLayer`. |
| **Wire** (`AcpWire`) | The raw ACP connection as a handler sees it. For ACP it **is** the `ClientLayer` context. |
| **Client layer** (`ClientLayer`) | The client-side mirror of `AgentLayer`. |
| **Event** (`AgentEvent`) | A plain-data record of something the agent did, sent to the workbench. |
| **Ask** | A question to the user (permission, choice, form, key press, sign-in) that has an answer and is cancelled with its turn. |
| **Vendor layer** | A `ClientLayer` for one vendor's additions to ACP. |
| **Transcript** | A recorded exchange: what the agent sends, what the client MUST answer, and which events, asks and service calls the workbench MUST see. |

## 5. Decisions already made

| # | Decision |
|---|---|
| D1 | Drivers and handlers MUST emit plain data. They MUST NOT import a UI library. |
| D2 | The event vocabulary MUST live in Subspace and MUST start from `TurnEvent`. |
| D3 | The driver over `AcpClient` MUST use Subspace's own session and turn model; it MUST NOT use Subspace only as a transport. |
| D5 | A sub-agent (child session) MUST get a child workbench created from its parent's. |
| D6 | Starting the agent's program is the application's business. A driver receives a `Channel`; it MUST NOT start a program itself unless given a helper to do so. |
| D9 | The client side MUST be built as `clientEndpoint` and `ClientLayer`, with the same contract as `agentEndpoint` and `AgentLayer`, and `AcpClient` MUST be rebuilt as a preset stack on them. |
| D10 | Package names MUST be `@deft-subspace/agent-driver` and `@deft-subspace/acp-vendors`. |

## 6. The interfaces

The names below are fixed. The types marked `…`, and any additions, are given in
`docs/agent-driver-design.md`, which takes precedence over this sketch where they differ.

```ts
// @deft-subspace/agent-driver

/** Plain data. MUST be structured-cloneable (no functions, no class instances). */
export type AgentEvent = TurnEvent | /* additions listed in agent-events-mapping.md */ …;

/** A question to the user. */
export interface Ask<Request, Answer> { readonly kind: string; readonly request: Request; }

export interface AgentWorkbench {
  /** The only way anything reaches the conversation. MUST NOT throw. */
  emit(event: AgentEvent): void;
  /** Resolves with the answer, or `{ outcome: 'cancelled' }`. MUST never stay pending. */
  ask<Request, Answer>(ask: Ask<Request, Answer>, options?: { signal?: AbortSignal }): Promise<Answer | { outcome: 'cancelled' }>;
  turnStarted(turnId: string): void;
  turnEnded(turnId: string, stopReason: string): void;
  readonly files: { readText(…): Promise<string>; writeText(…): Promise<void> };
  readonly terminals: { create(…); output(…); waitForExit(…); kill(…); release(…) };
  readonly tools: { list(): …; call(name: string, args: unknown): Promise<…> };
  readonly sessions: { opened(…): Promise<void>; titled(…): Promise<void>; used(…): Promise<void> };
  readonly project: { readonly path: string; readonly env: Readonly<Record<string, string>>; setting(key: string): unknown };
  /** A workbench for a sub-agent. Its events and asks are scoped to that child. */
  child(childSessionId: string): AgentWorkbench;
}

export interface AgentDriverCapabilities {
  logout: boolean; stopTerminals: boolean; emptyPrompts: boolean; loadSession: boolean; resumeSession: boolean;
  listSessions: boolean; deleteSessions: boolean; modes: boolean; configOptions: boolean;
  sessionCapabilities: readonly string[];
}

export interface AgentDriver {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly info: AgentInfo;
  readonly capabilities: AgentDriverCapabilities;
  readonly sessionId: string | null;
  readonly pid: number | null;
  sendPrompt(prompt: PromptInput): Promise<StopReason | null>;
  cancel(): Promise<boolean>;
  setMode(modeId: string): Promise<string | null>;
  setConfigOption(id: string, value: string | boolean): Promise<string | null>;
  listSessions(cwd: string): Promise<AgentSessionList | null>;
  deleteSession(sessionId: string): Promise<string | null>;
  setSessionTitle(title: string, byUser?: boolean): Promise<void>;
  logout(): Promise<string | null>;
  stopTerminal(toolCallId: string): Promise<string | null>;
  cancelSubagent(childSessionId: string): Promise<boolean>;
}

export type AgentDriverFactory = (workbench: AgentWorkbench, options: AgentDriverOptions) => AgentDriver;
export interface AgentHandler<Wire> { readonly name: string; attach(workbench: AgentWorkbench, wire: Wire): void | (() => void); }
```

### 6.1 Requirements on a workbench (and on your fake one)

- W1. `emit` MUST be the only path from a driver or handler to the conversation.
- W2. There MUST be exactly one registry of open asks per workbench.
- W3. Every open ask MUST be settled as cancelled when its turn is cancelled or ends, when
  the driver stops, and when the workbench closes. An ask MUST NOT be left pending. An ask
  that belongs to no turn (for example a permission question about background work,
  `docs/agent-driver-design.md` §4.8) is settled by cancel, stop and close only.
- W4. A workbench MUST NOT know any protocol method name.
- W5. The fake workbench MUST record every event, ask and service call, in order, and
  MUST let a test script the answers to asks and the results of service calls.

### 6.2 Requirements on a driver

- V1. A driver MUST NOT import from a UI library or from an application.
- V2. A driver MUST NOT assume it owns a process. `pid` MUST be `null` when it does not.
- V3. Every method MUST settle. After `stop()`, every pending call MUST reject or resolve
  with its "not done" value; none MAY hang.
- V4. A driver MUST report what it cannot do through `capabilities`, and its methods MUST
  return the documented "can't" result rather than throw.
- V5. Two drivers given the same transcript MUST produce the same events, asks and service
  calls, in the same order.
- V6. The interfaces MUST be implementable by a driver that embeds an SDK in-process, with
  no channel, no process and no JSON-RPC. `docs/agent-driver-design.md` contains that
  sketch; if you find a member that such a driver could not implement, **STOP** and report.

## 7. Client layers

- C1. `clientEndpoint(channel, options)` and `ClientLayer` MUST mirror `agentEndpoint` and
  `AgentLayer`: exclusive `requests` and `notifications` maps; `inbound` and `outbound`
  hooks that stack; state per endpoint (`create`); `provides` / `requires`; `closed`.
- C2. The contract in `docs/AGENT-LAYERS.md` ("The contract", items 1 to 4 and 6) MUST hold
  on the client side. Two layers answering the same method MUST be an error when the stack
  is built.
- C3. "A vendor layer answers before the base" MUST be a hook wrapping the base layer's
  handler, or a service the base layer consults. It MUST NOT be a second handler for the
  same method.
- C4. `AcpClient` MUST be rebuilt as a preset stack of client layers. Its public API,
  options, protocol results and close behaviour MUST NOT change. Every existing Subspace
  test MUST pass without being edited. New tests MUST pin close order and cancellation.
- C5. A client layer MUST be able to add `_meta` to `initialize` (client capabilities),
  `session/new`, `session/load`, `session/resume` and `session/prompt` through `outbound`.
- C6. There MUST be a supported, documented way to register a handler for an extension
  method whose name does not start with `_` (some agents send, for example, `x.ai/…`). A
  layer MUST be able to declare a bare name once and have both spellings (`name` and
  `_name`) registered.
- C7. The agent's capabilities and info, `_meta` included, MUST be readable by a layer
  after `initialize`.
- C8. `docs/AGENT-LAYERS.md` MUST be updated: its status line, and a section for the
  client side as built.

## 8. Vendor layers

`docs/agent-vendor-protocols.md` describes what each vendor sends on the wire and how it
must be answered. With `docs/agent-driver-design.md` §6, the vendor transcripts and the
Specifier's written answers, it is the whole of what you know about the vendors. No
vendor source code is given to you.

- X1. Deft, xAI and Antigravity MUST each be one `ClientLayer` in `@deft-subspace/acp-vendors`.
- X2. A vendor layer MUST act only through the workbench (`emit`, `ask`, services) and the
  layer context.
- X3. Everything specific to a vendor MUST be in that vendor's layer and nowhere else:
  the metadata it advertises to the agent, the metadata it reads from the agent, the
  methods it answers, and the methods it calls. For Deft this is: advertising, under
  `_meta["deft.co"]` in the client capabilities, that the client can wait for a key, what
  it can display, and which tools it offers; reading from the agent's `_meta["deft.co"]` whether it accepts
  empty prompts and whether it can stop a tool call's command; answering
  `deft.co/call_tool` and `deft.co/wait_for_key`; and calling `_deft.co/stop_terminal`.
- X4. Each vendor layer MUST decide from the agent's info and capabilities whether it
  applies, and when it does not, MUST NOT advertise, call, or report anything for that
  vendor beyond what it must advertise before the agent is known. Detection governs what
  a layer advertises and starts. A vendor's inbound methods MUST be answered whenever they
  arrive: an agent that sends one speaks that vendor's protocol. Deft's client
  capabilities are advertised to every agent, because `initialize` is sent before the
  agent is known.
- X5. Each vendor layer MUST pass every one of its transcripts.

## 9. Your phases

Your work starts only after the Specifier's Phase 0 documents exist in Subspace's `docs/`
and Viz has approved them. If they are not there, **STOP**.

### Phase 1: `@deft-subspace/agent-driver`

Deliverables: the package, with the interfaces and types of §6 as settled in
`docs/agent-driver-design.md`; the fake workbench (W5); a transcript format; and a
conformance runner `checkDriver(factory, transcript)` that drives a driver from a
transcript and compares the workbench's record with what the transcript requires.
No protocol code. No dependency on `@deft-subspace/acp` except types.

Acceptance: `pnpm run typecheck` and `pnpm test` pass for every package; the runner is
tested with a scripted in-memory driver, including a transcript that the driver fails;
the package uses no Node API outside a `./node` entry.

### Phase 2: `clientEndpoint` and `ClientLayer`

Deliverables: everything in §7.

Acceptance: C1 to C8 each have a test that fails if the requirement is broken; all
existing Subspace tests pass unedited; a proxy test forwards an unknown request and an
unknown notification through a client endpoint.

### Phase 4, step 2: the vendor layers

Starts when the vendor transcripts are in `@deft-subspace/acp-testkit` (the Specifier adds
them). Deliverables: everything in §8.

Acceptance: every vendor transcript passes on a client endpoint with the layer in its
stack; an agent without the vendor's capability, that sends none of its methods, sees no vendor
behaviour beyond what X4 says is advertised to every agent.

### Phase 5, step 1: the driver over `AcpClient`

Deliverables: an `AgentDriver` (V1 to V6) built on `AcpClient` (D3) with the vendor layers
in its stack, taking the agent's connection as a `Channel`.

Acceptance: `checkDriver` passes for it on every transcript.

## 10. Stop conditions

You MUST stop and report, without working around it, when:
- a clean-room rule in §2 would have to be bent, or restricted material is in front of you;
- an input this brief names is missing;
- a requirement here contradicts `docs/AGENT-LAYERS.md`'s contract, or an existing
  Subspace test that cannot pass unedited;
- a transcript cannot be satisfied and you believe the transcript is wrong (ask in the
  log; do not change the transcript);
- you need to know how the application behaves and the inputs do not say (ask in the log).

## 11. Final report

Under 300 words, appended to `docs/agent-drivers-status.md`: per phase, done / partly /
not started; branch and last commit; test totals; open questions; what the Python port
would need; your clean-room statement (CR-E).
