Every benchmark agent speaks ACP v1 over stdio and reads the prompt text as a command:

- `noop`: end the turn at once (`end_turn`).
- `stream N SIZE`: send N `agent_message_chunk` updates of SIZE characters each, then end the turn.
- `ask N`: ask permission N times, one after another, then end the turn.

On exit, if `BENCH_RSS_FILE` is set, the agent writes its peak resident set size in bytes to that file.
