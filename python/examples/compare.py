"""Recipe: ask several agents the same question at once and compare.
@typecheck-only (starts Claude and Codex through npx)
"""

import asyncio
import sys

from deft_subspace.acp import read_only, run


async def main() -> None:
    question = " ".join(sys.argv[1:]) or "What is the riskiest part of this codebase? One paragraph."
    agents = ["claude", "codex"]

    answers = await asyncio.gather(
        *(
            run(agent, question, on_permission=read_only, timeout_ms=300_000, quiet=True, handle_signals=False)
            for agent in agents
        ),
        return_exceptions=True,
    )
    for agent, answer in zip(agents, answers):
        print(f"\n## {agent}\n")
        print(f"failed: {answer}" if isinstance(answer, BaseException) else answer.text)


asyncio.run(main())
