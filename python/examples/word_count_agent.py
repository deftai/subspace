"""A tiny agent: counts the words in a file, asking before it reads.
@typecheck-only (it waits for a client on stdin; word_count.py starts it)
"""

import asyncio
from pathlib import Path

from deft_subspace.acp import AgentTurn, serve_stdio


async def count_words(turn: AgentTurn) -> None:
    file = turn.text.strip()
    words = await turn.tool(f"Read {file}", lambda _call: str(len(Path(file).read_text().split())), kind="read", ask=True)
    await turn.say(f"{file} has {words} words.")


async def main() -> None:
    peer = serve_stdio(name="word-count", prompt=count_words)
    await peer.closed


asyncio.run(main())
