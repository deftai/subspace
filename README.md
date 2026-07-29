# Deft Subspace

Multi-protocol **agent infrastructure**: great DX for clients and servers on any transport, many protocols.

**Ship order:** ACP wire + client + agent → probe/testkit → harness → A2A → Bridge (consumer) → MCP.

Strategy docs: [deftai/section-31/strategy/subspace](https://github.com/deftai/section-31/tree/main/strategy/subspace)

## Packages (`@deft/*`)

| Package | Role |
|---------|------|
| `@deft/subspace-foundation` | Protocol-agnostic kernel (transport/framer/codec) |
| `@deft/acp-wire` | ACP transport + NDJSON; Option C; composes foundation |
| `@deft/acp-client` | Host façade + **phase 2** session product |
| `@deft/acp-agent` | Agent façade + reverse RPC + session-echo helpers |

**Option C:** structured messages in-process by default; NDJSON only on byte edges; optional `encodeRoundTrip` for parity tests.

### Phase 2 product (`defineAcpClientProduct`)

- `sessions.create` / `load` / `ensure` over `session/new` + `session/load`
- `session.prompt` → `AsyncIterable` demuxed `session/update` events
- **One** prompt queue owner; `cancel` without session teardown
- Reverse map: `session/request_permission` with `deny` | `approve-reads` (never approve-all default)
- Host session store only (`localId` ≠ `acpSessionId` ≠ `providerId`); soft-close + resume

### Prove it

```bash
# Node ≥22 — workspace install required for package name imports
pnpm install
pnpm test
```

| Suite | Covers |
|-------|--------|
| `option_c_dual_transport_echo` | Phase 1/1.5 wire A/B/C |
| `phase2_session_product` | Session façade linked + stdio, cancel, permissions |

### Out of scope (still)

- Middleware stack / foundation RpcSession / TCP bags / StreamMux / AuthPipeline
- Bridge / A2A / harness tool loop / probe product / testkit / React subpath

## License

MIT (see `LICENSE`).
