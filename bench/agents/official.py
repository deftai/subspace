"""The benchmark agent on the official Python SDK (agent-client-protocol). See protocol.md."""

import asyncio
import atexit
import os
import resource
import sys
from typing import Any

from acp import Agent, run_agent
from acp.schema import (
    AgentCapabilities,
    AgentMessageChunk,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PermissionOption,
    PromptResponse,
    TextContentBlock,
    ToolCallUpdate,
)


def _rss() -> None:
    if path := os.environ.get("BENCH_RSS_FILE"):
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        with open(path, "w") as f:
            f.write(str(peak if sys.platform == "darwin" else peak * 1024))


atexit.register(_rss)

OPTIONS = [PermissionOption(option_id="yes", name="Allow", kind="allow_once"), PermissionOption(option_id="no", name="Reject", kind="reject_once")]


class BenchAgent(Agent):
    def __init__(self) -> None:
        self.conn: Any = None
        self.sessions = 0

    def on_connect(self, conn: Any) -> None:
        self.conn = conn

    async def initialize(self, protocol_version: int, client_capabilities=None, client_info=None, **kwargs: Any) -> InitializeResponse:
        return InitializeResponse(protocol_version=1, agent_capabilities=AgentCapabilities(), agent_info=Implementation(name="bench-official-py", version="1.0.0"))

    async def new_session(self, cwd: str, mcp_servers=None, **kwargs: Any) -> NewSessionResponse:
        self.sessions += 1
        return NewSessionResponse(session_id=f"s{self.sessions}")

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any) -> PromptResponse:
        parts = "".join(getattr(block, "text", "") for block in prompt).split(" ")
        if parts[0] == "stream":
            chunk = "x" * int(parts[2])
            for _ in range(int(parts[1])):
                await self.conn.session_update(session_id, AgentMessageChunk(session_update="agent_message_chunk", content=TextContentBlock(type="text", text=chunk)))
        elif parts[0] == "ask":
            for i in range(int(parts[1])):
                await self.conn.request_permission(session_id=session_id, tool_call=ToolCallUpdate(tool_call_id=f"t{i}"), options=OPTIONS)
        return PromptResponse(stop_reason="end_turn")

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        pass


asyncio.run(run_agent(BenchAgent()))
