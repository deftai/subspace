# Agent drivers implementation status

## Phase 1: `@deft-subspace/agent-driver` (2026-11-19)

- **Branch:** `feat/agent-drivers-phase-1`
- **Done:**
  - Added `packages/agent-driver` (`@deft-subspace/agent-driver`, MIT, zero runtime dependencies, type-only imports from `@deft-subspace/acp` and `@deft-subspace/kernel`, no Node APIs in `src/`).
  - Implemented all plain-data event types, ask types (`permission`, `question`, `choices`, `plan_approval`, `key`, `sign_in`, `sign_in_outside`), `StartFailure`/`StartFailureError`, `AgentDriver`, `AgentDriverCapabilities`, `AgentDriverOptions`, `AcpDriverOptions`, `AgentWorkbench` and its services, and `AgentHandler<Wire>` per `docs/agent-driver-design.md`.
  - Implemented `FakeWorkbench` (W1–W5, single ask registry shared with `child()`, detached asks, turn-end and workbench-close cancellation, ordered recording of events, asks, service calls and turn boundaries).
  - Implemented `DriverTranscript` and conformance runner `checkDriver` / `assertDriverConforms`.
- **Tests:** `packages/agent-driver`: 9/9 passing; `pnpm run typecheck` passes across all 9 workspace projects; `pnpm --filter @deft-subspace/agent-driver run build` passes.
- **Not done:** None for Phase 1.
- **Decisions needed:** None.

## Phase 2: `clientEndpoint` and `ClientLayer` (2026-11-19)

- **Branch:** `feat/agent-drivers-phase-2`
- **Done:**
  - Added `packages/acp/src/client-endpoint.ts` (`clientEndpoint`, `ClientLayer`, `EndpointAgent`, `ClientEndpointContext`, `ClientCallContext`, `NEGOTIATED_AGENT`, `bothSpellings`) and exported them from `@deft-subspace/acp`.
  - Rebuilt `AcpClient` (`packages/acp/src/client.ts`) as a preset stack on `clientEndpoint` (`negotiate`, `sessions`, `files`, `terminals`, `elicitation`, `mcp`, `extensions`, plus `options.layers`), routing all outbound requests and notifications through `endpoint.agent` (including `McpProvider` notifications in `packages/acp/src/mcp.ts`).
  - Added `packages/acp/test/client-endpoint.test.ts` (13 tests covering C1–C8, close order, cancellation, and a two-way proxy through `clientEndpoint`).
  - Updated `docs/AGENT-LAYERS.md` status and client-side section (C8).
- **Tests:** `packages/acp/test/client-endpoint.test.ts`: 13/13 pass; `packages/acp`: 233/235 pass (2 pre-existing container `ENOENT` failures for missing `zip`/`ps` binaries); `packages/agent-driver`: 9/9; `packages/acp-testkit`: 88/88; `packages/claude`: 6/6; `packages/devtools`: 19/19; `packages/cli`: 17/17; `packages/create-subspace`: 5/5; `pnpm run typecheck` passes across all 9 workspace projects.
- **Not done:** None for Phase 2.

## Final report (2026-11-19)

- **Phases:** Phase 1 done (`feat/agent-drivers-phase-1`, `494877a`); Phase 2 done (`feat/agent-drivers-phase-2`, latest commit); Phase 4 step 2 and Phase 5 step 1 not started (stopped per §9/§10: vendor transcripts are not yet in `@deft-subspace/acp-testkit`).
- **Tests:** 377/379 passing across `agent-driver` (9/9), `acp` (233/235; 2 missing `zip`/`ps` in container), `acp-testkit` (88/88), `claude` (6/6), `devtools` (19/19), `cli` (17/17), `create-subspace` (5/5). `kernel` has 5 pre-existing container PID-1 process-group failures (untouched). Typecheck passes for all 9 projects.
- **Open questions:** None; ready for Phase 4 step 2 once the Specifier adds vendor transcripts to `@deft-subspace/acp-testkit`.
- **Python port (`python/`):** Would need a `deft-subspace-agent-driver` package (event/ask dataclasses, `FakeWorkbench`, `check_driver`) and a client-side `client_endpoint` / `ClientLayer` / `both_spellings` / `NEGOTIATED_AGENT` mirror in `deft-subspace-acp` with `AcpClient` rebuilt on it.
- **Clean-room statement (CR-E):** Session `01a1f25b-a53e-71df-adde-5f4debc3da09` had no access to restricted material; full start and finish environment records are in `docs/clean-room-log.md`.

## Phase 1/2 review fixes (2026-11-19)

- **Branch:** `feat/agent-drivers-phase-2-fixes` (from `feat/agent-drivers-phase-2`, `ebc4925`)
- **Finding 1 (frozen lockfile):** Updated `pnpm-lock.yaml` with `packages/agent-driver` and `@deft-subspace/agent-driver` under `packages/acp-testkit` (no new external dependencies). Verified with `pnpm install --frozen-lockfile --offline`.
- **Finding 2 (data-only transcripts + ACP wire replay):**
  - `@deft-subspace/agent-driver`: added data-only `FakeWorkbenchData` / `FakeWorkbenchServiceScript` (`{ ok }` / `{ error }` queues per service method), `RecordedDriverTranscript` / `RecordedTranscriptStep` with opaque `wire` and `action: 'exchange'`, and exported `verifyWorkbenchRecords` / `matchSubset`. Still zero protocol code and zero Node APIs.
  - `@deft-subspace/acp-testkit`: added `packages/acp-testkit/src/driver-transcript.ts` (`AcpWireMessage`, `parseAcpTranscript`, `wireFromTrace`, `wireMessagesOf`, `wireToTrace`, `checkAcpDriver` / `assertAcpDriverConforms`, `checkClientLayer` / `assertClientLayerConforms`), built on `replayAgent` with automatic client response checking and optional `match` subset checks.
  - Documented the format in `docs/agent-driver-transcripts.md` with tested example `packages/acp-testkit/transcripts/example-vendor-key.transcript.json`.
- **Tests:** `pnpm run typecheck` passes (9/9 projects); `build` passes (`acp`, `agent-driver`, `acp-testkit`); `agent-driver`: 10/10; `acp-testkit`: 93/93 (including 5 new transcript-runner tests).
- **Next:** Stopped; ready for Phase 4 step 2 once the Specifier adds vendor transcripts in this format to `@deft-subspace/acp-testkit`.


