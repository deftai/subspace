# Changelog

## Unreleased

- kernel: `notify()` without params leaves `params` out of the message instead of sending `"params": null`.
- kernel: a handler that raises a `BaseException` that is not an `Exception` (`SystemExit`, `KeyboardInterrupt`) is no longer answered with an internal error; it propagates.
- kernel: the NDJSON decoder skips a UTF-8 byte order mark at the start of the stream.
- kernel: a message that cannot be encoded as JSON (a datetime, a cycle, NaN) no longer vanishes. `NdjsonEncoder.feed()` raises the new `EncodeError` (a `ValueError`) after calling `on_error`; a request fails with `LocalError("send-failed")`, `notify()` raises, and a handler whose answer cannot be encoded replies with an internal error. Later messages still go out.
- kernel: a failed write of an answer is reported as a new `send-failed` diagnostic, not `handler-failed`, and no second answer is attempted.
- kernel: a `cancel_inbound.id` extractor that raises is reported as `invalid-message` instead of closing the connection.
- kernel: `start()` after `close()` does nothing.
- kernel: when the other side ends its stream, `RpcPeer` drains instead of closing at once: outbound requests fail with `closed` and nothing more is read, but request handlers already running may answer for up to `drain_timeout_ms` (new option, default 1000; 0 is the old behaviour) before they are aborted and the peer closes. So `printf '{"id":1,"method":"x"}\n' | agent` gets its answer. `closed`, `on_close` and `is_closed` follow once the drain ends. New `RpcPeer.state`: `idle`, `open`, `draining` or `closed`.
- kernel: when queued writes are still stuck 1 s into `close()`, the peer cancels its writer task, fails those writes with `closed` and aborts the channel. Channels may have an `abort()` (`StreamChannel` aborts its transport); without one, `close()` is called.
- kernel: `TraceTap.note(text, None)` records `"data": null`, as the TypeScript tap does; leave `data` out for a note without data.
- kernel: `MemoryChannel.receive()` may be awaited by several tasks at once; each gets its own item.
- kernel: `SupervisedProcess.exited` and `stop()` return shielded awaitables, so cancelling a wait (e.g. `asyncio.wait_for`) no longer cancels the process's own exit watcher or its stop: a timed-out `stop()` still sends SIGKILL after the grace period, and later calls still work. They are `asyncio.Future`s now, not `asyncio.Task`s.
- kernel: `SupervisedProcess.ended()` settles once the process has exited and its stdout pipe has closed, whether or not anyone read stdout to the end (it hung after `RpcPeer.close()` cancelled the reader). Unread output is still there to read.
- kernel: on POSIX, SIGTERM and SIGHUP now stop live supervised process groups before the process dies of the signal, while groups are alive and only if the app has no handler of its own for that signal (installed from the main thread only).
- kernel: a process group is dropped from the exit-time kill list once its last member is gone, not only if it was gone when its leader exited, so a reused group id is never killed at exit.
- kernel: `stderr_tail_bytes` counts bytes, not characters; a character cut in half at the start of the tail is dropped.
- kernel: on Windows, a command found through PATH and PATHEXT as a `.cmd`/`.bat` file (like `npx.cmd`) is run through cmd.exe with its arguments escaped; the not-found hint mentions .cmd shims.
- kernel: `SupervisedProcess(...)` takes a new `stdout_closed` argument; create processes with `spawn_process()`.
- A turn ended by the client after the cancel grace period now drains: queued prompts wait until the agent confirms the old turn (v1: its prompt answer; v2: its idle), for at most twice `cancel_grace_ms`, and its late updates go to the session (`on_idle_update`, `tool_calls`) instead of the next turn. `busy` is False while it drains; a prompt sent then is queued.
- After that drain, the old `session/prompt` request is given up on (`$/cancel_request`) instead of staying pending forever.
- `Session.cancel()` arms the cancel deadline before telling the agent, and tells it in the session's own task: cancelling the caller while it waits no longer leaves the turn without a deadline.
- A tool call id the agent reuses in a later turn belongs to that turn; only background work is routed to earlier turns.
- A client-wide `on_question` answers questions between turns and questions that name no session (they were declined).
- A turn handler that raises `CancelledError`, or a handler task that is cancelled, fails the turn with `RuntimeError("A turn handler was cancelled")`; the turn used to report success.
- Updates for a session closed here are dropped, so a later `load_session` of it no longer replays them.
- `session.modes` is replaced on every change instead of being changed in place.
- `Session.close()` ignores any error from `session/close`, not only RPC and local errors.
