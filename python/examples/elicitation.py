"""The agent asks the user a question through the client (form elicitation).
An accepted answer that does not fit the agent's schema goes back as a decline.
"""

import asyncio
import os

from deft_subspace.acp import AcpClient, AgentTurn, ElicitationRequest, serve_agent
from deft_subspace.kernel import AbortSignal, channel_pair


async def asker(turn: AgentTurn) -> str:
    answer = await turn.elicit(
        "Which branch should I use?",
        requested_schema={"type": "object", "properties": {"branch": {"type": "string", "minLength": 1}}, "required": ["branch"]},
    )
    await turn.say(
        f"Using {answer.content['branch']}" if answer.action == "accept" and answer.content else f"No answer ({answer.action})"
    )
    return "end_turn"


# Show the form to the user; here, answer at once.
def ask_user(request: ElicitationRequest, _signal: AbortSignal) -> dict:
    return {"action": "accept", "content": {"branch": "main"}} if request.mode == "form" else {"action": "decline"}


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="asker", prompt=asker)

    client = await AcpClient.connect(client_end, elicitation_modes=["form"], elicitation=ask_user)
    session = await client.new_session(os.getcwd())
    print((await session.prompt("Deploy")).text)  # "Using main"
    await client.close()


asyncio.run(main())
