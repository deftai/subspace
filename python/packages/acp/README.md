# deft-subspace-acp

[Agent Client Protocol](https://agentclientprotocol.com) (ACP) for Python apps, for both clients and agents. Part of [Deft Subspace](https://github.com/deftai/subspace/tree/main/python).

- **One model for v1 and v2.** The client asks for v2 and accepts v1, and your code sees the same events either way.
- **Turns you can await:** `async for event in turn`, and `await turn` for the result.
- **Cancellation that works**, and **permissions that fail closed.**
- **Tested against real agents:** Grok Build, the Claude and Codex ACP adapters, and agents built with the official SDK.

```python
import asyncio
from deft_subspace.acp import run

async def main():
    result = await run("claude", "What does this repo do?", permissions="reject")
    print(result.text)

asyncio.run(main())
```

Extras: `otel` (OpenTelemetry spans) and `mcp` (MCP servers over http and sse).

See the [README](https://github.com/deftai/subspace/tree/main/python) for clients, agents, and how this differs from the TypeScript packages. MIT licensed.
