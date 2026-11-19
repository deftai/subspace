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
