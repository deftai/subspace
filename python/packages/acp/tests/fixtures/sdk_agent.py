"""An ACP v1 agent built with the official Python SDK, for interop tests.

Prompt text decides what it does:
- "ask": asks permission for a tool call, then says which option was chosen.
- "slow": waits until cancelled, then ends `cancelled`.
- anything else: echoes the text back in two chunks.
"""

import asyncio
import uuid
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
    ToolCallStart,
    ToolCallUpdate,
)


class EchoAgent(Agent):
    def __init__(self) -> None:
        self.conn: Any = None
        self.cancelled: dict[str, asyncio.Event] = {}

    def on_connect(self, conn: Any) -> None:
        self.conn = conn

    async def initialize(self, protocol_version: int, client_capabilities=None, client_info=None, **kwargs: Any) -> InitializeResponse:
        return InitializeResponse(
            protocol_version=1,
            agent_capabilities=AgentCapabilities(load_session=False),
            agent_info=Implementation(name="sdk-echo", version="1.0.0"),
        )

    async def new_session(self, cwd: str, mcp_servers=None, **kwargs: Any) -> NewSessionResponse:
        session_id = f"sdk-{uuid.uuid4().hex[:8]}"
        self.cancelled[session_id] = asyncio.Event()
        return NewSessionResponse(session_id=session_id)

    async def say(self, session_id: str, text: str) -> None:
        await self.conn.session_update(session_id, AgentMessageChunk(session_update="agent_message_chunk", content=TextContentBlock(type="text", text=text)))

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any) -> PromptResponse:
        text = "".join(getattr(block, "text", "") for block in prompt)
        if text == "ask":
            await self.conn.session_update(
                session_id,
                ToolCallStart(session_update="tool_call", tool_call_id="t1", title="Delete build/", kind="delete", status="pending"),
            )
            answer = await self.conn.request_permission(
                session_id=session_id,
                tool_call=ToolCallUpdate(tool_call_id="t1"),
                options=[
                    PermissionOption(option_id="yes", name="Allow", kind="allow_once"),
                    PermissionOption(option_id="no", name="Reject", kind="reject_once"),
                ],
            )
            outcome = answer.outcome
            chosen = getattr(outcome, "option_id", None) or "cancelled"
            await self.say(session_id, f"chose {chosen}")
            return PromptResponse(stop_reason="end_turn")
        if text == "slow":
            self.cancelled[session_id].clear()
            await self.cancelled[session_id].wait()
            return PromptResponse(stop_reason="cancelled")
        half = len(text) // 2
        await self.say(session_id, f"echo: {text[:half]}")
        await self.say(session_id, text[half:])
        return PromptResponse(stop_reason="end_turn")

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        self.cancelled[session_id].set()


if __name__ == "__main__":
    asyncio.run(run_agent(EchoAgent()))
