# Changelog

## Unreleased

- `serve_agent`: with `queue_prompts` on v2, a turn's idle state (and its failed tool calls) now goes out before the next queued turn starts.
- `serve_agent`: a prompt handler that raises now fails the tool calls it left open and stops the terminals it did not detach, as a cancelled turn already did.
- `serve_agent`: a prompt handler that ends with `asyncio.CancelledError` after the turn was cancelled (e.g. it cancelled its own task when `turn.signal` fired) now ends the turn `cancelled`: v1 answers `stopReason: "cancelled"` instead of a -32800 error, and v2 sends its idle state.
- `serve_agent`: a `new_session` that returns the id of a session that is already open is now refused with -32602; before, the open session was replaced and its turn, background work and MCP connections leaked.
- `AbortSignal.any(...)`: the combined signal can now be `dispose()`d (or used as a context manager) to remove its listeners from the source signals; before, they stayed until a source fired.
- `serve_agent`: a finished turn no longer leaves a listener on the connection's signal (one leaked per turn), and a finished tool call or terminal no longer leaves one on its turn's signal; MCP-over-ACP requests no longer leave one on their server's signal.
- `model_agent`: results of tool calls that ran when a turn hit `max_steps` or was cancelled are no longer dropped: they go to the model with the next prompt, as `PromptInput.tool_results` (new field, default empty).
- `serve_agent(connection_closed=...)`: new optional hook, called with the ids of the sessions still open when the connection closes (`close_session` is still not called for them). `model_agent` uses it to drop those sessions' conversations, which it kept forever before.
- `serve_agent`: on v1, `capabilities={"sessionCapabilities": ..., "mcpCapabilities": ...}` now merge into the advertised ones (as on v2) instead of replacing them, so `close` and `resume` are no longer dropped.
- `serve_agent`: a second `initialize` on a connection is now refused with -32600 (Invalid Request); before, it could switch the protocol mid-connection.
- `AgentTurn.elicit`: an error answer from the client now raises instead of answering `cancel`; only a cancelled turn or a closed connection answers `cancel`.
- `AgentTurn.tool_call(status="completed"|"failed"|"cancelled")` is no longer tracked as open (it was failed again when the turn was cancelled or raised), and `tool_call_update` now keeps v2 background work in step: a create is tracked, and a final status finishes it (a cancellable call finished this way no longer accepts `tool_call/cancel`).
- MCP connections of a session: `session/close`, new servers from load or resume, and a closed connection now abort an MCP connect still in flight (through `McpConnectContext.signal`) instead of waiting for it, up to the connect timeout.
