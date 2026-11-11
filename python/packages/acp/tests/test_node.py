"""connect_agent(), and files and terminals served from inside a workspace."""

from __future__ import annotations

import asyncio
import errno
import os
import sys

import pytest
from deft_subspace.acp.agent import serve_agent
from deft_subspace.acp.capabilities import CapabilityError
from deft_subspace.acp.client import AcpClient
from deft_subspace.acp.node import connect_agent, workspace_files, workspace_terminals
from deft_subspace.kernel import SpawnError, channel_pair


@pytest.mark.skipif(sys.platform == "win32", reason="symbolic links need privileges on Windows")
async def test_workspace_files_stay_inside_the_workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (tmp_path / "secret.txt").write_text("secret")
    (ws / "a.txt").write_text("one\ntwo\nthree")
    os.symlink(tmp_path, ws / "out")
    files = workspace_files(str(ws))
    assert await files.read_text_file({"path": "a.txt", "line": 2, "limit": 1}) == "two"
    await files.write_text_file({"path": "new/b.txt", "content": "b"})
    assert (ws / "new" / "b.txt").read_text() == "b"
    with pytest.raises(ValueError, match="outside the workspace"):
        await files.read_text_file({"path": f"{ws}/../secret.txt"})
    with pytest.raises(ValueError, match="symbolic link"):
        await files.read_text_file({"path": "out/secret.txt"})
    with pytest.raises(ValueError, match="symbolic link"):
        await files.write_text_file({"path": "out/x.txt", "content": ""})
    with pytest.raises(FileNotFoundError) as missing:
        await files.read_text_file({"path": "..notes.txt"})
    assert missing.value.errno == errno.ENOENT


async def test_a_missing_agent_binary_is_a_spawn_error_with_a_hint():
    with pytest.raises(SpawnError, match="on PATH"):
        await connect_agent("no-such-acp-agent-binary")


async def test_an_agent_that_dies_during_initialize_reports_its_stderr():
    code = "import sys; sys.stderr.write('auth: no API key configured\\n'); sys.stderr.flush(); sys.exit(1)"
    with pytest.raises(Exception) as caught:
        await connect_agent(sys.executable, args=["-c", code])
    assert "closed" in str(caught.value)
    assert "no API key configured" in str(caught.value)


def _python(code: str) -> tuple[str, list[str]]:
    return sys.executable, ["-c", code]


async def test_v1_terminals_run_inside_the_workspace_report_output_and_exit_truncate_kill_and_refuse(tmp_path):
    terminals = workspace_terminals(str(tmp_path), allow=lambda request: request.command != "rm", kill_grace_ms=200)
    seen: dict = {}

    async def prompt(turn):
        command, args = _python("import sys, time; print('out', flush=True); time.sleep(0.1); sys.stderr.write('err\\n'); sys.exit(3)")
        ok = await turn.terminal(command, args=args)
        seen["exit"] = await ok.wait_for_exit()
        seen["output"] = (await ok.output())["output"]
        await ok.release()

        command, args = _python("import sys; sys.stdout.write('x' * 5000)")
        big = await turn.terminal(command, args=args, output_byte_limit=100)
        await big.wait_for_exit()
        out = await big.output()
        seen["big"] = [len(out["output"]), out["truncated"]]
        await big.release()

        command, args = _python(
            "import signal, sys, time\n"
            "if hasattr(signal, 'SIGTERM'): signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "print('ready', flush=True)\n"
            "while True: time.sleep(1)"
        )
        forever = await turn.terminal(command, args=args)
        while "ready" not in (await forever.output())["output"]:
            await asyncio.sleep(0.01)
        await forever.kill()
        seen["killed"] = (await forever.wait_for_exit())["signal"]
        await forever.release()

        try:
            await turn.terminal("rm", args=["-rf", "/"])
        except Exception as error:
            seen["refused"] = str(error)
        try:
            await turn.terminal(sys.executable, cwd="/")
        except Exception as error:
            seen["outside"] = str(error)
        return "end_turn"

    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="terms", protocols=[1], prompt=prompt)
    client = await AcpClient.connect(client_end, terminals=terminals)
    try:
        await (await client.new_session(str(tmp_path))).prompt("go")
        assert seen["exit"] == {"exitCode": 3, "signal": None}
        assert seen["output"].replace("\r\n", "\n") == "out\nerr\n"
        assert seen["big"] == [100, True]
        if sys.platform != "win32":
            assert seen["killed"] == "SIGKILL"
        assert "refused to run rm" in seen["refused"]
        assert "outside the workspace" in seen["outside"]
    finally:
        await client.close()
        await terminals.dispose()


async def test_v2_no_client_terminals(tmp_path):
    errors: list[BaseException] = []

    async def prompt(turn):
        try:
            await turn.terminal("ls")
        except Exception as error:
            errors.append(error)
        return "end_turn"

    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="terms", protocols=[2], prompt=prompt)
    client = await AcpClient.connect(client_end, terminals=workspace_terminals(str(tmp_path)))
    await (await client.new_session(str(tmp_path))).prompt("go")
    assert isinstance(errors[0], CapabilityError)
    await client.close()


async def test_a_terminal_for_another_session_is_unknown(tmp_path):
    terminals = workspace_terminals(str(tmp_path))
    created = await terminals.create({"sessionId": "a", "command": sys.executable, "args": ["-c", "print(1)"]})
    with pytest.raises(Exception, match="Unknown terminal"):
        await terminals.output({"sessionId": "b", "terminalId": created["terminalId"]})
    status = await terminals.wait_for_exit({"sessionId": "a", **created})
    assert status == {"exitCode": 0, "signal": None}
    assert (await terminals.output({"sessionId": "a", **created}))["output"].strip() == "1"
    await terminals.dispose()
