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


@pytest.mark.skipif(sys.platform == "win32", reason="process groups")
async def test_a_group_is_forgotten_once_its_last_member_is_gone():
    from deft_subspace.kernel import process

    # The leader exits at once; a grandchild keeps the group alive a little longer.
    script = (
        "import subprocess, sys\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(0.5)'],"
        " stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
    )
    child = await spawn_process(PY, args=["-c", script])
    await asyncio.wait_for(child.ended(), 3)
    assert child._kill_now in process._live  # the grandchild is still running
    deadline = time.monotonic() + 5
    while child._kill_now in process._live and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    assert child._kill_now not in process._live


# A program that starts a supervised child (which starts a grandchild), prints both pids, and waits.
SUPERVISOR = """
import asyncio, signal, sys
from deft_subspace.kernel import spawn_process

async def main():
    if sys.argv[1] == "own-handler":
        signal.signal(signal.SIGTERM, lambda *_: print("handled", flush=True))
    if sys.argv[1] == "loop-handler":
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, lambda: print("handled", flush=True))
    child = await spawn_process(sys.executable, args=["-c", (
        "import subprocess, sys, time\\n"
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\\n"
        "print(g.pid, flush=True)\\n"
        "time.sleep(60)\\n"
    )])
    grandchild = (await child.channel.receive()).decode().strip()
    print(child.pid, grandchild, flush=True)
    await asyncio.sleep(60)

asyncio.run(main())
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


async def _gone(pid: int, within: float = 3) -> bool:
    deadline = time.monotonic() + within
    while _alive(pid) and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    return not _alive(pid)


async def _run_supervisor(mode: str):
    app = await asyncio.create_subprocess_exec(PY, "-c", SUPERVISOR, mode, stdout=asyncio.subprocess.PIPE)
    assert app.stdout is not None
    line = await asyncio.wait_for(app.stdout.readline(), 10)
    pids = [int(p) for p in line.split()]
    return app, pids


def _kill_all(app: asyncio.subprocess.Process, pids: list[int]) -> None:
    import signal

    for pid in [app.pid, *pids]:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
@pytest.mark.parametrize("signame", ["SIGTERM", "SIGHUP"])
async def test_a_fatal_signal_stops_the_supervised_groups_and_still_kills_the_app(signame):
    import signal

    app, pids = await _run_supervisor("default")
    try:
        sig = getattr(signal, signame)
        app.send_signal(sig)
        assert await asyncio.wait_for(app.wait(), 5) == -sig
        for pid in pids:
            assert await _gone(pid), f"{pid} outlived the app"
    finally:
        _kill_all(app, pids)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
@pytest.mark.parametrize("mode", ["own-handler", "loop-handler"])
async def test_an_apps_own_signal_handler_is_left_alone(mode):
    import signal

    app, pids = await _run_supervisor(mode)
    try:
        app.send_signal(signal.SIGTERM)
        assert app.stdout is not None
        assert (await asyncio.wait_for(app.stdout.readline(), 5)).strip() == b"handled"
        await asyncio.sleep(0.2)
        assert app.returncode is None
        assert all(_alive(pid) for pid in pids)
    finally:
        _kill_all(app, pids)

