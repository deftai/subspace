"""Answering an agent's permission questions. The default is "reject":
nothing is allowed unless you say so.
"""

import asyncio
import os

from deft_subspace.acp import AcpClient, AgentTurn, PermissionEvent, PermissionRequest, serve_agent
from deft_subspace.kernel import AbortSignal, channel_pair


async def careful(turn: AgentTurn) -> str:
    call = await turn.tool_call("Delete build/", kind="delete")
    answer = await turn.request_permission("Delete build/?", tool_call_id=call.id)
    if not answer.allowed:
        await call.fail()
        await turn.say("Left build/ alone.")
        return "end_turn"
    await call.complete()
    await turn.say("Deleted build/.")
    return "end_turn"


# Decide each question; here, allow reads and refuse everything else.
def permissions(request: PermissionRequest, _signal: AbortSignal) -> str:
    return "allow" if request.tool_call and request.tool_call.kind == "read" else "reject"


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="careful", prompt=careful)

    client = await AcpClient.connect(client_end, permissions=permissions)
    session = await client.new_session(os.getcwd())
    turn = session.prompt("Clean up")
    async for event in turn:
        if isinstance(event, PermissionEvent):
            print(f"{event.request.title} -> {'allowed' if event.outcome.allowed else 'refused'}")
    print((await turn).text)  # "Left build/ alone."
    await client.close()


asyncio.run(main())
