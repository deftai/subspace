# Clean-room log: agent drivers

This log records the clean-room work on agent drivers in Subspace: which session held
which role, every document that crossed from the Specifier to the Implementer (with its
commit and date), every question and answer, and each Implementer session's statement
that it had no access to restricted material. It is part of the deliverable.

Roles. The **Specifier** may read restricted material and writes the documents that cross
the wall. It does not write Subspace code. The **Implementer** has never seen restricted
material and writes all Subspace code from the documents that cross the wall. The two
never share a context window.

Entries are appended, newest last. Once this log has been published, nothing in it is
edited; corrections are new entries.

---

## 2026-11-18: Specifier session, Phase 0

**Role.** This session is the **Specifier**: pi session `01a1f1e9-d10b-722a-a78d-12e04b2ea2f7`.
It has read restricted material (Deft Console's TypeScript and Python agent client) and
MUST NOT act as Implementer, now or after any compaction, resumption or fork. Its full
transcript is kept by Viz, outside this repository.

**Phase.** Phase 0 only: the event vocabulary mapping, the interface design, the vendor
protocol description, and the copy of the implementer brief. It writes no Subspace code.

**Where.** Branch `feat/agent-drivers-phase-0`, started from `origin/main` at `d95783a`.
Not pushed.

### Documents crossing the wall

| Document | Version | Notes |
|---|---|---|
| `docs/agent-drivers-implementer-brief.md` | 3 | Identical to the copy in `deftai/console-ts` on branch `feat/agent-drivers-phase-0`. Re-checked against the clean-room rules: requirements only, no internals of the restricted client. |
| `docs/agent-events-mapping.md` | 3 | Behaviour only. Rows are numbered, not named after the restricted client's types. |
| `docs/agent-driver-design.md` | 3 | Interfaces, plain-data types, observable behaviour, the in-process sketch, Viz's decisions (§11). Type sketches are original to it. |
| `docs/agent-vendor-protocols.md` | 1 | The Deft, xAI and Antigravity messages as they appear on the wire. No code. |

The commit that adds this entry is the version that crosses, pending the legal review.

### History of this branch before publication

An earlier local version of this branch (last commit `05ac8b8`; never pushed; never given
to an Implementer) also carried the vendor extensions' source code under
`docs/vendor-reference/`, and earlier versions of the documents above. On the legal review
of 2026-11-18 it was withdrawn, for three reasons:

- the vendor source imported the restricted client's modules, named its members, and
  described in comments how it runs its handlers;
- two rules of the design (failures when starting, and the answer to a failed mode
  change) followed the existing client's handling step by step;
- one type value used the existing client's internal name.

The branch was rebuilt from `origin/main` without them. The vendor source is replaced by
`docs/agent-vendor-protocols.md`; the two rules now state outcomes only, with the texts
left to the transcripts; the value is renamed. The earlier version is kept by Viz, outside
this repository, as a git bundle (SHA-256
`f5e049049675eb31a51b8ccdace8f2eb1ad26715c78521a39e649c0f26b9d30a`).

### Decisions

Viz's decisions on the questions Phase 0 raised are in `docs/agent-driver-design.md` §11.

### Pending

- Review of the crossing documents by Deft's lawyer.
- No Implementer has started. The Implementer's environment and records are set out in the
  brief (CR-C, CR-E).

---

## 2026-11-19: Implementer session start, Phases 1 and 2

**Role.** This session is the **Implementer**: pi session
`01a1f25b-a53e-71df-adde-5f4debc3da09`.

**Clean-room statement.** I am a fresh session that has never read, been shown, or been
told the contents of Deft Console's source (TypeScript or Python) or of Toad. I have had
no access to restricted material. I am working exclusively from the Phase 0 documents in
`deftai/subspace`, the Subspace repository, the ACP specification, and the official ACP
SDK reference.

**Phases.** Starting Phase 1 (`@deft-subspace/agent-driver`) and Phase 2
(`clientEndpoint` and `ClientLayer`). Phase 4 step 2 (vendor layers) and Phase 5 step 1
(ACP driver) are blocked on the Specifier adding the vendor transcripts to
`@deft-subspace/acp-testkit`.

**Environment record (start).**
- Date: `2026-11-19T05:51:07Z`
- Machine: `283d6d978d2d`
- User: `root`
- Working directory: `/workspace/subspace`
- Home directory (`/root`): `.bashrc`, `.cache`, `.gitconfig`, `.local`, `.npm`, `.pi`, `.profile`
- Parent directory (`/workspace`): `subspace`
- Starting commit: `d260c85` (`feat/agent-drivers-phase-0`), branched to `feat/agent-drivers-phase-1`

---

## 2026-11-19: Implementer session finish, Phases 1 and 2

**Role.** This session is the **Implementer**: pi session
`01a1f25b-a53e-71df-adde-5f4debc3da09`.

**Clean-room statement.** Throughout this session I had no access to restricted material
(Deft Console's TypeScript or Python source, or Toad). All code and documentation added
are MIT-licensed, original work written solely from the Phase 0 documents in
`deftai/subspace`, the Subspace repository, the ACP specification, and the official ACP
SDK reference, with no new runtime dependencies.

**Phases completed.**
- Phase 1 (`@deft-subspace/agent-driver`): done on branch `feat/agent-drivers-phase-1` (commit `494877a`).
- Phase 2 (`clientEndpoint`, `ClientLayer`, `AcpClient` preset stack, `docs/AGENT-LAYERS.md`): done on branch `feat/agent-drivers-phase-2`.
- Phase 4 step 2 (vendor layers) and Phase 5 step 1 (ACP driver): not started; stopped per §9 and §10 because the vendor transcripts are not yet in `@deft-subspace/acp-testkit`.

**Environment record (finish).**
- Date: `2026-11-19T06:04:02Z`
- Machine: `283d6d978d2d`
- User: `root`
- Working directory: `/workspace/subspace`
- Home directory (`/root`): `.bashrc`, `.cache`, `.gitconfig`, `.local`, `.npm`, `.pi`, `.profile`, `.pnpm-store`
- Parent directory (`/workspace`): `subspace`



---

## 2026-11-19: Specifier review of Phases 1 and 2

**From** the Specifier (pi session `01a1f1e9-d10b-722a-a78d-12e04b2ea2f7`), in writing, under
CR-D. No code, patch or suggested implementation is attached.

**What was reviewed.** The exported bundle of `feat/agent-drivers-phase-1` (`494877a`) and
`feat/agent-drivers-phase-2` (`ebc4925`), this log, `docs/agent-drivers-status.md`, and the
proxy's access log (only the model API was reached). Outside the container, on a fresh
install: `pnpm run typecheck` passes, `pnpm run build` passes, and `pnpm test` passes in
every package (acp 235, kernel 59, acp-testkit 88, agent-driver 9, devtools 19, cli 17,
claude 6, create-subspace 5, examples). The failures you saw for `zip`, `ps` and the
kernel's process-group tests come from the container, not from your work; the
environment is being fixed. Nothing for you to do about them.

**Accepted.** Phase 1 and Phase 2 meet their acceptance criteria, with the two findings
below. Existing tests are unedited. Noted for Viz, no action: `AcpClient` gained an
optional `layers` option and an `endpoint` property; nothing else in its public API changed.

### Finding 1: the repository must install from its lockfile

A fresh clone of `feat/agent-drivers-phase-2` fails `pnpm install --frozen-lockfile`:
the lockfile does not list the new `@deft-subspace/agent-driver` package and its
workspace dependencies. CI installs this way. The repository MUST install with a frozen
lockfile, with no new dependency.

### Finding 2: the transcript format must carry the agent's side, as data

Brief §4 defines a transcript as a recorded exchange: **what the agent sends, what the
client must answer**, and which events, asks and service calls the workbench must see. The
Phase 1 format carries the driver steps and the workbench's expected record. It has no
place for the agent's side, and service results can be scripted only with code. The
Specifier is about to record the vendor transcripts (Phase 4 step 1) by running the
existing application, so the format has to hold a recording. Requirements:

1. **Data only.** A transcript MUST be storable as a file (JSON or JSON Lines) with no
   functions, so that it can be recorded from a running program and kept in
   `@deft-subspace/acp-testkit`. Steps that need code MAY remain, for hand-written tests,
   but no recorded transcript will use them.
2. **The agent's side.** For ACP, a transcript MUST hold every message the agent sends and
   every message the client must send, in order, placed relative to the driver steps that
   cause them (for example, the prompt that starts a turn). A replaying agent MUST be able
   to play the agent's side to any ACP client and report a client message that differs
   from the recording. How to represent it is your choice. Reusing the trace format that
   `@deft-subspace/acp-testkit` already records and replays is acceptable.
3. **Scripted answers and results as data.** The answer to each ask, and the result (or
   failure) of each service call, MUST be expressible in the file, in the order they are
   needed, so that the fake workbench can be set up from the file alone.
4. **Expectations unchanged.** What the workbench must see stays as now: events, asks,
   service calls and turn boundaries, in order, matched as subsets.
5. **Running them.** It MUST be possible to run one recorded ACP transcript (a) against any
   `AgentDriver` over ACP, with `checkDriver` or a companion in
   `@deft-subspace/acp-testkit`, and (b) against a client endpoint with one vendor layer in
   its stack, with a workbench (brief §9, Phase 4 acceptance).
6. **Protocol-neutral core.** `@deft-subspace/agent-driver` stays free of protocol code
   (brief §9, Phase 1). The ACP part of a transcript MAY be opaque to it and interpreted
   by an ACP-side companion.
7. **Documented.** Describe the format in a document in the repository, with one small
   example file, so that the Specifier can record transcripts in it.

### Next

Fix both findings on a new branch from `feat/agent-drivers-phase-2`, report in
`docs/agent-drivers-status.md`, and stop. Phase 4 step 2 still waits for the vendor
transcripts, which the Specifier will record in the format you settle on. If anything
here is unclear, ask in this log.

---

## 2026-11-19: Implementer session finish, Phase 1/2 review fixes

**Role.** This session is the **Implementer**: pi session
`01a1f25b-a53e-71df-adde-5f4debc3da09`.

**Clean-room statement.** Throughout this follow-up work I had no access to restricted
material (Deft Console's TypeScript or Python source, or Toad). All changes are
MIT-licensed, original work written solely from the Phase 0 documents, the Specifier's
written review above, and the Subspace repository, with no new runtime dependencies.

**Work completed.** Fixed Finding 1 (updated `pnpm-lock.yaml`, verified with
`pnpm install --frozen-lockfile`) and Finding 2 (data-only transcript format with
per-step/top-level `wire` and data-only `FakeWorkbench` service scripting; ACP runners
`checkAcpDriver` and `checkClientLayer` in `@deft-subspace/acp-testkit`; documented in
`docs/agent-driver-transcripts.md` with example file
`packages/acp-testkit/transcripts/example-vendor-key.transcript.json`) on branch
`feat/agent-drivers-phase-2-fixes`. Stopped awaiting the Specifier's vendor transcripts.

**Environment record (finish).**
- Date: `2026-11-19T06:37:12Z`
- Machine: `8c386f4f4a81`
- User: `root`
- Working directory: `/workspace/subspace`
- Home directory (`/root`): `.bashrc`, `.cache`, `.gitconfig`, `.local`, `.npm`, `.pi`, `.profile`, `.pnpm-store`
- Parent directory (`/workspace`): `subspace`


---

## 2026-11-19 — Specifier: Phase 4 step 1 vendor transcripts

**Role.** Specifier. Branch `feat/agent-drivers-phase-4-transcripts` (from
`implementer/phase-2-fixes` at `cde5f18`).

**What crossed the wall.** Eighteen pure-JSON driver transcripts under
`packages/acp-testkit/transcripts/vendor-*.transcript.json`. Each is data recorded from a
live run of Deft Console's ACP client against the oracle's scripted agents (Console branch
`feat/agent-drivers-transcript-recorder`). The wire half is the JSON-RPC exchange; the
`expected` half is the protocol-neutral vocabulary of `docs/agent-events-mapping.md`. No
Console or Toad source is in these files. No vendor extension source is in these files.

**Coverage.**
- Deft: `wait_for_key` / `call_tool` both spellings; tools off; stop_terminal; key ask
  cancelled with the turn.
- xAI: ask_user_question, exit_plan_mode, mcp elicit/complete, models/update,
  session_notification; subagent cancel both spellings; session delete prefixed and
  fallback.
- Antigravity: system-prompt meta; sign-in typed / env / declined / elicitation cancelled.
- Baseline: minimal handshake with no vendor methods.
- Permission asks cancelled by turn cancel and by cancelled answer.
- ACP elicitation/create (form and url).

**Not crossed.** Console source, the recorder itself, and the oracle fixtures stay in the
Console repository. The Implementer receives only these JSON transcripts plus the Phase 0
docs already on the wall.

**Next.** Implementer Phase 4 step 2 (vendor layers). Specifier continues Phase 3
(Console restructuring) in parallel.

---

## 2026-11-19 — Specifier: corrected Phase 4 transcripts

**Role.** Specifier. Follow-up to Implementer questions on export `export-20261119T073520Z`.

**What changed (still pure JSON only).** Re-recorded / corrected the 18 vendor transcripts:
1. Wire fallback pairs for delete/cancel stay on the driver step (not on `start`).
2. Workbench ask shapes match design §4; wire shapes match vendor-protocols (e.g. choices
   `accepted` + map answers; plan_approval workbench `decision` / wire `outcome`).
3. `workbench.project.env` and `workbench.services` where layers need them; M27 source
   `"an MCP server"`; Antigravity system-prompt `presentation.systemPrompt` service row.
4. `options.session` omitted on `session/new` transcripts; `expectSessionId` kept.

**Not crossed.** Console source. Recorder fixes stay in Console.


---

## 2026-11-19: Answers to Phase 4 transcript questions

**From** the Specifier (pi session `01a1f1e9-d10b-722a-a78d-12e04b2ea2f7`), in writing, under
CR-D. You were right to stop (brief §10). Do not implement against the broken transcripts.
A corrected bundle is placed with this answer as
`answers/phase4-transcripts-corrected.bundle` (tip **`19fc6fe`**, still based on
`cde5f18`). Until that bundle is merged, do not treat the 18 files at `33bdb3c` as final.

### 1. Out-of-order wire (fallback delete / cancel) — Specifier bug

**Yes: those fallback request/reply pairs belong on the `deleteSession` /
`cancelSubagent` step where they occur, after the prefixed attempt, not on `start`.**

The recorder split the bidirectional wire across steps badly when one driver method sent
two client requests (prefixed, then unprefixed). That is a Specifier defect. Corrected
transcripts will place:

- `_x.ai/session/delete` (or cancel) and its −32601 reply, then
- `x.ai/session/delete` (or cancel) and its result,

all on the corresponding driver step, in that order, with nothing of either pair on
`start`.

### 2. Ask / wire shapes — which document wins

**Split by layer of the stack:**

| Layer | Authoritative source |
|---|---|
| **Wire** (what the client sends and answers on JSON-RPC) | `docs/agent-vendor-protocols.md`, and the **corrected** transcripts once delivered. Vendor-protocols §1: when transcripts exist they pin exact shapes. |
| **Workbench ask request and answer** (what `workbench.ask` sees) | `docs/agent-driver-design.md` §4. The xAI layer **translates** workbench answers into wire shapes. |
| **Mapping rows** | `docs/agent-events-mapping.md` for which ask kind and which event; if a row disagrees with design §4 on field names, **design §4 wins** for the workbench, vendor-protocols for the wire. |

Concrete resolutions for `vendor-xai-requests`:

- **`choices` (M29).** Workbench request: `{ toolCallId, planning: boolean, questions }`
  per design §4.3 (`planning` true when Grok's `mode` is `"plan"`; do not put `mode` on
  the workbench request). Workbench answer: `{ outcome: "accepted", answers: Record<string, string[]>, annotations? }`
  or the planning variants, or cancelled. **Wire** result: vendor-protocols §3.2 —
  `{ outcome: "accepted", answers, annotations? }` (answers keyed by question text), not
  Console's oracle test shape `outcome: "answered"` with an array. The first recording
  passed through a Console UI test answer; that is not the Grok wire contract.
- **`plan_approval` (M30).** Workbench request: `{ toolCallId, plan: string | null }`
  (`planContent` on the wire becomes `plan` on the workbench). Workbench answer:
  `{ decision: "approve" | "keep_planning" | "abandon" }`. **Wire** result:
  `{ outcome: "approved" | "cancelled" | "abandoned" }` per vendor-protocols §3.3 and
  mapping M30. A cancelled ask → wire `cancelled` (keep planning).
- **`question` for `x.ai/mcp/elicit` (M27).** Workbench `source`: `"an MCP server"` when
  `serverName` is absent (mapping M27), not `"an MCP server (MCP server)"`. Wire reply
  uses `outcome` (`accept` / `decline` / `cancel`), not ACP's `action` key.

Corrected transcripts will match the above in both `expected` / `workbench.asks` and
`wire`.

### 3. `workbench` scripting and `expected` completeness

**`expected` is matched 1-to-1, in order, against `workbench.records`.** Your reading of
`verifyWorkbenchRecords` is right. A transcript that only lists asks/events will fail as
soon as the layer (or harness) records a service call or turn boundary.

Corrected transcripts will:

- Set **`workbench.project.env`** when the scenario depends on it (Antigravity sign-in from
  env: `GEMINI_API_KEY`).
- Set **`workbench.services`** for every service the layer must call under that transcript
  (`presentation.systemPrompt`, `tools.list` / `tools.call`, `project.rememberEnv`, …),
  with FIFO `{ ok }` / `{ error }` replies. Layers MUST NOT read application setting keys
  to decide behaviour (design §8.1); Antigravity's system-prompt append uses
  `presentation.systemPrompt` (and the agent's capability meta), not
  `agent.display_guidance`.
- List the corresponding **`service` (and `ask` / `event`) rows in `expected`**, in the
  order `FakeWorkbench` will record them for a correct implementation.
- Include **`turn_started` / `turn_ended` only when the run under test records them**
  (a full `AgentDriver` turn). For `checkClientLayer` harnesses that never call
  `turnStarted` / `turnEnded`, those rows stay absent — do not invent them.

Until the corrected files land, you may sketch layers against design §6 and vendor-protocols
alone, but do not mark Phase 4 step 2 complete on the first 18 files.

### 4. `options.session` on `session/new` transcripts

**Yes: omit `options.session` (or at least omit `sessionId`) when the transcript opens a
new session with `session/new`.** Design §5: `options.session` means reopen a saved
session. Use `workbench.project.path` for cwd, and `expectSessionId: "sess-1"` when the
session id after start must be checked. Corrected transcripts will follow that.

### What you should do now

1. Import the corrected bundle (workspace may already be at `33bdb3c`):

```sh
test -f /tmp/phase4-transcripts-corrected.bundle \
  || test -f /tmp/phase4-transcripts.bundle  # operator may use either name
BUNDLE=/tmp/phase4-transcripts-corrected.bundle
test -f "$BUNDLE" || BUNDLE=/tmp/phase4-transcripts.bundle
git fetch "$BUNDLE" feat/agent-drivers-phase-4-transcripts
git merge --ff-only FETCH_HEAD
git rev-parse HEAD   # expect 19fc6fe…
```

2. Continue Phase 4 step 2 against **`19fc6fe`**. Do not claim passage on `33bdb3c`.
3. Do not edit transcript JSON yourself.
4. **Known residual on Q3:** `workbench.services` scripting and env are present where the
   layer must read them; not every transcript yet lists a full 1-to-1 `service` row for
   every internal tool/call the Deft layer may make while answering `call_tool`. Implement
   from design §6.1 and vendor-protocols; if `verifyWorkbenchRecords` fails only because
   `expected` is missing service rows your correct layer emits (or has extras the
   transcript omitted), stop and list the actual `workbench.records` in this log — the
   Specifier will extend `expected`, not you editing the file.
5. If anything else still cannot be satisfied, stop and ask again.

### Specifier follow-up (for the log)

Export under review: `export-20261119T073520Z`. No Phase 4 step 2 code was reviewed (you
correctly stopped). Proxy log: model API only, plus refused github.com from build checks.

---

## 2026-11-19: Implementer — Phase 4 step 2 built, stopping on Q3 residual (missing `service` rows in `expected` and `tools` script in `vendor-deft-requests`)

**Role.** This session is the **Implementer**: pi session
`01a1f25b-a53e-71df-adde-5f4debc3da09`.

**Clean-room statement.** Throughout this work I had no access to restricted material.
All code in `packages/acp-vendors` is MIT-licensed, original work written solely from the
Phase 0 documents, the Specifier's written answers above, and the Subspace repository,
with no new external dependencies.

**Status.** Built `@deft-subspace/acp-vendors` (`deftLayer`, `xaiLayer`,
`antigravityLayer`, `vendorServicesLayer`, `VENDOR_SERVICES`) on branch
`feat/agent-drivers-phase-4-vendors` on top of `19fc6fe`. Typecheck (10/10 projects),
build, frozen lockfile (`pnpm install --frozen-lockfile`), and unit tests (4/4) all pass.

**Transcript test results (18 `vendor-*.transcript.json` files at `19fc6fe`).**
17 of 18 transcripts pass **100% on the wire** (zero `ReplayDivergence`s, zero step
failures) and match **every `ask` and `event` row identically**. Per Specifier
instruction #4, I am stopping without editing any transcript file to report the exact
missing `service` rows and `workbench.services.tools` script:

1. **Missing `initialize` service rows in `expected` across all 18 transcripts.**
   Because `deftLayer` advertises `clientCapabilities._meta["deft.co"]` to every agent on
   `initialize` (X4, design §6.1), `FakeWorkbench` records these two `service` rows first
   on every transcript:
   ```json
   { "kind": "service", "workbench": "main", "service": "presentation", "method": "capabilities" },
   { "kind": "service", "workbench": "main", "service": "tools", "method": "list" }
   ```
   Currently none of the 18 transcripts include these two leading rows in `expected` (in
   `vendor-antigravity-system-prompt.transcript.json`, `expected` starts at
   `presentation.systemPrompt` instead of after `presentation.capabilities` and
   `tools.list`).

2. **Missing `project.rememberEnv` service row in `vendor-antigravity-sign-in-typed.transcript.json`.**
   Per design §6.3 step 3, after `authenticate` succeeds with a typed API key,
   `antigravityLayer` calls `workbench.project.rememberEnv("GEMINI_API_KEY", "typed-key")`.
   `FakeWorkbench` records:
   ```json
   { "kind": "service", "workbench": "main", "service": "project", "method": "rememberEnv", "args": { "name": "GEMINI_API_KEY", "value": "typed-key" } }
   ```
   at the end of `workbench.records` (after the `sign_in` and `question` asks).

3. **Missing `workbench.services.tools` (`list` and `call`) and `service: tools.call` rows in `vendor-deft-requests.transcript.json`.**
   `vendor-deft-requests.transcript.json` has no `workbench.services.tools` script (only
   `project.settings["agent.display_tools"]: true`), so `workbench.tools.list()` returns
   the default `[]`, causing `deft.co/call_tool` for `show_image`, `show_diagram`, and
   `show_page` to reply `-32602 Unknown tool` (wire message 17). To satisfy the 3 tool
   calls (`id: 716`, `717`, `718`) and the invalid-arguments check (`id: 719`),
   `vendor-deft-requests.transcript.json` needs:
   - `workbench.services.tools.list`: `[{ "ok": [ { "name": "show_image", "description": "...", "inputSchema": { "type": "object" } }, { "name": "show_diagram", "description": "...", "inputSchema": { "type": "object" } }, { "name": "show_page", "description": "...", "inputSchema": { "type": "object" } } ] }]`
   - `workbench.services.tools.call`:
     ```json
     [
       { "ok": { "ok": false, "message": "No path given." } },
       { "ok": { "ok": false, "message": "No such file: /tmp-oracle/project/missing.png" } },
       { "ok": { "ok": false, "message": "No Mermaid source given." } }
     ]
     ```
   - And the 3 corresponding `service: tools.call` rows in `expected` after the 2 `key` asks.

Once those `expected` service rows and `vendor-deft-requests`'s `workbench.services.tools`
script are added, all 18 vendor transcripts should pass immediately with zero code changes
to `@deft-subspace/acp-vendors`.

