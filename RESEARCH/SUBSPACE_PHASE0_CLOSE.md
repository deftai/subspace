---
title: "Subspace Phase 0 Close — Kernel Exit"
tags: [subspace, phase-0, acp, kernel]
status: active
created: 2026-07-29
---

# Subspace phase 0 close (kernel as built)

**Date:** 2026-07-29  
**Kernel tip:** `main` @ `3e7018dd186856b4d56b03a9f1f8bccbc6a0d511` (merge of PR #5 schema-fix)  
**This memo:** formal phase-0 exit for the ACP kernel slice — “doc set agreed” for what landed, not a product roadmap rewrite.

## Verdict

**Phase 0 is closed for the kernel.** Phases 1–4 shipped on `main`, schema-fix makes the product path honest against real agents, and step 3 (this PR lineage) makes the monorepo install/consume/truth surface usable without a fake registry dance.

The next constraint is **not** “is the monorepo real?” — it is **what product layer to build next** (harness / A2A / Bridge / MCP per ship order).

## What landed (ship order restated)

| Phase | Package face | On main (representative) | Proof |
|-------|--------------|--------------------------|--------|
| 1 / 1.5 | `@deft/subspace-foundation`, `@deft/acp-wire` | Option C dual transport | `option_c_dual_transport_echo` |
| 2 | `@deft/acp-client`, `@deft/acp-agent` | Session product + reverse perms | `phase2_session_product` |
| 3 | `@deft/acp-probe` | Thin CLI over client product | `phase3_acp_probe` |
| 4 | `@deft/acp-testkit` | Importable scenarios (no `acp-tester` pkg) | `phase4_acp_testkit` |
| Schema-fix | client + probe | `cwd`+`mcpServers`, `initialize` on connect, probe `--cwd`, error stringify | PR #5 `efbde20` / merge `3e7018d` |

**Public version face after step 3:** all six packages at **0.1.0**, publishable metadata (no `private` on package faces). Root monorepo remains `private: true`.

## External smoke truth

From workspace research (`SUBSPACE_EXTERNAL_ACP_SMOKE.md`, pre-fix) and post-fix product path:

| Claim | Truth |
|-------|--------|
| Real ACP agents exist on this class of machine | **Yes** — e.g. `grok-acp`, `claude-code-acp` on PATH |
| Transport / NDJSON / `initialize` | **OK** against real agents |
| Product probe before schema-fix | **FAIL** — missing `cwd` + `mcpServers` on `session/new` |
| Product path after schema-fix (PR #5) | **Designed and tested** to send required params + initialize first; real-agent one-shot is a **manual** smoke, not a permanent CI matrix |
| In-repo fixture probe | **Green** in suite always |

**Rule kept:** truth over green — no permanent external-agent CI matrix in this close.

## Delete-list (restated — still deleted / never shipped)

Do **not** reintroduce under “phase 0 polish”:

- Middleware stack / foundation `RpcSession` bag
- TCP bags / StreamMux / AuthPipeline as kernel deliverables
- Separate `acp-tester` package (testkit scenarios only)
- Bridge extraction, A2A, harness tool loop, MCP packages as phase-0 items
- Fake `npm publish` theater without registry auth
- Release-bot / changesets empire / marketing site / monorepo rename

## npm / consume residual

| Path | Status |
|------|--------|
| Git clone + `pnpm install` + `pnpm test` | **Supported** (primary) |
| `pnpm pack` per package | **Supported** (documented in root README) |
| `npm install @deft/...` from registry | **Residual:** needs `npm login` / token for `@deft` — **not** green on unauthenticated machines |

Honest status line for operators: **needs `npm login` / token for `@deft`**. Never claim registry publish succeeded without auth evidence.

## Open risks only (not phase-0 blockers)

1. **ACP protocol motion** — v1 vs v2 draft / elicitation; pin schema negotiation as product evolves (see earlier gap memo).
2. **TS-at-runtime** — packages export `.ts` via Node `--experimental-strip-types`; no dist build yet. Fine for 0.1.0; may need emit before wide npm consumers.
3. **workspace:\* on publish** — monorepo deps are workspace protocol; registry publish must rewrite or pack in dependency order (documented, not automated here).
4. **Next product constraint unnamed** — harness vs other ship-order items is an intentional product decision, outside this memo.

## Exit criteria (phase 0)

| Gate | Met when |
|------|----------|
| Kernel code on main | Phases 1–4 + schema-fix @ `3e7018d`+ |
| Install/consume story | Root README: git + pack; npm residual explicit |
| Doc set agreed | This memo + root README match physics |
| Suite | Full monorepo `pnpm test` green on tip |

**Phase 0 closed.** Further work is phase-next product, not kernel-loop ambiguity.
