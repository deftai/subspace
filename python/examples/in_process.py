"""An agent and a client in one process, joined by an in-memory channel.
The quickest way to try the API, and how most tests are written.
"""

import asyncio
import os

from deft_subspace.acp import AcpClient, AgentTurn, serve_agent
from deft_subspace.kernel import channel_pair


async def echo(turn: AgentTurn) -> str:
    await turn.say(f"You said: {turn.text}")
    return "end_turn"


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="echo", prompt=echo)

    client = await AcpClient.connect(client_end)
    session = await client.new_session(os.getcwd())
    result = await session.prompt("hello")
    print(result.text)  # "You said: hello"
    await client.close()


asyncio.run(main())
