"""An MCP server over Streamable HTTP and SSE, built with the official MCP SDK, for the connector tests.

Run with a port; it prints "ready" once it listens.
"""

import sys

import uvicorn
from mcp.server.mcpserver import Context, MCPServer

server = MCPServer("tiny-http")


@server.tool()
async def add(a: int, b: int, ctx: Context) -> str:
    """Add two numbers."""
    await ctx.report_progress(1, 1)
    return str(a + b)


@server.tool()
def whoami(ctx: Context) -> str:
    """The Authorization header the request carried."""
    request = ctx.request_context.request
    return request.headers.get("authorization", "none") if request is not None else "none"


if __name__ == "__main__":
    port, kind = int(sys.argv[1]), sys.argv[2]
    app = server.streamable_http_app() if kind == "http" else server.sse_app()
    print("ready", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
