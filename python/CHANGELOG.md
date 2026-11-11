# Changelog

## Unreleased

- A turn ended by the client after the cancel grace period now drains: queued prompts wait until the agent confirms the old turn (v1: its prompt answer; v2: its idle), for at most twice `cancel_grace_ms`, and its late updates go to the session (`on_idle_update`, `tool_calls`) instead of the next turn. `busy` is False while it drains; a prompt sent then is queued.
- After that drain, the old `session/prompt` request is given up on (`$/cancel_request`) instead of staying pending forever.
- `Session.cancel()` arms the cancel deadline before telling the agent, and tells it in the session's own task: cancelling the caller while it waits no longer leaves the turn without a deadline.
- A tool call id the agent reuses in a later turn belongs to that turn; only background work is routed to earlier turns.
- A client-wide `on_question` answers questions between turns and questions that name no session (they were declined).
- A turn handler that raises `CancelledError`, or a handler task that is cancelled, fails the turn with `RuntimeError("A turn handler was cancelled")`; the turn used to report success.
- Updates for a session closed here are dropped, so a later `load_session` of it no longer replays them.
- `session.modes` is replaced on every change instead of being changed in place.
- `Session.close()` ignores any error from `session/close`, not only RPC and local errors.
