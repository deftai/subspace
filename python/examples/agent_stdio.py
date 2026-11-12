"""An agent program on stdio, ready for any ACP client (Zed, Toad, ...).
@typecheck-only (it waits for a client on stdin)
"""

import asyncio
import os

from deft_subspace.acp import AgentTurn, ToolCallHandle, serve_stdio


async def tidy(turn: AgentTurn) -> None:
    # One step each: the tool call is shown, run, then completed (or failed if it raises).
    files = await turn.tool("List files", lambda _call: os.listdir("."), kind="read")
    logs = [f for f in files if f.endswith(".log")]
    if not logs:
        await turn.say("Nothing to tidy.")
        return

    def delete(call: ToolCallHandle) -> None:
        for log in logs:
            if not call.signal.aborted:
                os.remove(log)

    # ask: the user is asked first. A refusal raises PermissionDenied, which ends the turn normally.
    await turn.tool(f"Delete {len(logs)} log files", delete, kind="delete", ask=True)
    await turn.say(f"Deleted {len(logs)} log files.")


async def main() -> None:
    # print() goes to stderr from here on, so it cannot corrupt the protocol on stdout.
    peer = serve_stdio(name="tidy", version="0.1.0", prompt=tidy)
    await peer.closed


asyncio.run(main())
