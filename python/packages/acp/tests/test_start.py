"""start(), run(), serve_stdio() with real processes, and connect_session() over any channel."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from deft_subspace.acp.agent import serve_agent
from deft_subspace.acp.client import AcpClient
from deft_subspace.acp.open import connect_session, open_session, require_permission_answer
from deft_subspace.acp.start import AgentCommand, run, start
from deft_subspace.kernel import channel_pair, parse_trace

FIXTURES = Path(__file__).parent / "fixtures"


def python(name: str, **fields) -> AgentCommand:
    return AgentCommand(sys.executable, [str(FIXTURES / name)], **fields)


def pair(protocol: int = 2):
    """An in-process agent: says two chunks, and asks permission when told "tool"."""
    agent_end, client_end = channel_pair()

    async def prompt(turn):
        await turn.say("Hello ")
        await turn.say("world")
        if turn.text == "tool":
            ok = await turn.request_permission("Edit a.txt")
            await turn.say(" (allowed)" if ok.allowed else " (refused)")
        return "end_turn"

    serve_agent(agent_end, name="dx", protocols=[protocol], prompt=prompt)
    return client_end


async def test_start_requires_a_permission_answer_and_rejects_unknown_agents():
    with pytest.raises(TypeError, match="needs an answer for the agent's permission questions"):
        await start("claude")
    with pytest.raises(TypeError, match='Unknown agent "nope"'):
        await start("nope", permissions="reject")
    require_permission_answer({"on_permission": "reject"}, "x")
    require_permission_answer({"handlers": None, "permissions": "allow"}, "x")


async def test_a_fixed_on_permission_answer_is_kept_for_start_and_for_one_prompt_over_the_clients_policy():
    rejecting = await start(python("login_agent.py", mode="ask"), on_permission="reject", handle_signals=False)
    try:
        assert (await rejecting.run("go")).text == "mode=ask allowed=false"
    finally:
        await rejecting.close()
    allowing = await start(python("login_agent.py", mode="ask"), permissions="allow", handle_signals=False)
    try:
        assert (await allowing.run("go", on_permission="reject")).text == "mode=ask allowed=false"
        assert (await allowing.run("go")).text == "mode=ask allowed=true"
    finally:
        await allowing.close()


async def test_start_logs_in_once_when_needed_switches_to_the_requested_mode_runs_turns_and_closes():
    async with await start(python("login_agent.py", mode="ask"), on_permission=lambda _r, _s: "allow", handle_signals=False) as agent:
        assert agent.client.agent.name == "login-agent"
        assert agent.session.modes is not None and agent.session.modes.current == "ask"
        deltas: list[str] = []
        result = await agent.run("go", on_message=lambda d, _i, _e: deltas.append(d))
        assert result.text == "mode=ask allowed=true"
        assert deltas == ["mode=ask allowed=true"]
        second = await agent.new_session()
        assert second.modes is not None and second.modes.current == "ask"
    # A mode the agent does not offer is a warning, not a failure.
    agent = await start(python("login_agent.py", mode="yolo"), permissions="reject", handle_signals=False)
    assert 'no mode "yolo"' in (agent.mode_warning or "")
    assert (await agent.run("go")).text == "mode=auto allowed=false"
    await agent.close()
    await agent.close()  # idempotent


async def test_run_one_prompt_then_the_agent_is_stopped():
    result = await run(python("login_agent.py"), "go", permissions="allow", handle_signals=False)
    assert result.text == "mode=auto allowed=true"


async def test_serve_stdio_an_agent_that_prints_still_speaks_clean_acp_and_turn_tool_over_stdio():
    for permissions in ("allow", "reject"):
        result = await run(python("stdio_agent.py"), "go", permissions=permissions, handle_signals=False)
        assert result.stop_reason == "end_turn"
        assert result.text == "listed: 2"
        status = next(c.status for c in result.tool_calls if c.title == "Delete b.txt")
        assert status == ("completed" if permissions == "allow" else "failed")


async def test_start_trace_records_the_connection_and_errors_say_what_to_do_next(tmp_path):
    trace = tmp_path / "run.jsonl"
    agent = await start(python("login_agent.py"), permissions="allow", trace=str(trace), handle_signals=False, quiet=True)
    await agent.run("go")
    await agent.close()
    records = parse_trace(trace.read_text())
    assert records[0]["kind"] == "header"
    assert records[0]["meta"]["cwd"] == os.getcwd()
    methods = [str(r["msg"].get("method", "")) for r in records if r["kind"] == "message"]
    for method in ("initialize", "authenticate", "session/new", "session/prompt", "session/request_permission"):
        assert method in methods, method

    with pytest.raises(Exception, match="Install it with `brew install agent`"):
        await start(AgentCommand("/no/such/agent", install="Install it with `brew install agent`"), permissions="reject", handle_signals=False, quiet=True)
    with pytest.raises(Exception, match=r"needs a login\. Run `agent login`"):
        await start(
            python("login_agent.py", login="Run `agent login`"),
            permissions="reject",
            handle_signals=False,
            quiet=True,
            env={"NO_LOGIN_METHODS": "1"},
        )


async def test_start_with_signals_installs_and_removes_its_handler():
    agent = await start(python("login_agent.py"), permissions="reject", quiet=True)
    await agent.close()


async def test_connect_session_a_ready_session_over_any_channel_needs_a_permission_answer_closes_everything():
    with pytest.raises(TypeError, match=r"connect_session\(\) needs an answer"):
        await connect_session(pair(), cwd="/w")
    streamed = [""]

    def on_message(delta, info, _event):
        streamed[0] += info.separator + delta

    connected = await connect_session(pair(), cwd="/w", mode="plan", on_permission=lambda _r, _s: "reject", on_message=on_message)
    assert 'no mode "plan"' in (connected.mode_warning or "")
    result = await connected.run("tool")
    assert result.text == "Hello world (refused)"
    assert streamed[0] == result.text
    await connected.close()
    with pytest.raises(Exception):
        await connected.session.prompt("again")


async def test_open_session_switches_to_an_offered_mode():
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="x", prompt=lambda _turn: None)
    client = await AcpClient.connect(client_end)
    opened = await open_session(client, cwd="/w")
    assert opened.mode_warning is None
    await client.close()


async def test_stdio_writes_go_through_one_writer_whole_and_in_order_even_when_a_send_is_cancelled():
    import asyncio
    import threading

    from deft_subspace.acp.start import _StdioChannel

    class Out:
        def __init__(self) -> None:
            self.data = bytearray()
            self.flushes = 0
            self.threads: set[str] = set()
            self.slow = threading.Event()

        def write(self, data: bytes) -> None:
            self.threads.add(threading.current_thread().name)
            if data == b"slow\n":
                self.slow.wait(1)
            for byte in data:  # a byte at a time: interleaved writes would show
                self.data.append(byte)

        def flush(self) -> None:
            self.flushes += 1

    out = Out()
    channel = _StdioChannel(reader=None, writer=out)
    slow = asyncio.ensure_future(channel.send(b"slow\n"))
    await asyncio.sleep(0.01)
    slow.cancel()  # its write is under way: it still goes out whole, first
    sends = [asyncio.ensure_future(channel.send(f"frame {i}\n".encode())) for i in range(50)]
    out.slow.set()
    await asyncio.gather(*sends)
    await channel.close()
    assert out.data.decode().split("\n")[:-1] == ["slow", *(f"frame {i}" for i in range(50))]
    assert out.threads == {"serve_stdio:stdout"}
    # Frames queued together share a flush.
    assert out.flushes < 52
    with pytest.raises(Exception):
        await channel.send(b"late\n")


async def test_start_trace_is_buffered_and_flushed_soon_after(tmp_path):
    import asyncio

    from deft_subspace.acp.start import _Trace

    trace = _Trace(str(tmp_path / "t.jsonl"), "x", "/").open()
    for i in range(100):
        trace.tap("out", {"jsonrpc": "2.0", "method": "n", "params": {"i": i}})
    await asyncio.sleep(_Trace.FLUSH_S * 3)
    assert len(parse_trace((tmp_path / "t.jsonl").read_text())) == 101
    trace.close()


async def test_stdio_send_returns_once_queued_waits_past_the_window_and_raises_a_failed_write_next_time():
    import asyncio
    import importlib
    import threading

    from deft_subspace.acp.start import _StdioChannel

    start = importlib.import_module("deft_subspace.acp.start")  # the package's `start` is the function

    class Blocked:
        def __init__(self) -> None:
            self.go = threading.Event()
            self.data = bytearray()

        def write(self, data: bytes) -> None:
            self.go.wait(5)
            self.data += data

        def flush(self) -> None:
            pass

    # A send does not wait for the write: the writer thread is stuck, yet sends return.
    out = Blocked()
    channel = _StdioChannel(reader=None, writer=out)
    for i in range(10):
        await asyncio.wait_for(channel.send(f"frame {i}\n".encode()), 1)
    # Past the window, even a small send waits until the writer catches up.
    small = b"x" * (start._LARGE // 2 - 1) + b"\n"
    while channel._unwritten + len(small) <= start._WINDOW:
        await asyncio.wait_for(channel.send(small), 1)
    waiting = asyncio.ensure_future(channel.send(small))
    await asyncio.sleep(0.05)
    assert not waiting.done()
    out.go.set()
    await asyncio.wait_for(waiting, 5)
    await channel.close()
    assert out.data.decode().split("\n")[:10] == [f"frame {i}" for i in range(10)]

    # A large frame is waited for even when the window has room.
    out = Blocked()
    channel = _StdioChannel(reader=None, writer=out)
    large = asyncio.ensure_future(channel.send(b"x" * start._LARGE))
    await asyncio.sleep(0.05)
    assert not large.done()
    out.go.set()
    await asyncio.wait_for(large, 5)
    assert channel._drain is not None  # the exit hook, while the writer may still have work
    await channel.close()
    assert channel._drain is None  # flushed: nothing left for the hook to wait for

    class Broken:
        def write(self, data: bytes) -> None:
            raise OSError(32, "Broken pipe")

        def flush(self) -> None:
            pass

    # A failed write is raised by the next send.
    channel = _StdioChannel(reader=None, writer=Broken())
    await channel.send(b"lost\n")
    for _ in range(100):
        if channel._failure is not None:
            break
        await asyncio.sleep(0.01)
    with pytest.raises(start.ChannelClosed):
        await channel.send(b"next\n")


def test_stdio_frames_queued_when_the_program_ends_are_still_written():
    """An agent that returns from main as soon as its peer is closed must not lose its last
    replies: the writer thread is a daemon, and sends return before their frames are written."""
    import subprocess

    script = """
import asyncio, sys, time
from deft_subspace.acp.start import _StdioChannel

class Slow:
    def __init__(self, out): self.out = out
    def write(self, data): time.sleep(0.3); self.out.write(data)
    def flush(self): self.out.flush()

async def main():
    channel = _StdioChannel(reader=None, writer=Slow(sys.stdout.buffer))
    await channel.send(b"last reply\\n")  # returns before it is written; main ends at once

asyncio.run(main())
"""
    done = subprocess.run([sys.executable, "-c", script], capture_output=True, timeout=30)
    assert done.returncode == 0, done.stderr
    assert done.stdout == b"last reply\n"
