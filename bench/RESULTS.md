# Benchmark results

Subspace (TypeScript and Python) against the official ACP SDKs (`@agentclientprotocol/sdk` 2.4.0 and `agent-client-protocol` 1.0.0), run on 2026-11-11 on an Apple M4 (10 cores, 16 GB), macOS 15, Node 26.12.0, Python 3.14.10. How they were run, and how to run them again, is in [README.md](README.md). The raw data is in `results/`.

Every client was run against every agent, each pair in two processes over stdio, on ACP v1 (the only version all four have in common). Each cell is the median of 3 runs (5 for startup).

## Summary

**TypeScript.** Subspace and the official SDK are close, within about a third of each other everywhere.

- The official SDK is ahead on plain request/response work: 37,116 against 30,505 sequential turns/s, 29,388 against 19,863 permission requests/s, and 105,411 against 70,923 turns/s across 20 concurrent sessions.
- Subspace is ahead on streaming, as a client: 338,905 chunks/s for the Subspace pair against 252,044 for the official pair. The Subspace client reaches 447,350 against the official agent.
- Most of the gap is on the agent side. In every row, the official agent is the faster of the two TS agents.

**Python.** The two are even on sequential turns (4,920 and 4,923 turns/s), and each is ahead somewhere else:

- **Subspace is ahead** on permission requests (7,148 against 4,550 requests/s) and on startup. Its agent is up and answering in about 91 ms, against 194 ms for the official SDK, which spends that time importing its models. The Subspace client also streams faster (193,434 against 99,204 chunks/s from a TS agent).
- **The official SDK is ahead** on streaming as an agent (22,962 against 15,634 chunks/s for the same-library pairs), and well ahead on concurrent sessions (37,674 against 8,663 turns/s).
- **The concurrency gap** is the Subspace Python agent. It handles 20 concurrent sessions no faster than one session at a time (about 12,500 turns/s either way, even with a fast TS client), while the official Python agent goes from 8,400 to 40,000. This is the clearest thing to fix.

**Across languages.** Against a TypeScript agent, the TypeScript clients get through about 2–5× more turns, chunks or requests per second than the Python clients. Against a Python agent, the agent is the limit and the difference mostly disappears. Python processes use about a third of the memory (50 against 130 MB in the streaming scenario).

**Protocol v2.** Only Subspace speaks v2 in both languages. The run found a 1 ms delay per turn in the Subspace TS agent: it started each v2 turn with `setTimeout(..., 0)`, and Node waits at least 1 ms for any timer. With `setImmediate` the TS pair went from 775 to 24,449 turns/s, and from 13,317 to 63,992 across 20 sessions (`results/v2-before-setimmediate.json` and `results/v2.json`; the fix is its own change). In Python, a v2 turn costs about a third more than a v1 turn (3,130 against 4,920 turns/s): it has three messages instead of two (the answer, then an idle update).

## What to keep in mind

- One machine, loopback pipes, and agents that do no real work. A real agent spends seconds per turn on a model, so the protocol cost per turn only matters for chatty traffic: streaming, many tool calls, many sessions.
- The clients do different amounts of work. The Subspace clients turn every update into typed events with a turn projection and keep the turn's history; the official SDK clients here only concatenate the text. That is what an app gets from each by default, but it is not the same work.
- Startup includes the agent's interpreter start and imports, not only the protocol.
- Memory is peak RSS, read by each process from its own resource usage at exit.

## Results, protocol v1

Median of 3 runs per cell (5 for startup). The same-library pairs are in bold.

### Startup: spawn the agent, initialize, session/new, one turn

Rows: client. Columns: agent. Cells: ms from the client's first line, lower is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **97.0** | 110 | 93.6 | 210 |
| Official TS | 94.5 | **106** | 93.0 | 208 |
| Subspace Py | 91.4 | 111 | **90.9** | 199 |
| Official Py | 88.9 | 115 | 88.9 | **194** |

### Startup including the client's own start and close

Rows: client. Columns: agent. Cells: ms for the whole client process, lower is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **192** | 201 | 199 | 338 |
| Official TS | 210 | **214** | 216 | 350 |
| Subspace Py | 203 | 221 | **215** | 346 |
| Official Py | 322 | 354 | 332 | **465** |

### Sequential turns (prompt → end_turn, no updates)

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **30,505** | 31,202 | 13,129 | 8,202 |
| Official TS | 36,022 | **37,116** | 12,718 | 8,402 |
| Subspace Py | 6,905 | 6,600 | **4,920** | 4,018 |
| Official Py | 9,517 | 10,038 | 6,356 | **4,923** |

Latency per turn, same-library pairs (ms): Subspace TS p50 0.024, p99 0.169; Official TS p50 0.021, p99 0.104; Subspace Py p50 0.196, p99 0.393; Official Py p50 0.198, p99 0.253

### Streaming: 20,000 message chunks of 100 characters in one turn

Rows: client. Columns: agent. Cells: chunks/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **338,905** | 447,350 | 16,649 | 21,601 |
| Official TS | 233,844 | **252,044** | 15,847 | 21,629 |
| Subspace Py | 193,434 | 205,157 | **15,634** | 22,738 |
| Official Py | 99,204 | 111,687 | 16,114 | **22,962** |

### Large chunks: 50 chunks of 1,000,000 characters in one turn

Rows: client. Columns: agent. Cells: MB/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **781** | 950 | 441 | 510 |
| Official TS | 675 | **703** | 388 | 450 |
| Subspace Py | 699 | 649 | **497** | 464 |
| Official Py | 651 | 683 | 488 | **490** |

### Permission requests: 1,000 asked one after another in one turn

Rows: client. Columns: agent. Cells: requests/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **19,863** | 26,016 | 11,127 | 10,116 |
| Official TS | 24,428 | **29,388** | 11,527 | 10,464 |
| Subspace Py | 11,864 | 12,517 | **7,148** | 6,623 |
| Official Py | 6,788 | 7,129 | 4,726 | **4,550** |

### Concurrent sessions: 20 sessions × 100 turns at once

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Official TS | Subspace Py | Official Py |
| --- | ---: | ---: | ---: | ---: |
| Subspace TS | **70,923** | 89,759 | 12,493 | 38,891 |
| Official TS | 88,169 | **105,411** | 12,525 | 39,982 |
| Subspace Py | 27,219 | 28,229 | **8,663** | 26,477 |
| Official Py | 42,365 | 41,577 | 10,881 | **37,674** |

### Peak memory in the stream scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 130 | 108 |
| Official TS | 113 | 109 |
| Subspace Py | 50 | 38 |
| Official Py | 58 | 53 |

### Peak memory in the large scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 273 | 148 |
| Official TS | 294 | 149 |
| Subspace Py | 152 | 56 |
| Official Py | 165 | 73 |


## Results, protocol v2 (Subspace only, after the setImmediate fix)

Median of 3 runs per cell (5 for startup). The same-library pairs are in bold.

### Startup: spawn the agent, initialize, session/new, one turn

Rows: client. Columns: agent. Cells: ms from the client's first line, lower is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **90.9** | 90.5 |
| Subspace Py | 90.5 | **86.6** |

### Startup including the client's own start and close

Rows: client. Columns: agent. Cells: ms for the whole client process, lower is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **182** | 195 |
| Subspace Py | 200 | **205** |

### Sequential turns (prompt → end_turn, no updates)

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **24,449** | 4,859 |
| Subspace Py | 6,288 | **3,130** |

Latency per turn, same-library pairs (ms): Subspace TS p50 0.029, p99 0.183; Subspace Py p50 0.308, p99 0.539

### Streaming: 20,000 message chunks of 100 characters in one turn

Rows: client. Columns: agent. Cells: chunks/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **359,312** | 15,804 |
| Subspace Py | 193,274 | **15,541** |

### Large chunks: 50 chunks of 1,000,000 characters in one turn

Rows: client. Columns: agent. Cells: MB/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **641** | 423 |
| Subspace Py | 548 | **423** |

### Permission requests: 1,000 asked one after another in one turn

Rows: client. Columns: agent. Cells: requests/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **18,996** | 10,496 |
| Subspace Py | 11,830 | **6,881** |

### Concurrent sessions: 20 sessions × 100 turns at once

Rows: client. Columns: agent. Cells: turns/s, higher is better.

| client ↓ / agent → | Subspace TS | Subspace Py |
| --- | ---: | ---: |
| Subspace TS | **63,992** | 4,884 |
| Subspace Py | 22,295 | **5,192** |

### Peak memory in the stream scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 131 | 104 |
| Subspace Py | 51 | 38 |

### Peak memory in the large scenario (MB RSS)

Same-library pairs; the client and the agent are separate processes.

| library | client | agent |
| --- | ---: | ---: |
| Subspace TS | 1114 | 140 |
| Subspace Py | 1370 | 58 |

