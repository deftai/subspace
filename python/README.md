# Deft Subspace for Python

A Python port of Subspace, a library for the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), for both clients and agents. It does what the TypeScript packages do, on `asyncio`, with Python names.

- **One model for v1 and v2.** The client asks for v2 and accepts v1, and your code sees the same events either way.
- **Turns you can await:** `async for event in turn`, and `await turn` for the result.
- **Cancellation that works:** open questions are answered `cancelled`, and a turn ends here if the agent doesn't confirm.
- **Permissions that fail closed.**
- **Tested against real agents:** the Claude and Codex ACP adapters, and agents built with the official Python SDK (`agent-client-protocol`), on v1 and v2.

```python
import asyncio
from deft_subspace.acp import start

async def main():
    agent = await start("claude", on_permission=lambda request, _signal: "allow" if request.tool_call and request.tool_call.kind == "read" else "reject")
    try:
        await agent.run("What does this repo do?", on_message=lambda delta, info, _event: print(info.separator + delta, end=""))
    finally:
        await agent.close()

asyncio.run(main())
```

Or in one line: `await run("codex", "What does this repo do?", permissions="reject")`.

Without an event loop, in a script or the REPL:

```python
from deft_subspace.acp.sync import run

print(run("codex", "What does this repo do?", permissions="reject").text)
```

To see what went over the wire, set `SUBSPACE_TRACE` to a folder: every `start()` writes a trace there, one file per connection, with no code change (`SUBSPACE_TRACE=traces python app.py`). `start(..., trace="run.jsonl")` traces one connection. The TypeScript trace viewer reads both.

## Packages

| Distribution | Import | What it is |
|---|---|---|
| `deft-subspace-kernel` | `deft_subspace.kernel` | Channels, NDJSON framing, a JSON-RPC peer with timeouts and cancellation, abort signals, traces, supervised processes. No dependencies. |
| `deft-subspace-acp` | `deft_subspace.acp` | `AcpClient`, `Session` and `Turn`; `serve_agent` and `agent_endpoint`; `start()`, `run()` and `serve_stdio()`; permission rules, tools, MCP-over-ACP, `model_agent()`, OpenTelemetry (`otel` extra), MCP servers over http and sse (`mcp` extra). |

The testkit, devtools, CLI and the Claude model adapter are not ported yet. Traces are the same JSON Lines format as the TypeScript packages, so the TypeScript trace viewer reads them.

## The model

### Clients

```python
from deft_subspace.acp import AcpClient, MessageEvent
from deft_subspace.kernel import ndjson

client = await AcpClient.connect(ndjson(byte_channel), name="my-app", permissions="reject")
session = await client.new_session(cwd)
turn = session.prompt("Fix the failing test")
async for event in turn:          # MessageEvent, ToolCallEvent, PermissionEvent, ... (frozen dataclasses)
    match event:
        case MessageEvent(delta=delta):
            print(delta, end="")
result = await turn               # TurnResult: stop_reason, text, tool_calls, cancelled, refused, ...
```

Handlers work on any turn, instead of iterating or as well: `on_message`, `on_thought`, `on_tool_call`, `on_plan`, `on_permission`, `on_question`, `on_event`, and the rest of `TurnHandlers`. They may be plain or async functions. Pass them to `prompt()`, or to `connect()` as defaults for every turn.

### Agents

```python
import os

from deft_subspace.acp import serve_stdio

async def prompt(turn):
    files = await turn.tool("List files", lambda _call: os.listdir("."), kind="read")
    await turn.say(f"{len(files)} files")

peer = serve_stdio(name="lister", prompt=prompt)
await peer.closed
```

`turn.signal` fires when the client cancels; return when it does.

## Differences from the TypeScript packages

- **Names** are snake_case (`new_session`, `on_permission`, `tool_call.raw_input`). Wire JSON keeps ACP's camelCase, and plain dicts go on the wire.
- **Options** are keyword arguments, not option objects.
- **Cancellation:** `AbortController` and `AbortSignal` (in the kernel) work like the Web ones. Cancelling a task that awaits a request also gives up on it and tells the other side.
- **Validators** (`schema=` on tools, `json()`, extensions) are pydantic models, `TypeAdapter`s, or objects with `parse()`, in place of Standard Schema.
- **Protocol types** are the official SDK's pydantic models, as `deft_subspace.acp.v1` and `.v2`. They are loaded on first use, because importing them is slow.
- **`mcp_connector()`** connects to `stdio` MCP servers by itself, with no MCP SDK. `http` and `sse` servers go through the official MCP SDK, the `mcp` extra (`pip install 'deft-subspace-acp[mcp]'`), which negotiates MCP 2026-07-28 and older versions.

What we learned porting, for whoever ports Subspace next: [docs/PORTING-LESSONS.md](../docs/PORTING-LESSONS.md).

## Develop

```sh
cd python
uv sync
uv run pytest        # every package
uv run pyright
```

Python 3.11 or later. CI runs Linux, macOS and Windows on 3.11 and 3.13.

## Releasing

Both distributions are released together, at the same version, by `.github/workflows/python-release.yml` when a `python-v<version>` tag is pushed. It runs the tests, builds and checks the wheels, smoke-tests them in a clean environment, and publishes with PyPI trusted publishing from the `pypi` environment.

1. `python scripts/set_version.py <version>`, then `uv lock`.
2. Add a `## <version>` section to `CHANGELOG.md`.
3. Merge, then tag the merge commit `python-v<version>` and push the tag.

`python scripts/check_versions.py --tag python-v<version>` runs the same checks locally.
