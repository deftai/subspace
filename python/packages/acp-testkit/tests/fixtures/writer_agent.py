"""A fixture agent for scenarios: "write <file> <text>" writes a file (asking first); anything else is greeted."""

import asyncio
import re
from pathlib import Path

from deft_subspace.acp import AgentTurn, serve_stdio


async def prompt(turn: AgentTurn) -> None:
    match = re.fullmatch(r"write (\S+) (.+)", turn.text.strip())
    if not match:
        await turn.say(f"Hello! You said: {turn.text}")
        return
    file, text = match.group(1), match.group(2)

    def write(_call: object) -> None:
        Path(file).write_bytes(text.encode("utf-8"))

    await turn.tool(f"Write {file}", write, kind="edit", ask=True, locations=[{"path": file}])
    await turn.say(f"Wrote {file}.")


async def main() -> None:
    peer = serve_stdio(name="writer", prompt=prompt)
    await peer.closed


asyncio.run(main())
