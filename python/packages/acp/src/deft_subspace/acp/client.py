"""The host side of ACP: connect to an agent, open sessions, run turns.

    client = await AcpClient.connect(channel, name="my-app")
    session = await client.new_session(cwd)
    turn = session.prompt("hello")
    async for event in turn:
        ...
    result = await turn

The client asks for protocol v2 and accepts v1; the app sees the same model
either way (`client.protocol` says which one is in use).
"""

from __future__ import annotations

import asyncio
import inspect
from urllib.parse import urlparse
from urllib.request import url2pathname
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, Protocol, Union

from deft_subspace.kernel import (
    AbortController,
    AbortSignal,
    Channel,
    CloseInfo,
    LocalError,
    PeerDiagnostic,
    RpcError,
    RpcPeer,
    cancel_request,
)

from . import schemas
from ._util import as_list
from .auth import AuthMethod, auth_method_names, auth_methods_from, can_logout
from .capabilities import AgentSupport, CapabilityError, agent_support
from .config import ConfigOption, SelectConfigOption, config_options_from, config_params, with_value
from .elicitation import validate_elicitation
from .extensions import ExtensionHandler, ExtensionNotification, ExtensionRequest, call_extension, register_extensions
from .handlers import HANDLER_KEYS, TurnHandlers, merge_handlers, observes
from .mcp import MCP_PROTOCOL_VERSION, McpProvider, McpRegistration, McpRequestHandler, McpServer, mcp_servers_param
from .model import (
    BackgroundItem,
    ContentBlock,
    Exhaustion,
    ExhaustedEvent,
    PermissionCommand,
    PermissionEvent,
    PermissionOutcome,
    PermissionRequest,
    ProtocolVersion,
    TerminalWork,
    ToolCall,
    ToolCallEvent,
    ToolCallWork,
    TurnEvent,
    TurnLimits,
    TurnResult,
    UsageEvent,
)
from .modes import SessionModes, modes_from, modes_from_config
from .permissions import PermissionPolicy, decide
from .policies import READ_KINDS
from .projection import TurnProjection, background_of
from .terminals import Terminals
from .tools import ToolSet, check_tool_input, tool_input_schema, tool_output_text
from .turn import Turn, TurnHistory, TurnView

PromptInput = Union[str, ContentBlock, Sequence[Union[str, ContentBlock]]]
"""A prompt: text, a content block, or a list of both (strings become text blocks)."""


def prompt_blocks(value: PromptInput) -> list[ContentBlock]:
    """A prompt as content blocks."""

    def block(item: str | ContentBlock) -> ContentBlock:
        return {"type": "text", "text": item} if isinstance(item, str) else item

    if isinstance(value, (str, dict)):
        return [block(value)]
    return [block(item) for item in value]


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class FileHandlers(Protocol):
    """File access an agent may ask for (v1 `fs/*`). See `workspace_files()` in `deft_subspace.acp.node`.

    Requests are the wire params: `{"sessionId", "path", "line"?, "limit"?}` and
    `{"sessionId", "path", "content"}`. Methods may be plain or async.
    """

    def read_text_file(self, request: dict[str, Any]) -> str | Awaitable[str]: ...

    def write_text_file(self, request: dict[str, Any]) -> None | Awaitable[None]: ...


class TerminalHandlers(Protocol):
    """Terminals an agent may run (v1 `terminal/*`). See `workspace_terminals()` in
    `deft_subspace.acp.node`. v2 removed client terminals, so these are only offered to v1 agents.
    Requests and answers are the wire shapes."""

    def create(self, request: dict[str, Any]) -> Any: ...

    def output(self, request: dict[str, Any]) -> Any: ...

    def wait_for_exit(self, request: dict[str, Any]) -> Any: ...

    def kill(self, request: dict[str, Any]) -> Any: ...

    def release(self, request: dict[str, Any]) -> Any: ...


@dataclass(frozen=True)
class ElicitationRequest:
    """What an agent asks the user for (`elicitation/create`): a form, or a URL to visit."""

    #: `form`, `url`, or another mode the agent names.
    mode: str
    message: str
    raw: Any
    session_id: str | None = None
    tool_call_id: str | None = None
    #: `form`: the JSON Schema of the answer.
    requested_schema: Any = None
    #: `url`: where to send the user, and the id the agent completes it by.
    url: str | None = None
    elicitation_id: str | None = None


ElicitationResponse = dict[str, Any]
"""`{"action": "accept", "content": {...}}`, `{"action": "decline"}` or `{"action": "cancel"}`."""

ElicitationHandler = Callable[[ElicitationRequest, AbortSignal], Union[ElicitationResponse, Awaitable[ElicitationResponse]]]
"""Answer an elicitation. Anything that goes wrong becomes `decline`, and so does a form answer
that does not fit `requested_schema` (check it first with `validate_elicitation` to ask again)."""


@dataclass(frozen=True)
class Timeouts:
    #: initialize. Agents often install on first run.
    initialize_ms: float = 60_000
    #: session/new, load, resume.
    session_ms: float = 60_000
    #: How long a cancelled turn may take to confirm before it is ended here. A turn ended here then
    #: holds queued prompts until the agent confirms it, for at most twice as long again.
    cancel_grace_ms: float = 10_000
    #: authenticate / auth/login (the user may be logging in in a browser).
    auth_ms: float = 300_000


@dataclass(frozen=True)
class AgentInfo:
    name: str | None = None
    title: str | None = None
    version: str | None = None


@dataclass(frozen=True)
class SessionSummary:
    session_id: str
    cwd: str
    title: str | None = None
    updated_at: str | None = None
    raw: Any = None


SessionMcpServers = Sequence[Union[McpServer, McpRegistration]]


@dataclass
class _Options:
    name: str | None
    version: str | None
    protocol: Literal["auto", 1, 2]
    permissions: PermissionPolicy
    files: FileHandlers | None
    terminals: TerminalHandlers | None
    elicitation: ElicitationHandler | None
    elicitation_modes: list[str] | None
    terminal_auth: bool
    agent_terminals: bool
    timeouts: Timeouts
    limits: TurnLimits | None
    handlers: TurnHandlers | None
    queue_prompts: bool
    on_elicitation_complete: Callable[[dict[str, Any]], Any] | None


def _check_handler_names(handlers: dict[str, Any]) -> None:
    unknown = [key for key in handlers if key not in HANDLER_KEYS]
    if unknown:
        raise TypeError(f"Unknown option{'s' if len(unknown) > 1 else ''}: {', '.join(unknown)}")


class AcpClient:
    def __init__(self, peer: RpcPeer, protocol: ProtocolVersion, init: dict[str, Any], options: _Options, mcp: McpProvider) -> None:
        """Use `AcpClient.connect()`."""
        self.peer = peer
        self.protocol: ProtocolVersion = protocol
        info = init.get("info") or init.get("agentInfo") or {}
        info = info if isinstance(info, dict) else {}
        self.agent = AgentInfo(info.get("name"), info.get("title"), info.get("version"))
        capabilities = init.get("capabilities") or init.get("agentCapabilities") or {}
        #: The agent's capabilities as it sent them (v1 `agentCapabilities` or v2 `capabilities`).
        self.capabilities: dict[str, Any] = capabilities if isinstance(capabilities, dict) else {}
        #: What the agent can do, the same shape for v1 and v2.
        self.supports: AgentSupport = agent_support(protocol, self.capabilities)
        #: How the agent lets you log in (`initialize`'s `authMethods`). Empty if it needs no login.
        self.auth_methods: list[AuthMethod] = auth_methods_from(init)
        #: What initialize returned.
        self.initialized: dict[str, Any] = init
        self._options = options
        self._mcp = mcp
        self._sessions: dict[str, Session] = {}
        #: Updates for a session id not registered yet: agents often send them right after session/new.
        self._early: dict[str, list[Any]] = {}
        #: Sessions closed here (the most recent): their trailing updates are dropped, not held as early.
        self._closed_here: dict[str, None] = {}
        self._turn_counter = 0

        # In v2 a running turn has no request in flight, so the connection closing must end it explicitly.
        def on_close(close: CloseInfo) -> None:
            text = "The agent closed the connection" if close.reason == "remote-ended" else "The connection to the agent closed"
            error = LocalError("closed", text, cause=close.error)
            for session in list(self._sessions.values()):
                session._connection_closed(error)

        peer.on_close(on_close)

    @classmethod
    async def connect(
        cls,
        channel: Channel[Any],
        *,
        name: str | None = None,
        version: str | None = None,
        protocol: Literal["auto", 1, 2] = "auto",
        permissions: PermissionPolicy = "reject",
        files: FileHandlers | None = None,
        terminals: TerminalHandlers | None = None,
        elicitation: ElicitationHandler | None = None,
        elicitation_modes: list[str] | None = None,
        terminal_auth: bool = False,
        agent_terminals: bool = True,
        timeouts: Timeouts | None = None,
        limits: TurnLimits | None = None,
        handlers: TurnHandlers | None = None,
        queue_prompts: bool = False,
        extensions: list[ExtensionHandler] | None = None,
        on_elicitation_complete: Callable[[dict[str, Any]], Any] | None = None,
        tap: Callable[[Literal["in", "out"], Any], None] | None = None,
        telemetry: Any = None,
        on_diagnostic: Callable[[PeerDiagnostic], None] | None = None,
        **turn_handlers: Any,
    ) -> AcpClient:
        """Connect over a channel of JSON-RPC messages (use `ndjson()` for bytes).

        - `protocol`: `"auto"` asks for v2 and accepts v1.
        - `permissions`: how to answer permission questions. Default `"reject"`: nothing is
          allowed unless you say so.
        - `files`, `terminals`: serve the agent's file requests and run its terminal commands
          (v1). Without them, the client advertises none.
        - `elicitation`: answer the agent's questions to the user (`elicitation/create`), in
          `elicitation_modes` (default both). Without it, none are advertised.
        - `terminal_auth`: the app can run the agent again in a terminal for the user to log in.
        - `agent_terminals`: show the terminals a v1 agent runs itself, as v2 does (advertises
          the `terminal_output` extension). Default True.
        - `limits`: limits for every turn, unless a prompt sets its own.
        - `handlers`, or flat `on_message=...` etc.: handlers for every turn (see `TurnHandlers`);
          a prompt's own replace them one by one.
        - `queue_prompts`: queue a prompt sent while a turn is running, instead of raising.
        - `extensions`: handlers for the agent's vendor extension methods.
        - `tap`: sees every JSON-RPC message, both directions. `telemetry`: `otel_tap(...)`.
        """
        _check_handler_names(turn_handlers)
        # Flat handler options and `handlers` are one set of defaults for every turn.
        merged = merge_handlers(handlers, turn_handlers)
        # An on_question is no use unless the agent is told it may ask: advertise forms (others declined).
        if merged is not None and merged.on_question is not None and elicitation is None:
            elicitation = lambda _request, _signal: {"action": "decline"}  # noqa: E731
            elicitation_modes = elicitation_modes or ["form"]
        options = _Options(
            name=name,
            version=version,
            protocol=protocol,
            permissions=permissions,
            files=files,
            terminals=terminals,
            elicitation=elicitation,
            elicitation_modes=elicitation_modes,
            terminal_auth=terminal_auth,
            agent_terminals=agent_terminals,
            timeouts=timeouts or Timeouts(),
            limits=limits,
            handlers=merged,
            queue_prompts=queue_prompts,
            on_elicitation_complete=on_elicitation_complete,
        )
        peer_options: dict[str, Any] = {"tap": tap}
        if telemetry is not None:
            from .telemetry import with_telemetry

            peer_options = with_telemetry(tap, telemetry)
        peer = RpcPeer(channel, name=name or "acp-client", **cancel_request, **peer_options, on_diagnostic=on_diagnostic)
        if telemetry is not None:
            peer.on_close(lambda _info: telemetry.close())

        # Handlers are registered before the first message can arrive.
        holder: list[AcpClient] = []

        def on_update(params: Any, _context: Any) -> None:
            if holder:
                holder[0]._route_update(params)

        peer.on_notification("session/update", on_update)

        async def on_permission(params: Any, context: Any) -> Any:
            if not holder:
                raise RpcError.internal("Not initialized")
            return await holder[0]._handle_permission(params if isinstance(params, dict) else {}, context.signal)

        peer.on_request("session/request_permission", on_permission)

        if files is not None:
            fs = files

            async def read_file(params: Any, _context: Any) -> Any:
                return {"content": await _resolve(fs.read_text_file(params))}

            async def write_file(params: Any, _context: Any) -> Any:
                await _resolve(fs.write_text_file(params))
                return {}

            peer.on_request("fs/read_text_file", read_file)
            peer.on_request("fs/write_text_file", write_file)

        if terminals is not None:
            t = terminals

            def answer(method: Callable[[dict[str, Any]], Any], empty: bool = False) -> Callable[[Any, Any], Awaitable[Any]]:
                async def handler(params: Any, _context: Any) -> Any:
                    result = await _resolve(method(params))
                    return {} if empty else result

                return handler

            peer.on_request("terminal/create", answer(t.create))
            peer.on_request("terminal/output", answer(t.output))
            peer.on_request("terminal/wait_for_exit", answer(t.wait_for_exit))
            peer.on_request("terminal/kill", answer(t.kill, True))
            peer.on_request("terminal/release", answer(t.release, True))

        register_extensions(peer, extensions)

        if on_elicitation_complete is not None:
            done = on_elicitation_complete

            def on_complete(params: Any, _context: Any) -> Any:
                if not isinstance(params, dict) or not isinstance(params.get("elicitationId"), str):
                    return None
                note = {"elicitationId": params["elicitationId"]}
                if isinstance(params.get("sessionId"), str):
                    note["sessionId"] = params["sessionId"]
                return done(note)

            peer.on_notification("elicitation/complete", on_complete)

        modes = options.elicitation_modes if options.elicitation_modes is not None else ["form", "url"]
        if elicitation is not None:
            default_handler = elicitation
            client_question = merged.on_question if merged is not None else None

            async def on_elicit(params: Any, context: Any) -> Any:
                p = params if isinstance(params, dict) else {}
                request = ElicitationRequest(
                    mode=str(p.get("mode", "")),
                    message=str(p.get("message", "")),
                    raw=p,
                    session_id=p["sessionId"] if isinstance(p.get("sessionId"), str) else None,
                    tool_call_id=p["toolCallId"] if isinstance(p.get("toolCallId"), str) else None,
                    requested_schema=p.get("requestedSchema"),
                    url=p["url"] if isinstance(p.get("url"), str) else None,
                    elicitation_id=p["elicitationId"] if isinstance(p.get("elicitationId"), str) else None,
                )
                if request.mode not in modes:
                    return {"action": "decline"}
                try:
                    # The running turn's on_question, if it has one; else the client's (also between turns,
                    # or for a question that names no session); else `elicitation`.
                    per_turn = holder[0]._question_handler_for(request.session_id) if holder and request.session_id else None
                    answer = await _resolve((per_turn or client_question or default_handler)(request, context.signal))
                    action = answer.get("action") if isinstance(answer, dict) else None
                    if action == "accept":
                        content = answer.get("content")
                        # A form answer must fit the form; one that does not is not sent.
                        if request.mode == "form" and validate_elicitation(request.requested_schema, content):
                            return {"action": "decline"}
                        return {"action": "accept", **({"content": content} if content else {})}
                    if action == "cancel":
                        return {"action": "cancel"}
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - fail closed
                    pass
                return {"action": "decline"}

            peer.on_request("elicitation/create", on_elicit)

        # Always answers mcp/message: unknown servers get -33001.
        mcp = McpProvider(peer)
        peer.start()

        client_name = name or "deft-subspace"
        client_version = version or "0.0.0"
        elicit_caps = {m: {} for m in modes} if elicitation is not None and modes else None
        v1_caps: dict[str, Any] = {
            "fs": {"readTextFile": files is not None, "writeTextFile": files is not None},
            "terminal": terminals is not None,
        }
        if terminal_auth:
            v1_caps["auth"] = {"terminal": True}
        if agent_terminals:
            v1_caps["_meta"] = {"terminal_output": True, "terminal_output_delta": True}
        if elicit_caps:
            v1_caps["elicitation"] = elicit_caps
        v2_caps: dict[str, Any] = {}
        if terminal_auth:
            v2_caps["auth"] = {"terminal": {}}
        if elicit_caps:
            v2_caps["elicitation"] = elicit_caps
        # One request both generations understand: v2 fields plus their v1 names.
        info = {"name": client_name, "version": client_version}
        params: dict[str, Any] = (
            {"protocolVersion": 1, "clientInfo": info, "clientCapabilities": v1_caps}
            if protocol == 1
            else {"protocolVersion": 2, "info": info, "capabilities": v2_caps, "clientInfo": info, "clientCapabilities": v1_caps}
        )
        try:
            init = await peer.request("initialize", params, timeout_ms=options.timeouts.initialize_ms)
        except BaseException:
            await peer.close()
            raise
        init = init if isinstance(init, dict) else {}
        raw_version = init.get("protocolVersion")
        try:
            negotiated = int(raw_version) if not isinstance(raw_version, bool) else -1  # type: ignore[arg-type]
        except (TypeError, ValueError):
            negotiated = -1
        if negotiated not in (1, 2):
            await peer.close()
            raise ValueError(f"Agent answered with protocol version {raw_version}; this client speaks 1 and 2")
        if protocol != "auto" and negotiated != protocol:
            await peer.close()
            raise ValueError(f"Asked for protocol v{protocol}, agent chose v{negotiated}")
        client = cls(peer, negotiated, init, options, mcp)  # type: ignore[arg-type]
        holder.append(client)
        return client

    # ---- sessions --------------------------------------------------------------

    async def new_session(
        self, cwd: str, *, mcp_servers: SessionMcpServers | None = None, additional_directories: list[str] | None = None
    ) -> Session:
        params: dict[str, Any] = {"cwd": cwd, "mcpServers": self._mcp_servers(mcp_servers)}
        if additional_directories:
            params["additionalDirectories"] = additional_directories
        result = await self.peer.request("session/new", params, timeout_ms=self._options.timeouts.session_ms)
        session_id = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise LocalError("invalid-response", "session/new returned no sessionId", method="session/new")
        session = Session(self, session_id, result)
        self._sessions[session.id] = session
        self._closed_here.pop(session.id, None)
        for update in self._early.pop(session.id, []):
            session._receive(update)
        return session

    async def load_session(
        self,
        session_id: str,
        cwd: str,
        *,
        mcp_servers: SessionMcpServers | None = None,
        additional_directories: list[str] | None = None,
    ) -> tuple[Session, list[TurnEvent]]:
        """Open an existing session and replay its history: v1 `session/load`, v2 `session/resume`
        from the start. Returns the session and the replayed updates, as events, in order; the
        session then behaves like a new one."""
        if not self.supports.load_session:
            raise CapabilityError("session/load", "agent")
        session = self._register(session_id)
        replayed: list[TurnEvent] = []
        stop = session.on_idle_update(lambda event, _raw: replayed.append(event))
        try:
            extra = {"replayFrom": {"type": "start"}} if self.protocol == 2 else {}
            result = await self.peer.request(
                "session/load" if self.protocol == 1 else "session/resume",
                self._locator(session_id, cwd, mcp_servers, additional_directories, extra),
                timeout_ms=self._options.timeouts.session_ms,
            )
            session._absorb(result)
            return session, replayed
        except BaseException:
            self._sessions.pop(session_id, None)
            raise
        finally:
            stop()

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        *,
        mcp_servers: SessionMcpServers | None = None,
        additional_directories: list[str] | None = None,
    ) -> Session:
        """Reopen an existing session without replaying its history (`session/resume`)."""
        if not self.supports.resume_session:
            raise CapabilityError("session/resume", "agent")
        session = self._register(session_id)
        try:
            session._absorb(
                await self.peer.request(
                    "session/resume",
                    self._locator(session_id, cwd, mcp_servers, additional_directories),
                    timeout_ms=self._options.timeouts.session_ms,
                )
            )
            return session
        except BaseException:
            self._sessions.pop(session_id, None)
            raise

    async def list_sessions(self, *, cwd: str | None = None, cursor: str | None = None) -> tuple[list[SessionSummary], str | None]:
        """The agent's sessions (`session/list`), one page at a time: `(sessions, next_cursor)`."""
        if not self.supports.list_sessions:
            raise CapabilityError("session/list", "agent")
        params: dict[str, Any] = {}
        if cwd is not None:
            params["cwd"] = cwd
        if cursor is not None:
            params["cursor"] = cursor
        result = await self.peer.request("session/list", params)
        result = result if isinstance(result, dict) else {}
        sessions = [
            SessionSummary(
                session_id=str(s.get("sessionId")),
                cwd=str(s.get("cwd")),
                title=s.get("title") if isinstance(s.get("title"), str) else None,
                updated_at=s.get("updatedAt") if isinstance(s.get("updatedAt"), str) else None,
                raw=s,
            )
            for s in as_list(result.get("sessions"))
            if isinstance(s, dict)
        ]
        cursor_out = result.get("nextCursor")
        return sessions, cursor_out if isinstance(cursor_out, str) else None

    async def authenticate(self, method_id: str, *, timeout_ms: float | None = None, signal: AbortSignal | None = None) -> None:
        """Log in with one of the agent's `auth_methods` (v1 `authenticate`, v2 `auth/login`).

        For an `agent` method the agent does the work, which can mean waiting for the user in
        a browser. Raises ValueError for a method it did not list.
        """
        if not any(m.id == method_id for m in self.auth_methods):
            offered = ", ".join(m.id for m in self.auth_methods) or "none"
            raise ValueError(f'The agent offers no login method "{method_id}" (offered: {offered})')
        login, _logout = auth_method_names(self.protocol)
        await self.peer.request(login, {"methodId": method_id}, timeout_ms=timeout_ms or self._options.timeouts.auth_ms, signal=signal)

    async def logout(self, *, timeout_ms: float = 30_000) -> None:
        """Log out (v1 `logout`, if the agent offers it; v2 `auth/logout`)."""
        if not self.can_logout:
            raise CapabilityError("logout", "agent")
        _login, logout = auth_method_names(self.protocol)
        await self.peer.request(logout, {}, timeout_ms=timeout_ms)

    @property
    def can_logout(self) -> bool:
        """Whether `logout()` can be called."""
        return can_logout(self.protocol, self.capabilities, self.auth_methods)

    async def delete_session(self, session_id: str, *, timeout_ms: float = 30_000) -> None:
        """Delete a session from the agent's history (`session/delete`). An open session with
        that id is closed here first (a running turn is cancelled)."""
        if not self.supports.delete_session:
            raise CapabilityError("session/delete", "agent")
        session = self._sessions.get(session_id)
        if session is not None:
            await session._shut_down()
        await self.peer.request("session/delete", {"sessionId": session_id}, timeout_ms=timeout_ms)

    # ---- MCP-over-ACP ------------------------------------------------------------

    def serve_mcp(self, *, name: str, handler: McpRequestHandler, server_id: str | None = None, max_active_requests: int = 64) -> McpRegistration:
        """Serve an MCP server to the agent over this connection (MCP-over-ACP).

        Put the registration in a session's `mcp_servers`; the agent must advertise the `acp`
        MCP transport (`client.supports.mcp.acp`). The server serves requests as soon as this
        returns; `dispose()` stops it.
        """
        return self._mcp.serve(name=name, handler=handler, server_id=server_id, max_active_requests=max_active_requests)

    def serve_tools(self, *, name: str, tools: ToolSet, version: str = "0.0.0", server_id: str | None = None) -> McpRegistration:
        """Serve your own tools to the agent over this connection (MCP-over-ACP), without writing
        an MCP handler: discovery, `tools/list` and `tools/call` (with the input checked) are
        answered for you. Put the registration in a session's `mcp_servers`. Read kinds are
        marked read-only for the agent."""

        async def handler(context: Any) -> dict[str, Any]:
            method, params, signal = context.method, context.params, context.signal
            if method == "server/discover":
                return {
                    "result": {
                        "supportedVersions": [MCP_PROTOCOL_VERSION],
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": name, "version": version},
                    }
                }
            if method == "tools/list":
                listed = []
                for tool_name, definition in tools.items():
                    entry: dict[str, Any] = {"name": tool_name, "description": definition.description, "inputSchema": tool_input_schema(definition)}
                    if (definition.kind or "") in READ_KINDS:
                        entry["annotations"] = {"readOnlyHint": True}
                    listed.append(entry)
                return {"result": {"tools": listed}}
            if method == "tools/call":
                call = params or {}
                tool_name = call.get("name")
                definition = tools.get(tool_name) if isinstance(tool_name, str) else None
                if definition is None:
                    return {"error": {"code": -32602, "message": f"Unknown tool {tool_name}"}}
                ok, value = check_tool_input(definition, call.get("arguments") or {})
                if not ok:
                    text = f"Invalid input: {'; '.join(value)}"
                    return {"result": {"resultType": "complete", "content": [{"type": "text", "text": text}], "isError": True}}
                # `ask`: the client's own permission policy answers first (an MCP call names no session).
                if definition.ask and isinstance(tool_name, str):
                    allowed, outcome = await self._ask_to_serve(tool_name, definition, value, params, signal)
                    if not allowed:
                        text = "Cancelled" if outcome == "cancelled" else "Not allowed"
                        return {"result": {"resultType": "complete", "content": [{"type": "text", "text": text}], "isError": True}}
                try:
                    from .tools import ToolContext

                    output = await _resolve(definition.run(value, ToolContext(signal)))
                except Exception as error:  # noqa: BLE001
                    # A failed tool is a result with isError, not a protocol error.
                    return {"result": {"resultType": "complete", "content": [{"type": "text", "text": str(error)}], "isError": True}}
                data = schemas.to_json(output)
                result: dict[str, Any] = {"resultType": "complete", "content": [{"type": "text", "text": tool_output_text(output)}], "isError": False}
                if isinstance(data, (dict, list)):
                    result["structuredContent"] = data
                return {"result": result}
            return {"error": {"code": -32601, "message": f"No method {method}"}}

        return self.serve_mcp(name=name, handler=handler, server_id=server_id)

    async def _ask_to_serve(self, tool_name: str, definition: Any, value: Any, raw: Any, signal: AbortSignal) -> tuple[bool, str]:
        """The question for a served tool with `ask`, answered by the client's permission policy."""
        title = definition.title
        label: str = str(title(value)) if callable(title) else str(title or tool_name)
        request = PermissionRequest(
            session_id="",
            title=definition.ask if isinstance(definition.ask, str) else label,
            # The tool's kind and checked input, so rules such as read_only or path and command rules apply.
            tool_call=ToolCall(id=f"served:{tool_name}", name=tool_name, title=label, kind=definition.kind or "other", raw_input=value),
            options=[
                {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
            ],
            protocol=self.protocol,
            raw=raw,
        )
        outcome = await decide(self._default_policy, request, signal)
        return outcome.outcome == "selected" and outcome.allowed, outcome.outcome

    def _mcp_servers(self, servers: SessionMcpServers | None) -> list[dict[str, Any]]:
        return mcp_servers_param(self.protocol, self.supports, list(servers or []))

    # ---- extensions --------------------------------------------------------------

    async def call(self, extension: ExtensionRequest[Any, Any], params: Any, *, signal: AbortSignal | None = None, timeout_ms: float | None = None) -> Any:
        """Call one of the agent's vendor extension requests."""
        return await call_extension(self.peer.request, extension, params, signal=signal, timeout_ms=timeout_ms)

    async def notify(self, extension: ExtensionNotification[Any], params: Any) -> None:
        """Send one of the agent's vendor extension notifications."""
        await self.peer.notify(extension.method, schemas.to_json(params))

    async def close(self) -> None:
        """Close the connection. Running turns fail with a `closed` LocalError."""
        await self.peer.close()

    async def __aenter__(self) -> AcpClient:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    # ---- internal ------------------------------------------------------------------

    @property
    def _default_policy(self) -> PermissionPolicy:
        handlers = self._options.handlers
        return handlers.on_permission if handlers is not None and handlers.on_permission is not None else self._options.permissions

    def _forget(self, session_id: str) -> None:
        if self._sessions.pop(session_id, None) is None:
            return
        self._closed_here[session_id] = None
        if len(self._closed_here) > 64:
            del self._closed_here[next(iter(self._closed_here))]

    def _register(self, session_id: str) -> Session:
        if session_id in self._sessions:
            raise ValueError(f"Session {session_id} is already open on this connection")
        session = Session(self, session_id, {})
        self._sessions[session_id] = session
        self._closed_here.pop(session_id, None)
        for update in self._early.pop(session_id, []):
            session._receive(update)
        return session

    def _locator(
        self,
        session_id: str,
        cwd: str,
        mcp_servers: SessionMcpServers | None,
        additional_directories: list[str] | None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"sessionId": session_id, "cwd": cwd, "mcpServers": self._mcp_servers(mcp_servers)}
        if additional_directories:
            params["additionalDirectories"] = additional_directories
        params.update(extra or {})
        return params

    def _next_turn_id(self, session_id: str) -> str:
        self._turn_counter += 1
        return f"{session_id}#{self._turn_counter}"

    def _question_handler_for(self, session_id: str) -> ElicitationHandler | None:
        session = self._sessions.get(session_id)
        return session._question_handler if session else None

    def _route_update(self, params: Any) -> None:
        if not isinstance(params, dict) or not isinstance(params.get("sessionId"), str):
            return
        session_id = params["sessionId"]
        session = self._sessions.get(session_id)
        if session is not None:
            session._receive(params.get("update"))
            return
        if session_id in self._closed_here:
            return
        # Keep a few, for a session/new still being answered; drop the rest.
        held = self._early.setdefault(session_id, [])
        if len(held) < 100:
            held.append(params.get("update"))
        if len(self._early) > 16:
            del self._early[next(iter(self._early))]

    async def _handle_permission(self, params: dict[str, Any], signal: AbortSignal) -> dict[str, Any]:
        session_id = params["sessionId"] if isinstance(params.get("sessionId"), str) else ""
        session = self._sessions.get(session_id)
        if session is None:
            raise RpcError.not_found(f"Unknown session {session_id}")
        return await session._permission(params, signal, self._default_policy)


@dataclass
class _Active:
    """A prompt's turn: what it has seen and counted. Where it is in its life is the session's state."""

    turn: Turn
    projection: TurnProjection
    limits: TurnLimits
    #: This turn's own answers (prompt handlers), over the client's.
    permissions: PermissionPolicy | None = None
    question: ElicitationHandler | None = None
    tool_calls: int = 0
    exhausted: Exhaustion | None = None
    #: Permission requests refused while the turn was not being cancelled.
    refused: int = 0
    #: Aborted on cancel: open permission questions are answered `cancelled`.
    questions: AbortController = field(default_factory=AbortController)
    #: Aborted when the session gives up on the turn: stops waiting for its session/prompt answer.
    request: AbortController = field(default_factory=AbortController)
    timers: list[asyncio.TimerHandle] = field(default_factory=list)
    idle_timer: asyncio.TimerHandle | None = None
    prompt_task: asyncio.Task[Any] | None = None


# Where a session is. Only `Session._enter()` changes it.


@dataclass
class _Idle:
    """No turn; queued prompts start."""


@dataclass
class _Running:
    """A turn the agent is working on."""

    turn: _Active
    #: session/prompt was answered.
    answered: bool = False
    #: An update of the turn's own has arrived (the agent has started it).
    started: bool = False
    #: v2: the turn's idle `(stop_reason, error)`, if it came before the prompt answer.
    idle_seen: tuple[str, Any] | None = None


@dataclass
class _Cancelling(_Running):
    """The same, after `session/cancel`; ended here at `deadline` if the agent does not confirm."""

    deadline: asyncio.TimerHandle | None = None


@dataclass
class _Draining:
    """A turn was ended here without the agent's confirmation. Queued prompts wait until the agent
    confirms it (v1: its prompt answer; v2: its idle) or `until` passes; its late updates go to the
    session (`on_idle_update`, `tool_calls`), not to the next turn."""

    stale: _Active
    until: asyncio.TimerHandle


_SessionState = Union[_Idle, _Running, _Cancelling, _Draining]


def _is_turn_idle(update: Any) -> bool:
    """A v2 idle state with a stop reason: the end of a turn."""
    return isinstance(update, dict) and update.get("sessionUpdate") == "state_update" and update.get("state") == "idle" and "stopReason" in update


def _is_background_idle(update: Any) -> bool:
    """A v2 idle state with no stop reason: a snapshot of background work, not the end of a turn."""
    return isinstance(update, dict) and update.get("sessionUpdate") == "state_update" and update.get("state") == "idle" and "stopReason" not in update


@dataclass
class SessionInfo:
    title: str | None = None
    updated_at: str | None = None


class Session:
    def __init__(self, client: AcpClient, session_id: str, created: dict[str, Any]) -> None:
        """Use `client.new_session()` (or load / resume)."""
        self.id = session_id
        self.client = client
        #: What session/new (or load, or resume) returned.
        self.created: dict[str, Any] = created
        #: Title and update time, from the agent's `session_info_update`.
        self.info = SessionInfo()
        #: Terminals the agent runs and shows (v2 `terminal_update`, `terminal_output_chunk`), by
        #: id. Kept across turns: one may outlive the turn that started it, and its updates may
        #: come before the tool call that shows it.
        self.terminals = Terminals()
        self._state: _SessionState = _Idle()
        #: Prompts waiting for the running turn to end (with `queue`).
        self._queued: list[tuple[_Active, list[ContentBlock]]] = []
        self._listeners: list[Callable[[TurnEvent, Any], None]] = []
        #: Recent updates between turns, replayed to listeners added later.
        self._idle_history: list[tuple[TurnEvent, Any]] = []
        self._modes: SessionModes | None = modes_from(created)
        self._config: list[ConfigOption] = config_options_from(created.get("configOptions")) or []
        #: Tool calls of earlier turns (and between turns), kept so later updates to background work patch them.
        self._idle_projection = TurnProjection(f"{session_id}#idle", self.terminals)
        self._background: list[BackgroundItem] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        #: Mode and config changes, one at a time, so a later change is never overwritten by an earlier answer.
        self._config_lock = asyncio.Lock()

    # ---- state ---------------------------------------------------------------------

    @property
    def background(self) -> list[BackgroundItem] | None:
        """v2: the work the agent says runs in the background (terminals, tool calls, subagents),
        from its latest state update. None when it does not report it, which means unknown, not "nothing"."""
        return self._background

    @property
    def tool_calls(self) -> dict[str, ToolCall]:
        """Tool calls of earlier turns, and of work between turns, by id (background work lives here)."""
        return self._idle_projection.tool_calls

    @property
    def modes(self) -> SessionModes | None:
        """The modes the agent offers and the current one, whichever way it offers them. None if none."""
        return self._modes

    @property
    def config_options(self) -> list[ConfigOption]:
        """The agent's config options for this session (model, reasoning effort, mode, on/off
        switches), kept current from its answers and `config_option_update`s. Empty if it offers none."""
        return self._config

    def config_option(self, option_id: str) -> ConfigOption | None:
        return next((o for o in self._config if o.id == option_id), None)

    @property
    def model(self) -> SelectConfigOption | None:
        """The model option (category `model`, a select), if the agent offers one."""
        return next((o for o in self._config if isinstance(o, SelectConfigOption) and o.category == "model"), None)

    @property
    def busy(self) -> bool:
        """A turn is running (or being cancelled)."""
        return self._current is not None

    @property
    def _progress(self) -> _Running | None:
        """The running (or cancelling) turn's progress, if any."""
        return self._state if isinstance(self._state, _Running) else None

    @property
    def _current(self) -> _Active | None:
        """The running (or cancelling) turn, if any."""
        progress = self._progress
        return progress.turn if progress is not None else None

    @property
    def queued_count(self) -> int:
        """Prompts waiting to start."""
        return len(self._queued)

    # ---- control ---------------------------------------------------------------------

    async def cancel_tool_call(self, tool_call_id: str, *, timeout_ms: float = 30_000) -> None:
        """v2: stop one tool call (`tool_call/cancel`), without cancelling the turn. Only for a
        tool call that advertises it (`cancellable`). Returns when the agent has accepted; it
        confirms with a final status on the tool call."""
        active = self._current
        call = (active.projection.tool_calls.get(tool_call_id) if active else None) or self._idle_projection.tool_calls.get(tool_call_id)
        if self.client.protocol != 2 or call is None or not call.cancellable:
            raise CapabilityError(f"cancelling tool call {tool_call_id}", "agent")
        await self.client.peer.request("tool_call/cancel", {"sessionId": self.id, "toolCallId": tool_call_id}, timeout_ms=timeout_ms)

    async def cancel_terminal(self, terminal_id: str, *, timeout_ms: float = 30_000) -> None:
        """v2: stop the process behind one of the agent's terminals (`terminal/cancel`). Only for a
        terminal that advertises it. The agent confirms with its exit status; the output stays."""
        terminal = self.terminals.get(terminal_id)
        if self.client.protocol != 2 or terminal is None or not terminal.cancellable:
            raise CapabilityError(f"cancelling terminal {terminal_id}", "agent")
        await self.client.peer.request("terminal/cancel", {"sessionId": self.id, "terminalId": terminal_id}, timeout_ms=timeout_ms)

    async def close(self) -> None:
        """End this session: cancel a running turn, then `session/close` if the agent supports it.
        The session is forgotten here either way."""
        await self._shut_down()
        try:
            if self.client.supports.close_session:
                await self.client.peer.request("session/close", {"sessionId": self.id}, timeout_ms=10_000)
        except Exception:  # noqa: BLE001
            # Not supported, or the agent is gone: the session is closed here regardless.
            pass
        finally:
            self.client._forget(self.id)

    async def set_mode(self, mode_id: str, *, timeout_ms: float | None = None) -> None:
        """Switch mode, through `session/set_mode` or `session/set_config_option` as the agent
        requires. Raises ValueError if the agent offers no such mode. Mode and config changes
        run one at a time, in the order they were made."""
        async with self._config_lock:
            await self._set_mode(mode_id, timeout_ms)

    async def _set_mode(self, mode_id: str, timeout_ms: float | None) -> None:
        """Switch mode, through `session/set_mode` or `session/set_config_option` as the agent
        requires. Raises ValueError if the agent offers no such mode."""
        modes = self._modes
        if modes is None:
            raise ValueError("The agent offers no session modes")
        if not any(m.id == mode_id for m in modes.available):
            available = ", ".join(m.id for m in modes.available) or "none"
            raise ValueError(f'The agent offers no mode "{mode_id}" (available: {available})')
        if modes.via == "modes":
            await self.client.peer.request("session/set_mode", {"sessionId": self.id, "modeId": mode_id}, timeout_ms=timeout_ms)
            self._modes = replace(modes, current=mode_id)
            return
        params = (
            {"sessionId": self.id, "configId": modes.config_id, "type": "id", "value": mode_id}
            if self.client.protocol == 2
            else {"sessionId": self.id, "configId": modes.config_id, "value": mode_id}
        )
        result = await self.client.peer.request("session/set_config_option", params, timeout_ms=timeout_ms)
        options = result.get("configOptions") if isinstance(result, dict) else None
        self._modes = modes_from_config(options) or SessionModes(modes.available, modes.via, mode_id, modes.config_id)
        self._config = config_options_from(options) or self._with_value(modes.config_id or "", mode_id)

    async def set_config_option(self, option_id: str, value: str | bool, *, timeout_ms: float | None = None) -> None:
        """Set a config option (`session/set_config_option`): a choice's value for a select option,
        True or False for an on/off one. Raises ValueError, without asking the agent, for an option
        or value it did not offer. Mode and config changes run one at a time, in the order they were made."""
        async with self._config_lock:
            await self._set_config_option(option_id, value, timeout_ms)

    async def _set_config_option(self, option_id: str, value: str | bool, timeout_ms: float | None) -> None:
        """Set a config option (`session/set_config_option`): a choice's value for a select option,
        True or False for an on/off one. Raises ValueError, without asking the agent, for an option
        or value it did not offer."""
        option = self.config_option(option_id)
        if option is None:
            offered = ", ".join(o.id for o in self._config) or "none"
            raise ValueError(f'The agent offers no config option "{option_id}" (offered: {offered})')
        built = config_params(self.client.protocol, self.id, option, value)
        if isinstance(built, str):
            raise ValueError(built)
        result = await self.client.peer.request("session/set_config_option", built, timeout_ms=timeout_ms)
        options = result.get("configOptions") if isinstance(result, dict) else None
        self._config = config_options_from(options) or self._with_value(option_id, value)
        self._modes = modes_from_config(options) or self._modes
        if self._modes is not None and self._modes.via == "config" and self._modes.config_id == option_id and isinstance(value, str):
            self._modes = replace(self._modes, current=value)

    async def set_model(self, value: str, *, timeout_ms: float | None = None) -> None:
        """Choose a model: sets the option with category `model`."""
        model = self.model
        if model is None:
            raise ValueError("The agent offers no model choice")
        await self.set_config_option(model.id, value, timeout_ms=timeout_ms)

    def _with_value(self, option_id: str, value: Any) -> list[ConfigOption]:
        return [with_value(o, value) if o.id == option_id else o for o in self._config]

    def on_idle_update(self, listener: Callable[[TurnEvent, Any], None]) -> Callable[[], None]:
        """Updates that arrive between turns (available commands, config options, ...), with the raw
        update. The last 50 are replayed to a new listener, so nothing sent right after session/new
        is missed. Returns a function that removes the listener."""
        for event, raw in self._idle_history:
            listener(event, raw)
        self._listeners.append(listener)

        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    def prompt(
        self,
        prompt: PromptInput,
        *,
        limits: TurnLimits | None = None,
        queue: bool | None = None,
        signal: AbortSignal | None = None,
        timeout_ms: float | None = None,
        history: TurnHistory = "all",
        **handlers: Any,
    ) -> Turn:
        """Send a prompt. Iterate the turn for its events, or pass handlers (`on_message`,
        `on_tool_call`, `on_permission`, ...; see `TurnHandlers`): the turn's result is then
        ready after they ran.

        `limits` replace the client's default limits for this turn; `timeout_ms` is the same as
        `limits.max_duration_ms`; `signal` cancels the turn when it fires. While a turn is running
        this raises, unless `queue` (or the client's `queue_prompts`) is set: then the turn starts
        when the running one ends. Content the agent cannot take (an image it did not offer to
        accept, for example) raises a `CapabilityError`. `history` bounds what the turn keeps of
        its events for a long turn (default "all"; see `TurnHistory`).
        """
        _check_handler_names(handlers)
        blocks = self._fit_content(prompt_blocks(prompt))
        if self.busy and not (queue if queue is not None else self.client._options.queue_prompts):
            raise RuntimeError(f"Session {self.id} already has a turn running (pass queue=True to queue it)")
        turn_id = self.client._next_turn_id(self.id)
        projection = TurnProjection(turn_id, self.terminals)
        base = limits or self.client._options.limits or TurnLimits()
        if timeout_ms is not None:
            base = TurnLimits(timeout_ms, base.idle_ms, base.max_tool_calls, base.max_usage)
        holder: list[_Active] = []
        turn = Turn(
            turn_id,
            lambda: self._cancel_turn(holder[0]),
            TurnView(lambda: projection.text, lambda: [c.snapshot() for c in projection.tool_calls.values()]),
            self._spawn,
            history,
        )
        active = _Active(turn=turn, projection=projection, limits=base)
        holder.append(active)
        merged = merge_handlers(self.client._options.handlers, handlers)
        if merged is not None and merged.on_permission is not None:
            active.permissions = merged.on_permission
        if merged is not None and merged.on_question is not None:
            active.question = merged.on_question
        if observes(merged):
            assert merged is not None
            turn.observe(merged)
        if signal is not None:
            # Aborting the signal cancels the turn (or, if it is queued, means it is never sent).
            def on_abort(_reason: Any) -> None:
                self._spawn(turn.cancel())

            if signal.aborted:
                asyncio.get_running_loop().call_soon(on_abort, None)
            else:
                remove = signal.add_listener(on_abort)
                turn._done.add_done_callback(lambda _f: remove())
        # After a running turn, one ended here that is still draining, and the prompts already waiting.
        if not isinstance(self._state, _Idle) or self._queued:
            self._queued.append((active, blocks))
        else:
            self._begin(active, blocks)
        return turn

    async def run(self, prompt: PromptInput, **options: Any) -> TurnResult:
        """`prompt()` and wait for the result."""
        return await self.prompt(prompt, **options)

    async def cancel(self) -> None:
        """Cancel the running turn, if any."""
        state = self._state
        if type(state) is not _Running:
            return
        active = state.turn
        # The deadline is set before anything is written, and the write is not the caller's: a
        # write the agent never reads, or a caller cancelled while it waits, must not keep the turn open.
        deadline = asyncio.get_running_loop().call_later(self.client._options.timeouts.cancel_grace_ms / 1000, lambda: self._force_end(active))
        self._enter(_Cancelling(state.turn, state.answered, state.started, state.idle_seen, deadline))
        # Open permission questions are answered `cancelled`, as the spec requires.
        active.questions.abort()

        async def tell() -> None:
            try:
                await self.client.peer.notify("session/cancel", {"sessionId": self.id})
            except Exception:  # noqa: BLE001 - the deadline ends the turn regardless
                pass

        await asyncio.shield(self._spawn(tell()))

    def _force_end(self, active: _Active) -> None:
        """The agent did not confirm a cancel in time: end the turn here."""
        if self._current is not active:
            return
        # Background work is not the turn's: session/cancel does not stop it.
        active.turn.push(*active.projection.fail_open_tool_calls(self._is_background))
        self._end(active, "cancelled", None, forced=True)

    async def __aenter__(self) -> Session:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    # ---- internal ----------------------------------------------------------------------

    @property
    def _question_handler(self) -> ElicitationHandler | None:
        current = self._current
        return current.question if current else None

    def _spawn(self, coroutine: Any) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _is_background(self, call: ToolCall) -> bool:
        """Whether a tool call is background work: listed, or showing a listed terminal."""
        items = self._background or []
        if any(isinstance(item, ToolCallWork) and item.tool_call_id == call.id for item in items):
            return True
        terminals = {item.terminal_id for item in items if isinstance(item, TerminalWork)}
        return any(isinstance(c, dict) and c.get("type") == "terminal" and c.get("terminalId") in terminals for c in call.content)

    def _absorb(self, result: Any) -> None:
        """Take in a load or resume answer (modes, config options)."""
        if not isinstance(result, dict):
            return
        self.created = result
        self._modes = modes_from(result) or self._modes
        self._config = config_options_from(result.get("configOptions")) or self._config

    async def _shut_down(self) -> None:
        """Stop queued and running turns and forget the session here, without telling the agent."""
        queued, self._queued = self._queued, []
        for active, _blocks in queued:
            active.turn.finish(self._not_sent())
        current = self._current
        if current is not None:
            await self.cancel()
            try:
                await current.turn.done
            except Exception:  # noqa: BLE001
                pass
        # A turn ended here is not waited for any longer.
        if isinstance(self._state, _Draining):
            self._enter(_Idle())
        self.client._forget(self.id)

    def _fit_content(self, blocks: list[ContentBlock]) -> list[ContentBlock]:
        """The prompt as the agent can take it: an embedded text file it cannot take becomes text
        (its path, then its contents); images, audio and binary files it cannot take raise."""
        can = self.client.supports.prompt
        out: list[ContentBlock] = []
        for block in blocks:
            kind = block.get("type")
            if kind == "image" and not can.image:
                raise CapabilityError("image prompts", "agent")
            if kind == "audio" and not can.audio:
                raise CapabilityError("audio prompts", "agent")
            if kind == "resource" and not can.embedded_context:
                resource = block.get("resource") if isinstance(block.get("resource"), dict) else {}
                assert isinstance(resource, dict)
                if not isinstance(resource.get("text"), str):
                    raise CapabilityError("embedded resources in prompts", "agent")
                uri = resource.get("uri")
                file_name = _local_name(uri) if isinstance(uri, str) else "file"
                out.append({"type": "text", "text": f"{file_name}:\n\n```\n{resource['text']}\n```"})
                continue
            out.append(block)
        return out

    def _begin(self, active: _Active, blocks: list[ContentBlock]) -> None:
        self._enter(_Running(active))
        loop = asyncio.get_running_loop()
        max_ms = active.limits.max_duration_ms
        if max_ms is not None:
            active.timers.append(loop.call_later(max_ms / 1000, lambda: self._exhaust(active, Exhaustion("duration", max_ms, max_ms))))
        self._restart_idle(active)

        async def send() -> None:
            try:
                result = await self.client.peer.request("session/prompt", {"sessionId": self.id, "prompt": blocks}, signal=active.request.signal)
            except asyncio.CancelledError:
                raise
            except BaseException as error:  # noqa: BLE001
                self._prompt_failed(active, error)
                return
            self._prompt_answered(active, result)

        active.prompt_task = self._spawn(send())

    def _start_next(self) -> None:
        """The next queued prompt, once nothing is running."""
        if not isinstance(self._state, _Idle) or not self._queued:
            return
        active, blocks = self._queued.pop(0)
        self._begin(active, blocks)

    @staticmethod
    def _not_sent() -> TurnResult:
        """The result of a queued turn cancelled before it reached the agent."""
        return TurnResult(stop_reason="cancelled", text="", tool_calls=[], cancelled=True)

    async def _cancel_turn(self, active: _Active) -> None:
        for index, (queued, _blocks) in enumerate(self._queued):
            if queued is active:
                del self._queued[index]
                active.turn.finish(self._not_sent())
                return
        if self._current is active:
            await self.cancel()

    def _exhaust(self, active: _Active, exhaustion: Exhaustion) -> None:
        """A limit was reached: record it once, tell the turn, cancel."""
        if self._current is not active or active.exhausted is not None:
            return
        active.exhausted = exhaustion
        active.turn.push(ExhaustedEvent(exhaustion.limit, exhaustion.max, exhaustion.value))
        self._spawn(self.cancel())

    def _restart_idle(self, active: _Active) -> None:
        idle_ms = active.limits.idle_ms
        if idle_ms is None or active.exhausted is not None:
            return
        if active.idle_timer is not None:
            active.idle_timer.cancel()
        active.idle_timer = asyncio.get_running_loop().call_later(idle_ms / 1000, lambda: self._exhaust(active, Exhaustion("idle", idle_ms, idle_ms)))

    @staticmethod
    def _stop_timers(active: _Active) -> None:
        for handle in active.timers:
            handle.cancel()
        if active.idle_timer is not None:
            active.idle_timer.cancel()

    def _connection_closed(self, error: LocalError) -> None:
        queued, self._queued = self._queued, []
        for active, _blocks in queued:
            active.turn.fail(error)
        current = self._current
        if current is not None:
            self._fail_turn(current, error)
        elif isinstance(self._state, _Draining):
            self._enter(_Idle())

    def _receive(self, update: Any) -> None:
        self._track(update)
        state = self._state
        if isinstance(state, _Draining):
            # v2: the idle of the turn ended here is the agent's confirmation, not news.
            if self.client.protocol == 2 and _is_turn_idle(update):
                self._drained(state.stale)
                return
            self._receive_between_turns(update)
            return
        # Updates to tool calls of earlier turns (background work) are not this turn's, nor is an
        # idle with no stop reason before this turn began: background work finished while the
        # agent had not started the new prompt yet.
        if not isinstance(state, _Running) or self._of_earlier_turn(update) or (not state.started and _is_background_idle(update)):
            self._receive_between_turns(update)
            return
        active = state.turn
        state.started = True
        events, snapshot = active.projection.apply(update)
        active.turn.push(*events)
        self._restart_idle(active)
        self._check_limits(active, events)
        if snapshot is not None and snapshot.state == "idle":
            state.idle_seen = (snapshot.stop_reason or "end_turn", snapshot.error)
            # v2: the turn ends at idle. The prompt answer normally came first.
            if self.client.protocol == 2 and state.answered:
                self._end(active, *state.idle_seen)

    def _receive_between_turns(self, update: Any) -> None:
        """An update that is no running turn's: kept with the session, for `on_idle_update` listeners."""
        events, _state = self._idle_projection.apply(update)
        for event in events:
            self._idle_history.append((event, update))
            if len(self._idle_history) > 50:
                self._idle_history.pop(0)
            for listener in list(self._listeners):
                listener(event, update)

    def _prompt_answered(self, active: _Active, result: Any) -> None:
        if isinstance(self._state, _Draining):
            # v1: the answer to a turn ended here is the agent's confirmation.
            if self.client.protocol == 1:
                self._drained(active)
            return
        progress = self._progress
        if progress is None or progress.turn is not active:
            return
        progress.answered = True
        if self.client.protocol == 1:
            stop = result.get("stopReason") if isinstance(result, dict) else None
            self._end(active, str(stop if stop is not None else "end_turn"))
        elif progress.idle_seen is not None:
            self._end(active, *progress.idle_seen)

    def _prompt_failed(self, active: _Active, error: BaseException) -> None:
        # A turn ended here whose prompt then fails (or is given up on): the agent is done with it.
        if isinstance(self._state, _Draining):
            self._drained(active)
            return
        self._fail_turn(active, error)

    def _drained(self, stale: _Active) -> None:
        """A turn ended here is confirmed, or no longer waited for."""
        if isinstance(self._state, _Draining) and self._state.stale is stale:
            self._enter(_Idle())

    def _check_limits(self, active: _Active, events: list[TurnEvent]) -> None:
        max_calls, max_usage = active.limits.max_tool_calls, active.limits.max_usage
        for event in events:
            if isinstance(event, ToolCallEvent) and event.created:
                active.tool_calls += 1
                if max_calls is not None and active.tool_calls > max_calls:
                    self._exhaust(active, Exhaustion("toolCalls", max_calls, active.tool_calls))
            elif isinstance(event, UsageEvent) and max_usage is not None and event.used > max_usage:
                self._exhaust(active, Exhaustion("usage", max_usage, event.used))

    def _of_earlier_turn(self, update: Any) -> bool:
        if not isinstance(update, dict):
            return False
        kind = update.get("sessionUpdate")
        # A background terminal's own updates (its output, its exit) belong to the turn that started it.
        if kind in ("terminal_update", "terminal_output_chunk") and isinstance(update.get("terminalId"), str):
            return any(isinstance(item, TerminalWork) and item.terminal_id == update["terminalId"] for item in self._background or [])
        # A new tool call is the running turn's, even with an id an earlier turn used.
        call_id = update.get("toolCallId")
        if not isinstance(call_id, str) or kind not in ("tool_call_update", "tool_call_content_chunk"):
            return False
        active = self._current
        if active is not None and call_id in active.projection.tool_calls:
            return False
        # Only background work goes on after its turn; other ids are the running turn's to reuse.
        earlier = self._idle_projection.tool_calls.get(call_id)
        return earlier is not None and self._is_background(earlier)

    def _track(self, update: Any) -> None:
        if not isinstance(update, dict):
            return
        kind = update.get("sessionUpdate")
        # Every state snapshot replaces the background list; one without it makes it unknown.
        if kind == "state_update":
            self._background = background_of(update)
        if kind == "session_info_update":
            if isinstance(update.get("title"), str):
                self.info.title = update["title"]
            if isinstance(update.get("updatedAt"), str):
                self.info.updated_at = update["updatedAt"]
        if kind == "current_mode_update" and self._modes is not None and isinstance(update.get("currentModeId"), str):
            self._modes = replace(self._modes, current=update["currentModeId"])
        elif kind == "config_option_update":
            modes = modes_from_config(update.get("configOptions"))
            if modes is not None:
                self._modes = modes
            config = config_options_from(update.get("configOptions"))
            if config is not None:
                self._config = config

    async def _permission(self, params: dict[str, Any], signal: AbortSignal, policy: PermissionPolicy) -> dict[str, Any]:
        # A question about listed background work stands on its own: not tied to a turn or its cancel.
        if self._about_background(params):
            request = self._permission_request(params, self._idle_projection)
            outcome = await decide(policy, request, signal)
            for listener in list(self._listeners):
                listener(PermissionEvent(request, outcome), params)
            return _answer(outcome)
        # No turn is running, or it is being cancelled: nobody asked for this. Fail closed.
        state = self._state
        if type(state) is not _Running:
            return {"outcome": {"outcome": "cancelled"}}
        active = state.turn
        request = self._permission_request(params, active.projection)
        combined = AbortSignal.any([signal, active.questions.signal])
        # What the agent said before asking is shown before the question.
        await active.turn.caught_up()
        outcome = await decide(active.permissions if active.permissions is not None else policy, request, combined)
        if (outcome.outcome == "cancelled" or not outcome.allowed) and not active.questions.signal.aborted:
            active.refused += 1
        active.turn.push(PermissionEvent(request, outcome))
        return _answer(outcome)

    def _about_background(self, params: dict[str, Any]) -> bool:
        """v2: a permission question whose subject is listed background work (by tool call or terminal)."""
        items = self._background
        if self.client.protocol != 2 or not items:
            return False
        subject = params.get("subject") if isinstance(params.get("subject"), dict) else {}
        assert isinstance(subject, dict)
        tool_call = subject.get("toolCall") if isinstance(subject.get("toolCall"), dict) else {}
        assert isinstance(tool_call, dict)
        tool_call_id = tool_call.get("toolCallId", subject.get("toolCallId"))
        terminal_id = subject.get("terminalId")
        return any(
            (isinstance(item, ToolCallWork) and item.tool_call_id == tool_call_id) or (isinstance(item, TerminalWork) and item.terminal_id == terminal_id)
            for item in items
        )

    def _permission_request(self, params: dict[str, Any], projection: TurnProjection) -> PermissionRequest:
        options = [o for o in as_list(params.get("options")) if isinstance(o, dict)]
        # v1: params.toolCall. v2: params.subject = {type: 'tool_call', toolCall} | {type: 'command', ...}.
        subject = params.get("subject") if isinstance(params.get("subject"), dict) else None
        raw_call = params.get("toolCall")
        if raw_call is None and subject is not None and subject.get("type") == "tool_call":
            raw_call = subject.get("toolCall")
        tool_call = projection.merge_tool_call(raw_call) if isinstance(raw_call, dict) else None
        command = PermissionCommand(str(subject.get("command")), str(subject.get("cwd"))) if subject is not None and subject.get("type") == "command" else None
        title = params["title"] if isinstance(params.get("title"), str) else (tool_call.title if tool_call else "") or (command.command if command else "") or "Permission requested"
        return PermissionRequest(
            session_id=self.id,
            title=title,
            options=options,
            protocol=self.client.protocol,
            raw=params,
            tool_call=tool_call.snapshot() if tool_call else None,
            command=command,
        )

    def _end(self, active: _Active, stop_reason: str, error: Any = None, forced: bool = False) -> None:
        """End the running (or cancelling) turn with its result. One ended here without the agent's
        confirmation (`forced`) drains; otherwise the session is idle again."""
        state = self._state
        if not isinstance(state, _Running) or state.turn is not active:
            return
        cancelled = isinstance(state, _Cancelling)
        # Later updates to this turn's tool calls (background work) patch them here.
        self._idle_projection.tool_calls.update(active.projection.tool_calls)
        if forced:
            loop = asyncio.get_running_loop()
            drain_s = 2 * self.client._options.timeouts.cancel_grace_ms / 1000
            self._enter(_Draining(active, loop.call_later(drain_s, lambda: self._drained(active))))
        else:
            self._enter(_Idle())
        active.turn.finish(
            TurnResult(
                stop_reason=stop_reason,
                text=active.projection.text,
                tool_calls=[c.snapshot() for c in active.projection.tool_calls.values()],
                cancelled=cancelled,
                forced=forced,
                error=error,
                exhausted=active.exhausted,
                refused=active.refused,
            )
        )

    def _fail_turn(self, active: _Active, error: BaseException) -> None:
        state = self._state
        if not isinstance(state, _Running) or state.turn is not active:
            return
        self._enter(_Idle())
        active.turn.fail(error)

    def _enter(self, next_state: _SessionState) -> None:
        """The one place the session's state changes. What the state it leaves held is released here."""
        previous = self._state
        if isinstance(previous, _Cancelling) and previous.deadline is not None:
            previous.deadline.cancel()
        if isinstance(previous, _Running) and not isinstance(next_state, _Cancelling):
            self._stop_timers(previous.turn)
        if isinstance(previous, _Draining):
            previous.until.cancel()
            # No longer waited for: the kernel stops waiting for its prompt answer and tells the agent ($/cancel_request).
            previous.stale.request.abort()
        self._state = next_state
        if isinstance(next_state, _Idle):
            asyncio.get_running_loop().call_soon(self._start_next)


def _local_name(uri: str) -> str:
    """A file URI as this system's path (`file:///D:/a/b` is `D:\\a\\b` on Windows); other URIs as they are."""
    if not uri.startswith("file://"):
        return uri
    parsed = urlparse(uri)
    return url2pathname(parsed.path) if not parsed.netloc else url2pathname(f"//{parsed.netloc}{parsed.path}")


def _answer(outcome: PermissionOutcome) -> dict[str, Any]:
    if outcome.outcome == "cancelled":
        return {"outcome": {"outcome": "cancelled"}}
    return {"outcome": {"outcome": "selected", "optionId": outcome.option_id}}
