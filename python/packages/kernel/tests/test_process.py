import asyncio
import os
import sys
import time

import pytest

from deft_subspace.kernel import RpcPeer, SpawnError, ndjson, spawn_process

PY = sys.executable


async def test_a_missing_program_is_a_spawn_error_with_a_hint():
    with pytest.raises(SpawnError) as info:
        await spawn_process("definitely-not-a-real-agent-binary")
    assert info.value.code == "ENOENT"
    assert "installed and on PATH" in str(info.value)


async def test_a_reply_written_just_before_exit_is_not_lost():
    child = await spawn_process(
        PY, args=["-c", "import sys,json; sys.stdout.write(json.dumps({'jsonrpc':'2.0','method':'hello','params':{'last':True}})+'\\n')"]
    )
    peer = RpcPeer(ndjson(child.channel))
    got = []
    peer.on_notification("hello", lambda p, _c: got.append(p)).start()
    await child.ended()
    await peer.closed
    assert got == [{"last": True}]


async def test_writing_to_a_process_that_died_fails():
    child = await spawn_process(PY, args=["-c", "raise SystemExit(1)"])
    await child.exited
    big = b"x" * (1024 * 1024)
    with pytest.raises(Exception):
        for _ in range(8):
            await child.channel.send(big)


@pytest.mark.skipif(sys.platform == "win32", reason="process groups")
async def test_stop_ends_the_whole_process_group_even_a_child_that_ignores_sigterm():
    script = (
        "import signal, subprocess, sys, time\n"
        "g = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])\n"
        "print(g.pid, flush=True)\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "time.sleep(60)\n"
    )
    child = await spawn_process(PY, args=["-c", script], kill_grace_ms=300)
    grandchild = int((await child.channel.receive()).decode().strip())
    assert grandchild > 0
    started = time.monotonic()
    info = await child.stop()
    assert info.signal == "SIGKILL"
    assert time.monotonic() - started < 3
    await asyncio.sleep(0.1)
    with pytest.raises(ProcessLookupError):
        os.kill(grandchild, 0)


async def test_keeps_the_last_stderr_output():
    child = await spawn_process(
        PY,
        args=["-c", "import sys; print('x'*100, file=sys.stderr); print('fatal: no API key', file=sys.stderr); raise SystemExit(3)"],
        stderr_tail_bytes=64,
    )
    while True:
        try:
            await child.channel.receive()
        except Exception:
            break
    info = await child.ended()
    assert info.code == 3
    await asyncio.sleep(0.05)
    assert child.stderr_tail().endswith("fatal: no API key")
    assert len(child.stderr_tail()) <= 64


IGNORES_SIGTERM = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM")
async def test_a_timed_out_stop_still_stops_the_process():
    child = await spawn_process(PY, args=["-c", IGNORES_SIGTERM], kill_grace_ms=300)
    await asyncio.sleep(0.2)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(child.stop(), 0.05)
    info = await asyncio.wait_for(child.stop(), 3)
    assert info.signal == "SIGKILL"
    assert (await asyncio.wait_for(child.ended(), 3)).signal == "SIGKILL"


async def test_a_timed_out_wait_for_exited_does_not_break_exited_or_ended():
    child = await spawn_process(PY, args=["-c", "import time; time.sleep(60)"], kill_grace_ms=300)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(child.exited, 0.05)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(child.ended(), 0.05)
    stopped = await asyncio.wait_for(child.stop(), 3)
    assert await asyncio.wait_for(child.exited, 1) == stopped
    assert await asyncio.wait_for(child.ended(), 1) == stopped


async def test_ended_settles_after_the_reader_stopped_early():
    child = await spawn_process(PY, args=["-c", "import time; time.sleep(60)"], kill_grace_ms=300)
    peer = RpcPeer(ndjson(child.channel)).start()
    await asyncio.sleep(0.05)
    await peer.close()
    stopped = await asyncio.wait_for(child.stop(), 3)
    assert await asyncio.wait_for(child.ended(), 2) == stopped


async def test_ended_settles_with_no_reader_and_the_output_is_still_there():
    child = await spawn_process(PY, args=["-c", "print('unread')"])
    assert (await asyncio.wait_for(child.ended(), 3)).code == 0
    assert await child.channel.receive() == b"unread\n"

