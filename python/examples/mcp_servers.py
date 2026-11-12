"""Giving a real agent MCP servers: one it starts (stdio) and one it connects
to (http). Each is written in the agent's protocol and checked against the
transports it advertised.
@typecheck-only (starts Claude's ACP adapter through npx)
"""

import asyncio
import os

from deft_subspace.acp import HttpMcpServer, StdioMcpServer, start


async def main() -> None:
    agent = await start(
        "claude",
        permissions="reject",
        mcp_servers=[
            StdioMcpServer(name="files", command="/usr/local/bin/files-mcp", args=["--root", os.getcwd()]),
            HttpMcpServer(
                name="search",
                url="https://mcp.example.com/mcp",
                headers={"Authorization": f"Bearer {os.environ.get('SEARCH_TOKEN')}"},
            ),
        ],
    )
    try:
        print(agent.client.supports.mcp)  # McpSupport(stdio=True, http=True, sse=False, acp=False)
        await agent.run(
            "List the tools you got from the files server.",
            on_message=lambda delta, info, _event: print(info.separator + delta, end="", flush=True),
        )
    finally:
        await agent.close()


asyncio.run(main())
