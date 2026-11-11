"""An agent served with serve_stdio(): it prints mid-turn, which must not reach stdout."""

import asyncio

from deft_subspace.acp.start import serve_stdio


async def prompt(turn) -> None:
    print("this would corrupt the protocol stream without the redirect")
    listing = await turn.tool("List files", lambda _call: "a.txt\nb.txt", kind="read")
    try:
        await turn.tool("Delete b.txt", lambda _call: "deleted", kind="delete", ask=True)
    finally:
        await turn.say(f"listed: {len(listing.split(chr(10)))}")


async def main() -> None:
    peer = serve_stdio(name="stdio-agent", prompt=prompt)
    await peer.closed


asyncio.run(main())
