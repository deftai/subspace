"""MCP servers for an agent's session: the ones it starts or connects to
(`stdio`, `http`, `sse`), and ones the client serves over the ACP connection
itself (`acp`, MCP-over-ACP).

    session = await client.new_session(
        cwd,
        mcp_servers=[
            StdioMcpServer("files", "/usr/local/bin/files-mcp", args=["--root", cwd]),
            HttpMcpServer("search", "https://mcp.example.com", headers={"Authorization": "Bearer ..."}),
            client.serve_mcp(name="project-tools", handler=handler),   # needs the agent's `acp` MCP capability
        ],
    )

Each server is checked against the transports the agent advertised before
session/new is sent. MCP-over-ACP follows the ACP RFD "MCP-over-ACP: Stateless
MCP Requests over ACP" (MCP 2026-07-28): the agent sends `mcp/message`
requests addressed by `serverId`; the handler answers each with one MCP
outcome and may send notifications scoped to it.
"""

from __future__ import annotations

import asyncio
import inspect
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Union

from deft_subspace.kernel import AbortController, AbortSignal, RpcError, RpcPeer

from .capabilities import AgentSupport, CapabilityError
from .model import ProtocolVersion


@dataclass(frozen=True)
class StdioMcpServer:
    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    type: Literal["stdio"] = field(default="stdio", init=False)


@dataclass(frozen=True)
class HttpMcpServer:
    name: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    type: Literal["http"] = field(default="http", init=False)


@dataclass(frozen=True)
class SseMcpServer:
    """v1 only; deprecated in MCP, and gone from v2."""

    name: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    type: Literal["sse"] = field(default="sse", init=False)


@dataclass(frozen=True)
class AcpMcpServer:
    """Served by this client over the ACP connection; see `client.serve_mcp()`."""

    name: str
    server_id: str
    type: Literal["acp"] = field(default="acp", init=False)


McpServer = Union[StdioMcpServer, HttpMcpServer, SseMcpServer, AcpMcpServer]

MCP_PROTOCOL_VERSION = "2026-07-28"
META_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"


class McpBindingError:
    """Outer ACP error codes of the MCP-over-ACP binding."""

    CANCELLED = -32800
    RESOURCE_LIMIT_EXCEEDED = -33000
    SERVER_UNAVAILABLE = -33001
    BACKEND_FAILED = -33002


def _pairs(record: dict[str, str]) -> list[dict[str, str]]:
    return [{"name": k, "value": v} for k, v in record.items()]


def mcp_servers_param(protocol: ProtocolVersion, supports: AgentSupport, servers: list[Any]) -> list[dict[str, Any]]:
    """The `mcpServers` param for session/new, load or resume, in the agent's protocol.

    Raises CapabilityError for a transport the agent did not advertise, and ValueError
    for a v2 stdio command that is not an absolute path. Entries may be servers or
    registrations from `client.serve_mcp()`.
    """
    out: list[dict[str, Any]] = []
    for entry in servers:
        server = getattr(entry, "declaration", entry)
        if not supports.mcp[server.type]:
            raise CapabilityError(f"{server.type} MCP servers", "agent")
        if isinstance(server, StdioMcpServer):
            if protocol == 2 and not server.command.startswith("/") and not re.match(r"^[A-Za-z]:[\\/]", server.command):
                raise ValueError(f'MCP server {server.name}: v2 needs an absolute command path, got "{server.command}"')
            # v1 has no type for stdio and requires args and env.
            base = {"name": server.name, "command": server.command, "args": list(server.args), "env": _pairs(server.env)}
            out.append({"type": "stdio", **base} if protocol == 2 else base)
        elif isinstance(server, (HttpMcpServer, SseMcpServer)):
            out.append({"type": server.type, "name": server.name, "url": server.url, "headers": _pairs(server.headers)})
        elif isinstance(server, AcpMcpServer):
            out.append({"type": "acp", "name": server.name, "serverId": server.server_id})
    return out


@dataclass
class McpOperationContext:
    """One MCP operation the agent asked a served server for."""

    server_id: str
    #: The agent's logical MCP request id (also the inner JSON-RPC id).
    request_id: str
    #: Inner MCP method, such as `tools/call` or `server/discover`.
    method: str
    params: dict[str, Any] | None
    protocol_version: str
    client_capabilities: dict[str, Any]
    client_info: Any
    envelope_meta: dict[str, Any] | None
    #: Fires when the agent cancels this request, the server is disposed, or the connection closes.
    signal: AbortSignal
    _notify: Callable[[str, Any], Awaitable[None]] = field(repr=False, default=None)  # type: ignore[assignment]

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        """An MCP notification for this request (progress, subscription events). Dropped once it has been answered."""
        await self._notify(method, params)


McpOutcome = dict[str, Any]
"""Exactly one of `{"result": ...}` (any JSON value) or `{"error": {"code", "message", "data"?}}`, optionally with `_meta`."""

McpRequestHandler = Callable[[McpOperationContext], Union[McpOutcome, Awaitable[McpOutcome]]]
"""Answers MCP requests for one served server. Raise an exception with a `to_mcp_error()`
method for an inner MCP error; any other exception is a binding failure (-33002), or
-32800 when cancelled."""


@dataclass
class McpRegistration:
    name: str
    server_id: str
    #: Put this (or the registration itself) in a session's `mcp_servers`.
    declaration: AcpMcpServer
    _dispose: Callable[[], Awaitable[None]] = field(repr=False)

    async def dispose(self) -> None:
        """Stop serving: later requests fail with -33001, running ones are cancelled. Returns when their handlers have settled."""
        await self._dispose()

    @property
    def type(self) -> str:
        return "acp"


@dataclass
class _Served:
    name: str
    handler: McpRequestHandler
    max_active: int
    active: dict[str, asyncio.Future[Any]] = field(default_factory=dict)
    controller: AbortController = field(default_factory=AbortController)


def _invalid_params(message: str) -> McpOutcome:
    return {"error": {"code": -32602, "message": message}}


def _valid_outcome(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if "result" in value:
        return True
    error = value.get("error")
    return isinstance(error, dict) and isinstance(error.get("code"), int) and not isinstance(error.get("code"), bool) and isinstance(error.get("message"), str)


class McpProvider:
    """Serves MCP servers to the agent over `mcp/message`, on one connection."""

    def __init__(self, peer: RpcPeer) -> None:
        self._servers: dict[str, _Served] = {}
        self._used: set[str] = set()
        self._peer = peer
        self._counter = 0
        peer.on_request("mcp/message", lambda params, context: self._handle(params, context.signal))

    def serve(self, *, name: str, handler: McpRequestHandler, server_id: str | None = None, max_active_requests: int = 64) -> McpRegistration:
        if server_id is None:
            self._counter += 1
            server_id = f"{name}:{self._counter:x}{secrets.token_hex(3)}"
        if server_id in self._used:
            raise ValueError(f"MCP server id {server_id} was already used on this connection")
        if not isinstance(max_active_requests, int) or max_active_requests < 1:
            raise ValueError("max_active_requests must be a positive integer")
        self._used.add(server_id)
        served = _Served(name, handler, max_active_requests)
        self._servers[server_id] = served
        sid = server_id

        async def dispose() -> None:
            if self._servers.get(sid) is not served:
                return
            del self._servers[sid]
            served.controller.abort(RuntimeError(f"MCP server {sid} was disposed"))
            if served.active:
                await asyncio.gather(*served.active.values(), return_exceptions=True)

        return McpRegistration(name, server_id, AcpMcpServer(name, server_id), dispose)

    async def _handle(self, raw: Any, caller_signal: AbortSignal) -> McpOutcome:
        envelope = raw if isinstance(raw, dict) else {}
        server_id, request_id, method = envelope.get("serverId"), envelope.get("requestId"), envelope.get("method")
        if not isinstance(server_id, str) or not isinstance(request_id, str) or not isinstance(method, str):
            raise RpcError(-32602, "mcp/message needs string serverId, requestId and method")
        params = envelope.get("params")
        if params is not None and not isinstance(params, dict):
            raise RpcError(-32602, "mcp/message params must be an object")
        served = self._servers.get(server_id)
        if served is None:
            raise RpcError(McpBindingError.SERVER_UNAVAILABLE, "MCP server registration unavailable", {"serverId": server_id})
        if request_id in served.active:
            raise RpcError(-32602, "duplicate active MCP request id", {"serverId": server_id, "requestId": request_id})
        if len(served.active) >= served.max_active:
            raise RpcError(McpBindingError.RESOURCE_LIMIT_EXCEEDED, "MCP-over-ACP active request limit exceeded", {"serverId": server_id})
        signal = AbortSignal.any([caller_signal, served.controller.signal])
        done = False
        meta = envelope.get("_meta") if isinstance(envelope.get("_meta"), dict) else None
        task = asyncio.ensure_future(self._run(served, server_id, request_id, method, params, meta, signal, lambda: done))
        served.active[request_id] = task
        try:
            return await task
        except Exception as error:  # noqa: BLE001
            if signal.aborted:
                raise RpcError(McpBindingError.CANCELLED, "MCP request cancelled") from error
            raise RpcError(McpBindingError.BACKEND_FAILED, str(error) or type(error).__name__) from error
        finally:
            # No notification may follow the answer.
            done = True
            served.active.pop(request_id, None)
            # Let go of the server's signal: it outlives the request.
            signal.dispose()

    async def _run(
        self,
        served: _Served,
        server_id: str,
        request_id: str,
        method: str,
        params: dict[str, Any] | None,
        envelope_meta: dict[str, Any] | None,
        signal: AbortSignal,
        is_done: Callable[[], bool],
    ) -> McpOutcome:
        # Recorded as active before the handler starts.
        await asyncio.sleep(0)
        meta = params.get("_meta") if params is not None and isinstance(params.get("_meta"), dict) else None
        version = meta.get(META_VERSION) if meta else None
        if not isinstance(version, str):
            return _invalid_params(f"missing {META_VERSION} in params._meta")
        if version != MCP_PROTOCOL_VERSION:
            return {"error": {"code": -32022, "message": "Unsupported protocol version", "data": {"supported": [MCP_PROTOCOL_VERSION], "requested": version}}}
        capabilities = meta.get(META_CAPABILITIES) if meta else None
        if not isinstance(capabilities, dict):
            return _invalid_params(f"missing {META_CAPABILITIES} in params._meta")
        # Cancelled before it started: it never starts.
        signal.throw_if_aborted()

        async def notify(notify_method: str, notify_params: Any) -> None:
            if is_done():
                return
            message: dict[str, Any] = {"serverId": server_id, "requestId": request_id, "method": notify_method}
            if notify_params is not None:
                message["params"] = notify_params
            await self._peer.notify("mcp/message", message)

        context = McpOperationContext(
            server_id=server_id,
            request_id=request_id,
            method=method,
            params=params,
            protocol_version=version,
            client_capabilities=capabilities,
            client_info=meta.get(META_CLIENT_INFO) if meta else None,
            envelope_meta=envelope_meta,
            signal=signal,
            _notify=notify,
        )
        try:
            outcome = served.handler(context)
            if inspect.isawaitable(outcome):
                outcome = await outcome
        except Exception as error:  # noqa: BLE001
            to_mcp = getattr(error, "to_mcp_error", None)
            if not callable(to_mcp):
                raise
            outcome = {"error": to_mcp()}
        if not _valid_outcome(outcome):
            raise ValueError(
                "MCP handler gave an invalid outcome: exactly one of a `result` or an `error` with an integer `code` and string `message`"
            )
        return outcome


def _record(value: Any) -> dict[str, str]:
    # v1 and v2 send name/value lists; accept a plain object too.
    if isinstance(value, list):
        return {e["name"]: str(e.get("value") if e.get("value") is not None else "") for e in value if isinstance(e, dict) and isinstance(e.get("name"), str)}
    if isinstance(value, dict):
        return {k: str(v) for k, v in value.items()}
    return {}


def parse_mcp_servers(raw: Any) -> tuple[list[McpServer], list[Any]]:
    """The agent side of `mcp_servers_param`: a session's `mcpServers` as sent (v1 or v2), typed.

    Returns `(servers, unknown)`: entries of a transport this side does not know, or
    missing required fields, are left out and returned in `unknown`.
    """
    servers: list[McpServer] = []
    unknown: list[Any] = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            unknown.append(entry)
            continue
        name = entry["name"]
        # Only a missing (or null) type is inferred; any other value, even "", is the entry's own.
        kind = entry["type"] if entry.get("type") is not None else ("stdio" if isinstance(entry.get("command"), str) else None)
        if kind == "stdio" and isinstance(entry.get("command"), str):
            args = [str(a) for a in entry["args"]] if isinstance(entry.get("args"), list) else []
            servers.append(StdioMcpServer(name, entry["command"], args, _record(entry.get("env"))))
        elif kind == "http" and isinstance(entry.get("url"), str):
            servers.append(HttpMcpServer(name, entry["url"], _record(entry.get("headers"))))
        elif kind == "sse" and isinstance(entry.get("url"), str):
            servers.append(SseMcpServer(name, entry["url"], _record(entry.get("headers"))))
        elif kind == "acp" and isinstance(entry.get("serverId"), str):
            servers.append(AcpMcpServer(name, entry["serverId"]))
        else:
            unknown.append(entry)
    return servers, unknown
