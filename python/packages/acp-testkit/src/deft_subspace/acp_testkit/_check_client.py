"""check_client: an agent-driven conformance suite for any ACP client.

    report = await check_client(acp_client_driver(permissions="allow", files=files), protocol=1)

The suite plays the agent. `connect` gets the client's end of a channel; it
connects the client (initialize, session/new) and returns a driver the suite
uses to start and cancel turns. Each check is one prompt; the agent reads
which check it is from the prompt text.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import tempfile
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, Literal, Protocol

from deft_subspace.acp import AcpClient, AgentTurn, NewSessionRequest, Turn, serve_agent
from deft_subspace.kernel import Call, Channel, ErrorCode, InboundContext, RpcError, channel_pair

from ._check import TIMED_OUT, CheckResult, Outcome, run_check, within


class ClientDriver(Protocol):
    """What the suite needs from a client: start a turn, cancel it, close. Methods may be plain or async."""

    def prompt(self, text: str, /) -> Awaitable[Any]:
        """Send a prompt; the awaitable resolves when the client considers the turn over."""
        ...

    def cancel(self) -> Any:
        """Cancel the running turn, as the user would."""
        ...

    def close(self) -> Any: ...


ConnectClient = Callable[[Channel[Any]], Awaitable[ClientDriver]]
"""Connect a client over the channel (initialize, session/new) and return its driver."""

CLIENT_CHECKS: dict[str, str] = {
    "permission.answered": "answers a permission request with an option it was offered",
    "permission.cancelled-on-cancel": 'answers "cancelled" for a permission request open when the turn is cancelled, and sends session/cancel',
    "fs.outside-workspace": "refuses file paths outside its workspace (if it advertises fs)",
    "unknown-method": "answers an unknown method with MethodNotFound (-32601)",
}
"""Each check's id and what it checks, in the order they run."""

_OPTIONS = [
    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
    {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
]

#: How long a client that answers at once (a fixed policy) gets to do so, after reading the
#: request, before the suite cancels. The TypeScript suite waits one timer tick.
_SETTLE_MS = 20


def _js(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return repr(value)


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class _Watched:
    """The client's end, watched: calls `on_permission_read` when the client reads a permission request."""

    def __init__(self, channel: Channel[Any]) -> None:
        self._channel = channel
        self.on_permission_read: Callable[[], None] | None = None

    async def receive(self) -> Any:
        message = await self._channel.receive()
        if (
            isinstance(message, dict)
            and message.get("method") == "session/request_permission"
            and self.on_permission_read is not None
        ):
            self.on_permission_read()
        return message

    async def send(self, item: Any) -> None:
        await self._channel.send(item)

    async def close(self) -> None:
        await self._channel.close()


async def check_client(
    connect: ConnectClient,
    *,
    protocol: Literal[1, 2] = 1,
    outside_file: str | None = None,
    timeout_ms: float = 10_000,
    only: Sequence[str] | None = None,
) -> list[CheckResult]:
    """Run the client checks (`CLIENT_CHECKS`) against the client `connect` connects.

    - `protocol`: the protocol the agent speaks. Default 1.
    - `outside_file`: an existing file outside the client's workspace, to try reading.
      Without it only writes are tried (and a client that can only read is skipped).
    - `timeout_ms`: how long to wait for an answer or a turn. Default 10 s.
    - `only`: run only these check ids.
    """
    timeout = timeout_ms

    def wanted(id: str) -> bool:
        return only is None or id in only

    agent_end, raw_client_end = channel_pair()
    # Watch what the client reads, to cancel only once it has the permission request.
    client_end = _Watched(raw_client_end)

    state: dict[str, Any] = {"init": {}, "cwd": "", "session_id": "", "sessions": 0}
    driver_box: list[ClientDriver] = []
    # What the running check's prompt handler found.
    found: dict[str, Outcome] = {}

    async def capture(call: Call, next_: Callable[[], Awaitable[Any]], _context: InboundContext) -> Any:
        if call.method == "initialize" and isinstance(call.params, dict):
            state["init"] = call.params
        return await next_()

    def permission_params(turn: AgentTurn, tool_call_id: str) -> dict[str, Any]:
        if protocol == 2:
            return {
                "sessionId": turn.session_id,
                "title": "Write notes.txt",
                "subject": {"type": "tool_call", "toolCall": {"toolCallId": tool_call_id}},
                "options": _OPTIONS,
            }
        return {"sessionId": turn.session_id, "toolCall": {"toolCallId": tool_call_id}, "options": _OPTIONS}

    async def permission_answered(turn: AgentTurn) -> Outcome:
        call = await turn.tool_call("Write notes.txt", kind="edit")
        answer = await within(agent.request("session/request_permission", permission_params(turn, call.id)), timeout, TIMED_OUT)
        await call.complete()
        if answer is TIMED_OUT:
            return Outcome(False, f"no answer within {_n(timeout)} ms")
        outcome = answer.get("outcome") if isinstance(answer, dict) else None
        outcome = outcome if isinstance(outcome, dict) else {}
        if outcome.get("outcome") == "selected":
            offered = any(o["optionId"] == outcome.get("optionId") for o in _OPTIONS)
            return Outcome(offered, f"selected {_js(outcome.get('optionId'))}{'' if offered else ', which was not offered'}")
        return Outcome(outcome.get("outcome") == "cancelled", f"answered {_js(answer)}")

    async def permission_cancelled_on_cancel(turn: AgentTurn) -> Outcome:
        call = await turn.tool_call("Write notes.txt", kind="edit")
        read = asyncio.Event()
        client_end.on_permission_read = read.set
        request = asyncio.ensure_future(agent.request("session/request_permission", permission_params(turn, call.id)))
        # Answered by the client (a timeout is no answer).
        answer = asyncio.ensure_future(within(request, timeout, TIMED_OUT))
        # Once the client has read the request (and had a moment to handle it), the user cancels the turn.
        delivered = await within(read.wait(), timeout, TIMED_OUT, cancel=True)
        client_end.on_permission_read = None
        if delivered is not TIMED_OUT:
            await asyncio.wait({request}, timeout=_SETTLE_MS / 1000)
        if request.done():
            error = request.exception() if not request.cancelled() else asyncio.CancelledError()
            if error is not None:
                return Outcome(False, f"the permission request failed before the cancel: {error}")
            # Answered at once (a fixed policy): no request was open to cancel.
            return Outcome(
                True, f"the client answered {_js(request.result())} before the cancel; nothing was open to cancel", skipped=True
            )
        driver = driver_box[0]
        cancelling = asyncio.ensure_future(_maybe(driver.cancel()))
        cancelling.add_done_callback(lambda t: t.cancelled() or t.exception())
        result = await answer
        cancel_seen = await within(turn.signal.wait(), timeout, TIMED_OUT, cancel=True)
        if result is TIMED_OUT:
            return Outcome(False, f"the permission request was not answered within {_n(timeout)} ms")
        outcome = result.get("outcome") if isinstance(result, dict) else None
        kind = outcome.get("outcome") if isinstance(outcome, dict) else None
        # Both: the open request answered cancelled, and the turn itself cancelled with session/cancel.
        return Outcome(
            kind == "cancelled" and cancel_seen is not TIMED_OUT,
            f"answered {_js(result)}; session/cancel {'not sent' if cancel_seen is TIMED_OUT else 'sent'}",
        )

    scenarios: dict[str, Callable[[AgentTurn], Awaitable[Outcome]]] = {
        "permission.answered": permission_answered,
        "permission.cancelled-on-cancel": permission_cancelled_on_cancel,
    }

    def new_session(request: NewSessionRequest) -> dict[str, Any]:
        state["cwd"] = request.cwd
        state["sessions"] += 1
        state["session_id"] = f"deft-testkit-session-{state['sessions']}"
        return {"sessionId": state["session_id"]}

    async def prompt(turn: AgentTurn) -> str:
        scenario = scenarios.get(turn.text)
        if scenario is None:
            return "end_turn"
        try:
            found[turn.text] = await scenario(turn)
        except Exception as error:  # noqa: BLE001
            found[turn.text] = Outcome(False, f"threw: {error!r}")
        return "cancelled" if turn.signal.aborted else "end_turn"

    agent = serve_agent(
        agent_end,
        name="deft-testkit-agent",
        protocols=[protocol],
        peer={"inbound": [capture]},
        new_session=new_session,
        prompt=prompt,
    )

    report: list[CheckResult] = []
    connecting = asyncio.ensure_future(connect(client_end))
    await asyncio.wait({connecting}, timeout=timeout / 1000)
    failure: str | None = None
    if not connecting.done():
        failure = f"the client did not connect within {_n(timeout)} ms"
        connecting.cancel()
    elif connecting.cancelled():
        failure = "the client's connect was cancelled"
    elif connecting.exception() is not None:
        failure = repr(connecting.exception())
    if failure is not None:
        await agent.close()
        return [CheckResult("connect", "the client connects (initialize, session/new)", False, failure)]
    driver: ClientDriver = connecting.result()
    driver_box.append(driver)

    for id in ("permission.answered", "permission.cancelled-on-cancel"):
        if not wanted(id):
            continue

        async def turn_check(id: str = id) -> Outcome:
            async def prompted() -> str:
                try:
                    await driver.prompt(id)
                except Exception as error:  # noqa: BLE001
                    return f"failed: {error!r}"
                return "ok"

            ended = await within(prompted(), timeout * 2, TIMED_OUT)
            outcome = found.get(id)
            if outcome is None:
                return Outcome(False, "the turn did not run" if ended is TIMED_OUT else f"the turn {ended}")
            if ended is TIMED_OUT:
                return Outcome(False, f"{outcome.detail}; the turn did not end on the client")
            return outcome

        report.append(await run_check(id, CLIENT_CHECKS[id], turn_check))

    if wanted("fs.outside-workspace"):

        async def fs_outside() -> Outcome:
            init = state["init"]
            caps = init.get("clientCapabilities") if isinstance(init.get("clientCapabilities"), dict) else None
            fs = (caps or {}).get("fs")
            if fs is None and isinstance(init.get("capabilities"), dict):
                fs = init["capabilities"].get("fs")
            fs = fs if isinstance(fs, dict) else {}
            if not fs.get("readTextFile") and not fs.get("writeTextFile"):
                return Outcome(True, "the client advertises no fs access", skipped=True)
            base = str(state["cwd"]).rstrip("\\/")
            tried: list[str] = []
            written: list[str] = []
            passed = True

            async def attempt(method: str, params: dict[str, Any]) -> None:
                nonlocal passed
                try:
                    await agent.request(method, {"sessionId": state["session_id"], **params}, timeout_ms=timeout)
                except Exception:  # noqa: BLE001
                    tried.append(f"{method} {params['path']}: refused")
                    return
                passed = False
                if method == "fs/write_text_file":
                    written.append(str(params["path"]))
                tried.append(f"{method} {params['path']}: allowed")

            if fs.get("writeTextFile"):
                await attempt("fs/write_text_file", {"path": f"{base}/../deft-testkit-outside.txt", "content": "deft-testkit"})
                await attempt(
                    "fs/write_text_file", {"path": f"{base}-deft-testkit-outside/escape.txt", "content": "deft-testkit"}
                )
            if fs.get("readTextFile") and outside_file:
                await attempt("fs/read_text_file", {"path": outside_file})
            # A client that let the writes through leaves files behind: remove them (when it shares our file system).
            if written:
                await asyncio.to_thread(_remove_written, written, f"{base}-deft-testkit-outside")
            if not tried:
                return Outcome(
                    True, "the client can only read files; pass outside_file to try a read outside the workspace", skipped=True
                )
            return Outcome(passed, "; ".join(tried))

        report.append(await run_check("fs.outside-workspace", CLIENT_CHECKS["fs.outside-workspace"], fs_outside))

    if wanted("unknown-method"):

        async def unknown_method() -> Outcome:
            try:
                result = await agent.request("deft-testkit/no-such-method", {}, timeout_ms=timeout)
            except RpcError as error:
                return Outcome(error.code == ErrorCode.METHOD_NOT_FOUND, f"error {error.code}: {error.message}")
            except Exception as error:  # noqa: BLE001
                return Outcome(False, repr(error))
            return Outcome(False, f"answered {_js(result)}")

        report.append(await run_check("unknown-method", CLIENT_CHECKS["unknown-method"], unknown_method))

    close = getattr(driver, "close", None)
    if close is not None:
        try:
            await _maybe(close())
        except Exception:  # noqa: BLE001
            pass
    await agent.close()
    return report


def _remove_written(paths: list[str], folder: str) -> None:
    """Best effort: the test files, then the folder made for one."""
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        os.rmdir(folder)
    except OSError:
        pass


def _n(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


class _AcpClientDriver:
    def __init__(self, client: AcpClient, session: Any) -> None:
        self.client = client
        self.session = session
        self.turn: Turn | None = None

    async def prompt(self, text: str) -> Any:
        turn: Turn = self.session.prompt(text)
        self.turn = turn
        return await turn

    async def cancel(self) -> None:
        if self.turn is not None:
            await self.turn.cancel()

    async def close(self) -> None:
        await self.client.close()


def acp_client_driver(*, cwd: str | None = None, **client_options: Any) -> ConnectClient:
    """A driver for our own AcpClient: connects (with `AcpClient.connect()`'s options), opens a
    session in `cwd` (default the temporary folder), runs turns."""

    async def connect(channel: Channel[Any]) -> ClientDriver:
        client = await AcpClient.connect(channel, **client_options)
        session = await client.new_session(cwd if cwd is not None else tempfile.gettempdir())
        return _AcpClientDriver(client, session)

    return connect
