"""Use the tiny agent: start it, ask it about two files, answer its question."""

import asyncio
import os
import sys

from deft_subspace.acp import AgentCommand, PermissionRequest, start
from deft_subspace.kernel import AbortSignal

here = os.path.dirname(os.path.abspath(__file__))


def yes(request: PermissionRequest, _signal: AbortSignal) -> str:
    print(f"  (agent asks: {request.title}) yes")
    return "allow"


async def main() -> None:
    agent = await start(
        AgentCommand(sys.executable, ["word_count_agent.py"]),
        cwd=here,
        on_permission=yes,
        on_message=lambda delta, info, _event: print(info.separator + delta, end=""),
    )
    try:
        for file in ["in_process.py", "word_count.py"]:
            await agent.run(file)
            print()
    finally:
        await agent.close()


asyncio.run(main())
