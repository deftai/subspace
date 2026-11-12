"""The agent side of ACP, written once for v1 and v2.

    async def prompt(turn):
        await turn.say(f"You said: {turn.text}")
        return "end_turn"

    serve_agent(channel, name="echo", prompt=prompt)

- The client's `session/cancel` aborts `turn.signal`; return when it fires.
  The turn then ends `cancelled`, and tool calls still open are marked failed.
- Unknown sessions get -32002 (never a silently created session).
- v1 and v2 differ on the wire (tool call create vs upsert, prompt answer vs
  idle state); the handler does not see that.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import uuid
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeVar

from deft_subspace.kernel import (
    AbortController,
    AbortSignal,
    Channel,
    ErrorCode,
    InboundContext,
    LocalError,
    RpcError,
    RpcPeer,
    SubspaceError,
    cancel_request,
)

from . import schemas
from .background import SessionWork, Work, base64
from .capabilities import CapabilityError, ClientSupport, client_support
from .endpoint import (
    AgentLayer,
    CallContext,
    EndpointCall,
    EndpointClient,
    EndpointContext,
    Next,
    StateKey,
    agent_endpoint,
    state_key,
)
from .extensions import ExtensionHandler, ExtensionNotification, ExtensionRequest, call_extension
from .mcp import AcpMcpServer, McpOutcome, McpServer, parse_mcp_servers
from .mcp_caller import McpCaller, McpCallOptions, McpServerClient, server_client
from .mcp_connections import ExternalMcpServer, McpConnector, SessionMcpConnections
from .model import ContentBlock, PermissionOption, ProtocolVersion, StopReason, ToolCallContent
from .tools import ToolContext, ToolDefinition, check_tool_input, tool_output_text, tool_title

T = TypeVar("T")


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


_tasks: set[asyncio.Task[Any]] = set()


def _spawn(coroutine: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
    task = asyncio.get_running_loop().create_task(coroutine)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


def _random_uuid() -> str:
    return str(uuid.uuid4())


def _is_final(status: Any) -> bool:
    return status in ("completed", "failed", "cancelled")


def _text(t: str) -> list[ToolCallContent]:
    return [{"type": "content", "content": {"type": "text", "text": t}}]


def _wire(**fields: Any) -> dict[str, Any]:
    """Keyword fields in ACP's wire names, None left out."""
    names = {"raw_input": "rawInput", "raw_output": "rawOutput"}
    return {names.get(k, k): v for k, v in fields.items() if v is not None}


DEFAULT_OPTIONS: list[PermissionOption] = [
    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
    {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
]


class PermissionDenied(SubspaceError):
    """Raised by `turn.tool()` when the user refused a tool that asked first.
    A prompt handler that lets it escape ends the turn `end_turn`: the agent
    stopped because it was not allowed, which is not an error."""

    def __init__(self, title: str) -> None:
        super().__init__(f"Not allowed: {title}")
        self.title = title


@dataclass(frozen=True)
class PermissionAnswer:
    """`allowed` is False for rejections and when the turn was cancelled."""

    outcome: Literal["selected", "cancelled"]
    allowed: bool
    #: For `selected`.
    option_id: str | None = None


@dataclass(frozen=True)
class ElicitAnswer:
    action: Literal["accept", "decline", "cancel"]
    #: For `accept`, when the client sent content.
    content: dict[str, Any] | None = None
    #: For URL-mode elicitations.
    elicitation_id: str | None = None


@dataclass(frozen=True)
class NewSessionRequest:
    cwd: str
    #: As sent.
    mcp_servers: list[Any]
    #: The same, typed; entries of unknown transports left out.
    servers: list[McpServer]
    #: session/new's params as sent.
    params: dict[str, Any]


@dataclass(frozen=True)
class LoadSessionRequest:
    session_id: str
    cwd: str
    mcp_servers: list[Any]
    servers: list[McpServer]
    params: dict[str, Any]
    #: Replay history through this before returning (when the client asked for replay).
    replay: ReplayWriter | None = None


# ---- turn handles ----------------------------------------------------------------


class ToolCallHandle:
    def __init__(self, writer: _TurnWriter, id: str, work: Work | None) -> None:
        self._writer = writer
        self._work = work
        self.id = id
        #: Fires when this tool call should stop: the turn is cancelled (unless it
        #: was detached), the client cancels it (if cancellable), or the session closes.
        self.signal: AbortSignal = work.controller.signal if work is not None else writer.signal

    async def update(
        self,
        *,
        title: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        content: list[ToolCallContent] | None = None,
        locations: list[Any] | None = None,
        raw_input: Any = None,
        raw_output: Any = None,
    ) -> None:
        await self._writer.tool_update(
            self.id, _wire(title=title, kind=kind, status=status, content=content, locations=locations, raw_input=raw_input, raw_output=raw_output)
        )

    async def complete(self, *, content: list[ToolCallContent] | None = None, raw_output: Any = None) -> None:
        await self._writer.tool_update(self.id, {**_wire(content=content, raw_output=raw_output), "status": "completed"})

    async def fail(self, *, content: list[ToolCallContent] | None = None, raw_output: Any = None) -> None:
        await self._writer.tool_update(self.id, {**_wire(content=content, raw_output=raw_output), "status": "failed"})

    async def cancelled(self, *, content: list[ToolCallContent] | None = None, raw_output: Any = None) -> None:
        """End it `cancelled` (e.g. after `signal` fired)."""
        await self._writer.tool_update(self.id, {**_wire(content=content, raw_output=raw_output), "status": "cancelled"})

    async def detach(self) -> None:
        """v2: keep it running in the background after the turn: listed on state
        updates, not stopped by `session/cancel`. Finish it with complete, fail or
        cancelled as usual. v1 has no background work: it is only no longer failed with the turn."""
        # No longer the turn's: not failed when it is cancelled.
        self._writer.open.discard(self.id)
        if self._work is not None and self._writer.protocol == 2 and self._writer.work is not None:
            await self._writer.work.detach(self._work)


class TerminalDisplay:
    """v2: a terminal the agent runs and shows the client (display only)."""

    def __init__(self, writer: _TurnWriter, id: str, work: Work, cancellable: bool) -> None:
        self._writer = writer
        self._work = work
        self._cancellable = cancellable
        self.id = id
        #: Fires when the client cancels it (if cancellable), the turn is cancelled (unless detached), or the session closes.
        self.signal: AbortSignal = work.controller.signal

    def _terminal(self, fields: dict[str, Any]) -> Awaitable[None]:
        return self._writer.update({"sessionUpdate": "terminal_update", "terminalId": self.id, **fields})

    async def write(self, data: str | bytes) -> None:
        """Append output (bytes, or text as UTF-8)."""
        await self._writer.update({"sessionUpdate": "terminal_output_chunk", "terminalId": self.id, "data": base64(data)})

    async def replace(self, data: str | bytes) -> None:
        """Replace all output so far."""
        await self._terminal({"output": {"data": base64(data)}})

    async def exit(self, *, exit_code: int | None = None, signal: str | None = None) -> None:
        """The process exited."""
        status = {k: v for k, v in (("exitCode", exit_code), ("signal", signal)) if v is not None}
        self._writer.terminals.discard(self._work)
        await self._terminal({"exitStatus": status, **({"capabilities": None} if self._cancellable else {})})
        assert self._writer.work is not None
        await self._writer.work.finish(self._work)

    async def detach(self) -> None:
        """Keep it running in the background after the turn (listed until it exits)."""
        self._writer.terminals.discard(self._work)
        assert self._writer.work is not None
        await self._writer.work.detach(self._work)


class TerminalHandle:
    """A command running in the client's terminal (v1)."""

    def __init__(self, peer: EndpointClient, session_id: str, terminal_id: str, signal: AbortSignal) -> None:
        self._peer = peer
        self._ref = {"sessionId": session_id, "terminalId": terminal_id}
        self._signal = signal
        self.id = terminal_id

    async def output(self) -> dict[str, Any]:
        """`{"output": str, "truncated": bool, "exitStatus"?: {...}}`."""
        return await self._peer.request("terminal/output", self._ref, signal=self._signal)

    async def wait_for_exit(self) -> dict[str, Any]:
        """`{"exitCode"?: int | None, "signal"?: str | None}`."""
        return await self._peer.request("terminal/wait_for_exit", self._ref, signal=self._signal)

    async def kill(self) -> None:
        await self._peer.request("terminal/kill", self._ref)

    async def release(self) -> None:
        await self._peer.request("terminal/release", self._ref)


class ReplayWriter(Protocol):
    """What `load_session` uses to replay history: updates only, no questions to the client."""

    async def say(self, text: str) -> None: ...
    async def think(self, text: str) -> None: ...
    async def user_message(self, text: str) -> None: ...
    async def tool_call(
        self,
        title: str,
        *,
        id: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        content: list[ToolCallContent] | None = None,
        locations: list[Any] | None = None,
        raw_input: Any = None,
        cancellable: bool = False,
    ) -> ToolCallHandle: ...
    async def tool_call_update(self, fields: dict[str, Any], *, create: bool = False) -> None: ...
    async def plan(self, entries: list[dict[str, Any]]) -> None: ...
    async def send_update(self, update: dict[str, Any]) -> None: ...


# ---- the turn --------------------------------------------------------------------


class _TurnWriter:
    """A turn's state and the updates it sends."""

    def __init__(
        self,
        peer: EndpointClient,
        session_id: str,
        protocol: ProtocolVersion,
        signal: AbortSignal,
        work: SessionWork | None,
    ) -> None:
        self.peer = peer
        self.session_id = session_id
        self.protocol: ProtocolVersion = protocol
        self.signal = signal
        self.work = work
        self.segment = 0
        self.last_was_text = False
        self.open: set[str] = set()
        #: The turn's terminals (v2), until they exit or are detached.
        self.terminals: set[Work] = set()
        self.turn_id = _random_uuid()[:8]

    def update(self, update: dict[str, Any]) -> Awaitable[None]:
        return self.peer.notify("session/update", {"sessionId": self.session_id, "update": update})

    async def state(self, state: Literal["running", "requires_action"]) -> None:
        if self.work is not None:
            self.work.state = state
        await self.update({"sessionUpdate": "state_update", "state": state, **(self.work.fields() if self.work else {})})

    async def idle(self, stop_reason: StopReason, error: Any = None) -> None:
        if self.work is not None:
            self.work.state = "idle"
        await self.update(
            {
                "sessionUpdate": "state_update",
                "state": "idle",
                "stopReason": stop_reason,
                **({"error": error} if error else {}),
                **(self.work.fields() if self.work else {}),
            }
        )

    async def end_open_work(self, reason: Any) -> None:
        """The turn was cancelled or its handler raised: fail the tool calls it left
        open, and stop and drop the terminals it neither detached nor exited."""
        for id in list(self.open):
            await self.tool_update(id, {"status": "failed"})
        for work in list(self.terminals):
            self.terminals.discard(work)
            if work.listed or work.final or self.work is None:
                continue
            work.controller.abort(reason)
            await self.work.finish(work)

    async def chunk(self, kind: Literal["agent_message_chunk", "agent_thought_chunk"], text: str) -> None:
        if not self.last_was_text:
            self.segment += 1
        self.last_was_text = True
        await self.update(
            {
                "sessionUpdate": kind,
                "messageId": f"{self.turn_id}-{'m' if kind == 'agent_message_chunk' else 't'}{self.segment}",
                "content": {"type": "text", "text": text},
            }
        )

    async def tool_call(
        self,
        title: str,
        *,
        id: str | None,
        kind: str | None,
        status: str | None,
        content: list[ToolCallContent] | None,
        locations: list[Any] | None,
        raw_input: Any,
        cancellable: bool,
    ) -> ToolCallHandle:
        self.last_was_text = False
        call_id = id if id is not None else f"call-{_random_uuid()[:8]}"
        cancellable = cancellable and self.protocol == 2 and self.work is not None
        # One created already finished is neither open nor work.
        done = _is_final(status)
        fields: dict[str, Any] = {
            "title": title,
            "kind": kind if kind is not None else "other",
            "status": status if status is not None else "pending",
            "content": content if content is not None else [],
            "locations": locations if locations is not None else [],
            **({"rawInput": raw_input} if raw_input is not None else {}),
            **({"capabilities": {"cancel": {}}} if cancellable and not done else {}),
        }
        if not done:
            self.open.add(call_id)
        work = self.work.add("tool_call", call_id, cancellable, self.signal) if self.work is not None and not done else None
        # v1 creates with tool_call; v2 has only the upsert.
        await self.update({"sessionUpdate": "tool_call" if self.protocol == 1 else "tool_call_update", "toolCallId": call_id, **fields})
        return ToolCallHandle(self, call_id, work)

    async def tool_update(self, id: str, fields: dict[str, Any]) -> None:
        self.last_was_text = False
        final = _is_final(fields.get("status"))
        if final:
            self.open.discard(id)
        work = self.work.get("tool_call", id) if self.work is not None else None
        # A finished tool call stops advertising cancel.
        await self.update(
            {
                "sessionUpdate": "tool_call_update",
                "toolCallId": id,
                **fields,
                **({"capabilities": None} if final and work is not None and work.cancellable else {}),
            }
        )
        if final and work is not None and self.work is not None:
            await self.work.finish(work)

    async def permission(self, title: str, tool_call_id: str | None, options: list[PermissionOption] | None, signal: AbortSignal) -> PermissionAnswer:
        options = options if options is not None else DEFAULT_OPTIONS
        # An existing tool call is referred to by id only, so its own title stays.
        tool_call = {"toolCallId": tool_call_id} if tool_call_id else {"toolCallId": f"permission-{_random_uuid()[:8]}", "title": title}
        if self.protocol == 2:
            params: dict[str, Any] = {"sessionId": self.session_id, "title": title, "subject": {"type": "tool_call", "toolCall": tool_call}, "options": options}
        else:
            params = {"sessionId": self.session_id, "toolCall": tool_call, "options": options}
        try:
            result = await self.peer.request("session/request_permission", params, signal=signal)
            outcome = result.get("outcome") if isinstance(result, dict) else None
            if isinstance(outcome, dict) and outcome.get("outcome") == "selected" and isinstance(outcome.get("optionId"), str):
                option_id: str = outcome["optionId"]
                option = next((o for o in options if o.get("optionId") == option_id), None)
                allowed = option is not None and str(option.get("kind", "")).startswith("allow")
                return PermissionAnswer("selected", allowed, option_id)
        except Exception:  # noqa: BLE001
            # Aborted, closed, or an error answer: treated as not allowed.
            pass
        return PermissionAnswer("cancelled", False)


class AgentTurn:
    """One prompt turn, as the prompt handler sees it."""

    def __init__(
        self,
        writer: _TurnWriter,
        prompt: list[ContentBlock],
        client_capabilities: dict[str, Any],
        servers: list[McpServer],
        mcp_caller: McpCaller | None,
        connections: SessionMcpConnections | None,
    ) -> None:
        self._writer = writer
        self._mcp_caller = mcp_caller
        self._connections = connections
        self.session_id = writer.session_id
        self.protocol: ProtocolVersion = writer.protocol
        #: What the client said it can do in initialize (v1 `clientCapabilities`, v2 `capabilities`).
        self.client_capabilities = client_capabilities
        #: The same, as one shape for v1 and v2.
        self.client_supports: ClientSupport = client_support(writer.protocol, client_capabilities)
        #: The session's MCP servers, typed (from session/new, load or resume).
        self.mcp_servers: list[McpServer] = servers
        self.prompt = prompt
        #: The prompt's text blocks, joined.
        self.text = "\n".join(b["text"] for b in prompt if isinstance(b, dict) and b.get("type") == "text" and b.get("text"))
        #: Aborted when the client cancels the turn or the connection closes.
        self.signal: AbortSignal = writer.signal

    def mcp(self, name: str) -> McpServerClient:
        """One of the session's MCP servers, by name: `list_tools()`, `call_tool()`,
        `request()`. `acp` servers go over this connection; `stdio`, `http` and
        `sse` ones through the agent's `mcp_connector`, connected on first use and
        kept for the session. Calls are cancelled with the turn. Raises if the
        session has no server of that name, or it is one the agent can't connect
        to (no connector, or not its transport)."""
        servers = self.mcp_servers
        server = next((s for s in servers if s.name == name), None)
        if server is None:
            listed = ", ".join(s.name for s in servers) or "none"
            raise RuntimeError(f'The session has no MCP server "{name}" (servers: {listed})')
        defaults = McpCallOptions(signal=self.signal)
        if isinstance(server, AcpMcpServer):
            if self._mcp_caller is None:
                raise RuntimeError(f'MCP server "{name}" is acp, and this agent has no mcp layer')
            return self._mcp_caller.server(server, defaults)
        external: ExternalMcpServer = server
        connections = self._connections
        problem = connections.problem(external) if connections is not None else f"MCP server \"{name}\" can't be used here"
        if problem or connections is None:
            raise RuntimeError(problem)

        async def send(method: str, params: dict[str, Any] | None, options: McpCallOptions) -> McpOutcome:
            connection = await connections.get(external, options.signal)
            return await connection.request(method, params, options)

        return server_client(external, send, defaults)

    async def read_file(self, path: str, *, line: int | None = None, limit: int | None = None) -> str:
        """Read a file through the client (v1 `fs/read_text_file`). Raises a `CapabilityError` if it offers none."""
        if not self.client_supports.read_text_file:
            raise CapabilityError("fs/read_text_file", "client")
        params = {"sessionId": self.session_id, "path": path, **_wire(line=line, limit=limit)}
        result = await self._writer.peer.request("fs/read_text_file", params, signal=self.signal)
        return result["content"]

    async def write_file(self, path: str, content: str) -> None:
        """Write a file through the client (v1 `fs/write_text_file`). Raises a `CapabilityError` if it offers none."""
        if not self.client_supports.write_text_file:
            raise CapabilityError("fs/write_text_file", "client")
        await self._writer.peer.request("fs/write_text_file", {"sessionId": self.session_id, "path": path, "content": content}, signal=self.signal)

    async def complete_elicitation(self, elicitation_id: str) -> None:
        """Tell the client a URL-mode elicitation finished (`elicitation/complete`)."""
        await self._writer.peer.notify("elicitation/complete", {"sessionId": self.session_id, "elicitationId": elicitation_id})

    async def call(self, extension: ExtensionRequest[Any, Any], params: Any) -> Any:
        """Call one of the client's vendor extension requests. Aborted with the turn."""
        return await call_extension(self._writer.peer.request, extension, params, signal=self.signal)

    async def notify(self, extension: ExtensionNotification[Any], params: Any) -> None:
        """Send one of the client's vendor extension notifications."""
        await self._writer.peer.notify(extension.method, schemas.to_json(params))

    async def say(self, text: str) -> None:
        await self._writer.chunk("agent_message_chunk", text)

    async def think(self, text: str) -> None:
        await self._writer.chunk("agent_thought_chunk", text)

    async def tool_call(
        self,
        title: str,
        *,
        id: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        content: list[ToolCallContent] | None = None,
        locations: list[Any] | None = None,
        raw_input: Any = None,
        cancellable: bool = False,
    ) -> ToolCallHandle:
        """Show a tool call. `cancellable` (v2): let the client cancel this tool call alone
        (`tool_call/cancel`); watch `handle.signal`."""
        return await self._writer.tool_call(
            title, id=id, kind=kind, status=status, content=content, locations=locations, raw_input=raw_input, cancellable=cancellable
        )

    async def tool(
        self,
        title: str,
        run: Callable[[ToolCallHandle], Any],
        *,
        id: str | None = None,
        kind: str | None = None,
        content: list[ToolCallContent] | None = None,
        locations: list[Any] | None = None,
        raw_input: Any = None,
        cancellable: bool = False,
        ask: bool | str = False,
    ) -> Any:
        """Run a tool as one step: show the tool call, ask first if `ask` is set
        (True, or the question to ask), run `run`, and complete it with what
        `run` returns (a string becomes text content) or fail it if `run` raises.
        A refusal raises `PermissionDenied`; let it escape to end the turn.

            files = await turn.tool("List files", lambda call: os.listdir(cwd), kind="read")
            await turn.tool("Delete build/", lambda call: shutil.rmtree("build"), kind="delete", ask=True)
        """
        w = self._writer
        call = await w.tool_call(
            title,
            id=id,
            kind=kind,
            status="pending" if ask else "in_progress",
            content=content,
            locations=locations,
            raw_input=raw_input,
            cancellable=cancellable,
        )
        if ask:
            answer = await w.permission(ask if isinstance(ask, str) else title, call.id, None, w.signal)
            if not answer.allowed:
                await call.fail(content=_text("Cancelled" if answer.outcome == "cancelled" else "Not allowed"))
                raise PermissionDenied(title)
            await call.update(status="in_progress")
        try:
            result = await _resolve(run(call))
        except Exception as error:
            # v1 has no cancelled status.
            if call.signal.aborted and w.protocol == 2:
                await call.cancelled()
            else:
                await call.fail(content=_text(str(error)))
            raise
        if isinstance(result, str):
            await call.complete(content=_text(result))
        elif result is None:
            await call.complete()
        else:
            await call.complete(raw_output=result)
        return result

    async def use_tool(self, definition: ToolDefinition, input: Any, name: str = "tool") -> Any:
        """Run a defined tool (`tool(...)`) as one step: its input is checked,
        its title, kind and `ask` used, and its output becomes the tool call's
        content. Returns the output; raises like `tool()`."""
        ok, checked = check_tool_input(definition, input)
        if not ok:
            raise ValueError(f"{name}: invalid input: {'; '.join(checked)}")
        value = checked

        async def run(call: ToolCallHandle) -> Any:
            output = await _resolve(definition.run(value, ToolContext(signal=call.signal)))
            # Shown as text in the client; the caller gets the value.
            await call.update(content=_text(tool_output_text(output)))
            return output

        return await self.tool(
            tool_title(name, definition, value),
            run,
            kind=definition.kind if definition.kind is not None else "other",
            raw_input=value,
            ask=definition.ask or False,
        )

    async def show_terminal(
        self,
        *,
        command: str | None = None,
        cwd: str | None = None,
        size: dict[str, int] | None = None,
        cancellable: bool = False,
        id: str | None = None,
    ) -> TerminalDisplay:
        """v2: show the client a terminal this agent runs (`terminal_update`,
        `terminal_output_chunk`). Refer to it from a tool call with content
        `{"type": "terminal", "terminalId": display.id}`. Raises on v1.
        `cancellable`: let the client stop it (`terminal/cancel`); watch `display.signal`.
        `size`: `{"cols": ..., "rows": ...}`."""
        w = self._writer
        if w.protocol != 2 or w.work is None:
            raise CapabilityError("agent terminals (protocol v2)", "client")
        terminal_id = id if id is not None else f"term-{_random_uuid()[:8]}"
        work = w.work.add("terminal", terminal_id, cancellable, w.signal)
        w.terminals.add(work)
        display = TerminalDisplay(w, terminal_id, work, cancellable)
        await display._terminal(
            {
                **_wire(command=command, cwd=cwd),
                **({"size": size} if size else {}),
                **({"capabilities": {"cancel": {}}} if cancellable else {}),
            }
        )
        return display

    async def plan(self, entries: list[dict[str, Any]]) -> None:
        """Entries: `{"content": str, "priority"?: str, "status"?: str}`."""
        planned = [_plan_entry(e) for e in entries]
        if self.protocol == 2:
            await self._writer.update({"sessionUpdate": "plan_update", "plan": {"type": "items", "entries": planned}})
        else:
            await self._writer.update({"sessionUpdate": "plan", "entries": planned})

    async def request_permission(
        self, title: str, *, tool_call_id: str | None = None, options: list[PermissionOption] | None = None
    ) -> PermissionAnswer:
        """Ask the user. `allowed` is False for rejections and when the turn was cancelled."""
        return await self._writer.permission(title, tool_call_id, options, self.signal)

    async def tool_call_update(self, fields: dict[str, Any], *, create: bool = False) -> None:
        """Send a tool call update you already have in ACP shape (wire names: `toolCallId`,
        `rawInput`, ...; e.g. from a model pipeline). `create` marks the first one: v1 sends
        it as `tool_call`; v2 always upserts with `tool_call_update`."""
        w = self._writer
        w.last_was_text = False
        tool_call_id = fields["toolCallId"]
        final = _is_final(fields.get("status"))
        # Tracked as tool_call() does: open (and v2 work) from a create until a final status.
        if create and not final and tool_call_id not in w.open:
            w.open.add(tool_call_id)
            if w.work is not None and w.work.get("tool_call", tool_call_id) is None:
                w.work.add("tool_call", tool_call_id, False, w.signal)
        if final:
            w.open.discard(tool_call_id)
        await w.update({**fields, "sessionUpdate": "tool_call" if create and self.protocol == 1 else "tool_call_update"})
        work = w.work.get("tool_call", tool_call_id) if final and w.work is not None else None
        if work is not None and w.work is not None:
            await w.work.finish(work)

    async def send_update(self, update: dict[str, Any]) -> None:
        """Send any `session/update` as given. You are responsible for it suiting `protocol`."""
        await self._writer.update(update)

    async def request(self, method: str, params: Any = None, *, signal: AbortSignal | None = None, timeout_ms: float | None = None) -> Any:
        """Call the client (e.g. `fs/read_text_file`, `terminal/create`). Aborted with the turn unless you pass a signal.
        Dict params without a `sessionId` get this turn's (ACP requires it on the client methods); one you set is kept."""
        with_session = {"sessionId": self.session_id, **params} if isinstance(params, dict) and "sessionId" not in params else params
        return await self._writer.peer.request(method, with_session, signal=signal if signal is not None else self.signal, timeout_ms=timeout_ms)

    async def user_message(self, text: str) -> None:
        """Echo or record the user's own message as an update (`user_message_chunk`)."""
        await self._writer.update(
            {"sessionUpdate": "user_message_chunk", "messageId": f"{self._writer.turn_id}-u", "content": {"type": "text", "text": text}}
        )

    async def terminal(
        self,
        command: str,
        *,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        output_byte_limit: int | None = None,
    ) -> TerminalHandle:
        """Run a command in the client's terminal (v1 clients that advertise `terminal`).
        Raises if the client offers none. Release the handle when done."""
        if not self.client_supports.terminal:
            raise CapabilityError("terminals", "client")
        params: dict[str, Any] = {
            "sessionId": self.session_id,
            "command": command,
            "args": args if args is not None else [],
            "env": [{"name": k, "value": v} for k, v in (env or {}).items()],
            **({"cwd": cwd} if cwd else {}),
            **({"outputByteLimit": output_byte_limit} if output_byte_limit else {}),
        }
        created = await self._writer.peer.request("terminal/create", params, signal=self.signal)
        return TerminalHandle(self._writer.peer, self.session_id, created["terminalId"], self.signal)

    async def elicit(
        self,
        message: str,
        *,
        requested_schema: Any = None,
        url: str | None = None,
        tool_call_id: str | None = None,
    ) -> ElicitAnswer:
        """Ask the user through the client (`elicitation/create`). Raises if the client
        offers no elicitation. A cancelled turn answers `cancel`."""
        mode: Literal["url", "form"] = "url" if url else "form"
        if not self.client_supports.elicitation[mode]:
            raise CapabilityError(f"{mode} elicitation", "client")
        elicitation_id = _random_uuid() if mode == "url" else None
        params: dict[str, Any] = {
            "sessionId": self.session_id,
            "mode": mode,
            "message": message,
            **({"toolCallId": tool_call_id} if tool_call_id else {}),
            **(
                {"requestedSchema": requested_schema if requested_schema is not None else {"type": "object", "properties": {}}}
                if mode == "form"
                else {"url": url, "elicitationId": elicitation_id}
            ),
        }
        try:
            answer = await self._writer.peer.request("elicitation/create", params, signal=self.signal)
            action = answer.get("action") if isinstance(answer, dict) else None
            if action == "accept":
                content = answer.get("content")
                return ElicitAnswer("accept", content if content else None, elicitation_id)
            if action == "decline":
                return ElicitAnswer("decline", None, elicitation_id)
        except Exception as error:
            # Aborted with the turn, or the connection gone: nobody answered. Anything else is the caller's.
            if not self.signal.aborted and not LocalError.is_(error, "aborted") and not LocalError.is_(error, "closed"):
                raise
        return ElicitAnswer("cancel", None, elicitation_id)


def _plan_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {"content": entry["content"], "priority": entry.get("priority") or "medium", "status": entry.get("status") or "pending"}


# ---- layers ----------------------------------------------------------------------


def _mcp_capabilities(protocol: ProtocolVersion, transports: list[str]) -> dict[str, Any]:
    """initialize's MCP capability, in each protocol's spelling."""
    if protocol == 2:
        return {t: {} for t in transports if t != "sse"}
    return {t: True for t in transports if t != "stdio"}


@dataclass
class _Negotiated:
    """What `initialize` settled. Before it: v1 and no client capabilities."""

    protocol: ProtocolVersion
    client_capabilities: dict[str, Any]
    #: initialize was answered: a second one is refused (the protocol can't change mid-connection).
    initialized: bool = False


NEGOTIATED: StateKey[_Negotiated] = state_key("negotiated")


@dataclass(eq=False)
class _AgentSession:
    """One session: its servers and cwd, and what each part attached to it."""

    id: str
    servers: list[McpServer]
    cwd: str
    parts: dict[str, Any] = field(default_factory=dict)


@dataclass
class _SessionPart:
    """Something that lives with a session (MCP connections, turns, background
    work). Close runs every `stop`, removes the session, then every `release`,
    then `close_session`. A closed connection runs `disconnect` only (MCP
    connections close; turns and their background work stop), then
    `connection_closed` with the sessions that were open."""

    name: str
    create: Callable[[_AgentSession], Any]
    reset: Callable[[Any, _AgentSession], Any] | None = None
    stop: Callable[[Any, _AgentSession, BaseException], None] | None = None
    release: Callable[[Any, _AgentSession], Any] | None = None
    disconnect: Callable[[Any, _AgentSession], Any] | None = None


class _SessionLifecycle:
    def __init__(self, close_session: Callable[[str], Any] | None, connection_closed: Callable[[list[str]], Any] | None = None) -> None:
        self.sessions: dict[str, _AgentSession] = {}
        self._parts: list[_SessionPart] = []
        self._close_session = close_session
        self._connection_closed = connection_closed

    def attach(self, part: _SessionPart) -> None:
        self._parts.append(part)

    def part(self, session: _AgentSession, name: str) -> Any:
        return session.parts.get(name)

    def require(self, session_id: Any) -> _AgentSession:
        """The session, or -32002 (never a silently created one)."""
        session = self.sessions.get(session_id) if isinstance(session_id, str) else None
        if session is None:
            raise RpcError.not_found(f"Unknown session {'undefined' if session_id is None else session_id}", {"sessionId": session_id})
        return session

    def open(self, id: str, servers: list[McpServer], cwd: str) -> _AgentSession:
        session = _AgentSession(id, servers, cwd)
        for part in self._parts:
            session.parts[part.name] = part.create(session)
        self.sessions[id] = session
        return session

    async def reopen(self, id: str, servers: list[McpServer], cwd: str) -> None:
        """Load or resume: an open session gets its new servers and cwd; otherwise it is opened."""
        existing = self.sessions.get(id)
        if existing is None:
            self.open(id, servers, cwd)
            return
        existing.servers = servers
        existing.cwd = cwd
        for part in self._parts:
            if part.reset is not None:
                await _resolve(part.reset(existing.parts.get(part.name), existing))

    async def close(self, session: _AgentSession) -> None:
        reason = Exception("session closed")
        for part in self._parts:
            if part.stop is not None:
                part.stop(session.parts.get(part.name), session, reason)
        self.sessions.pop(session.id, None)
        for part in self._parts:
            if part.release is not None:
                await _resolve(part.release(session.parts.get(part.name), session))
        if self._close_session is not None:
            await _resolve(self._close_session(session.id))

    async def disconnect(self) -> None:
        async def one(part: _SessionPart, session: _AgentSession) -> None:
            if part.disconnect is not None:
                await _resolve(part.disconnect(session.parts.get(part.name), session))

        open_ = list(self.sessions.values())
        # Every part is told, and the connection-level hook runs, even if one part fails.
        results = await asyncio.gather(*(one(part, session) for session in open_ for part in self._parts), return_exceptions=True)
        if self._connection_closed is not None:
            await _resolve(self._connection_closed([session.id for session in open_]))
        for result in results:
            if isinstance(result, BaseException):
                raise result


SESSIONS: StateKey[_SessionLifecycle] = state_key("sessions")


@dataclass
class _McpPart:
    caller: McpCaller


MCP: StateKey[_McpPart] = state_key("mcp")


def _as_peer_handler(handler: Callable[[Any, InboundContext], Any]) -> Callable[..., Any]:
    """Peer-style handlers adapted to the endpoint: `(params, context)` as the peer would call them."""

    def adapted(call: EndpointCall, ctx: CallContext, *_rest: Any) -> Any:
        is_request = call.kind == "request"
        return handler(call.params, InboundContext(method=call.method, signal=ctx.signal, peer=ctx.peer, id=call.id, is_request=is_request))

    return adapted


@dataclass(frozen=True)
class _Options:
    name: str
    version: str
    prompt: Callable[[AgentTurn], Any]
    protocols: list[ProtocolVersion]
    capabilities: dict[str, Any]
    mcp_transports: list[str] | None
    mcp_connector: McpConnector | None
    new_session: Callable[[NewSessionRequest], Any] | None
    load_session: Callable[[LoadSessionRequest], Any] | None
    close_session: Callable[[str], Any] | None
    connection_closed: Callable[[list[str]], Any] | None
    queue_prompts: bool
    extensions: list[ExtensionHandler]
    methods: dict[str, Callable[[Any, InboundContext], Any]]


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value.strip()) if value.strip() else 0
        except ValueError:
            return None
    return None


def _negotiate_layer(options: _Options, load_session: bool) -> AgentLayer[None]:
    """`initialize`: version choice and the agent's capabilities."""
    accepted = options.protocols

    def initialize(call: EndpointCall, ctx: CallContext, _state: Any, _next: Next) -> Any:
        if ctx.get(NEGOTIATED).initialized:
            raise RpcError(ErrorCode.INVALID_REQUEST, "Already initialized")
        params = call.params if isinstance(call.params, dict) else {}
        asked = _as_number(params.get("protocolVersion"))
        best: ProtocolVersion = max(accepted)
        protocol: ProtocolVersion = best
        for p in accepted:
            if asked == p:
                protocol = p
        caps = params.get("capabilities") if protocol == 2 else params.get("clientCapabilities")
        ctx.set(NEGOTIATED, _Negotiated(protocol, caps if isinstance(caps, dict) else {}, initialized=True))
        info = {"name": options.name, "version": options.version}
        transports = options.mcp_transports
        if transports is None:
            transports = list(options.mcp_connector.transports) if options.mcp_connector is not None else []
        mcp = _mcp_capabilities(protocol, transports)
        extra = options.capabilities
        if protocol == 2:
            extra_session = extra.get("session")
            session: dict[str, Any] = dict(extra_session) if isinstance(extra_session, dict) else {}
            if mcp:
                session_mcp = session.get("mcp")
                session["mcp"] = {**mcp, **(session_mcp if isinstance(session_mcp, dict) else {})}
            return {"protocolVersion": 2, "info": info, "capabilities": {**extra, **({"session": session} if session else {})}, "authMethods": []}
        # Merged like v2's: extra session and MCP capabilities add to these, they don't replace them.
        rest = {k: v for k, v in extra.items() if k not in ("sessionCapabilities", "mcpCapabilities")}
        extra_session = extra.get("sessionCapabilities")
        extra_mcp = extra.get("mcpCapabilities")
        mcp_capabilities = {**mcp, **(extra_mcp if isinstance(extra_mcp, dict) else {})}
        return {
            "protocolVersion": 1,
            "agentInfo": info,
            "agentCapabilities": {
                "loadSession": load_session,
                **rest,
                "sessionCapabilities": {
                    "close": {},
                    **({"resume": {}} if load_session else {}),
                    **(extra_session if isinstance(extra_session, dict) else {}),
                },
                **({"mcpCapabilities": mcp_capabilities} if mcp_capabilities else {}),
            },
            "authMethods": [],
        }

    return AgentLayer(
        name="negotiate",
        provides=[NEGOTIATED],
        create=lambda ctx: ctx.set(NEGOTIATED, _Negotiated(1, {})),
        requests={"initialize": initialize},
    )


def _sessions_layer(options: _Options, replay_writer: Callable[[EndpointContext, str], ReplayWriter]) -> AgentLayer[_SessionLifecycle]:
    """`session/new`, `load`, `resume` and `close`, and the session lifecycle service."""

    async def new_session(call: EndpointCall, _ctx: CallContext, sessions: _SessionLifecycle, _next: Next) -> Any:
        params = call.params
        if not isinstance(params, dict) or not isinstance(params.get("cwd"), str):
            raise RpcError.invalid_params("cwd is required")
        raw = params.get("mcpServers")
        mcp_servers: list[Any] = raw if isinstance(raw, list) else []
        servers, _unknown = parse_mcp_servers(mcp_servers)
        created = None
        if options.new_session is not None:
            created = await _resolve(options.new_session(NewSessionRequest(params["cwd"], mcp_servers, servers, params)))
        if isinstance(created, str):
            session_id = created
        elif isinstance(created, dict) and created.get("sessionId"):
            session_id = str(created["sessionId"])
        else:
            session_id = _random_uuid()
        # Never replace an open session (its turns, background work and MCP servers would be left running).
        if session_id in sessions.sessions:
            raise RpcError.invalid_params(f"Session {session_id} is already open", {"sessionId": session_id})
        sessions.open(session_id, servers, params["cwd"])
        return {"sessionId": session_id}

    async def close_session(call: EndpointCall, _ctx: CallContext, sessions: _SessionLifecycle, _next: Next) -> Any:
        params = call.params if isinstance(call.params, dict) else {}
        await sessions.close(sessions.require(params.get("sessionId")))
        return {}

    requests: dict[str, Any] = {"session/new": new_session, "session/close": close_session}

    if options.load_session is not None:
        load = options.load_session

        async def open_(params: Any, replay: bool, ctx: EndpointContext, sessions: _SessionLifecycle) -> Any:
            if not isinstance(params, dict) or not isinstance(params.get("sessionId"), str):
                raise RpcError.invalid_params("sessionId is required")
            if not isinstance(params.get("cwd"), str):
                raise RpcError.invalid_params("cwd is required")
            session_id: str = params["sessionId"]
            writer = replay_writer(ctx, session_id) if replay else None
            raw = params.get("mcpServers")
            mcp_servers: list[Any] = raw if isinstance(raw, list) else []
            servers, _unknown = parse_mcp_servers(mcp_servers)
            result = await _resolve(load(LoadSessionRequest(session_id, params["cwd"], mcp_servers, servers, params, writer)))
            await sessions.reopen(session_id, servers, params["cwd"])
            return result if result is not None else {}

        def load_session(call: EndpointCall, ctx: CallContext, sessions: _SessionLifecycle, _next: Next) -> Any:
            return open_(call.params, True, ctx, sessions)

        def resume_session(call: EndpointCall, ctx: CallContext, sessions: _SessionLifecycle, _next: Next) -> Any:
            params = call.params
            replay = ctx.get(NEGOTIATED).protocol == 2 and isinstance(params, dict) and bool(params.get("replayFrom"))
            return open_(params, replay, ctx, sessions)

        requests["session/load"] = load_session
        requests["session/resume"] = resume_session

    def create(ctx: EndpointContext) -> _SessionLifecycle:
        sessions = _SessionLifecycle(options.close_session, options.connection_closed)
        ctx.set(SESSIONS, sessions)
        return sessions

    return AgentLayer(
        name="sessions",
        requires=[NEGOTIATED],
        provides=[SESSIONS],
        create=create,
        requests=requests,
        closed=lambda _info, _ctx, sessions: sessions.disconnect(),
    )


def _mcp_layer(options: _Options) -> AgentLayer[_McpPart]:
    """The session's MCP servers: `acp` ones over this connection, and the agent's own connections to the rest."""

    def create(ctx: EndpointContext) -> _McpPart:
        part = _McpPart(McpCaller(ctx.client, {"name": options.name, "version": options.version}))
        ctx.set(MCP, part)
        ctx.get(SESSIONS).attach(
            _SessionPart(
                name="mcp",
                create=lambda session: SessionMcpConnections(options.mcp_connector, session.cwd),
                reset=lambda connections, session: connections.reset(session.cwd),
                release=lambda connections, _session: connections.close(),
                # MCP servers the agent started (stdio) or connected to go with the connection.
                disconnect=lambda connections, _session: connections.close(),
            )
        )
        return part

    return AgentLayer(
        name="mcp",
        requires=[SESSIONS],
        provides=[MCP],
        create=create,
        notifications={"mcp/message": lambda call, _ctx, part, _next: part.caller.receive(call.params)},
    )


TurnPhase = Literal["queued", "running", "finishing", "ended"]
"""Where a prompt is in its session's queue: waiting for the turn ahead (`queued`), in the
prompt handler (`running`), sending its last updates (`finishing`: open tool calls failed,
v2's idle state), then `ended`. Only an ended turn lets the next one start, so its updates
never interleave. Queued and running turns make the session busy; a finishing one does not
(a prompt sent on its idle state waits the moment it takes to end)."""


@dataclass(eq=False)
class _SessionTurn:
    controller: AbortController
    #: Settles when the turn is `ended`.
    ended: asyncio.Future[None]
    phase: TurnPhase = "queued"


@dataclass(eq=False)
class _TurnsPart:
    """A session's turns (the queue) and background work (v2)."""

    work: SessionWork
    #: Turns not yet ended, in order: the first is running or finishing, the rest are queued.
    turns: deque[_SessionTurn] = field(default_factory=deque)


def _abort_turns(turns: _TurnsPart, reason: BaseException) -> None:
    """Stop every turn of the session that has not ended, the running one and the queued ones."""
    for turn in list(turns.turns):
        turn.controller.abort(reason)


def _cancelling() -> bool:
    """Whether the current task itself is being cancelled (not just something it awaited)."""
    task = asyncio.current_task()
    return task is not None and task.cancelling() > 0


def _turns_layer(options: _Options) -> AgentLayer[None]:
    """`session/prompt` and the ways to stop work: the v1 and v2 turn lifecycles."""

    def create(ctx: EndpointContext) -> None:
        def make(session: _AgentSession) -> _TurnsPart:
            session_id = session.id
            return _TurnsPart(work=SessionWork(lambda update: ctx.client.notify("session/update", {"sessionId": session_id, "update": update})))

        def stop(turns: _TurnsPart, _session: _AgentSession, reason: BaseException) -> None:
            _abort_turns(turns, reason)
            # Closing stops background work too.
            turns.work.close_all()

        def disconnect(turns: _TurnsPart, _session: _AgentSession) -> None:
            # The client gone: detached work no longer follows the turn's signal, so stop it here.
            reason = Exception("connection closed")
            _abort_turns(turns, reason)
            turns.work.close_all(reason)

        ctx.get(SESSIONS).attach(_SessionPart(name="turns", create=make, stop=stop, disconnect=disconnect))

    async def prompt(call: EndpointCall, ctx: CallContext, _state: Any, _next: Next) -> Any:
        params = call.params if isinstance(call.params, dict) else {}
        sessions = ctx.get(SESSIONS)
        session = sessions.require(params.get("sessionId"))
        turns: _TurnsPart = sessions.part(session, "turns")
        negotiated = ctx.get(NEGOTIATED)
        protocol = negotiated.protocol
        # A turn that is only finishing (its handler returned) does not refuse the next prompt; that one waits for its end.
        busy = any(t.phase in ("queued", "running") for t in turns.turns)
        if busy and not options.queue_prompts:
            raise RpcError.invalid_params(f"Session {session.id} already has a turn running")
        controller = AbortController()
        # The session's controller and the connection; not this request's own signal ($/cancel_request does not stop a turn).
        signal = AbortSignal.any([controller.signal, ctx.peer.signal])
        raw_prompt = params.get("prompt")
        prompt_blocks: list[ContentBlock] = raw_prompt if isinstance(raw_prompt, list) else []
        mcp_part = ctx.peek(MCP)
        writer = _TurnWriter(ctx.client, session.id, protocol, signal, turns.work)
        turn = AgentTurn(
            writer,
            prompt_blocks,
            negotiated.client_capabilities,
            session.servers,
            mcp_part.caller if mcp_part is not None else None,
            sessions.part(session, "mcp"),
        )
        # Wait for the turn ahead (if any), in order.
        ahead = turns.turns[-1].ended if turns.turns else None
        entry = _SessionTurn(controller, asyncio.get_running_loop().create_future())
        turns.turns.append(entry)

        async def run() -> StopReason:
            stop: StopReason = "cancelled"
            failure: Exception | None = None

            async def finish() -> None:
                # The turn's last updates go out before the next turn may start.
                nonlocal stop
                if signal.aborted:
                    stop = "cancelled"
                entry.phase = "finishing"
                try:
                    if stop == "cancelled" or failure is not None:
                        await writer.end_open_work(signal.reason if signal.aborted else failure)
                    if protocol == 2:
                        await writer.idle(stop, {"message": str(failure)} if failure is not None else None)
                finally:
                    entry.phase = "ended"
                    # Let go of the connection's signal: it outlives the turn.
                    signal.dispose()
                    if entry in turns.turns:
                        turns.turns.remove(entry)
                    if not entry.ended.done():
                        entry.ended.set_result(None)

            try:
                if ahead is not None:
                    await asyncio.shield(ahead)
                if not signal.aborted:
                    entry.phase = "running"
                    if protocol == 2:
                        await writer.state("running")
                    result = await _resolve(options.prompt(turn))
                    stop = result if result is not None else "end_turn"
            except asyncio.CancelledError:
                if not signal.aborted or _cancelling():
                    # This task itself was cancelled: end the turn, then let the cancel go on.
                    with contextlib.suppress(Exception):
                        await finish()
                    raise
                # The handler cancelled its own work when the signal fired (task.cancel()).
                stop = "cancelled"
            except Exception as error:  # noqa: BLE001 - every handler error ends the turn
                if signal.aborted:
                    stop = "cancelled"
                elif isinstance(error, PermissionDenied):
                    # The agent stopped because the user said no: a normal end.
                    stop = "end_turn"
                else:
                    stop = "error"
                    failure = error
            await finish()
            if failure is not None and protocol == 1:
                raise failure
            return stop

        if protocol == 1:
            return {"stopReason": await run()}

        # v2: answer at once with the user message id, then run; the end is an idle state update.
        user_message_id = _random_uuid()

        async def later() -> None:
            try:
                await run()
            except Exception:  # noqa: BLE001
                pass

        asyncio.get_running_loop().call_soon(lambda: _spawn(later()))
        return {"messageId": user_message_id}

    def cancel(call: EndpointCall, ctx: CallContext, _state: Any, _next: Next) -> None:
        sessions = ctx.get(SESSIONS)
        params = call.params if isinstance(call.params, dict) else {}
        session_id = params.get("sessionId")
        session = sessions.sessions.get(session_id) if isinstance(session_id, str) else None
        if session is None:
            return
        # Queued prompts are cancelled too: the client asked for the session to stop.
        _abort_turns(sessions.part(session, "turns"), Exception("cancelled by the client"))

    return AgentLayer(
        name="turns",
        requires=[NEGOTIATED, SESSIONS],
        create=create,
        requests={
            # v2: stop one cancellable tool call or terminal (background work, or a step of the turn).
            "tool_call/cancel": lambda call, ctx, _s, _n: _cancel_work(call, ctx, "tool_call", "toolCallId"),
            "terminal/cancel": lambda call, ctx, _s, _n: _cancel_work(call, ctx, "terminal", "terminalId"),
            "session/prompt": prompt,
        },
        notifications={"session/cancel": cancel},
    )


def _cancel_work(call: EndpointCall, ctx: CallContext, kind: Literal["tool_call", "terminal"], key: str) -> dict[str, Any]:
    params = call.params if isinstance(call.params, dict) else {}
    sessions = ctx.get(SESSIONS)
    session = sessions.require(params.get("sessionId"))
    if not isinstance(params.get(key), str):
        raise RpcError.invalid_params(f"{key} is required")
    turns: _TurnsPart = sessions.part(session, "turns")
    turns.work.cancel(kind, params[key])
    return {}


def _extensions_layer(options: _Options) -> AgentLayer[None]:
    """`methods` and typed `extensions`."""
    requests: dict[str, Any] = {}
    notifications: dict[str, Any] = {}
    for method, handler in options.methods.items():
        if method != "*":
            requests[method] = _as_peer_handler(handler)
    for h in options.extensions:
        if h.method == "*":
            continue
        if h.kind == "request":
            requests[h.method] = _as_peer_handler(h.handler)
        else:
            notifications[h.method] = _as_peer_handler(h.handler)
    return AgentLayer(name="extensions", requests=requests, notifications=notifications)


def _agent_layers(options: _Options) -> list[AgentLayer[Any]]:
    """`serve_agent`'s layers, in order. `serve_agent` is `agent_endpoint` with these."""

    def replay_writer(ctx: EndpointContext, session_id: str) -> ReplayWriter:
        negotiated = ctx.get(NEGOTIATED)
        mcp_part = ctx.peek(MCP)
        writer = _TurnWriter(ctx.client, session_id, negotiated.protocol, AbortController().signal, None)
        return AgentTurn(writer, [], negotiated.client_capabilities, [], mcp_part.caller if mcp_part is not None else None, None)

    return [
        _negotiate_layer(options, options.load_session is not None),
        _sessions_layer(options, replay_writer),
        _mcp_layer(options),
        _turns_layer(options),
        _extensions_layer(options),
    ]


def serve_agent(
    channel: Channel[Any],
    *,
    name: str,
    prompt: Callable[[AgentTurn], Any],
    version: str | None = None,
    protocols: list[ProtocolVersion] | None = None,
    capabilities: dict[str, Any] | None = None,
    mcp_transports: list[Literal["stdio", "http", "sse", "acp"]] | None = None,
    mcp_connector: McpConnector | None = None,
    new_session: Callable[[NewSessionRequest], Any] | None = None,
    load_session: Callable[[LoadSessionRequest], Any] | None = None,
    close_session: Callable[[str], Any] | None = None,
    connection_closed: Callable[[list[str]], Any] | None = None,
    queue_prompts: bool = False,
    extensions: list[ExtensionHandler] | None = None,
    methods: dict[str, Callable[[Any, InboundContext], Any]] | None = None,
    peer: dict[str, Any] | None = None,
    telemetry: Any = None,
) -> RpcPeer:
    """Serve an agent on `channel`. Needs a running event loop. Returns the peer.

    - `prompt(turn)`: run one turn; return a stop reason (None: `end_turn`). Plain or async.
    - `protocols`: versions to accept. Default [1, 2].
    - `capabilities`: extra fields for initialize's capabilities (v1 `agentCapabilities`, v2 `capabilities`).
    - `mcp_transports`: MCP server transports to advertise. `acp` (servers the client serves
      over this connection) is handled here; `stdio`, `http` and `sse` need an `mcp_connector`
      (or the agent connects itself). v1 always takes stdio. Default: the connector's
      transports, else none (v1: stdio).
    - `mcp_connector`: connects to the session's `stdio`, `http` and `sse` MCP servers for `turn.mcp(name)`.
    - `new_session(request)`: may return a session id (a str, or `{"sessionId": ...}`). An id that
      is already open is refused (-32602), the open session kept.
    - `load_session(request)`: reopen an existing session: v1 `session/load` (with `replay`)
      and `session/resume` (without), v2 `session/resume` (with `replay` when the client asks
      for it). Replay history through `request.replay` before returning; the client is
      answered after. Raise `RpcError.not_found(...)` for an unknown id. Providing it
      advertises loading and resuming.
    - `close_session(session_id)`: the client closed a session (`session/close`), after its turn was cancelled.
    - `connection_closed(session_ids)`: the connection closed, with the sessions still open on it, after
      their turns stopped and their MCP connections closed. `close_session` is not called for them;
      drop here what you keep per session.
    - `queue_prompts`: queue a prompt that arrives while a turn is running, instead of refusing it.
    - `extensions`: handlers for the client's calls to your vendor extension methods (see `extension_request`, `handle`).
    - `methods`: more request handlers `(params, context)`, e.g. vendor `_name/method` extensions.
      Registered before the first message.
    - `peer`: RpcPeer keyword arguments (`tap`, `on_diagnostic`, `timeout_ms`, ...); cancellation is always `$/cancel_request`.
    - `telemetry`: OpenTelemetry for this connection (`otel_tap()`). A turn continues the client's
      trace when its prompt carries one in `_meta`, your handlers run inside their request's span,
      and requests to the client carry the trace on.
    """
    options = _Options(
        name=name,
        version=version or "0.0.0",
        prompt=prompt,
        protocols=list(protocols) if protocols else [1, 2],
        capabilities=dict(capabilities or {}),
        mcp_transports=list(mcp_transports) if mcp_transports is not None else None,
        mcp_connector=mcp_connector,
        new_session=new_session,
        load_session=load_session,
        close_session=close_session,
        connection_closed=connection_closed,
        queue_prompts=queue_prompts,
        extensions=list(extensions or []),
        methods=dict(methods or {}),
    )
    # A '*' among `methods` or `extensions` answers whatever nothing else does.
    any_request = options.methods.get("*") or next((h.handler for h in options.extensions if h.kind == "request" and h.method == "*"), None)
    any_notification = next((h.handler for h in options.extensions if h.kind == "notification" and h.method == "*"), None)
    endpoint = agent_endpoint(
        channel,
        name=name,
        layers=_agent_layers(options),
        request=_as_peer_handler(any_request) if any_request is not None else None,
        notification=_as_peer_handler(any_notification) if any_notification is not None else None,
        peer=_peer_options(peer, telemetry),
    )
    if telemetry is not None:
        endpoint.peer.on_close(lambda _info: telemetry.close())
    return endpoint.peer


def _peer_options(peer: dict[str, Any] | None, telemetry: Any) -> dict[str, Any]:
    options = dict(peer or {})
    if telemetry is not None:
        from .telemetry import with_telemetry

        options.update(with_telemetry(options.get("tap"), telemetry, inbound=options.get("inbound"), outbound=options.get("outbound")))
    return {**options, **cancel_request}


__all__ = [
    "AgentTurn",
    "ElicitAnswer",
    "LoadSessionRequest",
    "NewSessionRequest",
    "PermissionAnswer",
    "PermissionDenied",
    "ReplayWriter",
    "TerminalDisplay",
    "TerminalHandle",
    "ToolCallHandle",
    "serve_agent",
]
