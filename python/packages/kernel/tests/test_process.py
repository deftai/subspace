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
