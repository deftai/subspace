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


async def test_mcp_connector_stdio():
    server = StdioMcpServer("tiny", sys.executable, [str(Path(__file__).parent / "fixtures" / "mcp_stdio_server.py")])
    progress = []

    async def prompt(turn):
        tiny = turn.mcp("tiny")
        listed = await tiny.list_tools()
        called = await tiny.call_tool("add", {"a": 1, "b": 2}, on_notification=progress.append)
        await turn.say(f"{listed[0]['name']} {called['content'][0]['text']}")

    client = await connect({"prompt": prompt, "mcp_connector": mcp_connector(stderr="ignore")})
    assert client.supports.mcp.stdio
    session = await client.new_session("/tmp", mcp_servers=[server])
    assert (await session.prompt("go")).text == "add 3"
    assert progress and progress[0]["method"] == "notifications/progress"
    await session.close()
    await client.close()
