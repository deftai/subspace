"""Recipe: give an agent tools from your own app, served over the ACP
connection itself (MCP-over-ACP): here an in-process agent that uses them.
"""

import asyncio
import json
import os

from deft_subspace.acp import AcpClient, AgentTurn, serve_agent, tool
from deft_subspace.kernel import channel_pair

# The app's state, which only the app can see.
open_buffers = ["README.md", "src/index.ts"]


# An agent that takes tools served this way (real agents advertise it with the `acp` MCP transport).
async def tool_user(turn: AgentTurn) -> None:
    editor = turn.mcp("editor")
    result = await editor.call_tool("open_buffers")
    await turn.say(f"Open: {json.dumps(result['structuredContent'])}")


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="tool-user", mcp_transports=["acp"], prompt=tool_user)

    client = await AcpClient.connect(client_end, permissions="reject")
    editor = client.serve_tools(
        name="editor",
        tools={
            "open_buffers": tool(
                description="The files open in the editor", kind="read", run=lambda _input, _ctx: {"files": open_buffers}
            ),
        },
    )
    session = await client.new_session(os.getcwd(), mcp_servers=[editor])
    print((await session.prompt("What is open?")).text)  # Open: {"files": ["README.md", "src/index.ts"]}
    await client.close()


asyncio.run(main())
