"""The benchmark client on the official Python SDK (agent-client-protocol)."""

import asyncio
import contextlib
import os
from typing import Any

from acp import spawn_agent_process
from acp.schema import AgentMessageChunk, AllowedOutcome, RequestPermissionResponse, TextContentBlock
from common import parse_args, run


def _passed_env() -> dict[str, str]:
    # The SDK starts agents with a trimmed environment (PATH and a few more); pass ours on.
    return {k: v for k, v in os.environ.items() if k.startswith("BENCH_")}


class BenchClient:
    def __init__(self) -> None:
        self.texts: dict[str, list[str]] = {}

    async def request_permission(self, session_id: str, tool_call: Any, options: Any, **kwargs: Any) -> RequestPermissionResponse:
        return RequestPermissionResponse(outcome=AllowedOutcome(outcome="selected", option_id="yes"))

    async def session_update(self, session_id: str, update: Any, **kwargs: Any) -> None:
        if isinstance(update, AgentMessageChunk) and isinstance(update.content, TextContentBlock):
            self.texts.setdefault(session_id, []).append(update.content.text)


class OfficialDriver:
    def __init__(self, stack: contextlib.AsyncExitStack, conn: Any, client: BenchClient) -> None:
        self.stack, self.conn, self.client = stack, conn, client

    async def new_session(self) -> str:
        return (await self.conn.new_session(cwd=os.getcwd(), mcp_servers=[])).session_id

    async def prompt(self, session: str, text: str) -> str:
        self.client.texts[session] = []
        await self.conn.prompt(session_id=session, prompt=[TextContentBlock(type="text", text=text)])
        return "".join(self.client.texts.get(session, []))

    async def close(self) -> None:
        await self.stack.aclose()


async def main() -> None:
    args = parse_args()

    async def connect() -> OfficialDriver:
        stack = contextlib.AsyncExitStack()
        client = BenchClient()
        conn, _process = await stack.enter_async_context(spawn_agent_process(client, args.agent[0], *args.agent[1:], env=_passed_env()))
        await conn.initialize(protocol_version=1)
        return OfficialDriver(stack, conn, client)

    await run(args, connect)


asyncio.run(main())
