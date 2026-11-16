# deft-subspace-acp-testkit

Test [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agents and clients, written with Subspace or not. Part of [Deft Subspace for Python](https://github.com/deftai/subspace/tree/main/python), a port of the TypeScript `@deft-subspace/acp-testkit`.

- **Record and replay:** `recorder()`, `tap_channel()` and `record_agent()` keep a connection as a trace; `replay_agent()` plays the agent's side back to a live client and raises a `ReplayDivergence` (expected vs got) instead of hanging.
- **Faults:** `fault_channel()` with `delay`, `disconnect_after`, `close_when(is_update(...))`, and for bytes `rechunk`, `merge`, `coalesce`, `inject_lines`.
- **Conformance:** `check_agent()` drives any agent; `check_client()` plays the agent against any client. `check_agent_process()` starts a program and checks it.
- **Scenarios:** `run_scenario()` runs a JSON scenario (the same files as the TypeScript testkit) and checks each turn.

```python
from deft_subspace.acp import serve_agent
from deft_subspace.acp_testkit import check_agent, failures, format_report
from deft_subspace.kernel import channel_pair

agent_end, checker_end = channel_pair()
serve_agent(agent_end, name="under-test", prompt=my_prompt_handler)
report = await check_agent(checker_end, permission_prompt=None)
print(format_report(report))
assert not failures(report)
```

Traces are the same JSON Lines format as the TypeScript packages, so a trace recorded by one replays in the other.

MIT licensed.
