import sys
from pathlib import Path

from link import connect

from deft_subspace.acp.mcp import StdioMcpServer
from deft_subspace.acp.mcp_connector import mcp_connector
from deft_subspace.acp.model_agent import ModelReply, ModelToolCall, PromptInput, ToolResultsInput, model_agent
from deft_subspace.acp.policies import read_only
from deft_subspace.acp.tools import tool


class ScriptedModel:
    """Asks for tools on the first call, then answers with what came back."""

    def __init__(self, calls, loop=False):
        self.calls = calls
        self.loop = loop
        self.inputs = []
        self.setups = []

    def conversation(self, setup):
        self.setups.append(setup)
        model = self

        class Conversation:
            async def send(self, value, stream):
                model.inputs.append(value)
                if isinstance(value, PromptInput) or model.loop:
                    await stream.on_thinking("hmm")
                    return ModelReply("tool_use", model.calls)
                assert isinstance(value, ToolResultsInput)
                await stream.on_text(" | ".join(f"{r.content}{'!' if r.is_error else ''}" for r in value.tool_results))
                return ModelReply("end_turn")

        return Conversation()


add = tool(description="Add", input={"type": "object"}, kind="read", run=lambda args, _ctx: args["a"] + args["b"])
remove = tool(description="Delete", kind="delete", ask=True, run=lambda _args, _ctx: "deleted")


async def test_model_agent_runs_tools_and_sends_results_back():
    model = ScriptedModel([ModelToolCall("c1", "add", {"a": 2, "b": 3}), ModelToolCall("c2", "remove", {}), ModelToolCall("c3", "nope", {})])
    client = await connect(model_agent(model=model, tools={"add": add, "remove": remove}, system=lambda cwd: f"in {cwd}"), on_permission=read_only)
    session = await client.new_session("/work")
    turn = session.prompt("add please")
    events = [e async for e in turn]
    result = await turn
    assert result.text == "5 | The user did not allow this tool call.! | There is no tool named nope.!"
    assert [c.status for c in result.tool_calls] == ["completed", "failed"]
    assert any(e.type == "thought" for e in events)
    assert model.setups[0].system == "in /work"
    assert [t.name for t in model.setups[0].tools] == ["add", "remove"]
    await client.close()


async def test_max_steps_stops_a_looping_model():
    model = ScriptedModel([ModelToolCall("c", "add", {"a": 1, "b": 1})], loop=True)
    client = await connect(model_agent(model=model, tools={"add": add}, max_steps=3), permissions="allow")
    session = await client.new_session("/work")
    result = await session.prompt("loop")
    assert result.stop_reason == "max_turn_requests"
    assert len(model.inputs) == 3
    await client.close()


async def test_serve_tools_over_mcp_over_acp():
    async def prompt(turn):
        server = turn.mcp("mine")
        listed = await server.list_tools()
        called = await server.call_tool("add", {"a": 4, "b": 5})
        await turn.say(f"{[t['name'] for t in listed]} {called['content'][0]['text']}")

    client = await connect({"prompt": prompt, "mcp_transports": ["acp"]})
    registration = client.serve_tools(name="mine", tools={"add": add})
    session = await client.new_session("/work", mcp_servers=[registration])
    assert (await session.prompt("go")).text == "['add'] 9"
    await registration.dispose()
    await client.close()


async def test_served_mcp_requests_leave_no_listener_on_the_server():
    async def prompt(turn):
        await turn.mcp("mine").call_tool("add", {"a": 1, "b": 1})

    client = await connect({"prompt": prompt, "mcp_transports": ["acp"]})
    registration = client.serve_tools(name="mine", tools={"add": add})
    session = await client.new_session("/work", mcp_servers=[registration])
    for _ in range(10):
        await session.prompt("go")
    served = client._mcp._servers[registration.server_id]
    assert served.controller.signal._listeners == []
    await registration.dispose()
    await client.close()


async def test_mcp_connector_stdio(tmp_path):
    server = StdioMcpServer("tiny", sys.executable, [str(Path(__file__).parent / "fixtures" / "mcp_stdio_server.py")])
    progress = []

    async def prompt(turn):
        tiny = turn.mcp("tiny")
        listed = await tiny.list_tools()
        called = await tiny.call_tool("add", {"a": 1, "b": 2}, on_notification=progress.append)
        await turn.say(f"{listed[0]['name']} {called['content'][0]['text']}")

    client = await connect({"prompt": prompt, "mcp_connector": mcp_connector(stderr="ignore")})
    assert client.supports.mcp.stdio
    session = await client.new_session(str(tmp_path), mcp_servers=[server])
    result = await session.prompt("go")
    assert result.error is None, result.error
    assert result.text == "add 3"
    assert progress and progress[0]["method"] == "notifications/progress"
    await session.close()
    await client.close()


async def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _serve_http(kind: str):
    import asyncio

    from deft_subspace.kernel import spawn_process

    port = await _free_port()
    child = await spawn_process(sys.executable, args=[str(Path(__file__).parent / "fixtures" / "mcp_http_server.py"), str(port), kind])
    for _ in range(200):
        try:
            _r, w = await asyncio.open_connection("127.0.0.1", port)
            w.close()
            break
        except OSError:
            await asyncio.sleep(0.05)
    return child, port


import pytest  # noqa: E402

from deft_subspace.acp.mcp import HttpMcpServer, SseMcpServer  # noqa: E402


@pytest.mark.parametrize("kind", ["http", "sse"])
async def test_mcp_connector_http_and_sse(kind):
    child, port = await _serve_http(kind)
    try:
        server = (
            HttpMcpServer("web", f"http://127.0.0.1:{port}/mcp", {"Authorization": "Bearer t"})
            if kind == "http"
            else SseMcpServer("web", f"http://127.0.0.1:{port}/sse", {"Authorization": "Bearer t"})
        )
        progress = []

        async def prompt(turn):
            web = turn.mcp("web")
            listed = await web.list_tools()
            added = await web.call_tool("add", {"a": 2, "b": 3}, on_notification=progress.append)
            who = await web.call_tool("whoami", {})
            await turn.say(f"{sorted(t['name'] for t in listed)} {added['content'][0]['text']} {who['content'][0]['text']}")

        # sse exists only in v1.
        client = await connect({"prompt": prompt, "mcp_connector": mcp_connector(), "protocols": [1] if kind == "sse" else [1, 2]})
        session = await client.new_session("/tmp", mcp_servers=[server])
        result = await session.prompt("go")
        assert result.text == "['add', 'whoami'] 5 Bearer t"
        assert progress and progress[0]["params"]["progress"] == 1
        await session.close()
        await client.close()
    finally:
        await child.stop()


def test_parse_mcp_servers_infers_only_a_missing_type():
    from deft_subspace.acp.mcp import parse_mcp_servers

    servers, unknown = parse_mcp_servers(
        [
            {"name": "a", "command": "/bin/a"},
            {"name": "b", "command": "/bin/b", "type": None},
            {"name": "c", "command": "/bin/c", "type": ""},
        ]
    )
    assert [s.name for s in servers] == ["a", "b"]
    assert unknown == [{"name": "c", "command": "/bin/c", "type": ""}]
