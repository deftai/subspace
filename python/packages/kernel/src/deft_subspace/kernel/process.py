"""Run another program as a supervised child and talk to it over stdio.

- On POSIX the child gets its own process group (a new session), so stopping
  it also stops whatever it started (`npx foo` runs `foo` as a grandchild).
  On Windows it gets its own process group, and stop() terminates the child.
- stop() closes stdin, sends SIGTERM, then SIGKILL after a grace period.
- The last stderr output is kept for error messages.
- `ended` settles only after the process has exited *and* its stdout has
  closed, so a final reply written just before exit is not lost: it is still
  there to read.
- `exited`, `ended()` and `stop()` can be cancelled (e.g. by `asyncio.wait_for`)
  without affecting the process or later calls.
- A missing program becomes a SpawnError with a hint.

Process groups outlive this process unless it stops them, so the live ones are
killed when it exits: at normal interpreter exit (atexit, which also covers
Ctrl-C under `asyncio.run`), and, on POSIX, on SIGTERM and SIGHUP. Those
signal handlers are installed only while supervised groups are alive, only
from the main thread, and only for signals still at their default action: an
app's own handler (`signal.signal` or `loop.add_signal_handler`) is left alone,
and then stopping the children is up to the app. After killing the groups the
handler restores the default action and re-sends the signal, so the process
still dies of it.
"""

from __future__ import annotations

import asyncio
import atexit
import codecs
import os
import signal as signals
import subprocess
import sys
import threading
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from types import FrameType

from .channel import ChannelClosed, EndOfChannel

_WINDOWS = sys.platform == "win32"


@dataclass(frozen=True)
class ExitInfo:
    #: The exit code, or None when a signal ended the process.
    code: int | None
    #: The signal's name (`SIGTERM`), or None.
    signal: str | None


class SpawnError(Exception):
    def __init__(self, command: str, code: str | None, hint: str) -> None:
        super().__init__(f"Could not start {command}{f' ({code})' if code else ''}. {hint}")
        self.command = command
        self.code = code
        self.hint = hint


# -- Killing live groups when this process ends --------------------------------------------

#: How to kill each process group that may still be alive.
_live: set[Callable[[], None]] = set()
_atexit_installed = False


def _kill_live() -> None:
    for kill in list(_live):
        kill()


def _track(kill: Callable[[], None]) -> None:
    global _atexit_installed
    _live.add(kill)
    if not _atexit_installed:
        _atexit_installed = True
        atexit.register(_kill_live)
    _install_signal_hooks()


def _untrack(kill: Callable[[], None]) -> None:
    _live.discard(kill)
    if not _live:
        _remove_signal_hooks()


#: Signals that end a process by default and so skip atexit.
_FATAL_SIGNALS = ("SIGTERM", "SIGHUP")
_hooked: set[int] = set()


def _on_fatal_signal(signum: int, _frame: FrameType | None) -> None:
    _kill_live()
    signals.signal(signum, signals.SIG_DFL)
    _hooked.discard(signum)
    os.kill(os.getpid(), signum)


def _can_set_signal_handlers() -> bool:
    return not _WINDOWS and threading.current_thread() is threading.main_thread()


def _install_signal_hooks() -> None:
    """POSIX: on a fatal signal nobody else handles, kill the live groups and die of it anyway."""
    if not _can_set_signal_handlers():
        return
    for name in _FATAL_SIGNALS:
        sig = getattr(signals, name, None)
        if sig is None or sig in _hooked:
            continue
        try:
            if signals.getsignal(sig) is not signals.SIG_DFL:
                continue  # the app (or Python) handles this one
            signals.signal(sig, _on_fatal_signal)
        except (OSError, ValueError):
            continue
        _hooked.add(sig)


def _remove_signal_hooks() -> None:
    if not _can_set_signal_handlers():
        return  # left in place; with nothing live they only restore the default and re-send
    for sig in list(_hooked):
        try:
            if signals.getsignal(sig) is _on_fatal_signal:
                signals.signal(sig, signals.SIG_DFL)
        except (OSError, ValueError):
            pass
        _hooked.discard(sig)


# -- The supervised process ----------------------------------------------------------------


def _exit_info(returncode: int) -> ExitInfo:
    if returncode < 0 and not _WINDOWS:
        try:
            return ExitInfo(None, signals.Signals(-returncode).name)
        except ValueError:
            return ExitInfo(None, f"SIG{-returncode}")
    return ExitInfo(returncode, None)


class _Protocol(asyncio.subprocess.SubprocessStreamProtocol):
    """The usual stream protocol, plus a future for "stdout has closed", whoever reads it."""

    def __init__(self, limit: int, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__(limit=limit, loop=loop)
        self.stdout_closed: asyncio.Future[None] = loop.create_future()

    def _stdout_gone(self) -> None:
        if not self.stdout_closed.done():
            self.stdout_closed.set_result(None)

    def pipe_connection_lost(self, fd: int, exc: Exception | None) -> None:
        super().pipe_connection_lost(fd, exc)
        if fd == 1:
            self._stdout_gone()

    def connection_lost(self, exc: Exception | None) -> None:
        super().connection_lost(exc)
        self._stdout_gone()


class _ProcessChannel:
    """A child's stdin and stdout as a byte channel."""

    def __init__(self, process: SupervisedProcess) -> None:
        self._process = process

    async def receive(self) -> bytes:
        stdout = self._process._proc.stdout
        assert stdout is not None
        data = await stdout.read(65536)
        if not data:
            raise EndOfChannel()
        return data

    async def send(self, item: bytes) -> None:
        stdin = self._process._proc.stdin
        if stdin is None or stdin.is_closing():
            raise ChannelClosed("stdin closed")
        try:
            stdin.write(item)
            await stdin.drain()
        except (ConnectionError, RuntimeError) as error:
            raise ChannelClosed(str(error)) from error

    async def close(self) -> None:
        self._process._close_stdin()


#: How often to check whether an exited leader's group is gone: from this, doubling, up to the max.
_POLL_FIRST = 0.05
_POLL_MAX = 1.0


class SupervisedProcess:
    """A running child. One supervisor task owns its lifecycle:

    running -> exited (the process has exited) -> ended (and stdout has closed),
    with "stopping" (stop() was called) on top. The supervisor also drops the
    group from the exit-time kill list once its last member is gone, so a
    reused group id is never killed. Callers only ever get shielded views of
    the private futures and tasks, so cancelling a wait affects nothing else.
    """

    def __init__(
        self,
        command: str,
        proc: asyncio.subprocess.Process,
        stdout_closed: Awaitable[None],
        *,
        stderr_tail_bytes: int,
        kill_grace_ms: float,
        on_stderr: Callable[[str], None] | None,
    ) -> None:
        self.command = command
        self._proc = proc
        self.pid: int | None = proc.pid
        self._tail_bytes = stderr_tail_bytes
        self._grace_ms = kill_grace_ms
        self._on_stderr = on_stderr
        self._stderr = ""
        loop = asyncio.get_running_loop()
        self._exited: asyncio.Future[ExitInfo] = loop.create_future()
        self._ended: asyncio.Future[ExitInfo] = loop.create_future()
        self._stopping: asyncio.Task[ExitInfo] | None = None
        #: stdin and stdout as a byte channel.
        self.channel = _ProcessChannel(self)
        self._kill_now = self._kill_group
        _track(self._kill_now)
        self._supervisor = loop.create_task(self._supervise(stdout_closed), name=f"{command}:supervise")
        self._stderr_task = loop.create_task(self._read_stderr(), name=f"{command}:stderr") if proc.stderr else None

    async def _supervise(self, stdout_closed: Awaitable[None]) -> None:
        info = _exit_info(await self._proc.wait())
        self._exited.set_result(info)
        stdout = asyncio.ensure_future(stdout_closed)
        delay = _POLL_FIRST
        tracked = True
        while True:
            if stdout.done() and not self._ended.done():
                self._ended.set_result(info)
            if tracked and not self._group_alive():
                _untrack(self._kill_now)
                tracked = False
            if self._ended.done() and not tracked:
                return
            if stdout.done():
                await asyncio.sleep(delay)
            else:
                await asyncio.wait([stdout], timeout=delay if tracked else None)
            delay = min(delay * 2, _POLL_MAX)

    async def _read_stderr(self) -> None:
        stderr = self._proc.stderr
        assert stderr is not None
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            data = await stderr.read(65536)
            if not data:
                break
            text = decoder.decode(data)
            self._stderr = (self._stderr + text)[-self._tail_bytes :] if self._tail_bytes > 0 else ""
            if self._on_stderr is not None:
                try:
                    self._on_stderr(text)
                except Exception:  # noqa: BLE001
                    pass

    def _close_stdin(self) -> None:
        stdin = self._proc.stdin
        if stdin is not None and not stdin.is_closing():
            try:
                stdin.close()
            except (OSError, RuntimeError):
                pass

    @property
    def exited(self) -> asyncio.Future[ExitInfo]:
        """Settles when the process exits. Await it; cancelling the wait does not affect the process."""
        return asyncio.shield(self._exited)

    async def ended(self) -> ExitInfo:
        """Waits until the process has exited and stdout has closed."""
        return await asyncio.shield(self._ended)

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode

    def stderr_tail(self) -> str:
        """The last stderr output, trimmed."""
        return self._stderr.strip()

    def _signal_group(self, sig: int) -> bool:
        try:
            if not _WINDOWS and self.pid is not None:
                os.killpg(self.pid, sig)
            elif sig == signals.SIGTERM:
                self._proc.terminate()
            else:
                self._proc.kill()
            return True
        except (ProcessLookupError, PermissionError, OSError):
            return False  # already gone

    def _kill_group(self) -> None:
        self._signal_group(getattr(signals, "SIGKILL", signals.SIGTERM))

    def _group_alive(self) -> bool:
        if _WINDOWS or self.pid is None:
            return self._proc.returncode is None
        try:
            os.killpg(self.pid, 0)
            return True
        except (ProcessLookupError, PermissionError, OSError):
            return False

    def stop(self, grace_ms: float | None = None) -> asyncio.Future[ExitInfo]:
        """Stop the process and its process group: end stdin, SIGTERM, then SIGKILL after `grace_ms`.

        Idempotent: every call waits for the same stop. Cancelling the wait does not cancel the stop.
        """
        if self._stopping is None:
            self._stopping = asyncio.get_running_loop().create_task(self._stop(grace_ms), name=f"{self.command}:stop")
        return asyncio.shield(self._stopping)

    async def _stop(self, grace_ms: float | None) -> ExitInfo:
        self._close_stdin()
        if self._group_alive():
            self._signal_group(signals.SIGTERM)
            grace = (self._grace_ms if grace_ms is None else grace_ms) / 1000
            deadline = time.monotonic() + grace
            while self._group_alive() and time.monotonic() < deadline:
                await asyncio.sleep(0.025)
            if self._group_alive():
                self._kill_group()
        _untrack(self._kill_now)
        return await asyncio.shield(self._exited)


async def _start(
    command: str, args: Sequence[str], limit: int, env: Mapping[str, str], **kwds: object
) -> tuple[asyncio.subprocess.Process, asyncio.Future[None]]:
    """asyncio.create_subprocess_exec, keeping the protocol to learn when stdout closes."""
    loop = asyncio.get_running_loop()
    protocol: _Protocol | None = None

    def factory() -> _Protocol:
        nonlocal protocol
        protocol = _Protocol(limit, loop)
        return protocol

    transport, _ = await loop.subprocess_exec(factory, command, *args, env=env, **kwds)  # type: ignore[arg-type]
    assert protocol is not None
    return asyncio.subprocess.Process(transport, protocol, loop), protocol.stdout_closed


async def spawn_process(
    command: str,
    *,
    args: Sequence[str] = (),
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    stderr_tail_bytes: int = 16 * 1024,
    kill_grace_ms: float = 2000,
    on_stderr: Callable[[str], None] | None = None,
) -> SupervisedProcess:
    """Start `command` with `args`. `env` is added to (not replacing) this process's environment."""
    full_env = {**os.environ, **(env or {})}
    extra: dict[str, object] = {}
    if _WINDOWS:
        extra["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        extra["start_new_session"] = True
    try:
        proc, stdout_closed = await _start(
            command,
            args,
            2**20,
            full_env,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **extra,
        )
    except FileNotFoundError as error:
        where = f" (cwd: {cwd})" if cwd else ""
        raise SpawnError(command, "ENOENT", f'Is "{command}" installed and on PATH?{where}') from error
    except PermissionError as error:
        raise SpawnError(command, "EACCES", f'"{command}" is not executable.') from error
    except OSError as error:
        raise SpawnError(command, getattr(error, "errno", None) and str(error.errno), str(error)) from error
    return SupervisedProcess(
        command, proc, stdout_closed, stderr_tail_bytes=stderr_tail_bytes, kill_grace_ms=kill_grace_ms, on_stderr=on_stderr
    )
