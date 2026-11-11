"""The quick way in: start a known agent with sensible defaults, run turns
with handler options, and serve an agent on stdio.

    agent = await start("claude", on_permission=lambda r, _s: "allow" if r.tool_call and r.tool_call.kind == "read" else "reject")
    try:
        await agent.run("Summarize README.md", on_message=lambda delta, info, _e: print(info.separator + delta, end=""))
    finally:
        await agent.close()

    result = await run("codex", "What does this repo do?", permissions="reject")

What `start()` does for you:
- Known agents by name: the built-ins (claude, codex, grok, gemini,
  opencode), any ACP registry id, and agents files (agents.toml,
  subspace.toml; see catalog.py). Each starts in the mode where it asks
  before acting, so your permission answers are actually consulted (a
  quirk records why). `mode=` overrides, `mode=False` keeps the agent's own.
- One folder: `cwd` (default `os.getcwd()`) is the agent's working
  directory, the workspace its file requests are confined to, and the session's cwd.
- A session, opened and ready (`agent.session`, `agent.run()`).
- Login: if opening the session fails because the agent needs a login and
  it offers exactly one method it handles itself, that method is used once.
- Ctrl-C (SIGINT) cancels the running turn and stops the agent before exiting.
- Questions from the agent (form elicitation) are advertised and go to the
  turn's `on_question`, or are declined.

It requires a permission answer (`on_permission` or `permissions`): agents
ask before writing and running, and a silent refusal surprises everyone.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import signal as signals
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from deft_subspace.kernel import ChannelClosed, EndOfChannel, ErrorCode, RpcError, RpcPeer, SpawnError, ndjson, trace_tap

from .agents import AgentCatalog, ResolvedAgent, list_agents, resolve_agent
from .catalog import load_catalog_async
from .client import PromptInput, Session, SessionMcpServers
from .conveniences import SessionConveniences
from .handlers import HANDLER_KEYS, TurnHandlers, merge_handlers
from .model import TurnLimits, TurnResult
from .open import open_session, require_permission_answer

if TYPE_CHECKING:
    from deft_subspace.kernel import AbortSignal, SupervisedProcess

    from .client import AcpClient
    from .node import ConnectedAgent


@dataclass(frozen=True)
class AgentCommand:
    """An agent given by its command (not by name)."""

    command: str
    args: Sequence[str] = ()
    #: The mode to switch each session to (its ask-first mode).
    mode: str | None = None
    env: Mapping[str, str] | None = None
    description: str | None = None
    #: How to install it, for the error when it is missing.
    install: str | None = None
    #: How to log in, for the error when it needs a login.
    login: str | None = None


AgentName = str
"""A known agent's name (built in, from an agents file, or an ACP registry id)."""


def agent_by_name(name: str, catalog: AgentCatalog) -> ResolvedAgent:
    """Look up a name in a catalog; an error that lists the known names if it is not there."""
    found = resolve_agent(catalog, name)
    if found is not None:
        return found
    known = [a.id for a in list_agents(catalog) if not all(s == "registry" for s in a.sources)]
    raise TypeError(
        f'Unknown agent "{name}". Known: {", ".join(known)} (and the ACP registry\'s; `subspace agents --all`), '
        "or pass AgentCommand(command, args)."
    )


class _Preset:
    def __init__(self, agent: ResolvedAgent | AgentCommand) -> None:
        self.command = agent.command
        self.args = list(agent.args)
        self.mode = agent.mode
        self.env = dict(agent.env or {})
        self.install = agent.install
        self.login = agent.login


@dataclass
class _Trace:
    path: str
    label: str
    cwd: str
    file: Any = None
    tap: Any = None
    _flush_at: Any = None

    #: How soon after a record the file is flushed (seconds): records are buffered, not
    #: written to disk one system call each.
    FLUSH_S = 0.05

    def open(self) -> _Trace:
        """A trace written to `path` as it happens (JSON Lines, the kernel's trace format)."""
        self.file = open(self.path, "w", encoding="utf-8")

        def write(record: Any) -> None:
            if self.file.closed:
                return
            self.file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            if self._flush_at is None:
                try:
                    self._flush_at = asyncio.get_running_loop().call_later(self.FLUSH_S, self._flush)
                except RuntimeError:  # no loop: write through
                    self._flush()

        self.tap = trace_tap(write, peer="client", label=self.label, meta={"agent": self.label, "cwd": self.cwd})
        return self

    def _flush(self) -> None:
        self._flush_at = None
        if self.file is not None and not self.file.closed:
            try:
                self.file.flush()
            except (OSError, ValueError):
                pass

    def close(self) -> None:
        if self._flush_at is not None:
            self._flush_at.cancel()
            self._flush_at = None
        if self.file is not None and not self.file.closed:
            self.file.close()


class StartedAgent(SessionConveniences):
    """An agent started by `start()`, with a session open: `run()`, `text()`, `stream()`, `json()`."""

    def __init__(
        self,
        connected: ConnectedAgent,
        session: Session,
        agent: ResolvedAgent | None,
        open_session: Callable[..., Any],
        close: Callable[[], Any],
    ) -> None:
        super().__init__(session)
        self.client: AcpClient = connected.client
        self.process: SupervisedProcess = connected.process
        #: The session opened by `start()`.
        self.session = session
        #: The agent as resolved from the catalog (when started by name): its command, quirks, sources.
        self.agent = agent
        self._open = open_session
        self._close = close
        #: Why the agent's mode was not applied, if it was not.
        self.mode_warning: str | None = None

    async def new_session(self, *, mcp_servers: SessionMcpServers | None = None, additional_directories: list[str] | None = None) -> Session:
        """Another session with the same agent (switched to the same mode)."""
        return await self._open(mcp_servers, additional_directories)

    async def close(self) -> None:
        """Cancel what is running, close the session and the connection, and stop the agent."""
        await self._close()

    async def __aenter__(self) -> StartedAgent:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()


def _append(error: BaseException, text: str, replace: bool = False) -> None:
    message = text if replace else f"{error.args[0] if error.args else ''}{text}"
    error.args = (message, *error.args[1:])
    if isinstance(getattr(error, "message", None), str):
        error.message = message  # type: ignore[attr-defined]


def _explain(error: BaseException, preset: _Preset, name: str) -> None:
    """Errors with a next step: a missing program says how to install it, a needed login how to log in."""
    if isinstance(error, SpawnError) and preset.install:
        _append(error, f"\n{name}: {preset.install}.")
    elif isinstance(error, RpcError) and error.code == ErrorCode.AUTH_REQUIRED:
        login = preset.login or "Log in to it first, then try again."
        _append(error, f"{name} needs a login. {login}\n({error.message})", replace=True)


class _SignalHook:
    """Ctrl-C: run `on_signal` once, then exit 130. Through the loop where it can, else `signal.signal`."""

    def __init__(self, on_signal: Callable[[], Any]) -> None:
        self._on_signal = on_signal
        self._loop = asyncio.get_running_loop()
        self._via_loop = False
        self._previous: Any = None
        self._installed = False
        try:
            self._loop.add_signal_handler(signals.SIGINT, self._fire)
            self._via_loop = True
            self._installed = True
        except (NotImplementedError, RuntimeError, ValueError):
            # Windows, or not the main thread: the plain signal module (main thread only).
            if threading.current_thread() is threading.main_thread():
                self._previous = signals.signal(signals.SIGINT, lambda _n, _f: self._loop.call_soon_threadsafe(self._fire))
                self._installed = True

    def _fire(self) -> None:
        self.remove()

        async def stop() -> None:
            try:
                await self._on_signal()
            finally:
                raise SystemExit(130)

        self._loop.create_task(stop())

    def remove(self) -> None:
        if not self._installed:
            return
        self._installed = False
        try:
            if self._via_loop:
                self._loop.remove_signal_handler(signals.SIGINT)
            else:
                signals.signal(signals.SIGINT, self._previous if self._previous is not None else signals.default_int_handler)
        except (RuntimeError, ValueError):
            pass


async def start(
    agent: AgentName | AgentCommand,
    *,
    cwd: str | None = None,
    files: Any = None,
    catalog: AgentCatalog | None = None,
    extra_args: Sequence[str] | None = None,
    mode: str | Literal[False] | None = None,
    permissions: Any = None,
    handlers: TurnHandlers | None = None,
    mcp_servers: SessionMcpServers | None = None,
    additional_directories: list[str] | None = None,
    handle_signals: bool = True,
    trace: str | None = None,
    quiet: bool = False,
    env: Mapping[str, str] | None = None,
    tap: Callable[[Literal["in", "out"], Any], None] | None = None,
    elicitation: Any = None,
    elicitation_modes: list[str] | None = None,
    **options: Any,
) -> StartedAgent:
    """Start a known agent (by name) or `AgentCommand(command, args)`, and open a session.

    - `cwd`: the agent's folder, the workspace its file requests stay in, and the session's cwd. Default `os.getcwd()`.
    - `files`: serve the agent's file requests (v1). Default: from `cwd`; False: none.
    - `catalog`: where names are looked up. Default: `load_catalog_async(cwd=cwd)` (built-ins, the ACP registry, agents files).
    - `extra_args`: arguments added after the agent's.
    - `mode`: the session mode to switch to. Default: the preset's ask-first mode. False: the agent's own.
    - `permissions`: a fixed answer to every permission question; or use `on_permission`. One of the two is required.
    - `handlers`, or flat `on_message=...` etc.: handlers for every turn.
    - `mcp_servers`, `additional_directories`: for the session.
    - `handle_signals`: cancel and stop the agent on Ctrl-C (SIGINT) before exiting. Default True.
    - `trace`: record the whole connection to this file (a trace; view it with `deft-subspace-trace`).
    - `quiet`: no notices on stderr (such as "the first start downloads the adapter").
    - Other options are `connect_agent()`'s (and so `AcpClient.connect()`'s and `spawn_process()`'s).
    """
    from .node import connect_agent

    resolved = agent_by_name(agent, catalog if catalog is not None else await load_catalog_async(cwd=cwd or os.getcwd())) if isinstance(agent, str) else None
    preset = _Preset(resolved if resolved is not None else agent)  # type: ignore[arg-type]
    merged = merge_handlers(handlers, options)
    require_permission_answer({**options, "permissions": permissions, "handlers": handlers}, "start()")
    folder = cwd if cwd is not None else os.getcwd()
    rest = {k: v for k, v in options.items() if k not in HANDLER_KEYS}
    # The agent's environment on top of ours; the caller's on top of that.
    agent_env: Mapping[str, str] | None = {**os.environ, **preset.env, **(env or {})} if preset.env else env
    # A label for messages and traces: the preset's name, or the program (and the script it runs).
    script = next((a for a in preset.args if not a.startswith("-")), None)
    name = resolved.id if resolved is not None else " ".join([os.path.basename(preset.command), *([os.path.basename(script)] if script else [])])
    recording = _Trace(trace, name, folder).open() if trace else None
    combined: Callable[[Literal["in", "out"], Any], None] | None = tap
    if recording is not None:
        trace_recorder = recording

        def both(direction: Literal["in", "out"], message: Any) -> None:
            trace_recorder.tap(direction, message)
            if tap is not None:
                tap(direction, message)

        combined = both

    loop = asyncio.get_running_loop()
    # npx may download the adapter first; say so if it takes a while.
    slow = (
        loop.call_later(4, lambda: sys.stderr.write(f"Starting {name}: the first start downloads its ACP adapter...\n"))
        if not quiet and preset.command == "npx"
        else None
    )
    connect_options: dict[str, Any] = dict(rest)
    if combined is not None:
        connect_options["tap"] = combined
    if agent_env is not None:
        connect_options["env"] = agent_env
    if files is False:
        pass
    elif files is not None:
        connect_options["files"] = files
    else:
        connect_options["workspace"] = folder
    if permissions:
        connect_options["permissions"] = permissions
    if merged is not None:
        connect_options["handlers"] = merged
    # Advertise form questions so a turn's on_question can answer them; decline otherwise.
    connect_options["elicitation"] = elicitation if elicitation is not None else (lambda _request, _signal: {"action": "decline"})
    connect_options["elicitation_modes"] = elicitation_modes if elicitation_modes is not None else ["form"]
    try:
        connected = await connect_agent(preset.command, args=[*preset.args, *(extra_args or [])], cwd=folder, **connect_options)
    except BaseException as error:
        if recording is not None:
            recording.close()
        _explain(error, preset, name)
        raise
    finally:
        if slow is not None:
            slow.cancel()
    session_mode = None if mode is False else (mode if mode is not None else preset.mode)
    holder: list[StartedAgent] = []

    async def open_one(servers: SessionMcpServers | None = mcp_servers, directories: list[str] | None = additional_directories) -> Session:
        opened = await open_session(connected.client, cwd=folder, mcp_servers=servers, additional_directories=directories, mode=session_mode)
        if opened.mode_warning:
            if holder:
                holder[0].mode_warning = opened.mode_warning
            else:
                warnings.append(opened.mode_warning)
        return opened.session

    warnings: list[str] = []
    try:
        session = await open_one()
    except BaseException as error:
        await connected.close()
        if recording is not None:
            recording.close()
        _explain(error, preset, name)
        raise

    closing: list[asyncio.Task[None]] = []
    hook: list[_SignalHook] = []

    async def do_close() -> None:
        for h in hook:
            h.remove()
        try:
            await session.close()
        except Exception:
            pass
        await connected.close()
        if recording is not None:
            recording.close()

    async def close() -> None:
        if not closing:
            closing.append(asyncio.ensure_future(do_close()))
        await asyncio.shield(closing[0])

    if handle_signals:
        hook.append(_SignalHook(close))
    started = StartedAgent(connected, session, resolved, open_one, close)
    if warnings:
        started.mode_warning = warnings[-1]
    holder.append(started)
    return started


async def run(
    agent: AgentName | AgentCommand,
    prompt: PromptInput,
    *,
    limits: TurnLimits | None = None,
    timeout_ms: float | None = None,
    signal: AbortSignal | None = None,
    **options: Any,
) -> TurnResult:
    """Start an agent, run one prompt, close it, and return the turn's result."""
    started = await start(agent, **options)
    try:
        prompt_options: dict[str, Any] = {}
        if limits is not None:
            prompt_options["limits"] = limits
        if timeout_ms is not None:
            prompt_options["timeout_ms"] = timeout_ms
        if signal is not None:
            prompt_options["signal"] = signal
        return await started.run(prompt, **prompt_options)
    finally:
        await started.close()


#: How many bytes `_StdioChannel.send` lets the writer thread fall behind before it waits.
_WINDOW = 1 << 20
#: A frame this big is waited for anyway: encoding the next one while it is written makes the
#: two threads trade the GIL for every pipe-sized write (about 10% slower for 1 MB frames).
_LARGE = 64 * 1024


@dataclass
class _StdioChannel:
    """This process's stdin and stdout as a byte channel. Reads come from a daemon
    thread (portable, and a blocked read never keeps the program alive). Writes go
    through one writer thread, in order, so frames never interleave, even when a send
    is cancelled while its write is under way."""

    reader: Any
    writer: Any
    _queue: asyncio.Queue[bytes | BaseException | None] = field(default_factory=asyncio.Queue)
    _started: bool = False
    _ended: bool = False
    _closed: bool = False
    #: (bytes, the sender's loop, a future for the result); None ends the writer.
    _writes: queue.SimpleQueue[tuple[bytes | None, asyncio.AbstractEventLoop, asyncio.Future[None]] | None] = field(default_factory=queue.SimpleQueue)
    _writing: bool = False
    #: Bytes queued for the writer thread and not yet written.
    _unwritten: int = 0
    #: The first write that failed; later sends raise it.
    _failure: BaseException | None = None

    def _start(self) -> None:
        if self._started:
            return
        self._started = True
        loop = asyncio.get_running_loop()

        def put(item: bytes | BaseException | None) -> None:
            try:
                loop.call_soon_threadsafe(self._queue.put_nowait, item)
            except RuntimeError:
                pass  # the loop is gone

        def read() -> None:
            read1: Any = getattr(self.reader, "read1", None)
            try:
                while True:
                    data: Any = read1(65536) if callable(read1) else self.reader.read(65536)
                    if not data:
                        put(None)
                        return
                    put(data)
            except BaseException as error:
                put(error)

        threading.Thread(target=read, name="serve_stdio:stdin", daemon=True).start()

    async def receive(self) -> bytes:
        self._start()
        if self._ended:
            raise EndOfChannel()
        item = await self._queue.get()
        if item is None or isinstance(item, BaseException):
            self._ended = True
            raise EndOfChannel()
        return item

    def _start_writer(self) -> None:
        if self._writing:
            return
        self._writing = True

        def settle(loop: asyncio.AbstractEventLoop, future: asyncio.Future[None], error: BaseException | None) -> None:
            def done() -> None:
                if future.done():
                    return
                if error is None:
                    future.set_result(None)
                else:
                    future.set_exception(ChannelClosed(str(error)))

            try:
                loop.call_soon_threadsafe(done)
            except RuntimeError:
                pass  # the loop is gone

        def run() -> None:
            failed: BaseException | None = None
            while True:
                entry = self._writes.get()
                if entry is None:
                    return
                # Everything queued so far goes out with one flush.
                batch = [entry]
                while True:
                    try:
                        more = self._writes.get_nowait()
                    except queue.Empty:
                        break
                    if more is None:
                        self._writes.put(None)
                        break
                    batch.append(more)
                if failed is None:
                    try:
                        for data, _loop, _future in batch:
                            if data is not None:
                                self.writer.write(data)
                        self.writer.flush()
                    except (OSError, ValueError) as error:
                        failed = error
                for _data, loop, future in batch:
                    settle(loop, future, failed)

        threading.Thread(target=run, name="serve_stdio:stdout", daemon=True).start()

    def _enqueue(self, data: bytes | None) -> asyncio.Future[None]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()
        self._start_writer()
        self._writes.put((data, loop, future))
        return future

    async def send(self, item: bytes) -> None:
        """Queue a frame for the writer thread. It returns once the frame is queued, as an
        asyncio stream's write does, and waits only while more than `_WINDOW` bytes are
        still unwritten (so a stdout nobody reads still holds the sender back) or for a
        frame of `_LARGE` bytes or more. Waiting for
        each frame would cost a round trip to the thread per message, and messages from
        concurrent sessions would go out one at a time. A failed write is raised by the
        next send."""
        if self._closed:
            raise ChannelClosed("stdout closed")
        if self._failure is not None:
            raise ChannelClosed(str(self._failure))
        future = self._enqueue(item)
        size = len(item)
        self._unwritten += size

        def written(done: asyncio.Future[None]) -> None:
            self._unwritten -= size
            if not done.cancelled() and done.exception() is not None and self._failure is None:
                self._failure = done.exception()

        future.add_done_callback(written)
        if self._unwritten > _WINDOW or size >= _LARGE:
            # Shielded: once queued, the frame is written whole whatever happens to this send.
            # Frames are written in order, so this one done means every earlier one is too.
            await asyncio.shield(future)

    async def close(self) -> None:
        """End our side: what was sent is written and flushed first."""
        if self._closed:
            return
        self._closed = True
        flushed = self._enqueue(None)
        self._writes.put(None)
        try:
            await flushed
        except ChannelClosed:
            pass

    async def abort(self) -> None:
        """Stop sending, and return at once instead of waiting for what was already sent.

        Nothing is interrupted: the (daemon) writer thread still writes what was queued, and on
        a stdout nobody reads it stays blocked there. Interpreter shutdown can then still hang
        flushing stdout; only something reading the pipe, or closing it, ends that."""
        self._closed = True
        if self._writing:
            self._writes.put(None)


def serve_stdio(*, redirect_console: bool = True, **options: Any) -> RpcPeer:
    """Serve an agent on this process's stdin and stdout, for any ACP client.
    `print()` and anything else that writes to `sys.stdout` writes to stderr from
    then on, so a stray line cannot corrupt the protocol stream (`redirect_console=False`
    to keep it). Options are `serve_agent()`'s. Needs a running event loop."""
    from .agent import serve_agent

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    if redirect_console:
        sys.stdout = sys.stderr
    return serve_agent(ndjson(_StdioChannel(stdin, stdout)), **options)
