# Benchmark results

Subspace (TypeScript and Python) against the official ACP SDKs (`@agentclientprotocol/sdk` 2.4.0 and `agent-client-protocol` 1.0.0). Run on 2026-11-11 on an Apple M4 (10 cores, 16 GB), macOS 15, Node 26.12.0 and Python 3.14.10, with the 1-minute load average between 2.4 and 3.2. How they were run, and how to run them again, is in [README.md](README.md). The raw data is in `results/`.

Every client was run against every agent, each pair in two processes over stdio, on ACP v1 (the only version all four have in common). Each cell is the median of 3 runs (5 for startup).

These results include two fixes found by the benchmarks: the Subspace Python agent's stdio writer no longer waits for each frame (this change), and the Subspace TS agent starts v2 turns with `setImmediate` (#23, for the v2 tables). `results/*-before-stdio-fix.json` are the runs from before the first; in them the Subspace Python agent streamed 15,634 chunks/s and ran 8,663 concurrent turns/s.

## Same-library pairs

| | Subspace TS | Official TS | ratio | Subspace Py | Official Py | ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| startup, ms (lower is better) | 83 | 98 | 0.85 | 83 | 192 | 0.43 |
| sequential turns/s | 34,041 | 36,391 | 0.94 | 4,963 | 4,885 | 1.02 |
| turn latency p50 / p99, ms | 0.021 / 0.147 | 0.021 / 0.118 | | 0.195 / 0.379 | 0.201 / 0.252 | |
| streamed chunks/s | 372,999 | 263,656 | 1.41 | 94,595 | 23,751 | 3.98 |
| large chunks, MB/s | 979 | 743 | 1.32 | 493 | 515 | 0.96 |
| permission requests/s | 24,158 | 29,159 | 0.83 | 7,082 | 4,702 | 1.51 |
| 20 concurrent sessions, turns/s | 95,391 | 121,446 | 0.79 | 24,911 | 39,649 | 0.63 |
| peak memory while streaming, client / agent, MB | 131 / 111 | 113 / 109 | | 53 / 42 | 57 / 52 | |

The ratio is Subspace ÷ official.

## Summary

**TypeScript.** Subspace and the official SDK are within about 20% of each other on request/response work, and Subspace is ahead on streaming.

- **The official SDK is ahead on plain request/response:** sequential turns by 6%, permission requests by 17%, 20 concurrent sessions by 21%. Most of that is the agent side: with the same client, the official agent is the faster of the two in every scenario except sequential turns from the Subspace client.
- **Subspace is ahead on streaming:** 41% more chunks/s and 32% more MB/s for the same-library pairs. Most of that is the client side: the Subspace client streams about 53% faster than the official client against either agent.

**Python.** The two are even on sequential turns, and Subspace is ahead almost everywhere else.

- **Startup:** Subspace is 2.3× faster (83 against 192 ms), because the official SDK spends about 100 ms importing its models.
- **Streaming and permissions:** Subspace streams 4× faster and answers permission requests 51% faster.
- **Memory:** Subspace uses less in every scenario.
- **Concurrent sessions:** the official SDK still leads, 39,649 against 24,911 turns/s. Both sides contribute. With TS clients, the official Python agent is about 20% faster (40,010–42,507 against 32,662–33,866 turns/s), and the official Python client gets more out of either agent than the Subspace Python client does.

**Across languages.** Against a TypeScript agent, the TypeScript clients get through about 2–5× more turns, chunks or requests per second than the Python clients. Against a Python agent, the agent is the limit and the difference mostly disappears. Python processes use about 40% of the memory.

**Protocol v2** (only Subspace has it in both languages). The TS pair runs 28,117 turns/s and the Python pair 3,628, against 34,041 and 4,963 on v1: a v2 turn has three messages instead of two (the answer, then an idle update). Before #23 the TS pair managed 775 turns/s on v2, because each turn waited for a 1 ms timer (`results/v2-before-setimmediate.json`).

## What to keep in mind

- One machine, loopback pipes, and agents that do no real work. A real agent spends seconds per turn on a model, so the protocol cost per turn only matters for chatty traffic: streaming, many tool calls, many sessions.
- The clients do different amounts of work. The Subspace clients turn every update into typed events with a turn projection and keep the turn's history; the official SDK clients here only concatenate the text. That is what an app gets from each by default, but it is not the same work.
- Startup includes the agent's interpreter start and imports, not only the protocol.
- Memory is peak RSS, read by each process from its own resource usage at exit.
- **Run on an idle machine, and compare changes old against new, alternating.** On a busy machine (load 10–40 during this work) the same cell varied up to tenfold; this run's cells that the fixes do not touch came out within 0.82–1.34× of an earlier run, with a median of 1.04.

## Results, protocol v1

Median of 3 runs per cell (5 for startup). The same-library pairs are in bold.

### Startup: spawn the agent, initialize, session/new, one turn

Rows: client. Columns: agent. Cells: ms from the client's first line, lower is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **82.6** | 99.9 | 83.6 | 182 |
| Official TS | 81.8 | **98.4** | 83.1 | 181 |
| Subspace Py | 85.0 | 99.0 | **82.9** | 180 |
| Official Py | 84.0 | 101 | 84.4 | **192** |

### Startup including the client's own start and close

Rows: client. Columns: agent. Cells: ms for the whole client process, lower is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **168** | 182 | 175 | 287 |
| Official TS | 183 | **200** | 196 | 310 |
| Subspace Py | 185 | 198 | **192** | 306 |
| Official Py | 299 | 312 | 305 | **447** |

### Sequential turns (prompt → end_turn, no updates)

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **34,041** | 31,069 | 12,793 | 8,371 |
| Official TS | 29,668 | **36,391** | 13,038 | 8,487 |
| Subspace Py | 6,954 | 6,892 | **4,963** | 4,069 |
| Official Py | 9,901 | 10,335 | 6,305 | **4,885** |

Latency per turn, same-library pairs (ms): Subspace TS p50 0.021, p99 0.147; Official TS p50 0.021, p99 0.118; Subspace Py p50 0.195, p99 0.379; Official Py p50 0.201, p99 0.252

### Streaming: 20,000 message chunks of 100 characters in one turn

Rows: client. Columns: agent. Cells: chunks/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **372,999** | 402,935 | 105,051 | 22,137 |
| Official TS | 242,033 | **263,656** | 93,241 | 22,310 |
| Subspace Py | 205,379 | 214,589 | **94,595** | 23,097 |
| Official Py | 102,624 | 115,034 | 77,881 | **23,751** |

### Large chunks: 50 chunks of 1,000,000 characters in one turn

Rows: client. Columns: agent. Cells: MB/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **979** | 1,038 | 476 | 556 |
| Official TS | 645 | **743** | 416 | 470 |
| Subspace Py | 747 | 782 | **493** | 533 |
| Official Py | 713 | 684 | 532 | **515** |

### Permission requests: 1,000 asked one after another in one turn

Rows: client. Columns: agent. Cells: requests/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **24,158** | 26,332 | 11,163 | 10,534 |
| Official TS | 25,303 | **29,159** | 11,140 | 10,494 |
| Subspace Py | 12,629 | 12,718 | **7,082** | 6,647 |
| Official Py | 6,972 | 7,267 | 4,831 | **4,702** |

### Concurrent sessions: 20 sessions × 100 turns at once

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **95,391** | 102,039 | 32,662 | 40,010 |
| Official TS | 102,961 | **121,446** | 33,866 | 42,507 |
| Subspace Py | 31,088 | 30,061 | **24,911** | 28,408 |
| Official Py | 50,785 | 50,535 | 31,071 | **39,649** |

### Peak memory in the stream scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 131 | 111 |
| Official TS | 113 | 109 |
| Subspace Py | 53 | 42 |
| Official Py | 57 | 52 |

### Peak memory in the large scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 274 | 138 |
| Official TS | 285 | 149 |
| Subspace Py | 149 | 57 |
| Official Py | 164 | 74 |


## Results, protocol v2 (Subspace only)

Median of 3 runs per cell (5 for startup). The same-library pairs are in bold.

### Startup: spawn the agent, initialize, session/new, one turn

Rows: client. Columns: agent. Cells: ms from the client's first line, lower is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **85.9** | 89.4 |
| Subspace Py | 94.4 | **84.6** |

### Startup including the client's own start and close

Rows: client. Columns: agent. Cells: ms for the whole client process, lower is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **172** | 186 |
| Subspace Py | 210 | **195** |

### Sequential turns (prompt → end_turn, no updates)

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **28,117** | 7,614 |
| Subspace Py | 6,328 | **3,628** |

Latency per turn, same-library pairs (ms): Subspace TS p50 0.026, p99 0.151; Subspace Py p50 0.253, p99 0.569

### Streaming: 20,000 message chunks of 100 characters in one turn

Rows: client. Columns: agent. Cells: chunks/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **383,185** | 108,406 |
| Subspace Py | 155,344 | **94,326** |

### Large chunks: 50 chunks of 1,000,000 characters in one turn

Rows: client. Columns: agent. Cells: MB/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **902** | 471 |
| Subspace Py | 777 | **521** |

### Permission requests: 1,000 asked one after another in one turn

Rows: client. Columns: agent. Cells: requests/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **24,423** | 11,162 |
| Subspace Py | 12,531 | **7,037** |

### Concurrent sessions: 20 sessions × 100 turns at once

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **66,747** | 17,516 |
| Subspace Py | 24,006 | **15,760** |

### Peak memory in the stream scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 130 | 108 |
| Subspace Py | 52 | 44 |

### Peak memory in the large scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 275 | 139 |
| Subspace Py | 151 | 57 |

