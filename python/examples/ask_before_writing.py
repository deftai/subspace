"""Permissions with a real agent: Claude (in its ask-first mode) asks before
writing a file; on_permission decides. Run it twice: ALLOW=1 writes, without refuses.
@typecheck-only (starts Claude's ACP adapter through npx)
"""

import asyncio
import os
import tempfile

from deft_subspace.acp import PermissionRequest, start, turn_end
from deft_subspace.kernel import AbortSignal

allow = os.environ.get("ALLOW") == "1"


def decide(request: PermissionRequest, _signal: AbortSignal) -> str:
    print(f"asked: {request.title} -> {'allow' if allow else 'reject'}")
    return "allow" if allow else "reject"


async def main() -> None:
    cwd = tempfile.mkdtemp(prefix="subspace-ask-")
    agent = await start("claude", cwd=cwd, on_permission=decide)
    try:
        result = await agent.run(
            "Create a file named hello.txt containing the word hi.",
            on_tool_call=lambda call, info, _event: info.created and print(f"[{call.title}]"),
        )
        # turn_end: "refused" when an agent ends a refused turn as "cancelled" (Grok, Codex); Claude
        # finishes the turn normally after a refusal, so it is "completed" with result.refused counting it.
        written = "written" if os.path.exists(os.path.join(cwd, "hello.txt")) else "not written"
        print(f"{turn_end(result)}, {result.refused} refused; hello.txt {written}")
    finally:
        await agent.close()


asyncio.run(main())
