"""An agent that uses the MCP servers the client gives its session. The client
passes a stdio server (this file, started with `mcp-server`); the agent
connects with `mcp_connector()`, lists the tools and calls one.

The connector needs nothing more for stdio servers; the server half here uses
the official MCP SDK (`pip install 'deft-subspace-acp[mcp]'`).
"""

import asyncio
import os
import sys

from deft_subspace.acp import AcpClient, AgentTurn, StdioMcpServer, mcp_connector, serve_agent
from deft_subspace.kernel import channel_pair


def serve_mcp() -> None:
    """The MCP server: one tool, `count_words`."""
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("words", version="1.0.0")

    @server.tool()
    def count_words(text: str) -> str:
        """Count the words in a text"""
        return str(len(text.split()))

    server.run("stdio")


# The agent: connects to the session's stdio and http servers on first use.
async def word_counter(turn: AgentTurn) -> str:
    words = turn.mcp("words")
    tools = await words.list_tools()
    await turn.say(f"Tools: {', '.join(t['name'] for t in tools)}. ")
    result = await words.call_tool("count_words", {"text": turn.text})
    await turn.say(f'"{turn.text}" has {result["content"][0]["text"]} words.')
    return "end_turn"


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="word-counter", mcp_connector=mcp_connector(), prompt=word_counter)

    # The client: gives the session the server, as a command to start.
    client = await AcpClient.connect(client_end)
    print(client.supports.mcp)  # McpSupport(stdio=True, http=True, sse=False, acp=False) (v2 has no sse)
    server = StdioMcpServer(name="words", command=sys.executable, args=[os.path.abspath(__file__), "mcp-server"])
    session = await client.new_session(os.getcwd(), mcp_servers=[server])
    result = await session.prompt("the quick brown fox")
    print(result.text)  # Tools: count_words. "the quick brown fox" has 4 words.
    await session.close()  # stops the server
    await client.close()


if "mcp-server" in sys.argv:
    serve_mcp()
else:
    asyncio.run(main())
