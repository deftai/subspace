"""serve_agent and agent_endpoint, driven by a raw kernel RpcPeer acting as the client.

Ported from the TS tests (endpoint, agent-lifecycle, background, agent-extensions)
where they don't need the client classes.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Iterable
from typing import Any

import pytest
from deft_subspace.acp.agent import AgentTurn, PermissionDenied, serve_agent
from deft_subspace.acp.capabilities import CapabilityError
from deft_subspace.acp.endpoint import AgentLayer, CallContext, EndpointCall, agent_endpoint, state_key
from deft_subspace.acp.extensions import extension_request, handle
from deft_subspace.acp.mcp import StdioMcpServer
from deft_subspace.acp.mcp_caller import McpCallOptions
from deft_subspace.acp.mcp_connections import McpConnectContext
from deft_subspace.acp.tools import tool
from deft_subspace.kernel import (
    AbortController,
    LocalError,
    RpcError,
    RpcPeer,
    cancel_request,
    channel_pair,
    ndjson,
    pipe_channel,
)
from deft_subspace.kernel.testing import rechunk, tick


async def sleep(ms: float) -> None:
    await asyncio.sleep(ms / 1000)


async def until(check: Callable[[], bool], ms: float = 2000) -> None:
    end = time.monotonic() + ms / 1000
    while not check():
        if time.monotonic() > end:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.005)


class Identity:
    def feed(self, item: bytes) -> Iterable[bytes]:
        return [item]

    def flush(self) -> Iterable[bytes]:
        return ()


def byte_link() -> tuple[Any, Any]:
    """Two JSON channels joined over bytes, like stdio; reads are re-chunked byte by byte."""
    a, b = channel_pair()
    client = ndjson(pipe_channel(a, read=rechunk(1), write=Identity()))
    agent = ndjson(pipe_channel(b, read=rechunk(1), write=Identity()))
    return client, agent


class Client:
    """A raw client peer and what it was sent."""

    def __init__(self, channel: Any) -> None:
        self.peer = RpcPeer(channel, name="client", **cancel_request)
        self.notes: list[tuple[str, Any]] = []
        self.peer.on_notification("*", lambda params, ctx: self.notes.append((ctx.method, params)))

    def start(self) -> Client:
        self.peer.start()
        return self

    def updates(self, session_id: str | None = None) -> list[dict[str, Any]]:
        return [p["update"] for m, p in self.notes if m == "session/update" and (session_id is None or p["sessionId"] == session_id)]

    def kinds(self) -> list[str]:
        return [u["sessionUpdate"] for u in self.updates()]

    async def init(self, protocol: int, **params: Any) -> Any:
        caps_key = "capabilities" if protocol == 2 else "clientCapabilities"
        return await self.peer.request("initialize", {"protocolVersion": protocol, caps_key: params.pop("caps", {}), **params})

    async def new_session(self, cwd: str = "/work", **params: Any) -> str:
        result = await self.peer.request("session/new", {"cwd": cwd, "mcpServers": [], **params})
        return result["sessionId"]

    async def idle(self, count: int = 1) -> dict[str, Any]:
        """v2: wait for the `count`-th idle state update with a stop reason."""

        def idles() -> list[dict[str, Any]]:
            return [u for u in self.updates() if u["sessionUpdate"] == "state_update" and u["state"] == "idle" and "stopReason" in u]

        await until(lambda: len(idles()) >= count)
        return idles()[count - 1]

    async def close(self) -> None:
        await self.peer.close()


def serve(**options: Any) -> Client:
    agent_end, client_end = channel_pair()
    options.setdefault("name", "test-agent")
    serve_agent(agent_end, **options)
    return Client(client_end).start()


# ---- endpoint --------------------------------------------------------------------


def connect(**options: Any):
    agent_end, client_end = channel_pair()
    endpoint = agent_endpoint(agent_end, **options)
    client = Client(client_end).start()
    return endpoint, client


async def test_endpoint_passes_unknown_calls_through_and_keeps_rpc_errors() -> None:
    seen: list[Any] = []

    def request(call: EndpointCall, ctx: CallContext) -> Any:
        seen.append(("request", call.method, call.params))
        if call.method == "_x/fail":
            raise RpcError(-32050, "nope", {"why": "because"})
        return {"echoed": call.params}

    def notification(call: EndpointCall, ctx: CallContext) -> None:
        seen.append(("notification", call.method, call.params))

    _endpoint, client = connect(name="raw", request=request, notification=notification)
    assert await client.peer.request("_vendor/anything", {"a": 1}) == {"echoed": {"a": 1}}
    with pytest.raises(RpcError) as info:
        await client.peer.request("_x/fail")
    assert info.value.code == -32050 and info.value.data == {"why": "because"}
    await client.peer.notify("_vendor/note", {"b": 2})
    await tick()
    assert seen == [
        ("request", "_vendor/anything", {"a": 1}),
        ("request", "_x/fail", None),
        ("notification", "_vendor/note", {"b": 2}),
    ]
    await client.close()


async def test_endpoint_without_request_handler_is_method_not_found_and_cancel_is_not_passed_on() -> None:
    notes: list[str] = []
    _endpoint, client = connect(name="bare", notification=lambda call, ctx: notes.append(call.method))
    with pytest.raises(RpcError) as info:
        await client.peer.request("session/new", {})
    assert info.value.code == -32601
    await client.peer.notify("$/cancel_request", {"requestId": 99})
    await client.peer.notify("_x/other")
    await tick()
    assert notes == ["_x/other"]
    await client.close()


async def test_endpoint_two_layers_answering_one_method_fail_at_build() -> None:
    a = AgentLayer[None](name="a", requests={"session/new": lambda *_: {}})
    b = AgentLayer[None](name="b", requests={"session/new": lambda *_: {}})
    with pytest.raises(ValueError, match='layers "a" and "b" both answer the request session/new'):
        connect(name="dup", layers=[a, b])


async def test_endpoint_requires_needs_an_earlier_provider() -> None:
    sessions = state_key("sessions")
    turns = AgentLayer[None](name="turns", requires=[sessions])
    provider = AgentLayer[None](name="sessions", provides=[sessions], create=lambda ctx: ctx.set(sessions, {}))
    with pytest.raises(ValueError, match='"turns" requires "sessions"'):
        connect(name="order", layers=[turns, provider])
    _endpoint, client = connect(name="ok", layers=[provider, turns])
    await client.close()


async def test_endpoint_next_runs_once_and_rewrites_change_method_and_params() -> None:
    errors: list[str] = []

    async def twice(call: EndpointCall, ctx: CallContext, state: Any, next_: Any) -> Any:
        if call.method != "session/prompt":
            return await next_()
        first = await next_()
        try:
            await next_()
        except RuntimeError as error:
            errors.append(str(error))
        return first

    def rename(call: EndpointCall, ctx: CallContext, state: Any, next_: Any) -> Any:
        return next_(EndpointCall("_new/name", {"rewritten": True})) if call.method == "_old/name" else next_()

    prompts = 0

    def request(call: EndpointCall, ctx: CallContext) -> Any:
        nonlocal prompts
        if call.method == "session/prompt":
            prompts += 1
            return {"n": prompts}
        return None

    _endpoint, client = connect(
        name="rewrite",
        layers=[
            AgentLayer[None](name="twice", inbound=twice),
            AgentLayer[None](name="rename", inbound=rename),
            AgentLayer[None](name="answers", requests={"_new/name": lambda call, *_: {"got": call.params}}),
        ],
        request=request,
    )
    assert await client.peer.request("_old/name", {"original": True}) == {"got": {"rewritten": True}}
    assert await client.peer.request("session/prompt", {}) == {"n": 1}
    assert prompts == 1
    assert "next() called twice" in errors[0]
    await client.close()


async def test_endpoint_layer_state_is_per_endpoint() -> None:
    def count(call: EndpointCall, ctx: CallContext, state: dict[str, int], next_: Any) -> int:
        state["n"] += 1
        return state["n"]

    counter = AgentLayer[dict[str, int]](name="counter", create=lambda ctx: {"n": 0}, requests={"_x/count": count})
    _one, one = connect(name="one", layers=[counter])
    _two, two = connect(name="two", layers=[counter])
    assert await one.peer.request("_x/count") == 1
    assert await one.peer.request("_x/count") == 2
    assert await two.peer.request("_x/count") == 1
    await one.close()
    await two.close()


async def test_endpoint_outbound_hooks_see_requests_and_results_first_is_outermost() -> None:
    order: list[str] = []

    def hook(name: str) -> AgentLayer[None]:
        async def outbound(call: EndpointCall, ctx: Any, state: Any, next_: Any) -> Any:
            order.append(f"{name} in {call.kind} {call.method} ({ctx.name})")
            result = await next_()
            order.append(f"{name} out {result}")
            return result

        return AgentLayer[None](name=name, outbound=outbound)

    endpoint, client = connect(name="hooks", layers=[hook("outer"), hook("inner")])
    client.peer.on_request("fs/read_text_file", lambda params, ctx: {"content": "x"})
    assert await endpoint.client.request("fs/read_text_file", {"path": "a"}) == {"content": "x"}
    assert order == [
        "outer in request fs/read_text_file (hooks)",
        "inner in request fs/read_text_file (hooks)",
        "inner out {'content': 'x'}",
        "outer out {'content': 'x'}",
    ]
    await client.close()


async def test_endpoint_notifications_keep_order_when_a_hook_is_slow() -> None:
    async def slow_first(call: EndpointCall, ctx: Any, state: Any, next_: Any) -> Any:
        if call.params["n"] == 1:
            await sleep(30)
        return await next_()

    endpoint, client = connect(name="order", layers=[AgentLayer[None](name="slow-first", outbound=slow_first)])
    await asyncio.gather(*(endpoint.client.notify("session/update", {"n": n}) for n in (1, 2, 3)))
    await tick()
    assert [p["n"] for _m, p in client.notes] == [1, 2, 3]
    await client.close()


async def test_endpoint_cancel_request_aborts_the_handler_signal() -> None:
    aborted = False

    async def request(call: EndpointCall, ctx: CallContext) -> Any:
        nonlocal aborted
        reason = await ctx.signal.wait()
        aborted = True
        raise reason

    _endpoint, client = connect(name="cancel", request=request)
    stop = AbortController()
    call = asyncio.ensure_future(client.peer.request("_x/slow", {}, signal=stop.signal))
    await sleep(5)
    stop.abort()
    with pytest.raises(LocalError):
        await call
    await sleep(5)
    assert aborted
    await client.close()


async def test_endpoint_closed_hooks_get_context_and_state() -> None:
    closed: list[str] = []
    layer = AgentLayer[dict[str, str]](
        name="cleanup",
        create=lambda ctx: {"id": "state-1"},
        closed=lambda info, ctx, state: closed.append(f"{ctx.name} {state['id']} {info.reason}"),
    )
    endpoint, client = connect(name="closing", layers=[layer])
    await client.close()
    await endpoint.peer.closed
    await tick()
    assert closed == ["closing state-1 remote-ended"]


# ---- initialize and sessions -----------------------------------------------------


async def test_initialize_v1_shape() -> None:
    client = serve(name="caps", version="1.2.3", prompt=lambda turn: None, mcp_transports=["stdio", "http", "acp"])
    result = await client.init(1)
    assert result == {
        "protocolVersion": 1,
        "agentInfo": {"name": "caps", "version": "1.2.3"},
        "agentCapabilities": {
            "loadSession": False,
            "sessionCapabilities": {"close": {}},
            "mcpCapabilities": {"http": True, "acp": True},
        },
        "authMethods": [],
    }
    await client.close()


async def test_initialize_v1_with_load_session_advertises_resume() -> None:
    client = serve(prompt=lambda turn: None, load_session=lambda request: None, capabilities={"promptCapabilities": {"image": False}})
    result = await client.init(1)
    assert result["agentCapabilities"] == {
        "loadSession": True,
        "sessionCapabilities": {"close": {}, "resume": {}},
        "promptCapabilities": {"image": False},
    }
    await client.close()


async def test_initialize_v2_shape_and_version_choice() -> None:
    client = serve(
        prompt=lambda turn: None,
        mcp_transports=["stdio", "sse", "acp"],
        capabilities={"session": {"prompt": {"image": {}}, "mcp": {"http": {}}}},
    )
    result = await client.init(2)
    assert result == {
        "protocolVersion": 2,
        "info": {"name": "test-agent", "version": "0.0.0"},
        "capabilities": {"session": {"prompt": {"image": {}}, "mcp": {"stdio": {}, "acp": {}, "http": {}}}},
        "authMethods": [],
    }
    await client.close()
    # An unknown version gets the best accepted one.
    client = serve(prompt=lambda turn: None, protocols=[1])
    assert (await client.init(2))["protocolVersion"] == 1
    await client.close()
    client = serve(prompt=lambda turn: None)
    assert (await client.peer.request("initialize", {"protocolVersion": 7}))["protocolVersion"] == 2
    await client.close()


async def test_initialize_v2_without_extras_has_empty_capabilities() -> None:
    client = serve(prompt=lambda turn: None)
    assert (await client.init(2))["capabilities"] == {}
    await client.close()


async def test_session_new_uses_the_agent_id_and_requires_cwd() -> None:
    seen: list[Any] = []

    def new_session(request: Any) -> Any:
        seen.append(request)
        return {"sessionId": f"s-{len(request.cwd)}"}

    client = serve(prompt=lambda turn: None, new_session=new_session)
    await client.init(1)
    servers = [{"name": "files", "command": "/bin/files", "args": [], "env": []}, {"name": "x", "type": "weird"}]
    assert await client.new_session("/tmp", mcpServers=servers) == "s-4"
    assert seen[0].servers == [StdioMcpServer("files", "/bin/files")]
    assert seen[0].mcp_servers == servers
    with pytest.raises(RpcError) as info:
        await client.peer.request("session/new", {})
    assert info.value.code == -32602
    await client.close()


async def test_session_new_default_id_is_a_uuid() -> None:
    client = serve(prompt=lambda turn: None)
    await client.init(2)
    assert len(await client.new_session()) == 36
    await client.close()


async def test_unknown_session_is_not_found() -> None:
    client = serve(prompt=lambda turn: None)
    await client.init(1)
    for method in ("session/prompt", "session/close"):
        with pytest.raises(RpcError) as info:
            await client.peer.request(method, {"sessionId": "nope", "prompt": []})
        assert info.value.code == -32002
        assert info.value.data == {"sessionId": "nope"}
    await client.close()


async def test_load_and_resume_replay() -> None:
    loads: list[tuple[str, bool]] = []

    async def load_session(request: Any) -> Any:
        loads.append((request.session_id, request.replay is not None))
        if request.replay is not None:
            await request.replay.user_message("earlier question")
            await request.replay.say("earlier answer")
        return None

    for protocol in (1, 2):
        loads.clear()
        client = serve(prompt=lambda turn: None, load_session=load_session)
        await client.init(protocol)
        if protocol == 1:
            assert await client.peer.request("session/load", {"sessionId": "old", "cwd": "/w", "mcpServers": []}) == {}
            assert await client.peer.request("session/resume", {"sessionId": "old", "cwd": "/w"}) == {}
            assert loads == [("old", True), ("old", False)]
        else:
            assert await client.peer.request("session/resume", {"sessionId": "old", "cwd": "/w", "replayFrom": {"type": "start"}}) == {}
            assert await client.peer.request("session/resume", {"sessionId": "old", "cwd": "/w"}) == {}
            assert loads == [("old", True), ("old", False)]
        assert client.kinds() == ["user_message_chunk", "agent_message_chunk"]
        # The reopened session takes prompts.
        assert (await client.peer.request("session/prompt", {"sessionId": "old", "prompt": []})) is not None
        await client.close()


# ---- turns -----------------------------------------------------------------------


async def test_v1_prompt_sends_updates_then_stop_reason() -> None:
    seen: list[AgentTurn] = []

    async def prompt(turn: AgentTurn) -> str:
        seen.append(turn)
        await turn.say("Hello ")
        await turn.say("there")
        call = await turn.tool_call("Read a.txt", kind="read", raw_input={"path": "a.txt"})
        await call.complete(content=[{"type": "content", "content": {"type": "text", "text": "ok"}}])
        await turn.think("hmm")
        await turn.plan([{"content": "step one"}])
        await turn.say("done")
        return "end_turn"

    client = serve(prompt=prompt)
    await client.init(1, caps={"fs": {"readTextFile": True}})
    sid = await client.new_session()
    result = await client.peer.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "hi"}, {"type": "text", "text": "there"}]})
    assert result == {"stopReason": "end_turn"}
    turn = seen[0]
    assert turn.text == "hi\nthere" and turn.protocol == 1 and turn.session_id == sid
    assert turn.client_supports.read_text_file and not turn.client_supports.write_text_file
    updates = client.updates(sid)
    assert [u["sessionUpdate"] for u in updates] == [
        "agent_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
        "agent_thought_chunk",
        "plan",
        "agent_message_chunk",
    ]
    m1, m2, created, completed, thought, plan, m3 = updates
    assert m1["messageId"] == m2["messageId"] and m1["messageId"].endswith("-m1")
    # A plan is not a step between texts: the message after the thought continues its segment.
    assert m3["messageId"].endswith("-m2") and thought["messageId"].endswith("-t2")
    assert created == {
        "sessionUpdate": "tool_call",
        "toolCallId": created["toolCallId"],
        "title": "Read a.txt",
        "kind": "read",
        "status": "pending",
        "content": [],
        "locations": [],
        "rawInput": {"path": "a.txt"},
    }
    assert completed["status"] == "completed" and "capabilities" not in completed
    assert plan == {"sessionUpdate": "plan", "entries": [{"content": "step one", "priority": "medium", "status": "pending"}]}
    await client.close()


async def test_v2_prompt_answers_with_message_id_then_running_then_idle() -> None:
    async def prompt(turn: AgentTurn) -> None:
        await turn.say("hi")
        call = await turn.tool_call("Step", status="in_progress")
        await call.complete()
        await turn.plan([{"content": "a", "priority": "high", "status": "completed"}])

    client = serve(prompt=prompt)
    await client.init(2)
    sid = await client.new_session()
    result = await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert list(result) == ["messageId"] and len(result["messageId"]) == 36
    idle = await client.idle()
    assert idle == {"sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn"}
    assert client.kinds() == ["state_update", "agent_message_chunk", "tool_call_update", "tool_call_update", "plan_update", "state_update"]
    updates = client.updates()
    assert updates[0] == {"sessionUpdate": "state_update", "state": "running"}
    assert updates[2]["title"] == "Step" and updates[2]["status"] == "in_progress"
    assert updates[4] == {"sessionUpdate": "plan_update", "plan": {"type": "items", "entries": [{"content": "a", "priority": "high", "status": "completed"}]}}
    await client.close()


async def test_v1_prompt_over_ndjson_bytes() -> None:
    client_end, agent_end = byte_link()

    async def prompt(turn: AgentTurn) -> str:
        await turn.say(f"You said: {turn.text} ✓")
        return "max_tokens"

    serve_agent(agent_end, name="echo", prompt=prompt)
    client = Client(client_end).start()
    await client.init(1)
    sid = await client.new_session()
    assert await client.peer.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "hello"}]}) == {"stopReason": "max_tokens"}
    assert client.updates()[0]["content"] == {"type": "text", "text": "You said: hello ✓"}
    await client.close()


@pytest.mark.parametrize("protocol", [1, 2])
async def test_cancel_fires_turn_signal_fails_open_tool_calls_and_stops_cancelled(protocol: int) -> None:
    started = asyncio.Event()
    reasons: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        await turn.tool_call("Long step", id="long", status="in_progress")
        started.set()
        reasons.append(await turn.signal.wait())

    client = serve(prompt=prompt)
    await client.init(protocol)
    sid = await client.new_session()
    answer = asyncio.ensure_future(client.peer.request("session/prompt", {"sessionId": sid, "prompt": []}))
    await started.wait()
    await client.peer.notify("session/cancel", {"sessionId": sid})
    if protocol == 1:
        assert await answer == {"stopReason": "cancelled"}
    else:
        await answer
        assert (await client.idle())["stopReason"] == "cancelled"
    assert "cancelled by the client" in str(reasons[0])
    failed = [u for u in client.updates() if u["sessionUpdate"] == "tool_call_update" and u["status"] == "failed"]
    assert failed == [{"sessionUpdate": "tool_call_update", "toolCallId": "long", "status": "failed"}]
    await client.close()


async def test_cancel_for_unknown_session_is_ignored() -> None:
    client = serve(prompt=lambda turn: None)
    await client.init(1)
    await client.peer.notify("session/cancel", {"sessionId": "nope"})
    await tick()
    assert await client.new_session()
    await client.close()


async def test_a_second_prompt_is_refused_while_one_runs() -> None:
    release = asyncio.Event()

    async def prompt(turn: AgentTurn) -> None:
        await release.wait()

    client = serve(prompt=prompt)
    await client.init(1)
    sid = await client.new_session()
    first = asyncio.ensure_future(client.peer.request("session/prompt", {"sessionId": sid, "prompt": []}))
    await tick()
    with pytest.raises(RpcError) as info:
        await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert info.value.code == -32602 and "already has a turn running" in info.value.message
    release.set()
    assert await first == {"stopReason": "end_turn"}
    await client.close()


async def test_queue_prompts_runs_them_in_order_and_cancel_drops_the_queue() -> None:
    order: list[str] = []
    gates: dict[str, asyncio.Event] = {"one": asyncio.Event(), "two": asyncio.Event()}

    async def prompt(turn: AgentTurn) -> None:
        order.append(f"start {turn.text}")
        if turn.text in gates:
            gate = asyncio.ensure_future(gates[turn.text].wait())
            stopped = asyncio.ensure_future(turn.signal.wait())
            await asyncio.wait({gate, stopped}, return_when=asyncio.FIRST_COMPLETED)
            gate.cancel()
            stopped.cancel()
        order.append(f"end {turn.text}")

    client = serve(prompt=prompt, queue_prompts=True)
    await client.init(1)
    sid = await client.new_session()

    def send(text: str) -> asyncio.Future[Any]:
        return asyncio.ensure_future(client.peer.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]}))

    one, two = send("one"), send("two")
    await tick()
    assert order == ["start one"]
    gates["one"].set()
    assert await one == {"stopReason": "end_turn"}
    await until(lambda: order == ["start one", "end one", "start two"])
    gates["two"].set()
    assert await two == {"stopReason": "end_turn"}

    # session/cancel stops the running turn and the queued ones.
    gates["three"] = asyncio.Event()
    three, four = send("three"), send("four")
    await until(lambda: "start three" in order)
    await client.peer.notify("session/cancel", {"sessionId": sid})
    assert await three == {"stopReason": "cancelled"}
    assert await four == {"stopReason": "cancelled"}
    assert "start four" not in order
    await client.close()


async def test_prompt_errors_v1_internal_error_v2_idle_error() -> None:
    def prompt(turn: AgentTurn) -> None:
        raise ValueError("boom")

    client = serve(prompt=prompt)
    await client.init(1)
    sid = await client.new_session()
    with pytest.raises(RpcError) as info:
        await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert info.value.code == -32603 and "boom" in info.value.message
    await client.close()

    client = serve(prompt=prompt)
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert await client.idle() == {"sessionUpdate": "state_update", "state": "idle", "stopReason": "error", "error": {"message": "boom"}}
    await client.close()


def _flow(updates: list[dict[str, Any]]) -> list[str]:
    """States and message text, in order."""
    out: list[str] = []
    for u in updates:
        if u["sessionUpdate"] == "state_update":
            out.append(u["state"])
        elif u["sessionUpdate"] == "agent_message_chunk":
            out.append(f"say:{u['content']['text']}")
    return out


async def test_v2_queue_prompts_a_turn_goes_idle_before_the_next_queued_one_starts() -> None:
    async def prompt(turn: AgentTurn) -> str:
        await sleep(10)
        await turn.say(turn.text)
        return "end_turn"

    async def slow_idle(call: Any, next_: Any) -> Any:
        # A slow write of the idle state: the next turn must still wait for it.
        update = call.params.get("update") if isinstance(call.params, dict) else None
        if isinstance(update, dict) and update.get("state") == "idle":
            await sleep(20)
        return await next_(call.params)

    client = serve(prompt=prompt, protocols=[2], queue_prompts=True, peer={"outbound": [slow_idle]})
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "one"}]})
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "two"}]})
    await client.idle(2)
    assert _flow(client.updates()) == ["running", "say:one", "idle", "running", "say:two", "idle"]
    await client.close()


@pytest.mark.parametrize("protocol", [1, 2])
async def test_a_prompt_handler_that_raises_fails_its_open_tool_calls(protocol: int) -> None:
    async def prompt(turn: AgentTurn) -> None:
        await turn.tool_call("grep")
        raise ValueError("boom")

    client = serve(prompt=prompt, protocols=[protocol])
    await client.init(protocol)
    sid = await client.new_session()
    if protocol == 1:
        with pytest.raises(RpcError, match="boom"):
            await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    else:
        await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
        assert (await client.idle())["stopReason"] == "error"
    statuses = [u["status"] for u in client.updates() if u["sessionUpdate"] in ("tool_call", "tool_call_update")]
    assert statuses == ["pending", "failed"]
    await client.close()


async def test_v2_a_turn_whose_running_state_fails_to_send_still_frees_the_session() -> None:
    fail_next = True

    async def outbound(call: Any, next_: Any) -> Any:
        nonlocal fail_next
        update = call.params.get("update") if isinstance(call.params, dict) else None
        if fail_next and isinstance(update, dict) and update.get("sessionUpdate") == "state_update" and update.get("state") == "running":
            fail_next = False
            raise RuntimeError("send failed")
        return await next_(call.params)

    client = serve(prompt=lambda turn: "end_turn", protocols=[2], peer={"outbound": [outbound]})
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert (await client.idle())["stopReason"] == "error"
    # Not refused as busy: the first turn ended.
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert (await client.idle(2))["stopReason"] == "end_turn"
    await client.close()


@pytest.mark.parametrize("protocol", [1, 2])
async def test_a_handler_cancelled_through_a_task_ends_the_turn_cancelled(protocol: int) -> None:
    async def prompt(turn: AgentTurn) -> str:
        async def work() -> None:
            await turn.tool_call("grep")
            await asyncio.sleep(30)

        task = asyncio.ensure_future(work())
        turn.signal.add_listener(lambda _reason: task.cancel())
        await task  # raises CancelledError on session/cancel
        return "end_turn"

    client = serve(prompt=prompt, protocols=[protocol])
    await client.init(protocol)
    sid = await client.new_session()
    answer = asyncio.ensure_future(client.peer.request("session/prompt", {"sessionId": sid, "prompt": []}))
    await until(lambda: any(u["sessionUpdate"] in ("tool_call", "tool_call_update") for u in client.updates()))
    await client.peer.notify("session/cancel", {"sessionId": sid})
    if protocol == 1:
        assert await answer == {"stopReason": "cancelled"}
    else:
        await answer
        assert (await client.idle())["stopReason"] == "cancelled"
    statuses = [u["status"] for u in client.updates() if u["sessionUpdate"] in ("tool_call", "tool_call_update")]
    assert statuses == ["pending", "failed"]
    await client.close()


# ---- permissions and tools -------------------------------------------------------


@pytest.mark.parametrize("protocol", [1, 2])
async def test_permission_request_shapes(protocol: int) -> None:
    answers: list[Any] = []
    asked: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        answers.append(await turn.request_permission("Delete build/"))
        call = await turn.tool_call("Edit file", id="edit")
        answers.append(await turn.request_permission("Edit it?", tool_call_id=call.id))

    def on_permission(params: Any, ctx: Any) -> Any:
        asked.append(params)
        return {"outcome": {"outcome": "selected", "optionId": "allow" if len(asked) == 1 else "reject"}}

    client = serve(prompt=prompt)
    client.peer.on_request("session/request_permission", on_permission)
    await client.init(protocol)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    if protocol == 2:
        await client.idle()
    options = [
        {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
        {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
    ]
    first_call = asked[0]["toolCall"] if protocol == 1 else asked[0]["subject"]["toolCall"]
    assert first_call["title"] == "Delete build/" and first_call["toolCallId"].startswith("permission-")
    if protocol == 1:
        assert asked[1] == {"sessionId": sid, "toolCall": {"toolCallId": "edit"}, "options": options}
    else:
        assert asked[1] == {"sessionId": sid, "title": "Edit it?", "subject": {"type": "tool_call", "toolCall": {"toolCallId": "edit"}}, "options": options}
    assert [(a.outcome, a.option_id, a.allowed) for a in answers] == [("selected", "allow", True), ("selected", "reject", False)]
    await client.close()


async def test_permission_error_answer_is_cancelled() -> None:
    answers: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        answers.append(await turn.request_permission("Go?"))

    client = serve(prompt=prompt)
    await client.init(1)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert (answers[0].outcome, answers[0].allowed) == ("cancelled", False)
    await client.close()


async def test_tool_ask_refused_raises_permission_denied_and_ends_the_turn() -> None:
    ran: list[str] = []
    caught: list[BaseException] = []

    async def prompt(turn: AgentTurn) -> None:
        try:
            await turn.tool("Delete build/", lambda call: ran.append("deleted"), kind="delete", ask=True)
        except PermissionDenied as error:
            caught.append(error)
            raise

    client = serve(prompt=prompt)
    client.peer.on_request("session/request_permission", lambda params, ctx: {"outcome": {"outcome": "selected", "optionId": "reject"}})
    await client.init(1)
    sid = await client.new_session()
    assert await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []}) == {"stopReason": "end_turn"}
    assert ran == []
    assert str(caught[0]) == "Not allowed: Delete build/" and isinstance(caught[0], PermissionDenied) and caught[0].title == "Delete build/"
    created, failed = client.updates()
    assert created["sessionUpdate"] == "tool_call" and created["status"] == "pending" and created["kind"] == "delete"
    assert failed == {
        "sessionUpdate": "tool_call_update",
        "toolCallId": created["toolCallId"],
        "content": [{"type": "content", "content": {"type": "text", "text": "Not allowed"}}],
        "status": "failed",
    }
    await client.close()


async def test_tool_allowed_runs_and_completes_failures_fail() -> None:
    results: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        results.append(await turn.tool("List", lambda call: "a\nb", ask="List the files?"))
        results.append(await turn.tool("Count", lambda call: {"n": 2}))

        def broken(call: Any) -> None:
            raise RuntimeError("disk on fire")

        try:
            await turn.tool("Break", broken)
        except RuntimeError as error:
            results.append(str(error))

    client = serve(prompt=prompt)
    client.peer.on_request("session/request_permission", lambda params, ctx: {"outcome": {"outcome": "selected", "optionId": "allow"}})
    await client.init(1)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert results == ["a\nb", {"n": 2}, "disk on fire"]
    updates = client.updates()
    assert [(u["sessionUpdate"], u.get("status")) for u in updates] == [
        ("tool_call", "pending"),
        ("tool_call_update", "in_progress"),
        ("tool_call_update", "completed"),
        ("tool_call", "in_progress"),
        ("tool_call_update", "completed"),
        ("tool_call", "in_progress"),
        ("tool_call_update", "failed"),
    ]
    assert updates[2]["content"] == [{"type": "content", "content": {"type": "text", "text": "a\nb"}}]
    assert updates[4]["rawOutput"] == {"n": 2}
    assert updates[6]["content"][0]["content"]["text"] == "disk on fire"
    await client.close()


async def test_use_tool_checks_input_and_shows_output() -> None:
    greet = tool(description="Greet", kind="think", title=lambda args: f"Greet {args['who']}", run=lambda args, ctx: {"hello": args["who"]})
    out: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        out.append(await turn.use_tool(greet, {"who": "ada"}, "greet"))

    client = serve(prompt=prompt)
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    await client.idle()
    assert out == [{"hello": "ada"}]
    calls = [u for u in client.updates() if u["sessionUpdate"] == "tool_call_update"]
    assert calls[0]["title"] == "Greet ada" and calls[0]["kind"] == "think" and calls[0]["rawInput"] == {"who": "ada"}
    assert calls[1]["content"][0]["content"]["text"] == '{\n  "hello": "ada"\n}'
    assert calls[2]["status"] == "completed" and calls[2]["rawOutput"] == {"hello": "ada"}
    await client.close()


@pytest.mark.parametrize("protocol", [1, 2])
async def test_pipeline_tool_updates_client_calls_and_capabilities(protocol: int) -> None:
    seen_caps: list[Any] = []
    read: list[Any] = []

    async def prompt(turn: AgentTurn) -> str:
        seen_caps.append(turn.client_capabilities)
        await turn.tool_call_update({"toolCallId": "p1", "title": "Read a.txt", "kind": "read", "status": "pending"}, create=True)
        file = await turn.request("fs/read_text_file", {"path": "a.txt"})
        await turn.tool_call_update({"toolCallId": "p1", "status": "completed", "rawOutput": file})
        await turn.send_update({"sessionUpdate": "available_commands_update", "availableCommands": []})
        await turn.say(file["content"])
        return "end_turn"

    def on_read(params: Any, ctx: Any) -> Any:
        read.append(params)
        return {"content": "hello file"}

    client = serve(prompt=prompt, protocols=[protocol], new_session=lambda request: {"sessionId": f"s-{len(request.params['cwd'])}"})
    client.peer.on_request("fs/read_text_file", on_read)
    await client.init(protocol, caps={"fs": {"readTextFile": True, "writeTextFile": True}})
    sid = await client.new_session("/tmp")
    assert sid == "s-4"
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    if protocol == 2:
        await client.idle()
    assert read == [{"sessionId": sid, "path": "a.txt"}]
    kinds = [k for k in client.kinds() if k != "state_update"]
    assert kinds == ["tool_call" if protocol == 1 else "tool_call_update", "tool_call_update", "available_commands_update", "agent_message_chunk"]
    assert seen_caps[0] == {"fs": {"readTextFile": True, "writeTextFile": True}}
    await client.close()


async def test_read_file_needs_the_capability() -> None:
    errors: list[BaseException] = []

    async def prompt(turn: AgentTurn) -> None:
        for call in (lambda: turn.read_file("a"), lambda: turn.terminal("ls"), lambda: turn.elicit("Name?")):
            try:
                await call()
            except CapabilityError as error:
                errors.append(error)

    client = serve(prompt=prompt)
    await client.init(1)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert [str(e) for e in errors] == [
        "The client does not offer fs/read_text_file",
        "The client does not offer terminals",
        "The client does not offer form elicitation",
    ]
    await client.close()


# ---- background work (v2) --------------------------------------------------------


async def test_v2_detached_work_outlives_the_turn_and_is_cancelled_one_at_a_time() -> None:
    log: list[str] = []
    tasks: list[asyncio.Task[Any]] = []
    asks: list[Any] = []

    async def prompt(turn: AgentTurn) -> str | None:
        if turn.text == "start":
            watch = await turn.tool_call("Watch deploy logs", id="watch", status="in_progress", cancellable=True)
            plain = await turn.tool_call("One step", id="plain", status="in_progress")
            await plain.complete()
            dev = await turn.show_terminal(id="dev", command="npm run dev", cwd="/work", cancellable=True)
            await dev.write("listening on 3000\n")
            await watch.detach()
            await dev.detach()

            async def on_watch() -> None:
                await watch.signal.wait()
                await watch.cancelled()
                log.append("watch cancelled")

            async def on_dev() -> None:
                await dev.signal.wait()
                await dev.exit(signal="SIGTERM")
                log.append("dev exited")

            tasks.extend([asyncio.ensure_future(on_watch()), asyncio.ensure_future(on_dev())])
            asks.append(lambda: turn.request_permission("Restart the deploy?", tool_call_id="watch"))
            await turn.say("started")
            return None
        await turn.signal.wait()
        return "cancelled"

    client = serve(prompt=prompt, protocols=[2])
    client.peer.on_request("session/request_permission", lambda params, ctx: {"outcome": {"outcome": "selected", "optionId": "allow"}})
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "start"}]})
    idle = await client.idle()
    assert idle["background"] == [{"type": "tool_call", "toolCallId": "watch"}, {"type": "terminal", "terminalId": "dev"}]
    updates = client.updates()
    watch_created = next(u for u in updates if u.get("toolCallId") == "watch")
    plain_created = next(u for u in updates if u.get("toolCallId") == "plain")
    assert watch_created["capabilities"] == {"cancel": {}} and "capabilities" not in plain_created
    terminal = next(u for u in updates if u["sessionUpdate"] == "terminal_update")
    assert terminal == {"sessionUpdate": "terminal_update", "terminalId": "dev", "command": "npm run dev", "cwd": "/work", "capabilities": {"cancel": {}}}
    chunk = next(u for u in updates if u["sessionUpdate"] == "terminal_output_chunk")
    assert chunk["data"] == "bGlzdGVuaW5nIG9uIDMwMDAK"
    # Detaching sent snapshots that list the work.
    snapshots = [u for u in updates if u["sessionUpdate"] == "state_update" and u["state"] == "running" and "background" in u]
    assert [len(s["background"]) for s in snapshots] == [1, 2]

    # A question about listed background work is answered with no turn running.
    assert (await asks[0]()).allowed

    # session/cancel stops the foreground turn only.
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "wait"}]})
    await until(lambda: len([u for u in client.updates() if u["sessionUpdate"] == "state_update"]) >= 5)
    await client.peer.notify("session/cancel", {"sessionId": sid})
    second = await client.idle(2)
    assert second["stopReason"] == "cancelled" and len(second["background"]) == 2
    assert log == []

    # One at a time; uncancellable and unknown items are refused.
    with pytest.raises(RpcError) as info:
        await client.peer.request("tool_call/cancel", {"sessionId": sid, "toolCallId": "plain"})
    assert info.value.code == -32602
    assert await client.peer.request("tool_call/cancel", {"sessionId": sid, "toolCallId": "watch"}) == {}
    await until(lambda: log == ["watch cancelled"])
    final_watch = [u for u in client.updates() if u.get("toolCallId") == "watch"][-1]
    assert final_watch["status"] == "cancelled" and final_watch["capabilities"] is None
    last = client.updates()[-1]
    assert last == {"sessionUpdate": "state_update", "state": "idle", "background": [{"type": "terminal", "terminalId": "dev"}]}
    assert await client.peer.request("terminal/cancel", {"sessionId": sid, "terminalId": "dev"}) == {}
    await until(lambda: log == ["watch cancelled", "dev exited"])
    exited = [u for u in client.updates() if u["sessionUpdate"] == "terminal_update"][-1]
    assert exited == {"sessionUpdate": "terminal_update", "terminalId": "dev", "exitStatus": {"signal": "SIGTERM"}, "capabilities": None}
    assert client.updates()[-1]["background"] == []

    for params in ({"sessionId": sid, "toolCallId": "watch"}, {"sessionId": sid, "toolCallId": "nope"}):
        with pytest.raises(RpcError) as info:
            await client.peer.request("tool_call/cancel", params)
        assert info.value.code == -32602
    with pytest.raises(RpcError) as info:
        await client.peer.request("tool_call/cancel", {"sessionId": sid})
    assert info.value.code == -32602 and info.value.message == "toolCallId is required"
    await client.close()


async def test_v2_session_close_stops_background_work() -> None:
    reasons: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        job = await turn.tool_call("Nightly job", id="job", cancellable=True)
        job.signal.add_listener(reasons.append)
        await job.detach()

    closed: list[str] = []
    client = serve(prompt=prompt, protocols=[2], close_session=closed.append)
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert (await client.idle())["background"] == [{"type": "tool_call", "toolCallId": "job"}]
    assert await client.peer.request("session/close", {"sessionId": sid}) == {}
    await until(lambda: len(reasons) == 1)
    assert "session closed" in str(reasons[0]) and closed == [sid]
    await client.close()


async def test_v2_a_closed_connection_stops_background_work() -> None:
    reasons: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        job = await turn.tool_call("Nightly job", id="job", cancellable=True)
        job.signal.add_listener(reasons.append)
        await job.detach()

    client = serve(prompt=prompt, protocols=[2])
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    await client.idle()
    await client.close()
    await until(lambda: len(reasons) == 1)
    assert "connection closed" in str(reasons[0])


async def test_v1_has_no_background_work() -> None:
    errors: list[BaseException] = []
    started = asyncio.Event()

    async def prompt(turn: AgentTurn) -> str:
        job = await turn.tool_call("Job", id="job", status="in_progress", cancellable=True)
        await job.detach()
        try:
            await turn.show_terminal(command="x")
        except CapabilityError as error:
            errors.append(error)
        started.set()
        await turn.signal.wait()
        return "cancelled"

    client = serve(prompt=prompt, protocols=[1])
    await client.init(1)
    sid = await client.new_session()
    answer = asyncio.ensure_future(client.peer.request("session/prompt", {"sessionId": sid, "prompt": []}))
    await started.wait()
    await client.peer.notify("session/cancel", {"sessionId": sid})
    assert await answer == {"stopReason": "cancelled"}
    assert len(errors) == 1
    # Detached: not failed with the turn; never cancellable on v1.
    assert client.updates() == [
        {"sessionUpdate": "tool_call", "toolCallId": "job", "title": "Job", "kind": "other", "status": "in_progress", "content": [], "locations": []}
    ]
    await client.close()


async def test_v2_cancelling_a_turn_cancels_its_foreground_cancellable_tool() -> None:
    started = asyncio.Event()

    async def prompt(turn: AgentTurn) -> None:
        async def run(call: Any) -> None:
            started.set()
            await call.signal.wait()
            raise RuntimeError("stopped")

        await turn.tool("Slow", run, cancellable=True)

    client = serve(prompt=prompt)
    await client.init(2)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    await started.wait()
    await client.peer.notify("session/cancel", {"sessionId": sid})
    assert (await client.idle())["stopReason"] == "cancelled"
    calls = [u for u in client.updates() if u["sessionUpdate"] == "tool_call_update"]
    assert calls[-1] == {"sessionUpdate": "tool_call_update", "toolCallId": calls[0]["toolCallId"], "status": "cancelled", "capabilities": None}
    await client.close()


# ---- extensions and methods ------------------------------------------------------


async def test_methods_and_extensions_are_served_before_the_first_message() -> None:
    ping = extension_request("_acme/ping")
    notes: list[Any] = []
    from deft_subspace.acp.extensions import extension_notification

    note = extension_notification("_acme/note")
    client = serve(
        prompt=lambda turn: "end_turn",
        methods={"_bridge/ping": lambda params, ctx: {"pong": params["n"] + 1}, "*": lambda params, ctx: {"any": ctx.method}},
        extensions=[handle(ping, lambda params, ctx: {"ok": params["x"], "request": ctx.is_request}), handle(note, lambda params, ctx: notes.append(params))],
    )
    assert await client.peer.request("_bridge/ping", {"n": 1}) == {"pong": 2}
    assert await client.peer.request("_acme/ping", {"x": 3}) == {"ok": 3, "request": True}
    assert await client.peer.request("_other/thing") == {"any": "_other/thing"}
    await client.peer.notify("_acme/note", {"y": 1})
    await until(lambda: notes == [{"y": 1}])
    await client.close()


async def test_turn_call_and_notify_extensions() -> None:
    steer = extension_request("_acme/steer")
    got: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        got.append(await turn.call(steer, {"text": "focus"}))
        await turn.complete_elicitation("e1")

    client = serve(prompt=prompt)
    client.peer.on_request("_acme/steer", lambda params, ctx: {"steered": params["text"]})
    await client.init(1)
    sid = await client.new_session()
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    assert got == [{"steered": "focus"}]
    assert ("elicitation/complete", {"sessionId": sid, "elicitationId": "e1"}) in client.notes
    await client.close()


# ---- MCP -------------------------------------------------------------------------


async def test_acp_mcp_server_over_the_connection() -> None:
    tools_seen: list[Any] = []
    messages: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        server = turn.mcp("project-tools")
        tools_seen.append(await server.list_tools())
        tools_seen.append(await server.call_tool("echo", {"message": "hi"}))

    def on_mcp(params: Any, ctx: Any) -> Any:
        messages.append(params)
        if params["method"] == "tools/list":
            if "cursor" not in params["params"]:
                return {"result": {"tools": [{"name": "echo"}], "nextCursor": "p2"}}
            return {"result": {"tools": [{"name": "time"}]}}
        return {"result": {"content": [{"type": "text", "text": params["params"]["arguments"]["message"]}]}}

    client = serve(prompt=prompt, mcp_transports=["acp"])
    client.peer.on_request("mcp/message", on_mcp)
    caps = await client.init(2)
    assert caps["capabilities"]["session"]["mcp"] == {"acp": {}}
    sid = await client.new_session(mcpServers=[{"type": "acp", "name": "project-tools", "serverId": "srv-1"}])
    await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
    await client.idle()
    assert tools_seen == [[{"name": "echo"}, {"name": "time"}], {"content": [{"type": "text", "text": "hi"}]}]
    first = messages[0]
    assert first["serverId"] == "srv-1" and first["method"] == "tools/list" and first["requestId"].startswith("mcp-")
    assert first["params"]["_meta"] == {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {"name": "test-agent", "version": "0.0.0"},
    }
    await client.close()


class RecordingConnector:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.connects = 0

    @property
    def transports(self) -> list[str]:
        return ["stdio"]

    async def connect(self, server: Any, context: McpConnectContext) -> Any:
        self.connects += 1
        events = self.events

        class Connection:
            async def request(self, method: str, params: Any, options: McpCallOptions) -> Any:
                return {"result": {"tools": [{"name": f"{server.name}-tool"}]}}

            async def close(self) -> None:
                events.append("mcp closed")

        return Connection()


def recording_agent(events: list[str]):
    connector = RecordingConnector(events)
    running = asyncio.Event()

    async def prompt(turn: AgentTurn) -> str:
        await turn.mcp("files").list_tools()
        running.set()
        await turn.signal.wait()
        events.append("turn stopped")
        return "cancelled"

    client = serve(prompt=prompt, protocols=[1], mcp_connector=connector, close_session=lambda sid: events.append(f"closeSession {sid}"))
    return client, running, connector


SERVER = {"type": "stdio", "name": "files", "command": "/bin/true", "args": [], "env": []}


async def test_session_close_stops_the_turn_then_closes_mcp_then_close_session() -> None:
    events: list[str] = []
    client, running, connector = recording_agent(events)
    caps = await client.init(1)
    assert "mcpCapabilities" not in caps["agentCapabilities"]  # v1: stdio is implied
    sid = await client.new_session(mcpServers=[SERVER])
    turn = asyncio.ensure_future(client.peer.request("session/prompt", {"sessionId": sid, "prompt": []}))
    await running.wait()
    assert await client.peer.request("session/close", {"sessionId": sid}) == {}
    assert await turn == {"stopReason": "cancelled"}
    assert events == ["turn stopped", "mcp closed", f"closeSession {sid}"]
    assert connector.connects == 1
    await client.close()


async def test_a_closed_connection_stops_turns_and_closes_mcp_without_close_session() -> None:
    events: list[str] = []
    client, running, _connector = recording_agent(events)
    await client.init(1)
    sid = await client.new_session(mcpServers=[SERVER])
    asyncio.ensure_future(client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})).add_done_callback(
        lambda f: f.cancelled() or f.exception()
    )
    await running.wait()
    await client.close()
    await until(lambda: len(events) >= 2)
    await sleep(10)
    assert sorted(events) == ["mcp closed", "turn stopped"]


async def test_mcp_connection_is_kept_for_the_session_and_unknown_servers_raise() -> None:
    events: list[str] = []
    connector = RecordingConnector(events)
    errors: list[str] = []
    listed: list[Any] = []

    async def prompt(turn: AgentTurn) -> None:
        listed.append(await turn.mcp("files").list_tools())
        for name in ("nope", "web"):
            try:
                turn.mcp(name)
            except RuntimeError as error:
                errors.append(str(error))

    client = serve(prompt=prompt, mcp_connector=connector)
    await client.init(2)
    sid = await client.new_session(mcpServers=[{**SERVER, "env": []}, {"type": "http", "name": "web", "url": "https://x", "headers": []}])
    for n in (1, 2):
        await client.peer.request("session/prompt", {"sessionId": sid, "prompt": []})
        await client.idle(n)
    assert connector.connects == 1
    assert listed == [[{"name": "files-tool"}]] * 2
    assert errors[0] == 'The session has no MCP server "nope" (servers: files, web)'
    assert "which the connector does not support (stdio)" in errors[1]
    await client.close()
