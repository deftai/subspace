"""MCP-over-ACP: the client serves tools over the ACP connection itself (no
extra process or port), and the agent calls them with `turn.mcp(name)`.
"""

import asyncio
import os
from typing import Any

from deft_subspace.acp import AcpClient, AgentTurn, McpOperationContext, serve_agent
from deft_subspace.kernel import channel_pair


# The agent: advertise the acp transport, then use the session's served tools.
async def tool_user(turn: AgentTurn) -> str:
    editor = turn.mcp("editor")
    tools = await editor.list_tools()
    result = await editor.call_tool("open_buffers")
    await turn.say(f"{', '.join(t['name'] for t in tools)}: {result['content']}")
    return "end_turn"


# The client's MCP server: one tool, answered by hand.
def handler(context: McpOperationContext) -> dict[str, Any]:
    if context.method == "tools/list":
        return {"result": {"tools": [{"name": "open_buffers", "inputSchema": {"type": "object"}}]}}
    if context.method == "tools/call":
        return {"result": {"content": [{"type": "text", "text": "README.md, src/index.ts"}], "isError": False}}
    return {"error": {"code": -32601, "message": f"no {context.method}"}}


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="tool-user", mcp_transports=["acp"], prompt=tool_user)

    client = await AcpClient.connect(client_end)
    editor = client.serve_mcp(name="editor", handler=handler)
    session = await client.new_session(os.getcwd(), mcp_servers=[editor])
    print((await session.prompt("Which files are open?")).text)
    await editor.dispose()
    await client.close()


asyncio.run(main())
