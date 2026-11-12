"""Cancelling a turn, and limiting one. A cancelled agent should stop when
`turn.signal` fires; if it does not confirm in time, the turn ends here
anyway (`forced=True`).
"""

import asyncio
import os

from deft_subspace.acp import AcpClient, AgentTurn, TurnLimits, serve_agent, turn_end
from deft_subspace.kernel import channel_pair


async def count(turn: AgentTurn) -> str:
    for i in range(1, 1001):
        if turn.signal.aborted:
            return "cancelled"
        await turn.say(f"{i} ")
        await asyncio.sleep(0.01)
    return "end_turn"


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="counter", prompt=count)

    client = await AcpClient.connect(client_end)
    session = await client.new_session(os.getcwd())

    turn = session.prompt("Count to 1000")
    asyncio.get_running_loop().call_later(0.1, lambda: asyncio.ensure_future(turn.cancel()))
    result = await turn
    print(result.stop_reason, turn_end(result))  # cancelled cancelled

    # Or let a limit cancel it: no messages for 1 s, at most 20 tool calls, at most 200 ms.
    limited = await session.prompt("Count again", limits=TurnLimits(idle_ms=1000, max_tool_calls=20, max_duration_ms=200))
    print(limited.exhausted)  # Exhaustion(limit='duration', max=200, value=...)
    await client.close()


asyncio.run(main())
