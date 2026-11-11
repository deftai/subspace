"""`mcp_connector()`: the agent connects to a session's `stdio`, `http` and `sse` MCP servers itself.

    serve_stdio(name="my-agent", mcp_connector=mcp_connector(), prompt=prompt)

    async def prompt(turn):
        files = turn.mcp("filesystem")
        tools = await files.list_tools()

A stdio server runs in the session's `cwd` with this process's environment
plus the server's `env`. Its stderr goes to this process's stderr, because
stdout is the ACP channel and a server can't write there. The connection does
the MCP `initialize` handshake. Requests go as sent: `tools/call` results are
not interpreted, the same as for `acp` servers.

- `stdio` servers need nothing more: the connector speaks MCP's stdio
  transport (JSON-RPC as NDJSON) over the kernel's peer, with the `initialize`
  handshake.
- `http` (Streamable HTTP) and `sse` servers go through the official MCP SDK
  (the `mcp` extra: `pip install 'deft-subspace-acp[mcp]'`), loaded on first
  use. It negotiates the protocol version (2026-07-28 servers, and older ones),
  and sends the server's `headers` with every request.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
from collections.abc import Callable, Sequence
from typing import Any, Literal

from deft_subspace.kernel import AbortError, LocalError, RpcError, RpcPeer, cancel_request, ndjson, spawn_process
from deft_subspace.kernel.process import SupervisedProcess

from .mcp import HttpMcpServer, McpOutcome, SseMcpServer, StdioMcpServer
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


def _load_sdk() -> Any:
    try:
        import mcp
        from mcp.client.sse import sse_client
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import create_mcp_http_client
        from mcp.shared.exceptions import MCPError
        from mcp_types._types import Request, RequestParams
        from pydantic import ConfigDict, TypeAdapter
    except ImportError as error:
        raise ImportError("mcp_connector() needs the mcp package for http and sse servers: pip install 'deft-subspace-acp[mcp]'") from error

    class RawParams(RequestParams):
        """Params passed on as given."""

        model_config = ConfigDict(extra="allow")

    class RawRequest(Request[RawParams | None, str]):  # type: ignore[misc]
        pass

    return {
        "Client": mcp.Client,
        "sse_client": sse_client,
        "streamable_http_client": streamable_http_client,
        "http_client": create_mcp_http_client,
        "MCPError": MCPError,
        "RawParams": RawParams,
        "RawRequest": RawRequest,
        "result": TypeAdapter(dict[str, Any]),
    }


class _SdkConnection:
    """An MCP SDK client, held open by a task of its own (its transports need one task to enter and leave them)."""

    def __init__(self, sdk: dict[str, Any], transport: Any, timeout_ms: float | None) -> None:
        self._sdk = sdk
        self._timeout_ms = timeout_ms
        self._ready: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._stop = asyncio.Event()
        self._task = asyncio.get_running_loop().create_task(self._hold(transport), name="mcp-client")

    async def _hold(self, transport: Any) -> None:
        try:
            async with self._sdk["Client"](transport) as client:
                if not self._ready.done():
                    self._ready.set_result(client)
                await self._stop.wait()
        except BaseException as error:  # noqa: BLE001
            if not self._ready.done():
                self._ready.set_exception(error if isinstance(error, Exception) else RuntimeError(str(error)))
            if isinstance(error, asyncio.CancelledError):
                raise

    async def opened(self, timeout_ms: float, signal: Any) -> None:
        waiter = asyncio.ensure_future(asyncio.wait_for(asyncio.shield(self._ready), timeout_ms / 1000))
        remove = signal.add_listener(lambda _reason: waiter.cancel()) if signal is not None else None
        try:
            await waiter
        except asyncio.CancelledError:
            if signal is not None and signal.aborted:
                raise AbortError("connect cancelled") from None
            raise
        finally:
            if remove is not None:
                remove()

    async def request(self, method: str, params: dict[str, Any] | None, options: McpCallOptions) -> McpOutcome:
        client = await asyncio.shield(self._ready)
        sdk = self._sdk
        listener = options.on_notification

        async def progress(value: float, total: float | None, message: str | None) -> None:
            if listener is None:
                return
            note: dict[str, Any] = {"progress": value}
            if total is not None:
                note["total"] = total
            if message is not None:
                note["message"] = message
            result: Any = listener({"method": "notifications/progress", "params": note})
            if inspect.isawaitable(result):
                await result

        timeout = options.timeout_ms if options.timeout_ms is not None else self._timeout_ms
        request = sdk["RawRequest"](method=method, params=sdk["RawParams"].model_validate(params) if params is not None else None)
        call = asyncio.ensure_future(
            client.session.send_request(
                request,
                sdk["result"],
                request_read_timeout_seconds=timeout / 1000 if timeout else None,
                progress_callback=progress if listener is not None else None,
            )
        )
        signal = options.signal
        remove = signal.add_listener(lambda _reason: call.cancel()) if signal is not None else None
        try:
            return {"result": await call}
        except asyncio.CancelledError:
            if signal is not None and signal.aborted:
                raise AbortError(f"{method} cancelled") from None
            raise
        except sdk["MCPError"] as error:
            # An answer with an error is the server's; anything else (abort, timeout, transport) raises.
            data = error.error.data
            return {"error": {"code": error.code, "message": error.error.message, **({"data": data} if data is not None else {})}}
        finally:
            if remove is not None:
                remove()

    async def close(self) -> None:
        self._stop.set()
        try:
            await asyncio.wait_for(asyncio.shield(self._task), 5)
        except BaseException:  # noqa: BLE001
            self._task.cancel()


class _Connector:
    def __init__(
        self,
        name: str,
        version: str,
        stderr: Literal["inherit", "ignore"] | Callable[[str, str], None],
        timeout_ms: float | None,
        connect_timeout_ms: float,
        transports: Sequence[str],
    ) -> None:
        self._transports = tuple(transports)
        self._name = name
        self._version = version
        self._stderr = stderr
        self._timeout_ms = timeout_ms
        self._connect_timeout_ms = connect_timeout_ms

    @property
    def transports(self) -> Sequence[str]:
        return self._transports

    async def connect(self, server: ExternalMcpServer, context: McpConnectContext) -> McpConnection:
        if server.type not in self._transports:
            raise ValueError(f"MCP server {server.name}: this connector does not connect to {server.type} servers")
        if isinstance(server, (HttpMcpServer, SseMcpServer)):
            return await self._connect_sdk(server, context)
        assert isinstance(server, StdioMcpServer)
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


    async def _connect_sdk(self, server: HttpMcpServer | SseMcpServer, context: McpConnectContext) -> McpConnection:
        sdk = _load_sdk()
        headers = dict(server.headers)
        if isinstance(server, HttpMcpServer):
            transport = sdk["streamable_http_client"](server.url, http_client=sdk["http_client"](headers=headers or None))
        else:
            transport = sdk["sse_client"](server.url, headers=headers or None)
        connection = _SdkConnection(sdk, transport, self._timeout_ms)
        try:
            await connection.opened(self._connect_timeout_ms, context.signal)
        except BaseException:
            await connection.close()
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
    transports: Sequence[Literal["stdio", "http", "sse"]] = ("stdio", "http", "sse"),
) -> Any:
    """Connects to stdio, http and sse MCP servers (http and sse need the `mcp` extra).

    - `name`, `version`: the `clientInfo` sent to servers.
    - `stderr`: where servers' stderr goes: `"inherit"`, `"ignore"`, or `fn(line, server_name)`.
    - `timeout_ms`: the default per-request timeout. Default none; requests are cancelled with the turn instead.
    - `connect_timeout_ms`: the longest a connect (start and handshake) may take.
    - `transports`: the transports to advertise and support.
    """
    return _Connector(name, version, stderr, timeout_ms, connect_timeout_ms, transports)


__all__ = ["HANDSHAKE_VERSION", "mcp_connector"]
