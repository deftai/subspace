"""Says an environment variable back: "env NAME" -> "NAME=value"."""

import asyncio
import os
import re

from deft_subspace.acp._start import serve_stdio


async def prompt(turn) -> None:
    name = re.sub(r"^env ", "", turn.text)
    await turn.say(f"{name}={os.environ.get(name, '')}")


async def main() -> None:
    peer = serve_stdio(name="echo-agent", prompt=prompt)
    await peer.closed


asyncio.run(main())
