# Changelog

## Unreleased

- kernel: `SupervisedProcess.exited` and `stop()` return shielded awaitables, so cancelling a wait (e.g. `asyncio.wait_for`) no longer cancels the process's own exit watcher or its stop: a timed-out `stop()` still sends SIGKILL after the grace period, and later calls still work. They are `asyncio.Future`s now, not `asyncio.Task`s.
- kernel: `SupervisedProcess.ended()` settles once the process has exited and its stdout pipe has closed, whether or not anyone read stdout to the end (it hung after `RpcPeer.close()` cancelled the reader). Unread output is still there to read.
- kernel: on POSIX, SIGTERM and SIGHUP now stop live supervised process groups before the process dies of the signal, while groups are alive and only if the app has no handler of its own for that signal (installed from the main thread only).
- kernel: a process group is dropped from the exit-time kill list once its last member is gone, not only if it was gone when its leader exited, so a reused group id is never killed at exit.
- kernel: `stderr_tail_bytes` counts bytes, not characters; a character cut in half at the start of the tail is dropped.
- kernel: on Windows, a command found through PATH and PATHEXT as a `.cmd`/`.bat` file (like `npx.cmd`) is run through cmd.exe with its arguments escaped; the not-found hint mentions .cmd shims.
- kernel: `SupervisedProcess(...)` takes a new `stdout_closed` argument; create processes with `spawn_process()`.
