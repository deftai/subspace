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

