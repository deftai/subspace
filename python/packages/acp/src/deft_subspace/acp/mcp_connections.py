"""The agent side of a session's other MCP servers (`stdio`, `http`, `sse`):
the ones the agent connects to itself.

Subspace doesn't speak MCP over those transports itself; an `McpConnector`
does. A server is connected the first time a turn uses it, kept for the
session's later turns, and closed when the session closes, the client sends
new servers (load or resume), or the connection closes.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from deft_subspace.kernel import AbortError, AbortSignal

from .mcp import HttpMcpServer, McpOutcome, SseMcpServer, StdioMcpServer
from .mcp_caller import McpCallOptions

ExternalMcpServer = StdioMcpServer | HttpMcpServer | SseMcpServer


class McpConnection(Protocol):
    """One open connection to an MCP server."""

    def request(self, method: str, params: dict[str, Any] | None, options: McpCallOptions) -> Awaitable[McpOutcome]:
        """Any MCP request; an inner error is `{"error": ...}`, not a raise."""
        ...

    def close(self) -> Awaitable[None]: ...


@dataclass(frozen=True)
class McpConnectContext:
    cwd: str
    signal: AbortSignal | None = None


class McpConnector(Protocol):
    """Connects to MCP servers over the transports it lists."""

    @property
    def transports(self) -> Sequence[str]: ...

    def connect(self, server: ExternalMcpServer, context: McpConnectContext) -> Awaitable[McpConnection]: ...


def _reason(signal: AbortSignal) -> BaseException:
    reason = signal.reason
    return reason if isinstance(reason, BaseException) else AbortError(str(reason))


class SessionMcpConnections:
    """A session's connections, by server name."""

    def __init__(self, connector: McpConnector | None, cwd: str) -> None:
        self._open: dict[str, asyncio.Future[McpConnection]] = {}
        self._connector = connector
        self._cwd = cwd
        self._closed = False

    def problem(self, server: ExternalMcpServer) -> str | None:
        """Why `server` can't be used here, or None."""
        if self._closed:
            return f'MCP server "{server.name}": the session is closed'
        if self._connector is None:
            return (
                f'MCP server "{server.name}" is {server.type}: give serve_agent an `mcp_connector` to use it'
            )
        transports = list(self._connector.transports)
        if server.type not in transports:
            return f'MCP server "{server.name}" is {server.type}, which the connector does not support ({", ".join(transports)})'
        return None

    async def get(self, server: ExternalMcpServer, signal: AbortSignal | None = None) -> McpConnection:
        """The connection to `server`, opening it on first use. A failed connect is not kept, so a later call tries again."""
        problem = self.problem(server)
        if problem or self._connector is None:
            raise RuntimeError(problem)
        connection = self._open.get(server.name)
        if connection is None:
            # Not the turn's signal: the connection outlives the turn that opened it.
            opened: asyncio.Future[McpConnection] = asyncio.ensure_future(self._connector.connect(server, McpConnectContext(cwd=self._cwd)))
            self._open[server.name] = opened
            name = server.name

            def drop(done: asyncio.Future[McpConnection]) -> None:
                failed = done.cancelled() or done.exception() is not None
                if failed and self._open.get(name) is done:
                    del self._open[name]

            opened.add_done_callback(drop)
            connection = opened
        if signal is None:
            return await asyncio.shield(connection)
        # The caller stops waiting on abort; the connect itself carries on for the next turn.
        if signal.aborted:
            raise _reason(signal)
        stopped: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        def on_abort(_reason: Any) -> None:
            if not stopped.done():
                stopped.set_result(None)

        remove = signal.add_listener(on_abort)
        try:
            await asyncio.wait({connection, stopped}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            remove()
            if not stopped.done():
                stopped.cancel()
        if connection.done():
            return connection.result()
        raise _reason(signal)

    async def reset(self, cwd: str) -> None:
        """New servers from load or resume: drop every connection, the next use reconnects."""
        self._cwd = cwd
        await self._close_open()

    async def close(self) -> None:
        self._closed = True
        await self._close_open()

    async def _close_open(self) -> None:
        open_ = list(self._open.values())
        self._open.clear()

        async def close_one(connection: asyncio.Future[McpConnection]) -> None:
            try:
                await asyncio.wait({connection})
                if connection.cancelled() or connection.exception() is not None:
                    return
                await connection.result().close()
            except Exception:  # noqa: BLE001
                pass

        await asyncio.gather(*(close_one(c) for c in open_))
