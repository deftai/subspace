"""Run another program as a supervised child and talk to it over stdio.

- On POSIX the child gets its own process group (a new session), so stopping
  it also stops whatever it started (`npx foo` runs `foo` as a grandchild).
  On Windows it gets its own process group, and stop() terminates the child.
- stop() closes stdin, sends SIGTERM, then SIGKILL after a grace period.
- The last stderr output is kept for error messages.
- `ended` settles only after the process has exited *and* its stdout has
  been read to the end, so a final reply written just before exit is not lost.
- A missing program becomes a SpawnError with a hint.
"""

from __future__ import annotations

import asyncio
import atexit
import codecs
import os
import signal as signals
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

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


_live: set[Callable[[], None]] = set()
_hook_installed = False


def _install_exit_hook() -> None:
    """Children in their own process group outlive us unless we stop them on exit."""
    global _hook_installed
    if _hook_installed:
        return
    _hook_installed = True

    def kill_all() -> None:
        for kill in list(_live):
            kill()

    atexit.register(kill_all)


def _exit_info(returncode: int) -> ExitInfo:
    if returncode < 0 and not _WINDOWS:
        try:
            return ExitInfo(None, signals.Signals(-returncode).name)
        except ValueError:
            return ExitInfo(None, f"SIG{-returncode}")
    return ExitInfo(returncode, None)


class _ProcessChannel:
    """A child's stdin and stdout as a byte channel."""

    def __init__(self, process: SupervisedProcess) -> None:
        self._process = process

    async def receive(self) -> bytes:
        stdout = self._process._proc.stdout
        assert stdout is not None
        data = await stdout.read(65536)
        if not data:
            self._process._stdout_done()
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


class SupervisedProcess:
    def __init__(
        self,
        command: str,
        proc: asyncio.subprocess.Process,
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
        self._stdout_ended: asyncio.Future[None] = loop.create_future()
        self._stopping: asyncio.Task[ExitInfo] | None = None
        #: stdin and stdout as a byte channel.
        self.channel = _ProcessChannel(self)
        self._exited_task = loop.create_task(self._wait_exit(), name=f"{command}:exit")
        self._stderr_task = loop.create_task(self._read_stderr(), name=f"{command}:stderr") if proc.stderr else None
        self._kill_now = self._kill_group
        _live.add(self._kill_now)
        _install_exit_hook()
        self._exited_task.add_done_callback(lambda _t: self._forget_if_gone())

    async def _wait_exit(self) -> ExitInfo:
        return _exit_info(await self._proc.wait())

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

    def _stdout_done(self) -> None:
        if not self._stdout_ended.done():
            self._stdout_ended.set_result(None)

    def _close_stdin(self) -> None:
        stdin = self._proc.stdin
        if stdin is not None and not stdin.is_closing():
            try:
                stdin.close()
            except (OSError, RuntimeError):
                pass

    @property
    def exited(self) -> asyncio.Task[ExitInfo]:
        """Settles when the process exits."""
        return self._exited_task

    async def ended(self) -> ExitInfo:
        """Waits until the process has exited and stdout has ended."""
        info = await asyncio.shield(self._exited_task)
        await asyncio.shield(self._stdout_ended)
        return info

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode

    def stderr_tail(self) -> str:
        """The last stderr output, trimmed."""
        return self._stderr.strip()

    def _signal_group(self, sig: int) -> bool:
        try:
            if sys.platform != "win32" and self.pid is not None:
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
        if sys.platform == "win32" or self.pid is None:
            return self._proc.returncode is None
        try:
            os.killpg(self.pid, 0)
            return True
        except (ProcessLookupError, PermissionError, OSError):
            return False

    def _forget_if_gone(self) -> None:
        if not self._group_alive():
            _live.discard(self._kill_now)

    def stop(self, grace_ms: float | None = None) -> asyncio.Task[ExitInfo]:
        """Stop the process and its process group: end stdin, SIGTERM, then SIGKILL after `grace_ms`.

        Idempotent: every call returns the same task.
        """
        if self._stopping is None:
            self._stopping = asyncio.get_running_loop().create_task(self._stop(grace_ms), name=f"{self.command}:stop")
        return self._stopping

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
        _live.discard(self._kill_now)
        return await asyncio.shield(self._exited_task)


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
        proc = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=cwd,
            env=full_env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=2**20,
            **extra,  # type: ignore[arg-type]
        )
    except FileNotFoundError as error:
        where = f" (cwd: {cwd})" if cwd else ""
        raise SpawnError(command, "ENOENT", f'Is "{command}" installed and on PATH?{where}') from error
    except PermissionError as error:
        raise SpawnError(command, "EACCES", f'"{command}" is not executable.') from error
    except OSError as error:
        raise SpawnError(command, getattr(error, "errno", None) and str(error.errno), str(error)) from error
    return SupervisedProcess(command, proc, stderr_tail_bytes=stderr_tail_bytes, kill_grace_ms=kill_grace_ms, on_stderr=on_stderr)
