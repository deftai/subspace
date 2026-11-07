# @deft-subspace/acp-testkit (experiment)

Test ACP agents and clients. Everything uses the kernel's trace format (`@deft-subspace/kernel` `trace.ts`: a header, then `{ t, dir, msg }` records, as JSON Lines).

| What | API |
|---|---|
| Record | `recorder()` gives a `tap` for `RpcPeer`/`AcpClient`; `tapChannel()` records any channel; `recordAgent()` (`./node`) records a real agent started with `connectAgent`. `replaceStrings()` redacts paths. |
| Replay | `replayAgent(channel, trace)` plays the agent side of a trace to a live client. It remaps ids, matches client calls by method in order, tolerates different params, and rejects `done` with a `ReplayDivergence` (expected vs got) instead of hanging. |
| Faults | `faultChannel(channel, { read, write })` with `delay`, `disconnectAfter`, `closeWhen(isUpdate(...))`, and for bytes `rechunk`, `merge`, `coalesce`, `injectLines`. |
| Conformance | `checkAgent(channel)` drives any agent; `checkClient(connect)` plays the agent against any client (`acpClientDriver()` for ours). Both return `[{ id, title, pass, skipped?, detail }]`; see `formatReport`. `checkAgentProcess()` (`./node`) starts a program and checks it. |
| Corpus | `corpus/*.trace.jsonl`: real agents' traces. `test/corpus.test.ts` replays each to `AcpClient` and compares the normalized `TurnResult` with the one recorded live (`meta.expected` in the header). |

## Recording more of the corpus

`scripts/record.ts` runs one turn against a real agent and saves `corpus/<name>.trace.jsonl`. The temp workspace and the home directory are replaced with `/workspace` and `~`. Check a new trace for anything private before committing it.

```bash
cd packages/testkit
# Plain turn
node --conditions=source scripts/record.ts claude-plain npx -y @agentclientprotocol/claude-agent-acp
# A write the reject policy refuses
PROMPT="Create a file named hello.txt containing the word hi." \
  node --conditions=source scripts/record.ts claude-write-rejected npx -y @agentclientprotocol/claude-agent-acp
# Cancel mid-stream, 300 ms after the first message
PROMPT="Count from 1 to 300, one number per line. Do not use any tools." CANCEL_AFTER_MS=300 \
  node --conditions=source scripts/record.ts claude-cancel npx -y @agentclientprotocol/claude-agent-acp
# Codex: the same, with npx -y @zed-industries/codex-acp (or the adapter you use)
```

`PERMISSIONS=allow` allows instead of rejecting. The corpus test picks up new files on its own.

To run the conformance checks against a real agent (each prompt check is one model turn; `ONLY` limits them):

```bash
ONLY=initialize.version,session.new,session.unknown node --conditions=source scripts/check-agent.ts grok --permission-mode default agent stdio
```

## Known quirks (Grok Build, recorded 2026-11-07)

- A write rejected by the permission policy ends the turn with `stopReason: "cancelled"`, though the client did not cancel (`grok-write-rejected`).
- A prompt for an unknown session is answered `-32602 Invalid params`, not `-32002` (seen with `checkAgent`; not in a trace).
- Many `_x.ai/*` extension notifications arrive around `session/new` and each turn; the client ignores them.
