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
