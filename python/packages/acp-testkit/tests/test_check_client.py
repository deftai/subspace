"""check_client against our AcpClient (v1 and v2) and against clients written on a bare JSON-RPC
peer (standing in for the TypeScript tests' official-SDK clients) (check-client.test.ts)."""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from deft_subspace.acp import PermissionRequest, workspace_files
from deft_subspace.acp_testkit import CLIENT_CHECKS, CheckResult, acp_client_driver, check_client, failures, format_report
from deft_subspace.kernel import AbortSignal, Channel, InboundContext, RpcError, RpcPeer


def summary(report: list[CheckResult]) -> list[str]:
    return [f"{r.id}:{'skip' if r.skipped else 'pass' if r.passed else 'fail'}" for r in report]


def workspace(tmp_path: Path) -> tuple[Path, Path, Path]:
    root = tmp_path
    cwd = root / "project"
    cwd.mkdir()
    outside = root / "secret.txt"
    outside.write_bytes(b"secret")
    return root, cwd, outside


async def slow_user(_request: PermissionRequest, signal: AbortSignal) -> str:
    """A user who allows after a while, unless the turn is cancelled first. The while is long
    enough that the cancel check's cancel always comes first, even on a busy machine."""
    try:
        await asyncio.wait_for(signal.wait(), 2)
    except TimeoutError:
        return "allow"
    return "cancelled"


@pytest.mark.parametrize("protocol", [1, 2])
async def test_acp_client_with_workspace_files_passes_every_check(protocol, tmp_path):
    root, cwd, outside = workspace(tmp_path)
    report = await check_client(
        acp_client_driver(cwd=str(cwd), permissions=slow_user, files=workspace_files(cwd)),
        protocol=protocol,
        outside_file=str(outside),
    )
    assert [r.id for r in report] == list(CLIENT_CHECKS)
    assert failures(report) == [], format_report(report)
    assert all(not r.skipped for r in report), format_report(report)
    assert re.search(
        r"refused.*refused.*read_text_file.*refused", next(r for r in report if r.id == "fs.outside-workspace").detail
    )
    assert not (root / "deft-testkit-outside.txt").exists()
    assert not Path(f"{cwd}-deft-testkit-outside").exists()


async def test_acp_client_without_file_access_the_fs_check_is_skipped_a_reject_policy_still_answers_too_soon_to_test_a_cancel():
    report = await check_client(acp_client_driver(permissions="reject"))
    assert summary(report) == [
        "permission.answered:pass",
        "permission.cancelled-on-cancel:skip",
        "fs.outside-workspace:skip",
        "unknown-method:pass",
    ]
    assert re.search(r'selected "reject"', report[0].detail)
    assert re.search(r"before the cancel", report[1].detail)


class _BareDriver:
    def __init__(self, peer: RpcPeer, session_id: str, on_cancel: Callable[[], Any]) -> None:
        self.peer = peer
        self.session_id = session_id
        self._on_cancel = on_cancel

    async def prompt(self, text: str) -> Any:
        return await self.peer.request(
            "session/prompt", {"sessionId": self.session_id, "prompt": [{"type": "text", "text": text}]}
        )

    async def cancel(self) -> None:
        await self._on_cancel()

    async def close(self) -> None:
        await self.peer.close()


async def _connect_bare(peer: RpcPeer, cwd: Path, fs: dict[str, bool]) -> str:
    peer.on_notification("session/update", lambda _p, _c: None)
    peer.start()
    await peer.request("initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": fs}})
    result = await peer.request("session/new", {"cwd": str(cwd), "mcpServers": []})
    return result["sessionId"]


async def test_a_careless_client_fails_the_checks_it_breaks_the_files_it_wrote_outside_are_removed_and_no_one_elses(
    tmp_path,
):
    root, cwd, _outside = workspace(tmp_path)
    # The user's own files, where earlier versions of the check wrote (and then deleted).
    mine = [root / "deft-testkit-outside.txt", Path(f"{cwd}-deft-testkit-outside") / "escape.txt"]
    for path in mine:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("mine")
    written: list[str] = []

    async def connect(channel: Channel[Any]) -> _BareDriver:
        peer = RpcPeer(channel, name="careless")
        waiting: list[asyncio.Event] = []

        # Allows once the user cancels the turn (or after a while), as if the cancel did not matter.
        async def ask(_params: Any, _ctx: InboundContext) -> Any:
            released = asyncio.Event()
            waiting.append(released)
            try:
                await asyncio.wait_for(released.wait(), 2)
            except TimeoutError:
                pass
            return {"outcome": {"outcome": "selected", "optionId": "allow"}}

        # Writes anywhere (here: inside the temporary root).
        def write(params: Any, _ctx: InboundContext) -> Any:
            written.append(params["path"])
            os.makedirs(os.path.dirname(params["path"]), exist_ok=True)
            Path(params["path"]).write_text(params["content"])
            return {}

        peer.on_request("session/request_permission", ask)
        peer.on_request("fs/write_text_file", write)
        peer.on_request("fs/read_text_file", lambda _p, _c: {"content": ""})
        session_id = await _connect_bare(peer, cwd, {"readTextFile": True, "writeTextFile": True})

        async def on_cancel() -> None:
            await peer.notify("session/cancel", {"sessionId": session_id})
            for released in waiting:
                released.set()
            waiting.clear()

        return _BareDriver(peer, session_id, on_cancel)

    report = await check_client(connect)
    assert summary(report) == [
        "permission.answered:pass",
        "permission.cancelled-on-cancel:fail",
        "fs.outside-workspace:fail",
        "unknown-method:pass",
    ]
    assert re.search(r'"selected".*session/cancel sent', report[1].detail)
    assert [os.path.dirname(p) == str(cwd) for p in written] == [False, False]
    # Fresh paths, the same escapes: up out of the workspace, and a sibling folder whose name starts like it.
    assert Path(os.path.abspath(os.path.dirname(written[0]))) == Path(os.path.abspath(root))
    assert os.path.dirname(written[1]).startswith(f"{cwd}-deft-testkit-outside-"), written[1]
    for path in mine:
        assert path.read_text() == "mine"
    for path in written:
        assert not Path(path).exists(), path
    assert not Path(os.path.dirname(written[1])).exists()


def bare_client(
    cwd: Path,
    fs: dict[str, bool],
    on_cancel: Callable[[RpcPeer, str, list[asyncio.Future[Any]]], Any],
    gate: Callable[[Channel[Any]], Channel[Any]] | None = None,
):
    """A bare v1 client that waits for the user, who only ever cancels; `on_cancel` is what its driver does when the user cancels."""

    async def connect(channel: Channel[Any]) -> _BareDriver:
        peer = RpcPeer(gate(channel) if gate else channel, name="bare-client")
        pending: list[asyncio.Future[Any]] = []

        async def ask(_params: Any, _ctx: InboundContext) -> Any:
            answer: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
            pending.append(answer)
            return await answer

        def read(_params: Any, _ctx: InboundContext) -> Any:
            raise RpcError.invalid_params("outside the workspace")

        peer.on_request("session/request_permission", ask)
        peer.on_request("fs/read_text_file", read)
        session_id = await _connect_bare(peer, cwd, fs)

        async def cancel() -> None:
            result = on_cancel(peer, session_id, pending)
            if asyncio.iscoroutine(result):
                await result

        return _BareDriver(peer, session_id, cancel)

    return connect


def answer_all(pending: list[asyncio.Future[Any]]) -> int:
    count = len(pending)
    for answer in pending:
        if not answer.done():
            answer.set_result({"outcome": {"outcome": "cancelled"}})
    pending.clear()
    return count


async def test_a_client_that_answers_cancelled_but_never_sends_session_cancel_fails(tmp_path):
    _root, cwd, _outside = workspace(tmp_path)
    report = await check_client(
        bare_client(cwd, {}, lambda _peer, _id, pending: answer_all(pending)),
        only=["permission.cancelled-on-cancel"],
        timeout_ms=300,
    )
    assert summary(report) == ["permission.cancelled-on-cancel:fail"]
    assert re.search(r"session/cancel not sent", report[0].detail)


class _Gated:
    """A client channel that stops reading after the first session/update until released."""

    def __init__(self, channel: Channel[Any]) -> None:
        self._channel = channel
        self.stalled = asyncio.Event()
        self.released = asyncio.Event()

    async def receive(self) -> Any:
        if self.stalled.is_set():
            await self.released.wait()
        message = await self._channel.receive()
        if isinstance(message, dict) and message.get("method") == "session/update":
            self.stalled.set()
        return message

    async def send(self, item: Any) -> None:
        await self._channel.send(item)

    async def close(self) -> None:
        await self._channel.close()


async def test_a_client_that_has_not_read_the_permission_request_when_it_times_out_fails(tmp_path):
    # The client stops reading after the tool call, before the permission request, until the request has timed out.
    _root, cwd, _outside = workspace(tmp_path)
    gates: list[_Gated] = []

    def gate(channel: Channel[Any]) -> Channel[Any]:
        gated = _Gated(channel)
        gates.append(gated)
        return gated

    async def notify_cancel(peer: RpcPeer, session_id: str, _pending: list[asyncio.Future[Any]]) -> None:
        await peer.notify("session/cancel", {"sessionId": session_id})

    timeout = 300
    report = asyncio.ensure_future(
        check_client(bare_client(cwd, {}, notify_cancel, gate), only=["permission.cancelled-on-cancel"], timeout_ms=timeout)
    )
    while not gates:
        await asyncio.sleep(0.01)
    await gates[0].stalled.wait()
    # Released well after the check's own timeout for the request has run out.
    await asyncio.sleep(timeout * 1.5 / 1000)
    gates[0].released.set()
    results = await report
    assert summary(results) == ["permission.cancelled-on-cancel:fail"], format_report(results)
    assert re.search(rf"not answered within {timeout} ms", results[0].detail)


async def test_the_cancel_comes_after_the_client_has_the_permission_request(tmp_path):
    _root, cwd, _outside = workspace(tmp_path)
    pending_at_cancel = [-1]

    async def on_cancel(peer: RpcPeer, session_id: str, pending: list[asyncio.Future[Any]]) -> None:
        pending_at_cancel[0] = answer_all(pending)
        await peer.notify("session/cancel", {"sessionId": session_id})

    report = await check_client(bare_client(cwd, {}, on_cancel), only=["permission.cancelled-on-cancel"])
    assert summary(report) == ["permission.cancelled-on-cancel:pass"], format_report(report)
    assert pending_at_cancel[0] == 1


async def test_a_client_that_can_only_read_with_no_outside_file_to_try_skips_the_fs_check(tmp_path):
    _root, cwd, _outside = workspace(tmp_path)
    report = await check_client(bare_client(cwd, {"readTextFile": True}, lambda *_a: None), only=["fs.outside-workspace"])
    assert summary(report) == ["fs.outside-workspace:skip"]
    assert re.search(r"outside_file", report[0].detail)


async def test_a_client_that_never_connects_is_one_failed_check_not_a_hang():
    async def never(_channel: Channel[Any]) -> Any:
        await asyncio.Event().wait()

    report = await check_client(never, timeout_ms=50)
    assert summary(report) == ["connect:fail"]
