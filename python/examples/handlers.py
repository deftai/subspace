"""Handler options: callbacks per event kind instead of an `async for` loop.
The result is ready after they ran; a handler that raises cancels the turn.
"""

import asyncio
import os

from deft_subspace.acp import AcpClient, AgentTurn, serve_agent
from deft_subspace.kernel import channel_pair


async def helper(turn: AgentTurn) -> None:
    await turn.think("Checking the tests first.")
    output = await turn.tool("npm test", lambda _call: "12 passed", kind="execute", ask="Run npm test?")
    await turn.say(f"All good: {output}.")


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="helper", prompt=helper)

    # Handler options on connect are defaults for every turn; a prompt's own replace them one by one.
    client = await AcpClient.connect(client_end, on_thought=lambda delta, _info, _event: print(f"(thinking) {delta}"))
    session = await client.new_session(os.getcwd())
    result = await session.prompt(
        "Are the tests passing?",
        on_message=lambda delta, info, _event: print(info.separator + delta, end=""),
        on_tool_call=lambda call, _info, _event: print(f"[{call.title}: {call.status}]"),
        on_permission=lambda request, _signal: "allow" if request.title.startswith("Run npm test") else "reject",
    )
    print(f"\n{result.stop_reason}")
    await client.close()


asyncio.run(main())
