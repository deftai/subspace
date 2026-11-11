"""The agent side of MCP-over-ACP: calling MCP servers the client serves over
the ACP connection (`"type": "acp"` in a session's `mcpServers`).

    async def prompt(turn):
        tools = turn.mcp("project-tools")
        for tool in await tools.list_tools(): ...
        result = await tools.call_tool("echo", {"message": "hi"})

Each call is one stateless MCP 2026-07-28 request: a fresh request id, the
protocol version, client capabilities and client info in `params._meta`.
There is no MCP handshake. Notifications for a call (progress) go to its
`on_notification`; cancelling (the turn's signal by default) sends
`$/cancel_request`.
"""

from __future__ import annotations

import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any, Protocol

from deft_subspace.kernel import AbortSignal, RpcError

from .mcp import MCP_PROTOCOL_VERSION, META_CAPABILITIES, META_CLIENT_INFO, META_VERSION, AcpMcpServer, McpOutcome, McpServer

McpNotificationListener = Callable[[dict[str, Any]], None]
"""Gets `{"method": ..., "params": ...}` (params only when sent)."""


@dataclass(frozen=True)
class McpCallOptions:
    #: Cancels the call (`$/cancel_request`). In a turn, defaults to the turn's signal.
    signal: AbortSignal | None = None
    #: MCP notifications for this call, e.g. `notifications/progress`.
    on_notification: McpNotificationListener | None = None
    #: Default: generated. Never reuse one still active on the same server.
    request_id: str | None = None
    timeout_ms: float | None = None


class McpError(Exception):
    """An inner MCP error: the server answered, with an MCP (not ACP) error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


McpTool = dict[str, Any]
"""A tool from `tools/list` (MCP fields kept as sent: `name`, `title`, `description`, `inputSchema`, ...)."""

McpSend = Callable[[str, "dict[str, Any] | None", McpCallOptions], Awaitable[McpOutcome]]
"""Sends one MCP request to one server; an inner error is `{"error": ...}`, not a raise."""


class _Requester(Protocol):
    def request(self, method: str, params: Any = None, *, signal: AbortSignal | None = None, timeout_ms: float | None = None) -> Awaitable[Any]: ...


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if n == 0:
        return "0"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out


def _key(server_id: str, request_id: str) -> str:
    return f"{server_id}\u0000{request_id}"


class McpServerClient:
    """One MCP server of the session, as the agent sees it (any transport)."""

    def __init__(self, server: McpServer, send: McpSend, defaults: McpCallOptions | None = None) -> None:
        self.name = server.name
        self.type = server.type
        #: For `acp` servers: the id the client gave it.
        self.server_id: str | None = server.server_id if isinstance(server, AcpMcpServer) else None
        self._send = send
        self._defaults = defaults or McpCallOptions()

    def _options(
        self,
        signal: AbortSignal | None,
        on_notification: McpNotificationListener | None,
        request_id: str | None,
        timeout_ms: float | None,
    ) -> McpCallOptions:
        d = self._defaults
        return replace(
            d,
            signal=signal if signal is not None else d.signal,
            on_notification=on_notification if on_notification is not None else d.on_notification,
            request_id=request_id if request_id is not None else d.request_id,
            timeout_ms=timeout_ms if timeout_ms is not None else d.timeout_ms,
        )

    async def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        signal: AbortSignal | None = None,
        on_notification: McpNotificationListener | None = None,
        request_id: str | None = None,
        timeout_ms: float | None = None,
    ) -> McpOutcome:
        """Any MCP request; returns the outcome (an inner error is `{"error": ...}`, not a raise)."""
        return await self._send(method, params, self._options(signal, on_notification, request_id, timeout_ms))

    async def _call(self, method: str, params: dict[str, Any], options: McpCallOptions) -> dict[str, Any]:
        outcome = await self._send(method, params, options)
        if "error" in outcome:
            error = outcome["error"]
            raise McpError(error["code"], error["message"], error.get("data"))
        result = outcome.get("result")
        return result if isinstance(result, dict) else {}

    async def discover(
        self,
        *,
        signal: AbortSignal | None = None,
        on_notification: McpNotificationListener | None = None,
        timeout_ms: float | None = None,
    ) -> dict[str, Any]:
        """`server/discover`."""
        return await self._call("server/discover", {}, self._options(signal, on_notification, None, timeout_ms))

    async def list_tools(
        self,
        *,
        signal: AbortSignal | None = None,
        on_notification: McpNotificationListener | None = None,
        timeout_ms: float | None = None,
    ) -> list[McpTool]:
        """Every tool, following `nextCursor` pages."""
        options = self._options(signal, on_notification, None, timeout_ms)
        tools: list[McpTool] = []
        cursor: str | None = None
        for _page in range(100):
            result = await self._call("tools/list", {"cursor": cursor} if cursor else {}, options)
            listed = result.get("tools")
            if isinstance(listed, list):
                tools.extend(t for t in listed if isinstance(t, dict))
            next_cursor = result.get("nextCursor")
            cursor = next_cursor if isinstance(next_cursor, str) and next_cursor else None
            if not cursor:
                break
        return tools

    async def call_tool(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        signal: AbortSignal | None = None,
        on_notification: McpNotificationListener | None = None,
        request_id: str | None = None,
        timeout_ms: float | None = None,
    ) -> dict[str, Any]:
        """`tools/call`. Returns the MCP result (`content`, `isError`, maybe
        `resultType: "input_required"`); a tool that failed is `isError: True`,
        not a raise. Raises `McpError` for an inner protocol error."""
        return await self._call(
            "tools/call",
            {"name": name, "arguments": args if args is not None else {}},
            self._options(signal, on_notification, request_id, timeout_ms),
        )


def server_client(server: McpServer, send: McpSend, defaults: McpCallOptions | None = None) -> McpServerClient:
    """The `McpServerClient` helpers over any way of sending."""
    return McpServerClient(server, send, defaults)


class McpCaller:
    """One per connection: sends `mcp/message` and routes its notifications."""

    def __init__(self, peer: _Requester, client_info: dict[str, str]) -> None:
        self._peer = peer
        self._client_info = client_info
        self._active: dict[str, McpNotificationListener | None] = {}
        self._counter = 0

    def receive(self, params: Any) -> None:
        """An `mcp/message` notification from the client: progress and the like for a call in flight."""
        if (
            not isinstance(params, dict)
            or not isinstance(params.get("serverId"), str)
            or not isinstance(params.get("requestId"), str)
            or not isinstance(params.get("method"), str)
        ):
            return
        # Unknown or finished requests: dropped, never given to another call.
        listener = self._active.get(_key(params["serverId"], params["requestId"]))
        if listener is not None:
            inner = params.get("params")
            listener({"method": params["method"], **({"params": inner} if isinstance(inner, dict) else {})})

    async def request(
        self,
        server_id: str,
        method: str,
        params: dict[str, Any] | None = None,
        options: McpCallOptions | None = None,
    ) -> McpOutcome:
        options = options or McpCallOptions()
        if options.request_id is not None:
            request_id = options.request_id
        else:
            self._counter += 1
            request_id = f"mcp-{_base36(self._counter)}-{_base36(random.getrandbits(40))[:8]}"
        key = _key(server_id, request_id)
        if key in self._active:
            raise RuntimeError(f"MCP request id {request_id} is already active on {server_id}")
        inner: dict[str, Any] = dict(params or {})
        meta: dict[str, Any] = dict(inner["_meta"]) if isinstance(inner.get("_meta"), dict) else {}
        # Required per request (MCP 2026-07-28); values the caller set are kept.
        if meta.get(META_VERSION) is None:
            meta[META_VERSION] = MCP_PROTOCOL_VERSION
        if meta.get(META_CAPABILITIES) is None:
            meta[META_CAPABILITIES] = {}
        if meta.get(META_CLIENT_INFO) is None:
            meta[META_CLIENT_INFO] = self._client_info
        inner["_meta"] = meta
        self._active[key] = options.on_notification
        try:
            result = await self._peer.request(
                "mcp/message",
                {"serverId": server_id, "requestId": request_id, "method": method, "params": inner},
                signal=options.signal,
                timeout_ms=options.timeout_ms if options.timeout_ms is not None else 0,
            )
            if not isinstance(result, dict):
                raise RpcError(-33002, "mcp/message answered without an MCP outcome")
            # `result` wins if both are present.
            if "result" in result:
                return {"result": result["result"]}
            error = result.get("error")
            if isinstance(error, dict) and isinstance(error.get("code"), int) and isinstance(error.get("message"), str):
                return {"error": error}
            raise RpcError(-33002, "mcp/message answered without an MCP outcome")
        finally:
            self._active.pop(key, None)

    def server(self, server: AcpMcpServer, defaults: McpCallOptions | None = None) -> McpServerClient:
        server_id = server.server_id

        async def send(method: str, params: dict[str, Any] | None, options: McpCallOptions) -> McpOutcome:
            return await self.request(server_id, method, params, options)

        return server_client(server, send, defaults)
