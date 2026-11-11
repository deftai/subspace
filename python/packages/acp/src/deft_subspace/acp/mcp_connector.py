"""`mcp_connector()`: the agent connects to a session's `stdio` MCP servers itself.

    serve_stdio(name="my-agent", mcp_connector=mcp_connector(), prompt=prompt)

    async def prompt(turn):
        files = turn.mcp("filesystem")
        tools = await files.list_tools()

A stdio server runs in the session's `cwd` with this process's environment
plus the server's `env`. Its stderr goes to this process's stderr, because
stdout is the ACP channel and a server can't write there. The connection does
the MCP `initialize` handshake. Requests go as sent: `tools/call` results are
not interpreted, the same as for `acp` servers.

Unlike the TypeScript connector, this one has no dependency on an MCP SDK. It
speaks MCP's stdio transport (JSON-RPC as NDJSON) over the kernel's peer. It
does not yet connect to `http` or `sse` servers.
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Sequence
from typing import Any, Literal

from deft_subspace.kernel import LocalError, RpcError, RpcPeer, cancel_request, ndjson, spawn_process
from deft_subspace.kernel.process import SupervisedProcess

from .mcp import McpOutcome, StdioMcpServer
from .mcp_caller import McpCallOptions
from .mcp_connections import ExternalMcpServer, McpConnectContext, McpConnection

#: The MCP version asked for in the handshake; the server may answer an older one.
HANDSHAKE_VERSION = "2025-06-18"


class _StdioConnection:
    def __init__(self, process: SupervisedProcess, peer: RpcPeer, timeout_ms: float | None) -> None:
        self._process = process
        self._peer = peer
        self._timeout_ms = timeout_ms
        self._progress: dict[str, Callable[[dict[str, Any]], Any]] = {}
        self._counter = 0
        peer.on_notification("notifications/progress", self._on_progress)

    def _on_progress(self, params: Any, _context: Any) -> None:
        token = params.get("progressToken") if isinstance(params, dict) else None
        listener = self._progress.get(str(token)) if token is not None else None
        if listener is not None:
            listener({"method": "notifications/progress", "params": dict(params)})

    async def request(self, method: str, params: dict[str, Any] | None, options: McpCallOptions) -> McpOutcome:
        sent = dict(params) if params else None
        token: str | None = None
        if options.on_notification is not None:
            self._counter += 1
            token = f"p{self._counter}"
            sent = sent or {}
            sent["_meta"] = {**(sent.get("_meta") or {}), "progressToken": token}
            self._progress[token] = options.on_notification
        try:
            result = await self._peer.request(
                method, sent, signal=options.signal, timeout_ms=options.timeout_ms if options.timeout_ms is not None else self._timeout_ms
            )
            return {"result": result}
        except RpcError as error:
            # An answer with an error is the server's; anything else (abort, timeout, transport) raises.
            return {"error": error.to_json()}
        finally:
            if token is not None:
                self._progress.pop(token, None)

    async def close(self) -> None:
        await self._peer.close()
        await self._process.stop()


class _Connector:
    def __init__(
        self,
        name: str,
        version: str,
        stderr: Literal["inherit", "ignore"] | Callable[[str, str], None],
        timeout_ms: float | None,
        connect_timeout_ms: float,
    ) -> None:
        self._name = name
        self._version = version
        self._stderr = stderr
        self._timeout_ms = timeout_ms
        self._connect_timeout_ms = connect_timeout_ms

    @property
    def transports(self) -> Sequence[str]:
        return ("stdio",)

    async def connect(self, server: ExternalMcpServer, context: McpConnectContext) -> McpConnection:
        if not isinstance(server, StdioMcpServer):
            raise ValueError(f"MCP server {server.name}: this connector does not connect to {server.type} servers yet")
        buffered = [""]

        def on_stderr(text: str) -> None:
            if self._stderr == "inherit":
                sys.stderr.write(text)
            elif callable(self._stderr):
                buffered[0] += text
                *lines, buffered[0] = buffered[0].split("\n")
                for line in lines:
                    self._stderr(line, server.name)

        process = await spawn_process(server.command, args=server.args, cwd=context.cwd, env=server.env, on_stderr=on_stderr)
        peer = RpcPeer(ndjson(process.channel), name=f"mcp:{server.name}", **cancel_request)
        connection = _StdioConnection(process, peer, self._timeout_ms)
        peer.start()
        try:
            await peer.request(
                "initialize",
                {"protocolVersion": HANDSHAKE_VERSION, "capabilities": {}, "clientInfo": {"name": self._name, "version": self._version}},
                signal=context.signal,
                timeout_ms=self._connect_timeout_ms,
            )
            await peer.notify("notifications/initialized")
        except BaseException as error:
            # Don't leave a half-started server behind.
            await connection.close()
            tail = process.stderr_tail()
            if tail and isinstance(error, (LocalError, RpcError)):
                raise type(error)(*_args(error, f"\nServer stderr: {tail[-1000:]}")) from error
            raise
        return connection


def _args(error: LocalError | RpcError, extra: str) -> tuple[Any, ...]:
    if isinstance(error, RpcError):
        return (error.code, error.message + extra)
    return (error.kind, error.message + extra)


def mcp_connector(
    *,
    name: str = "subspace",
    version: str = "0.0.0",
    stderr: Literal["inherit", "ignore"] | Callable[[str, str], None] = "inherit",
    timeout_ms: float | None = None,
    connect_timeout_ms: float = 60_000,
) -> Any:
    """Connects to stdio MCP servers.

    - `name`, `version`: the `clientInfo` sent to servers.
    - `stderr`: where servers' stderr goes: `"inherit"`, `"ignore"`, or `fn(line, server_name)`.
    - `timeout_ms`: the default per-request timeout. Default none; requests are cancelled with the turn instead.
    - `connect_timeout_ms`: the longest a connect (start and handshake) may take.
    """
    return _Connector(name, version, stderr, timeout_ms, connect_timeout_ms)


__all__ = ["HANDSHAKE_VERSION", "mcp_connector"]
