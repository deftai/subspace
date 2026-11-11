"""An ACP v2 agent built with the official Python SDK's experimental v2 API, for interop tests.

Prompt "ask" asks permission (v2 subject) first; anything else is echoed.
"""

import asyncio
import uuid
from typing import Any

from acp.experimental.v2 import run_agent, schema


def m(model: Any, data: dict[str, Any]) -> Any:
    return model.model_validate(data)


class EchoAgentV2:
    def __init__(self) -> None:
        self.conn: Any = None

    def on_connect(self, conn: Any) -> None:
        self.conn = conn

    async def initialize(self, protocol_version: int, **kwargs: Any) -> Any:
        return m(schema.InitializeResponse, {"protocolVersion": 2, "info": {"name": "sdk-echo-v2", "version": "2.0.0"}, "capabilities": {}, "authMethods": []})

    async def new_session(self, cwd: str, **kwargs: Any) -> Any:
        return m(schema.NewSessionResponse, {"sessionId": f"v2-{uuid.uuid4().hex[:8]}"})

    async def prompt(self, session_id: str, prompt: list[Any], **kwargs: Any) -> Any:
        text = "".join(getattr(block, "text", "") for block in prompt)
        asyncio.get_running_loop().create_task(self.run(session_id, text))
        return m(schema.PromptResponse, {"messageId": str(uuid.uuid4())})

    async def update(self, session_id: str, model: Any, data: dict[str, Any]) -> None:
        await self.conn.session_update(session_id=session_id, update=m(model, data))

    async def run(self, session_id: str, text: str) -> None:
        await self.update(session_id, schema.RunningSessionStateUpdate, {"sessionUpdate": "state_update", "state": "running"})
        reply = f"echo: {text}"
        if text == "ask":
            await self.update(
                session_id,
                schema.SessionToolCallUpdate,
                {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Run tests", "kind": "execute", "status": "pending"},
            )
            answer = await self.conn.request_permission(
                session_id=session_id,
                title="Run tests?",
                options=[
                    m(schema.PermissionOption, {"optionId": "yes", "name": "Allow", "kind": "allow_once"}),
                    m(schema.PermissionOption, {"optionId": "no", "name": "Reject", "kind": "reject_once"}),
                ],
                subject=m(schema.ToolCallPermissionSubjectVariant, {"type": "tool_call", "toolCall": {"toolCallId": "t1"}}),
            )
            outcome = answer.model_dump(by_alias=True, exclude_none=True)["outcome"]
            reply = f"chose {outcome.get('optionId', 'cancelled')}"
        message_id = str(uuid.uuid4())
        for piece in (reply[: len(reply) // 2], reply[len(reply) // 2 :]):
            await self.update(
                session_id,
                schema.AgentMessageChunk,
                {"sessionUpdate": "agent_message_chunk", "messageId": message_id, "content": {"type": "text", "text": piece}},
            )
        await self.update(session_id, schema.IdleSessionStateUpdate, {"sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn"})

    async def cancel_session(self, session_id: str, **kwargs: Any) -> None:
        pass


if __name__ == "__main__":
    asyncio.run(run_agent(EchoAgentV2()))
