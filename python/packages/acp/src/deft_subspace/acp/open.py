"""Opening a ready session, for any channel: `connect_session()` is `start()`
for a connection you already have (a socket, an in-process agent).

    connected = await connect_session(
        channel,
        cwd="/work",
        on_permission=lambda request, _signal: "allow" if request.tool_call and request.tool_call.kind == "read" else "reject",
        on_message=lambda delta, info, _event: print(info.separator + delta, end=""),
    )
    await connected.run("What does this repo do?")
    await connected.close()
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from deft_subspace.kernel import Channel, ErrorCode, RpcError

from .client import AcpClient, Session, SessionMcpServers
from ._conveniences import SessionConveniences
from .handlers import merge_handlers


@dataclass(frozen=True)
class OpenedSession:
    session: Session
    mode_warning: str | None = None


async def open_session(
    client: AcpClient,
    *,
    cwd: str,
    mcp_servers: SessionMcpServers | None = None,
    additional_directories: list[str] | None = None,
    mode: str | None = None,
) -> OpenedSession:
    """Open a session: on "needs a login", if the agent offers exactly one method
    it handles itself, log in with it once and try again; then switch to `mode`
    when offered. A mode the agent does not offer is a warning, not a failure."""
    try:
        session = await client.new_session(cwd, mcp_servers=mcp_servers, additional_directories=additional_directories)
    except RpcError as error:
        methods = [m for m in client.auth_methods if m.type == "agent"]
        if not (error.code == ErrorCode.AUTH_REQUIRED and len(methods) == 1):
            raise
        await client.authenticate(methods[0].id)
        session = await client.new_session(cwd, mcp_servers=mcp_servers, additional_directories=additional_directories)
    if not mode:
        return OpenedSession(session)
    modes = session.modes
    if modes is not None and any(m.id == mode for m in modes.available):
        await session.set_mode(mode)
        return OpenedSession(session)
    offered = ", ".join(m.id for m in modes.available) if modes is not None else ""
    return OpenedSession(session, f'The agent offers no mode "{mode}" (offered: {offered or "none"}); it runs in its own.')


def require_permission_answer(options: Mapping[str, Any], caller: str) -> None:
    """Raises TypeError unless the options say how to answer permission questions
    (`permissions`, or `on_permission` flat or in `handlers`)."""
    if options.get("permissions"):
        return
    merged = merge_handlers(options.get("handlers"), dict(options))
    if merged is not None and merged.on_permission is not None:
        return
    raise TypeError(
        f"{caller} needs an answer for the agent's permission questions: pass on_permission=lambda request, signal: "
        "'allow' or 'reject', or permissions='reject' to refuse everything ('allow' to allow everything)."
    )


class ConnectedSession(SessionConveniences):
    """A session ready for turns, and its connection. `close()` (or `async with`) closes both."""

    def __init__(self, client: AcpClient, session: Session, mode_warning: str | None) -> None:
        super().__init__(session)
        self.client = client
        self.session = session
        self.mode_warning = mode_warning
        self._closing: asyncio.Task[None] | None = None

    async def close(self) -> None:
        """Close the session and the connection."""
        if self._closing is None:
            self._closing = asyncio.ensure_future(self._close())
        await asyncio.shield(self._closing)

    async def _close(self) -> None:
        try:
            await self.session.close()
        except Exception:
            pass
        await self.client.close()

    async def __aenter__(self) -> ConnectedSession:
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()


async def connect_session(
    channel: Channel[Any],
    *,
    cwd: str | None = None,
    mcp_servers: SessionMcpServers | None = None,
    additional_directories: list[str] | None = None,
    mode: str | None = None,
    **client_options: Any,
) -> ConnectedSession:
    """Connect over a channel and open a session, ready for turns. Handler options
    are defaults for every turn. Like `start()`, it needs a permission answer.
    `cwd` defaults to `os.getcwd()`. Other options are `AcpClient.connect()`'s."""
    require_permission_answer(client_options, "connect_session()")
    folder = cwd if cwd is not None else os.getcwd()
    client = await AcpClient.connect(channel, **client_options)
    try:
        opened = await open_session(client, cwd=folder, mcp_servers=mcp_servers, additional_directories=additional_directories, mode=mode)
    except BaseException:
        await client.close()
        raise
    return ConnectedSession(client, opened.session, opened.mode_warning)
