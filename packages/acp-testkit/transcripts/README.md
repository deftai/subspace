# Driver transcripts

Pure-JSON recordings of agent ↔ client exchanges for conformance.

- `example-vendor-key.transcript.json` — format example (Implementer, Phase 2).
- `vendor-*.transcript.json` — vendor coverage (Specifier, Phase 4 step 1).

Each `vendor-*.transcript.json` was recorded from a live run of Deft Console's ACP
client against a scripted agent (Console oracle scenarios). The wire half is the
JSON-RPC exchange; `expected` is the protocol-neutral workbench vocabulary
(`docs/agent-events-mapping.md`). Re-run the recorder in Console
(`packages/console/test/acp/transcripts/`) to refresh them.

Run with `checkAcpDriver` / `checkClientLayer` from `@deft-subspace/acp-testkit`.
