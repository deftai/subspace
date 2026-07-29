# Deft Subspace

Multi-protocol **agent infrastructure**: great DX for clients and servers on any transport, many protocols.

**Ship order:** ACP wire + client + agent → probe/testkit → harness → A2A → Bridge (consumer) → MCP.

**Kernel status:** phases 1–5 on `main` (early harness landed). DX first pass: shared agent helpers + multi-file harness. See [`RESEARCH/SUBSPACE_PHASE0_CLOSE.md`](./RESEARCH/SUBSPACE_PHASE0_CLOSE.md).

Strategy docs: [deftai/section-31/strategy/subspace](https://github.com/deftai/section-31/tree/main/strategy/subspace)

## Packages (`@deft/*`)

| Package | Version | Role |
|---------|---------|------|
| `@deft/subspace-foundation` | 0.1.0 | Protocol-agnostic kernel (transport/framer/codec) |
| `@deft/acp-wire` | 0.1.0 | ACP transport + NDJSON; Option C; composes foundation |
| `@deft/acp-client` | 0.1.0 | Host façade + **phase 2** session product |
| `@deft/acp-agent` | 0.1.0 | Agent façade + reverse RPC + session-echo + **shared helpers** |
| `@deft/acp-probe` | 0.1.0 | **Phase 3** thin CLI over client product (stdio smoke) |
| `@deft/acp-testkit` | 0.1.0 | **Phase 4** importable scenarios + asserts (no `acp-tester` package) |
| `@deft/acp-harness` | 0.1.0 | **Phase 5 early** agent harness + **stub** model (linked + stdio) |

**Option C:** structured messages in-process by default; NDJSON only on byte edges; optional `encodeRoundTrip` for parity tests.

**DX helpers (first pass — not a framework):** `promptToText`, `notifyAgentMessageChunk` / `agentMessageChunkUpdate`, `defaultInitializeResult`, `createDeferredBridge` on `@deft/acp-agent`; harness `resolveHarnessOptions` + multi-file layout. Rich `on*` / wildcards / hooks bag remains **provisional** (not shipped).

### Phase 2 product (`defineAcpClientProduct`)

- `sessions.create` / `load` / `ensure` over `session/new` + `session/load`
- `session.prompt` → `AsyncIterable` demuxed `session/update` events
- **One** prompt queue owner; `cancel` without session teardown
- Reverse map: `session/request_permission` with `deny` | `approve-reads` (never approve-all default)
- Host session store only (`localId` ≠ `acpSessionId` ≠ `providerId`); soft-close + resume

### Schema-fix (PR #5) — real agents

Product path is honest against real ACP agents (Grok Build / Claude Code ACP), not only in-repo fixtures:

| Behavior | Detail |
|----------|--------|
| **`initialize` on connect** | Client issues `initialize` before `session/new` (real agents reject session until init completes) |
| **`session/new` params** | Always send `cwd` + `mcpServers` (defaults: `process.cwd()`, `[]`) via `buildSessionNewParams` |
| **Probe `--cwd`** | Aligns spawn cwd with `session/new` cwd |
| **Error strings** | Wire failures stringify without `"[object Object]"` |

```bash
# Probe vs a real agent on PATH (example)
pnpm exec node --experimental-strip-types packages/acp-probe/bin/acp-probe.ts \
  --command grok-acp \
  --cwd "$PWD" \
  --prompt "reply with SMOKE_OK only" \
  --permission deny \
  --timeout 60000
```

## Consume (until npm registry auth exists)

Packages are **publish-ready metadata** (`0.1.0`, public `publishConfig`, no `private` on the six faces). This machine has **no npm auth** for `@deft` — do not expect `npm install @deft/...` from the registry until someone runs `npm login` (or supplies a token) for the org.

### Path A — monorepo (recommended while developing)

```bash
git clone https://github.com/deftai/subspace.git
cd subspace
pnpm install   # Node ≥22; packageManager pnpm@9.15.0
pnpm test
```

Workspace deps stay `workspace:*` in-repo. Imports resolve via package names after install.

### Path B — pack a tarball (no registry)

From a checkout after `pnpm install`:

```bash
# Dependency order for packing (foundation first)
pnpm --filter @deft/subspace-foundation pack
pnpm --filter @deft/acp-wire pack
pnpm --filter @deft/acp-client pack
pnpm --filter @deft/acp-agent pack
pnpm --filter @deft/acp-probe pack
pnpm --filter @deft/acp-testkit pack
pnpm --filter @deft/acp-harness pack
# Install resulting .tgz files into a consumer with pnpm/npm file: or packed deps
```

Note: sources are TypeScript run with Node’s `--experimental-strip-types` (no build step yet). Consumers need Node ≥22 the same way the monorepo does.

### Path C — npm (residual)

**Needs `npm login` / token for `@deft`.** When auth exists:

```bash
# from monorepo root, after version/tag discipline you choose
pnpm --filter "./packages/*" publish --access public
```

Until then, treat registry install as **not available** — git + pack only.

## Prove it

```bash
# Node ≥22 — workspace install required for package name imports
pnpm install
pnpm test
```

| Suite | Covers |
|-------|--------|
| `option_c_dual_transport_echo` | Phase 1/1.5 wire A/B/C |
| `phase2_session_product` | Session façade linked + stdio, cancel, permissions |
| `phase3_acp_probe` | CLI smoke vs session-echo-agent; fail exits; cwd+mcpServers |
| `phase4_acp_testkit` | Multi-turn · cancel · perms on linked; multi-turn (+ cancel) on stdio |
| `phase5_acp_harness` | Stub harness brain: linked + stdio turn, cancel, streamed update |

```bash
# Probe screwdriver vs in-repo session-echo
pnpm exec node --experimental-strip-types packages/acp-probe/bin/acp-probe.ts \
  --command node --arg --experimental-strip-types \
  --arg packages/acp-agent/bin/session-echo-agent.ts \
  --prompt hello --permission deny
```

### Harness (early)

**`@deft/acp-harness`** is a **minimum** agent loop that samples a **stub** model and streams ACP — not a production coding agent (no real providers, tools drawer, MCP, or Bridge).

```bash
# Probe vs stub harness agent
pnpm exec node --experimental-strip-types packages/acp-probe/bin/acp-probe.ts \
  --command node --arg --experimental-strip-types \
  --arg packages/acp-harness/bin/stub-harness-agent.ts \
  --prompt hello --permission deny
```

Linked in-process: `listenHarness(agentTransport)` or `defineHarness({ model }).listen(transport)`.

## Out of scope (still)

- Middleware stack / foundation RpcSession / TCP bags / StreamMux / AuthPipeline
- Bridge / A2A / real model providers / full tool-MCP empire / `acp-tester` package / React subpath
- Permanent CI matrix against external agents (truth was proven ad-hoc; suite stays fixture-based)

## License

MIT (see `LICENSE`).
