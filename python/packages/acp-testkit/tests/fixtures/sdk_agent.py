"""An ACP v1 agent built with the official Python SDK that behaves well for check_agent's default prompts."""

import asyncio
from typing import Any

from acp import Agent, RequestError, run_agent
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

LONG = "Count from 1 to 300, one number per line. Do not use any tools."
PERMISSION = "Create a file named deft-testkit.txt containing the word hi in the current directory."


class WellBehaved(Agent):
    def __init__(self) -> None:
        self.conn: Any = None
        self.cancelled: dict[str, asyncio.Event] = {}
        self.count = 0

    def on_connect(self, conn: Any) -> None:
        self.conn = conn

    async def initialize(
        self, protocol_version: int, client_capabilities=None, client_info=None, **kwargs: Any
    ) -> InitializeResponse:
        return InitializeResponse(
            protocol_version=1,
            agent_capabilities=AgentCapabilities(load_session=False),
            agent_info=Implementation(name="sdk-well-behaved", version="1.0.0"),
            auth_methods=[],
        )

    async def new_session(self, cwd: str, mcp_servers=None, **kwargs: Any) -> NewSessionResponse:
        self.count += 1
        session_id = f"sdk-{self.count}"
        self.cancelled[session_id] = asyncio.Event()
        return NewSessionResponse(session_id=session_id)

    async def say(self, session_id: str, text: str) -> None:
        await self.conn.session_update(
            session_id, AgentMessageChunk(session_update="agent_message_chunk", content=TextContentBlock(type="text", text=text))
        )

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any) -> PromptResponse:
        cancelled = self.cancelled.get(session_id)
        if cancelled is None:
            raise RequestError.resource_not_found(session_id)
        text = "".join(getattr(block, "text", "") for block in prompt)
        if text == LONG:
            for i in range(1, 301):
                if cancelled.is_set():
                    break
                await self.say(session_id, f"{i}\n")
                await asyncio.sleep(0.005)
        elif text == PERMISSION:
            await self.conn.session_update(
                session_id,
                ToolCallStart(
                    session_update="tool_call", tool_call_id="t1", title="Write deft-testkit.txt", kind="edit", status="pending"
                ),
            )
            answer = await self.conn.request_permission(
                session_id=session_id,
                tool_call=ToolCallUpdate(tool_call_id="t1"),
                options=[
                    PermissionOption(option_id="yes", name="Allow", kind="allow_once"),
                    PermissionOption(option_id="no", name="Reject", kind="reject_once"),
                ],
            )
            if getattr(answer.outcome, "outcome", None) == "cancelled":
                await cancelled.wait()
        else:
            await self.say(session_id, "OK")
        return PromptResponse(stop_reason="cancelled" if cancelled.is_set() else "end_turn")

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        if session_id in self.cancelled:
            self.cancelled[session_id].set()


if __name__ == "__main__":
    asyncio.run(run_agent(WellBehaved()))
