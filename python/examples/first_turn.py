"""A first turn with a real agent: start Claude (in its ask-first mode),
stream the reply, decide its permission questions.
@typecheck-only (starts Claude's ACP adapter through npx)
"""

import asyncio

from deft_subspace.acp import start


async def main() -> None:
    agent = await start(
        "claude",
        # Required: how to answer the agent's permission questions. Here: reads yes, everything else no.
        on_permission=lambda request, _signal: "allow" if request.tool_call and request.tool_call.kind == "read" else "reject",
    )
    try:
        result = await agent.run(
            "Summarize README.md in one sentence.",
            # separator: a blank line between messages
            on_message=lambda delta, info, _event: print(info.separator + delta, end="", flush=True),
            on_tool_call=lambda call, info, _event: info.created and print(f"\n[{call.title}]"),
        )
        print(f"\n{result.stop_reason}, {len(result.tool_calls)} tool call(s)")
    finally:
        await agent.close()  # or: async with await start(...) as agent:


asyncio.run(main())
