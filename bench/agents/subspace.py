"""The benchmark agent on Subspace (Python). See protocol.md."""

import asyncio
import atexit
import os
import resource
import sys

from deft_subspace.acp import serve_stdio


def _rss() -> None:
    if path := os.environ.get("BENCH_RSS_FILE"):
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        with open(path, "w") as f:
            f.write(str(peak if sys.platform == "darwin" else peak * 1024))


atexit.register(_rss)


async def prompt(turn) -> None:
    parts = turn.text.split(" ")
    if parts[0] == "stream":
        chunk = "x" * int(parts[2])
        for _ in range(int(parts[1])):
            await turn.say(chunk)
    elif parts[0] == "ask":
        for i in range(int(parts[1])):
            await turn.request_permission(f"Step {i}")


async def main() -> None:
    peer = serve_stdio(name="bench-subspace-py", version="1.0.0", prompt=prompt)
    await peer.closed


asyncio.run(main())
