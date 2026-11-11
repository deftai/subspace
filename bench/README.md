# Benchmarks

Subspace (TypeScript, Python) against the official ACP SDKs (`@agentclientprotocol/sdk`, `agent-client-protocol`), every client against every agent. Results: [RESULTS.md](RESULTS.md).

## What is measured

Each library has one benchmark agent (`agents/`) and one benchmark client (`clients/`). The agents read the prompt text as a command ([agents/protocol.md](agents/protocol.md)); the clients share their scenarios (`clients/common.ts`, `clients/common.py`). Each run starts the agent as a child process and talks to it over stdio.

| scenario | what one run does |
| --- | --- |
| `startup` | spawn the agent, `initialize`, `session/new`, one empty turn |
| `turns` | 2,000 empty turns, one after another (latency p50 and p99 too) |
| `stream` | one turn that streams 20,000 message chunks of 100 characters |
| `large` | one turn that streams 50 chunks of 1,000,000 characters |
| `ask` | one turn that asks permission 1,000 times, one after another |
| `concurrent` | 20 sessions, each running 100 empty turns, all at once |

Every scenario but `startup` warms up first (100 turns, or a few short streams), then times only its own part. The clients check what they received (the streamed text's length). Each process records its own peak RSS; agents write theirs to `BENCH_RSS_FILE` on exit.

## Run

```sh
pnpm install && pnpm run build              # the TypeScript packages, from the repo root
uv venv .venv -p 3.14                       # in bench/
uv pip install -p .venv/bin/python -e ../python/packages/kernel -e ../python/packages/acp agent-client-protocol==1.0.0
.venv/bin/python run.py --python .venv/bin/python --quick       # every pair, tiny sizes: does it all run?
.venv/bin/python run.py --python .venv/bin/python               # the full matrix, protocol v1 (about 10 minutes)
.venv/bin/python run.py --python .venv/bin/python --protocol 2 --out results/v2.json   # Subspace pairs only
python3 report.py results/v1.json > tables.md
```

`--only subspace-ts/official-py` runs chosen pairs, `--scenarios turns stream` chosen scenarios, `--repeat N` sets the runs per cell (default 3; startup always gets at least 5).

## Notes

- All four libraries run ACP v1. Subspace negotiates v2 with itself when it can, so its clients ask for v1 unless `BENCH_PROTOCOL=2` (`--protocol 2`).
- The official Python SDK starts agents with a trimmed environment (PATH and a few more), so its client passes `BENCH_*` variables on explicitly.
- The TypeScript files run with Node's built-in type stripping (Node 22.18+), against the packages' built `dist/`.
- Run on an otherwise idle machine; the numbers move with load.
