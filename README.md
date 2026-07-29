# Deft Subspace

Multi-protocol **agent infrastructure**: great DX for clients and servers on any transport, many protocols.

**Ship order:** ACP wire + client + agent → probe/testkit → harness → A2A → Bridge (consumer) → MCP.

Strategy docs: [deftai/section-31/strategy/subspace](https://github.com/deftai/section-31/tree/main/strategy/subspace)

## Phase 1 (this tree)

Four packages under `@deft/*`:

| Package | Role |
|---------|------|
| `@deft/subspace-foundation` | Protocol-agnostic kernel (transport/framer/codec sketches) |
| `@deft/acp-wire` | ACP transport + NDJSON codecs; Option C |
| `@deft/acp-client` | Thin host façade (connect + request/notify) |
| `@deft/acp-agent` | Thin agent façade (listen + exact method map) |

**Option C:** structured messages in-process by default; NDJSON only on byte edges; optional `encodeRoundTrip` for parity tests.

### Prove it

```bash
# Node ≥22 (uses --experimental-strip-types)
npm test
```

North-star for phase 1: `option_c_dual_transport_echo`

| Path | Transport |
|------|-----------|
| A | linked structured (no JSON hop) |
| B | linked `encodeRoundTrip` |
| C | stdio spawn NDJSON |

### Non-goals (phase 1)

- Bridge / Rete in core
- Session sugar / queue product
- Probe CLI / testkit product packages
- A2A / MCP packages

## License

MIT (see `LICENSE`).
