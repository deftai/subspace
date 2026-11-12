"""One prompt, one line: start an agent, run the prompt, stop the agent.
@typecheck-only (starts Codex's ACP adapter through npx)
"""

import asyncio

from deft_subspace.acp import run


async def main() -> None:
    result = await run(
        "codex",
        "What does this repository do? Two sentences.",
        permissions="reject",  # read-only question: refuse anything else it asks
        on_message=lambda delta, info, _event: print(info.separator + delta, end="", flush=True),
    )
    print(f"\n({len(result.text)} characters)")


asyncio.run(main())
