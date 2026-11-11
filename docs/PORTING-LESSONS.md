# Porting Subspace: lessons learned

A journal from porting `@deft-subspace/kernel` and `@deft-subspace/acp` from
TypeScript to Python (`python/`, released as `deft-subspace-kernel` and
`deft-subspace-acp`). It is written for whoever ports Subspace next, to
Rust, Java, C++ or anything else: what was hard, what broke, what we would
do again, and what we would do first.

The Journal at the end gets new entries, dated, as we learn more.

## How to read this

- **General lessons** apply to any target language.
- **TypeScript → Python** records how each TS concept was mapped, with the
  traps we hit. Most traps have a counterpart in other languages; the
  per-language notes at the end say which, as predictions, not experience.
- **Checklist** is the short version: what to do, in order.

## General lessons

### Process

1. **Port behaviour, not code.** The TS sources are the spec, but the tests
   are the better spec. Port the test suite alongside each module and keep
   test names close to the TS ones, so a failing case can be found on both
   sides.
2. **Start with the kernel, then acp, and stop there for the first pass.**
   The kernel (channels, NDJSON framing, the JSON-RPC peer, abort signals,
   traces, supervised processes) is small, has no ACP knowledge, and every
   other layer sits on it. A working kernel with its tests is the base for
   everything else. The testkit, devtools, the CLI, the Claude adapter and
   `create-subspace` were left for later.
3. **Use the official SDK's protocol types, keep plain data on the wire.**
   The TS port takes its types from `@agentclientprotocol/sdk`; the Python
   port takes its from the official `agent-client-protocol` package
   (pydantic models for v1 and v2). Messages travel as plain dicts; the SDK
   schemas are loaded lazily, used for validation and types, never for
   every message. This keeps unknown fields and extensions intact and
   avoids a parse/serialise round trip per message.
4. **Porting is a code review of the original.** Writing the same thing a
   second time found real bugs in the TS port, fixed in both:
   - `setMode` and `setConfigOption` called back to back could reach the
     agent out of order (now serialised per session);
   - the agent catalog was loaded with blocking file calls on the event
     loop (now `loadCatalogAsync`);
   - a `file://` URI was turned into a path by string slicing, wrong on
     Windows (now `url2pathname` in Python, the equivalent in TS).

   Keep a list of "looks wrong in the original" while porting, and fix
   those in both ports in their own PR.
5. **Test against real agents early.** Unit tests and the official SDK's
   example agents agreed with us; real agents still taught us things (see
   Agent quirks). We ran the same 11 scenarios against three real agents
   over both protocol versions: a plain turn, refused and allowed writes, a
   read, a shell command, cancel, a turn after cancel, an MCP server over
   stdio, MCP over ACP, list sessions, load or resume, and memory after
   reopening.
6. **An audit after the port pays.** A deep audit of both ports, after the
   Python one was merged, found many defects, most of them shared by both
   ports because the Python one followed the TS one faithfully. Expect the
   new port to copy the original's bugs; plan an audit pass for both.
7. **Keep fixtures shared.** Trace files, the registry snapshot and the
   agent fixtures are the same data on both sides. A trace written by one
   port must parse in the other.

### Protocol semantics that are easy to get wrong

These are language-independent; each one bit us at least once.

- **Absent is not null.** JavaScript has `undefined` (left out of JSON) and
  `null` (written as `null`). Python has only `None`. `notify()` with no
  params sent `"params": null` in Python, while TS left `params` out. Use a
  private sentinel for "not given" wherever the TS code tests for
  `undefined`, and decide per field whether `None` means "absent" or
  "null". Rust (`Option` plus `#[serde(skip_serializing_if)]`), Java and
  C++ need the same decision.
- **A message that cannot be encoded must fail loudly.** A datetime, a
  cycle or NaN in a message made the encoder raise inside the writer, and
  the message just vanished: the request hung forever. Now encoding errors
  fail the request (`send-failed`), `notify()` raises, and a handler whose
  answer cannot be encoded replies with an internal error. Later messages
  still go out.
- **Strip a UTF-8 BOM** at the start of an NDJSON stream. Some Windows
  tools write one.
- **Ending is not closing.** When the other side ends its stream, requests
  it already sent may still deserve answers (`printf '{"id":1,...}\n' |
  agent` must get its reply). The peer drains: no more reading, outbound
  requests fail with `closed`, handlers already running may answer for up
  to `drain_timeout_ms`, then it closes. Model the states explicitly:
  `idle`, `open`, `draining`, `closed`.
- **A stuck writer must not hold `close()` forever.** If queued writes are
  still stuck a second into `close()`, fail them and abort the channel.
- **Turns have more states than "running" and "done".** A cancelled turn
  that the agent has not confirmed yet is neither. After the cancel grace
  period the client ends the turn itself, but the agent's late answer (v1:
  its prompt response; v2: its idle update) must not land in the next turn.
  The port now has an explicit draining state: queued prompts wait for the
  confirmation (bounded), and late updates go to the session, not the next
  turn.
- **Arm the deadline before you send the cancel.** If the cancel is sent
  first and the caller is cancelled while it waits for the send, the turn
  is left with no deadline at all.
- **Tool call ids may be reused across turns.** A reused id belongs to the
  new turn; only background work is routed to earlier turns.
- **Never replace an open session.** An agent's `new_session` that returns
  an id already open must be refused, or the old session's turn,
  background work and MCP processes leak.
- **A second `initialize` must be refused**, or the protocol version can
  change mid-connection.
- **Merge, don't replace, advertised capabilities.** Options that add
  capabilities on v1 replaced the defaults and dropped `close` and
  `resume`.
- **Clean up on every path.** A part failing to disconnect must not stop
  the others, or the connection-level hook. Collect errors, finish the
  cleanup, then raise the first.

### Resource use

The TS port was written for clarity first, and both ports had the same
memory and time blowups, found by the audit with synthetic stress tests:

- **Terminal output rebuilt per chunk:** a turn's events each held a full
  copy of the output so far (4 MB of output kept 878 MB in TS, 883 MB in
  Python). Now output is append-only segments; a snapshot is a view, joined
  only when read.
- **Message text per event:** each message event carried the whole message
  so far (40k chunks kept 4 GB). Now the text is read from the message's
  log the first time it is looked at, then kept.
- **Tool call snapshots copied their content list** (20k chunks: 1.6 GB).
  Now a snapshot copies on first read.
- **History**: a turn keeping every event is the default, but long turns
  need `history=<n>` or `"none"`.

Write a stress test per hot path (many small chunks, long turns) before
optimising, and keep it in the suite.

### Testing

- **Make timing tests event-driven.** Tests that waited a fixed number of
  event-loop ticks or milliseconds were flaky under load and on Windows.
  Wait for the event itself (a promise, a future, a condition), with a
  generous timeout only as a safety net. Stress-run the suite in a loop
  before trusting it.
- **CI on Linux, macOS and Windows, oldest and newest runtime.** The Python
  job runs 3.11, 3.13 and 3.14 on all three. Many Windows-only bugs (below)
  would have shipped without it.
- **A clean-install smoke test.** Build the packages, install them into a
  fresh environment outside the repo, run a small script with the
  interpreter isolated (`python -I`), so nothing from the source tree is
  picked up by accident.
- **Interop tests against the official SDK.** Our client against SDK
  agents, our agent against the SDK client, v1 and v2. These are cheap and
  catch wire-format drift.
- **Benchmark against the official SDKs, every client against every agent**
  (`bench/`). A 4×4 matrix tells client cost from agent cost: a slow cell in
  one column is the agent, in one row the client. Benchmark both protocol
  versions: our own pairs negotiated v2 and hid a v2-only delay until we
  forced v1 for the comparison.
- **Check the benchmark before the library.** Two of our "findings" were the
  benchmark's own bugs: a warm-up sized like the scenario (200 MB pushed
  through each client before a 50 MB test), and an SDK that starts agents
  with a trimmed environment, so a variable we relied on never arrived.

### Reviews

Automated reviewers flagged many things; most high-confidence "P1"s were
false positives, so verify each against the code before changing anything:

- text inside docstrings read as code ("called before it is defined");
- a method reported as removed that had moved to another module;
- a deliberate module-level loop reported as lost indentation;
- non-null assertions on child process streams that are always piped.

The real findings were narrow and concrete: a relative `.cmd` path resolved
against the wrong folder, a `__proto__` key lost when copying JSON, an
error reply counted as a pass, cleanup skipped after one failure. Reply on
the PR with a short triage of each finding, fixed or not and why.

### Agent quirks (as of 2026-11)

Found by running real agents; recorded in the agent catalog's quirks where
the library can work around them.

- **Codex (`codex-acp` 2.5.0)**: in its `read-only` mode it cancels MCP tool
  calls itself. Use `mode="agent"` when the turn needs MCP tools. Quirk
  `mcp-calls-cancelled-in-read-only`.
- **Grok Build (1.0.77, v1)** sends no `agentInfo`.
- **None of the three agents tested advertises MCP over ACP**, so that path
  is only covered by unit and interop tests.
- **Agents differ on refusals:** a refused write ended one agent's turn as
  `refused`/`cancelled`, while another completed the turn and explained
  the refusal in text. Tests and apps must accept both.

### Packaging and release

- **Two distributions, one namespace.** `deft_subspace` is a PEP 420
  namespace package shared by `deft-subspace-kernel` and
  `deft-subspace-acp` (no `__init__.py` at the namespace level). acp pins
  the kernel to the exact same version; both are always released together.
  Rust crates, Maven artifacts or CMake packages should follow the same
  split: a kernel with no ACP knowledge, and acp on top.
- **Script the version.** `scripts/set_version.py` sets every version and
  the pin; `scripts/check_versions.py` fails CI (and the release) if they
  disagree or do not match the tag.
- **Publish from CI with trusted publishing** (OIDC, no stored tokens),
  from a protected environment that needs a reviewer, triggered by a
  `python-v*` tag. Pin every third-party action to a commit SHA.
- **Mark the package typed** (`py.typed`), give each distribution its own
  README and LICENSE, and keep dependency ranges bounded above (`<2`).

## TypeScript → Python

### Runtime model

| TypeScript | Python | Notes |
| --- | --- | --- |
| `Promise`, `async`/`await` | `asyncio` coroutines, tasks, futures | A coroutine does nothing until awaited or wrapped in a task; a TS promise starts at once. |
| `AbortController` / `AbortSignal` | own `AbortController` / `AbortSignal` in the kernel | Same API shape as the Web one, so ported code reads alike. |
| `AbortSignal.any()` | `AbortSignal.any()` returning a disposable signal | Must remove its listeners from the sources when disposed, or every turn leaks one. |
| microtask ordering | eager tasks (3.12+) | See below. |
| `EventEmitter`, callbacks | plain callbacks and `asyncio.Queue` | |
| `Buffer` | `bytes` / `bytearray` | |
| `undefined` vs `null` | sentinel object vs `None` | See "Absent is not null". |

### Cancellation is the biggest difference

JavaScript has no task cancellation: a promise runs to completion, and
cancellation is cooperative through `AbortSignal`. Python's asyncio injects
`CancelledError` into the task at its next `await`. That changes a lot:

- **`CancelledError` is a `BaseException`, not an `Exception`.** `except
  Exception` does not catch it, which is usually right. But a turn handler
  that raised `CancelledError` was reported as a success; now it fails the
  turn, or ends it `cancelled` if the turn was in fact cancelled.
- **Cancelling a waiter cancels what it awaits.** `await
  asyncio.wait_for(proc.exited, 5)` cancelled the process's own exit
  watcher on timeout. Shield shared futures (`asyncio.shield`) and hand out
  a new shield on each access.
- **Do not swallow your caller's cancellation.** `close()` that catches
  `CancelledError` while it waits for a reader hides the cancel from the
  task that asked for it. Re-raise it when the current task is the one
  being cancelled.
- **Do work in the task that owns it.** A cancel sent from the caller's
  task can be lost if the caller is cancelled mid-send; send it from the
  session's own task.
- **`SystemExit` and `KeyboardInterrupt` must propagate**, not become an
  internal-error reply.

Rust (dropping a future cancels it at any `.await`) is closer to Python
than to JS here; Java and C++ are closer to JS (cooperative), with their own
interruption rules.

### Ordering and the event loop

- **`setTimeout(fn, 0)` is not "next tick" in Node.** Node waits at least
  1 ms for any timer. The TS agent started every v2 turn that way, adding
  1 ms per turn (775 turns/s instead of 24,449). Use `setImmediate` (or
  `queueMicrotask` when order allows); Python's `loop.call_soon` has no such
  floor. Look for the same thing in any port: a "yield to the loop" that is
  really a timer.

- **Message order is a contract.** Writes go through one writer task fed
  by a queue, so messages leave in the order they were sent, whole, even
  when callers are cancelled.
- **Eager tasks on 3.12+** start a task synchronously up to its first
  `await`, like a JS promise executor. The RPC peer uses them for the
  writer and request handlers: about 2× faster round trips. A loop with a
  custom task factory gets normal tasks from that factory (eager tasks
  would bypass it).
- **Once a handler closes the peer, dispatch nothing more**, not even
  messages already buffered.
- **Never block the event loop.** File checks (`realpath`, `lstat`), file
  reads and writes, catalog loading and trace writes run in a thread
  (`asyncio.to_thread`) or are batched. A stdio writer thread does the
  writes, in order, with one flush per batch.

### Speed

The first Python RPC peer was about 40× slower than the TS one per round
trip. What helped: the single writer task that runs only while something is
queued, skipping the middleware runner when there is none, eager tasks,
copying traced messages directly instead of `copy.deepcopy`, one sender
task for hooked notifications instead of a task per notification (15k/s to
137k/s), and lazy fields instead of copies (above). Measure before and
after each change; keep the benchmark script.

### Types and tools

- **pyright in standard mode** caught real bugs. Typical fights:
  `Protocol` variance for transforms; `TypedDict` key access; a function
  typed `Never` that callers tried to await.
- **Platform checks must be literal** (`sys.platform == "win32"`) for
  pyright to narrow them; `os.killpg` does not exist on Windows.
- **Frozen dataclasses with lazy fields:** a descriptor on the class reads
  the value the first time and stores it. `==`, `asdict()`, `replace()`,
  pickling and `deepcopy()` must keep working; test each.
- **pydantic models from the SDK** are good for validation, too heavy per
  message. Load them lazily.

### Windows

Windows found the most bugs, almost all in process handling.

- **`.cmd` and `.bat` files** (like `npx.cmd`) can only start through
  `cmd.exe`, and their arguments must be escaped as Rust's std does since
  CVE-2024-24576 ("BatBadBut"): quote, double the quotes, defuse `%`, run
  `cmd.exe /d /e:ON /v:OFF /s /c`, and refuse CR, LF and NUL. Python's
  `subprocess` quotes arguments itself, so the port builds the command line
  and hands it to asyncio's private `loop._make_subprocess_transport`; a
  test fails loudly if a Python release changes it.
- **Find the command as Windows would:** PATH and PATHEXT, a name that
  already has a known extension, and a relative path resolved against the
  child's `cwd`, not the parent's folder.
- **No process groups to signal.** Stop a child and everything it started
  with `taskkill /T` (without `/F`, then with `/F` after the grace period),
  or a `.cmd` launch's program, a child of `cmd.exe`, survives and keeps
  stdout open.
- **Text mode translates newlines.** `write_text` wrote `\r\n`; tests that
  compare bytes must write bytes.
- **No `/tmp`.** Use the test framework's temporary directory.
- **`file://` URIs**: use the platform's URL-to-path conversion
  (`url2pathname`), not string slicing; mind UNC hosts.
- **Test on a real Windows machine too**, not only CI: run the suite as a
  normal (non-elevated) user, and try a real `.cmd` launch and tree kill.

### Processes (all platforms)

- **On POSIX, give the child its own process group** (a new session), so
  stopping it stops what it started (`npx foo` runs `foo` as a grandchild).
- **"Ended" means exited and stdout closed**, so a last reply written just
  before exit is still read.
- **Stop SIGTERM/SIGHUP from leaving orphans:** on those signals, stop live
  process groups before dying, but only if the app has no handler of its
  own.
- **Forget a process group once its last member is gone**, or a reused
  group id is killed at exit.
- **Count the stderr tail in bytes, not characters**, and drop a character
  cut in half at the start.

### MCP

- **stdio MCP servers are native:** a kernel peer plus the `initialize`
  handshake. No MCP SDK needed.
- **http and sse go through the MCP SDK** (an optional `mcp` extra). Its
  client must be entered and exited in the same task (anyio cancel
  scopes), so one owner task holds it open and requests go to that task.
- **Pass params through unchanged**: a request params model with
  `extra="allow"`, so fields the SDK does not know survive.
- **Don't import private SDK helpers.** The SDK's HTTP client factory is
  private; the port builds its own HTTP client with explicit timeouts
  (30 s, 300 s for reads).
- **Infer stdio only when `type` is missing**, never when it is some other
  value.

## Checklist for the next port

1. Read `GUIDE.md`, this file and the TS kernel tests.
2. Pick the protocol types source: the official ACP SDK for the language if
   there is one; generate from the ACP JSON schema if not.
3. Decide the async model and the cancellation story first (see
   Cancellation). Write `AbortSignal` (with disposable `any()`), the
   channel, and the NDJSON framing with their tests.
4. Port `RpcPeer` with the explicit states, the single ordered writer,
   draining, encode-error handling and `$/cancel_request`. Run the TS RPC
   tests' cases.
5. Port supervised processes, with Windows `.cmd` launching, PATHEXT and
   `cwd` resolution, and tree kill from day one. Get Windows CI before
   anything else depends on it.
6. Port acp: model, projection, turns (with draining), client, then agent
   and the endpoint layers. Keep plain data on the wire.
7. Add interop tests against the official SDK, v1 and v2.
8. Run the real-agent scenarios. Record quirks in the catalog.
9. Run the stress tests for terminal output, message text and tool call
   content; measure RPC round trips against the TS port.
10. Package: kernel and acp as separate artifacts at one version, a
    version-check script, a clean-install smoke test, tag-triggered
    publishing from CI.

## Notes for specific targets

Predictions from the Python experience, to be replaced by real notes.

- **Rust**: dropping a future cancels it at any `.await`, so the
  Cancellation section applies almost word for word (use `tokio::select!`
  with care, and guards for cleanup). `serde` needs the absent-vs-null
  decision per field. Process groups: `nix`; Windows `.cmd` escaping is
  already in std's `Command` (that is where the BatBadBut fix comes from).
  Two crates: kernel and acp.
- **Java**: virtual threads or `CompletableFuture`; cancellation is
  cooperative, as in TS. Jackson must be told to omit absent fields
  (`Include.NON_ABSENT` with `Optional`). `ProcessBuilder` does not escape
  for `cmd.exe`: port the escaping. `ProcessHandle.descendants()` helps
  with tree kill.
- **C++**: pick one async model (Asio, or coroutines on top of it) and one
  JSON library that keeps the absent/null distinction (nlohmann's
  `contains` vs `is_null`). All of the Windows process handling is yours;
  consider Job Objects for tree kill.

## Journal

### 2026-11-10: kernel and acp ported

Kernel and acp ported to Python 3.11+ with plain asyncio, client and agent
sides, using the official `agent-client-protocol` types. Interop tests
against the official SDK agents pass on v1 and v2. MCP servers over http
and sse added through the MCP SDK. Porting found three TS bugs (config
order, blocking catalog load, `file://` paths on Windows), fixed in both
ports.

### 2026-11-11: real agents

The 11 scenarios passed against Grok Build 1.0.77 (v1), claude-agent-acp
0.101.0 (v2) and codex-acp 2.5.0 (v2), after one fix: Codex cancels MCP tool
calls in read-only mode, now a catalog quirk.

### 2026-11-11: audit, publishing prep, 0.1.0a1

A deep audit of both ports found defects in turn states, cancellation,
process handling on Windows, memory use and RPC speed; all fixed in both
ports with tests (python/CHANGELOG.md lists the Python ones). Review bots
on the fix PR were mostly false positives; four real findings fixed. The
packages are ready for PyPI as 0.1.0a1, not yet published.

### 2026-11-11: benchmarks against the official SDKs

`bench/` runs every client against every agent across Subspace TS, Subspace
Python and the official TS and Python SDKs (results in `bench/RESULTS.md`).
In TypeScript, Subspace and the official SDK are within about a third of
each other; Subspace streams faster as a client, and the official agent is
faster at plain request/response. In Python the two are even on turns, and
Subspace starts twice as fast and answers permissions faster. But the
Subspace Python agent does not gain from concurrent sessions (about 12,500
turns/s with one session or twenty, against 8,400 → 40,000 for the official
agent), the clearest thing to fix next. The run also found the 1 ms
`setTimeout` delay per v2 turn in the TS agent.
