"""Helpers for a program on this machine: start an agent program and connect
to it, and serve its file requests and terminals from inside a workspace.

    connected = await connect_agent(
        "npx",
        args=["-y", "@agentclientprotocol/claude-agent-acp"],
        cwd=repo,
        workspace=repo,
    )

(The TypeScript package calls this module `node`, for Node.js; the name is kept.)
"""

from __future__ import annotations

import asyncio
import codecs
import inspect
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from deft_subspace.kernel import EndOfChannel, ExitInfo, FramingDiagnostic, RpcError, SupervisedProcess, ndjson, spawn_process

from .client import AcpClient, FileHandlers

__all__ = [
    "AgentFileError",
    "CommandRequest",
    "ConnectedAgent",
    "InstallError",
    "Installed",
    "StartedAgent",
    "WorkspaceFiles",
    "WorkspaceTerminals",
    "agent_by_name",
    "agent_files",
    "ask_in_terminal",
    "binaries_path",
    "connect_agent",
    "file",
    "image",
    "inside_workspace",
    "install_agent",
    "installed_binaries",
    "mcp_connector",
    "load_catalog",
    "load_registry",
    "parse_agent_file",
    "parse_agent_table",
    "refresh_registry",
    "registry_cache_path",
    "run",
    "serve_stdio",
    "start",
    "terminal",
    "workspace_files",
    "workspace_terminals",
]


@dataclass
class ConnectedAgent:
    client: AcpClient
    process: SupervisedProcess

    async def close(self) -> None:
        """Close the connection and stop the agent's process group."""
        await self.client.close()
        await self.process.stop()


def _append_message(error: BaseException, text: str) -> None:
    """Add `text` to an exception's message, in place."""
    message = f"{error.args[0] if error.args else ''}{text}"
    error.args = (message, *error.args[1:])
    if isinstance(getattr(error, "message", None), str):
        error.message = message  # type: ignore[attr-defined]


async def _stderr_read(child: SupervisedProcess, max_ms: float = 1000) -> None:
    """Let the process's stderr be read to its end (it closes soon after the process exits)."""
    task = getattr(child, "_stderr_task", None)
    if isinstance(task, asyncio.Task) and not task.done():
        await asyncio.wait({task}, timeout=max_ms / 1000)


async def connect_agent(
    command: str,
    *,
    args: Sequence[str] = (),
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    stderr_tail_bytes: int = 16 * 1024,
    kill_grace_ms: float = 2000,
    workspace: str | None = None,
    files: FileHandlers | None = None,
    on_stderr: Callable[[str], None] | None = None,
    on_framing_diagnostic: Callable[[FramingDiagnostic], None] | None = None,
    **client_options: Any,
) -> ConnectedAgent:
    """Start an agent program and connect to it. Startup failures include the agent's stderr.

    - `workspace`: serve fs requests from this directory (and nothing outside it).
    - Other options are `spawn_process()`'s and `AcpClient.connect()`'s.
    """
    child = await spawn_process(
        command, args=args, cwd=cwd, env=env, stderr_tail_bytes=stderr_tail_bytes, kill_grace_ms=kill_grace_ms, on_stderr=on_stderr
    )
    channel = ndjson(child.channel, on_diagnostic=on_framing_diagnostic)
    try:
        client = await AcpClient.connect(
            channel,
            files=files if files is not None else (workspace_files(workspace) if workspace else None),
            **client_options,
        )
        return ConnectedAgent(client, child)
    except BaseException as error:
        await child.stop()
        if isinstance(error, Exception):
            await _stderr_read(child)
            tail = child.stderr_tail()
            if tail:
                _append_message(error, f"\nAgent stderr: {tail[-1000:]}")
        raise


class WorkspaceFiles:
    """File access confined to `root`. Paths are resolved against it, `..` cannot
    leave it, and symbolic links are followed to check where they really lead."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = os.fspath(root)

    async def read_text_file(self, request: dict[str, Any]) -> str:
        path = await inside_workspace(self.root, request.get("path"))
        content = await asyncio.to_thread(_read_text, path)
        line, limit = request.get("line"), request.get("limit")
        if line is None and limit is None:
            return content
        lines = content.split("\n")
        start = max(0, (line if line is not None else 1) - 1)
        return "\n".join(lines[start:] if limit is None else lines[start : start + limit])

    async def write_text_file(self, request: dict[str, Any]) -> None:
        target = await inside_workspace(self.root, request.get("path"))
        await asyncio.to_thread(_write_text, target, str(request.get("content", "")))


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        return f.read()


def _write_text(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)


def workspace_files(root: str | os.PathLike[str]) -> WorkspaceFiles:
    """File access confined to `root` (see `WorkspaceFiles`)."""
    return WorkspaceFiles(root)


async def inside_workspace(root: str | os.PathLike[str], path: Any) -> str:
    """`path` resolved against `root`; raises ValueError if it, or a symbolic link on the way, leads outside."""
    if not isinstance(path, str) or not path:
        raise ValueError("Path is required")
    base = os.path.abspath(root)
    target = os.path.abspath(os.path.join(base, path))
    if not _is_inside(base, target):
        raise ValueError(f"Path is outside the workspace: {path}")
    if not _is_inside(os.path.realpath(base, strict=True), _real_location(target)):
        raise ValueError(f"Path leads outside the workspace through a symbolic link: {path}")
    return target


def _is_inside(root: str, path: str) -> bool:
    try:
        rel = os.path.relpath(path, root)
    except ValueError:  # another drive (Windows)
        return False
    return rel != ".." and not rel.startswith(f"..{os.sep}") and not os.path.isabs(rel)


def _real_location(path: str) -> str:
    existing = path
    rest: list[str] = []
    while True:
        try:
            os.lstat(existing)
            break
        except OSError:
            parent = os.path.dirname(existing)
            if parent == existing:
                return path
            rest.insert(0, os.path.basename(existing))
            existing = parent
    return os.path.join(os.path.realpath(existing), *rest)


@dataclass(frozen=True)
class CommandRequest:
    """A command the agent asks to run, for `workspace_terminals(allow=...)`."""

    command: str
    args: list[str]
    cwd: str
    session_id: str


@dataclass
class _Terminal:
    session_id: str
    limit: int
    output: str = ""
    size: int = 0
    truncated: bool = False
    process: SupervisedProcess | None = None
    exit: ExitInfo | None = None
    ended: asyncio.Task[ExitInfo] | None = None
    tasks: set[asyncio.Task[Any]] = field(default_factory=set)

    def append(self, text: str) -> None:
        self.output += text
        self.size += len(text.encode("utf-8"))
        if self.size <= self.limit:
            return
        # Keep the newest bytes, cut at a character boundary.
        kept = self.output.encode("utf-8")[-self.limit :].decode("utf-8", errors="replace").lstrip("�")
        self.output = kept
        self.size = len(kept.encode("utf-8"))
        self.truncated = True


#: Code for a command the client refused to run.
COMMAND_REFUSED = -32001


def _exit_status(info: ExitInfo) -> dict[str, Any]:
    return {"exitCode": info.code, "signal": info.signal}


class WorkspaceTerminals:
    """Terminals that run inside `root` (v1 `terminal/*`). Each command runs in its
    own process group, so `kill` stops whatever it started too. stdout and
    stderr are merged, and only the newest `outputByteLimit` bytes are kept.
    Call `dispose()` to stop every terminal still running."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        allow: Callable[[CommandRequest], bool | Awaitable[bool]] | None = None,
        default_output_byte_limit: int | None = None,
        kill_grace_ms: float | None = None,
    ) -> None:
        self.root = os.fspath(root)
        self._allow = allow
        self._default_limit = default_output_byte_limit
        self._grace = kill_grace_ms
        self._terminals: dict[str, _Terminal] = {}
        self._next = 0

    def _get(self, request: dict[str, Any]) -> _Terminal:
        terminal_id = request.get("terminalId")
        terminal = self._terminals.get(terminal_id) if isinstance(terminal_id, str) else None
        if terminal is None or terminal.session_id != request.get("sessionId"):
            raise RpcError.not_found(f"Unknown terminal {terminal_id}")
        return terminal

    async def _allowed(self, request: CommandRequest) -> bool:
        if self._allow is None:
            return True
        try:
            answer = self._allow(request)
            if inspect.isawaitable(answer):
                answer = await answer
            return bool(answer)
        except Exception:
            return False

    async def create(self, request: dict[str, Any]) -> dict[str, Any]:
        cwd = await inside_workspace(self.root, request["cwd"]) if request.get("cwd") else os.path.abspath(self.root)
        command = str(request.get("command", ""))
        args = [str(a) for a in request.get("args") or []]
        session_id = str(request.get("sessionId", ""))
        if not await self._allowed(CommandRequest(command, args, cwd, session_id)):
            raise RpcError(COMMAND_REFUSED, f"The client refused to run {command}")
        env = {str(v.get("name")): str(v.get("value")) for v in request.get("env") or [] if isinstance(v, dict)}
        limit = request.get("outputByteLimit")
        terminal = _Terminal(
            session_id=session_id,
            limit=limit if isinstance(limit, int) else self._default_limit if self._default_limit is not None else 1024 * 1024,
        )
        process = await spawn_process(
            command,
            args=args,
            cwd=cwd,
            env=env,
            kill_grace_ms=self._grace if self._grace is not None else 2000,
            stderr_tail_bytes=1,
            on_stderr=terminal.append,
        )
        terminal.process = process

        # No input: close stdin so commands that read it do not wait.
        async def close_stdin() -> None:
            try:
                await process.channel.close()
            except Exception:
                pass

        async def drain() -> None:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            try:
                while True:
                    try:
                        data = await process.channel.receive()
                    except EndOfChannel:
                        break
                    terminal.append(decoder.decode(data))
                rest = decoder.decode(b"", final=True)
                if rest:
                    terminal.append(rest)
            except Exception:
                pass  # The process went away; its exit is reported below.

        async def ended(drained: asyncio.Task[None]) -> ExitInfo:
            # Exited, and all of its output read.
            info = await process.ended()
            await drained
            terminal.exit = info
            return info

        loop = asyncio.get_running_loop()
        terminal.tasks.add(loop.create_task(close_stdin()))
        drained = loop.create_task(drain())
        terminal.ended = loop.create_task(ended(drained))
        self._next += 1
        terminal_id = f"term-{self._next}"
        self._terminals[terminal_id] = terminal
        return {"terminalId": terminal_id}

    async def output(self, request: dict[str, Any]) -> dict[str, Any]:
        terminal = self._get(request)
        out: dict[str, Any] = {"output": terminal.output, "truncated": terminal.truncated}
        if terminal.exit is not None:
            out["exitStatus"] = _exit_status(terminal.exit)
        return out

    async def wait_for_exit(self, request: dict[str, Any]) -> dict[str, Any]:
        terminal = self._get(request)
        assert terminal.ended is not None
        return _exit_status(await asyncio.shield(terminal.ended))

    async def kill(self, request: dict[str, Any]) -> None:
        terminal = self._get(request)
        assert terminal.process is not None and terminal.ended is not None
        if terminal.exit is None:
            await terminal.process.stop(self._grace)
        await asyncio.shield(terminal.ended)

    async def release(self, request: dict[str, Any]) -> None:
        terminal = self._get(request)
        del self._terminals[request["terminalId"]]
        assert terminal.process is not None
        if terminal.exit is None:
            await terminal.process.stop(self._grace)

    async def dispose(self) -> None:
        terminals = list(self._terminals.values())
        self._terminals.clear()
        await asyncio.gather(*(t.process.stop(self._grace) for t in terminals if t.exit is None and t.process is not None))


def workspace_terminals(
    root: str | os.PathLike[str],
    *,
    allow: Callable[[CommandRequest], bool | Awaitable[bool]] | None = None,
    default_output_byte_limit: int | None = None,
    kill_grace_ms: float | None = None,
) -> WorkspaceTerminals:
    """Terminals that run inside `root` (see `WorkspaceTerminals`).

    - `allow(request)`: refuse commands you do not want run. Return False (or raise) to refuse. Default: allow.
    - `default_output_byte_limit`: output kept per terminal when the agent sets no `outputByteLimit`. Default 1 MiB.
    - `kill_grace_ms`: how long `kill` waits after SIGTERM before SIGKILL. Default 2000 ms.
    """
    return WorkspaceTerminals(root, allow=allow, default_output_byte_limit=default_output_byte_limit, kill_grace_ms=kill_grace_ms)


from .catalog import (
    AgentFileError,
    agent_files,
    load_catalog,
    load_registry,
    parse_agent_file,
    parse_agent_table,
    refresh_registry,
    registry_cache_path,
)
from .content import file, image
from .install import Installed, InstallError, binaries_path, install_agent, installed_binaries
from .mcp_connector import mcp_connector
from .start import StartedAgent, agent_by_name, run, serve_stdio, start
from .terminal_ui import ask_in_terminal, terminal
