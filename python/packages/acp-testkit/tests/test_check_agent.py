"""check_agent against our serve_agent, against agents written on a bare JSON-RPC peer (v1 and v2,
standing in for the TypeScript tests' official-SDK agents), against an official Python SDK agent
in a process, and against broken agents (check-agent.test.ts)."""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path
from typing import Any

import pytest
from deft_subspace.acp import AgentTurn, serve_agent
from deft_subspace.acp_testkit import (
    AGENT_CHECKS,
    DEFAULT_PROMPTS,
    CheckResult,
    check_agent,
    check_agent_process,
    failures,
    format_report,
)
from deft_subspace.kernel import InboundContext, RpcError, RpcPeer
from testkit_helpers import ByteLink, text_of, well_behaved

ALL_IDS = list(AGENT_CHECKS)
#: Checks of features these agents do not offer (config options, session/delete), so skipped.
OPTIONAL = ["config.set-current", "session.delete"]
OPTIONS = [
    {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
    {"optionId": "no", "name": "Reject", "kind": "reject_once"},
]
SDK_AGENT = Path(__file__).parent / "fixtures" / "sdk_agent.py"


def summary(report: list[CheckResult]) -> list[str]:
    return [f"{r.id}:{'skip' if r.skipped else 'pass' if r.passed else 'fail'}" for r in report]


def bare_agent(channel: Any, name: str) -> RpcPeer:
    """An agent written on a bare kernel peer, as one written with an official SDK sees the wire."""
    return RpcPeer(channel, name=name)


def _listen(peer: RpcPeer, method: str, handler: Any) -> None:
    peer.on_request(method, lambda params, _ctx: handler(params))


@pytest.mark.parametrize("protocol", [1, 2])
async def test_serve_agent_passes_every_check(protocol):
    link = ByteLink()
    serve_agent(link.agent, name="good", protocols=[protocol], prompt=well_behaved)
    report = await check_agent(link.client, cancel_grace_ms=1000)
    assert [r.id for r in report] == ALL_IDS
    assert failures(report) == [], format_report(report)
    assert all(not r.skipped or r.id in OPTIONAL for r in report), format_report(report)
    assert re.search(f"agent chose {protocol}", report[0].detail)


async def test_a_bare_v1_agent_passes_every_check():
    link = ByteLink()
    peer = bare_agent(link.agent, "bare-v1")
    running: dict[str, asyncio.Event] = {}
    sessions = [0]

    def new_session(_params: Any) -> Any:
        sessions[0] += 1
        session_id = f"s{sessions[0]}"
        running[session_id] = asyncio.Event()
        return {"sessionId": session_id}

    def cancel(params: Any, _ctx: InboundContext) -> None:
        if params.get("sessionId") in running:
            running[params["sessionId"]].set()

    async def prompt(params: Any) -> Any:
        cancelled = running.get(params["sessionId"])
        if cancelled is None:
            raise RpcError.not_found(f"Session not found: {params['sessionId']}")
        session_id = params["sessionId"]

        async def say(text: str) -> None:
            await peer.notify(
                "session/update",
                {
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}},
                },
            )

        text = text_of(params.get("prompt"))
        if text == DEFAULT_PROMPTS.long_prompt:
            for i in range(1, 301):
                if cancelled.is_set():
                    break
                await say(f"{i}\n")
                await asyncio.sleep(0.005)
        elif text == DEFAULT_PROMPTS.permission_prompt:
            await peer.notify(
                "session/update",
                {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "t1",
                        "title": "Write deft-testkit.txt",
                        "kind": "edit",
                        "status": "pending",
                    },
                },
            )
            answer = await peer.request(
                "session/request_permission", {"sessionId": session_id, "toolCall": {"toolCallId": "t1"}, "options": OPTIONS}
            )
            if answer["outcome"]["outcome"] == "cancelled":
                await cancelled.wait()
        else:
            await say("OK")
        return {"stopReason": "cancelled" if cancelled.is_set() else "end_turn"}

    _listen(peer, "initialize", lambda _p: {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []})
    _listen(peer, "session/new", new_session)
    _listen(peer, "session/prompt", prompt)
    peer.on_notification("session/cancel", cancel)
    peer.start()
    report = await check_agent(link.client, cancel_grace_ms=1000)
    assert failures(report) == [], format_report(report)
    assert all(not r.skipped or r.id in OPTIONAL for r in report), format_report(report)


async def test_a_bare_v2_agent_passes_every_check():
    link = ByteLink()
    peer = bare_agent(link.agent, "bare-v2")
    running: dict[str, asyncio.Event] = {}
    sessions = [0]
    tasks: set[asyncio.Task[Any]] = set()

    def new_session(_params: Any) -> Any:
        sessions[0] += 1
        session_id = f"s{sessions[0]}"
        running[session_id] = asyncio.Event()
        return {"sessionId": session_id}

    def cancel(params: Any, _ctx: InboundContext) -> None:
        if params.get("sessionId") in running:
            running[params["sessionId"]].set()

    def prompt(params: Any) -> Any:
        cancelled = running.get(params["sessionId"])
        if cancelled is None:
            raise RpcError.not_found(f"Session not found: {params['sessionId']}")
        session_id = params["sessionId"]
        text = text_of(params.get("prompt"))

        async def send(update: dict[str, Any]) -> None:
            await peer.notify("session/update", {"sessionId": session_id, "update": update})

        # v2: answer at once; the turn ends with an idle state update.
        async def run() -> None:
            await asyncio.sleep(0.001)
            await send({"sessionUpdate": "state_update", "state": "running"})
            if text == DEFAULT_PROMPTS.long_prompt:
                for i in range(1, 301):
                    if cancelled.is_set():
                        break
                    await send(
                        {"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": {"type": "text", "text": f"{i}\n"}}
                    )
                    await asyncio.sleep(0.005)
            elif text == DEFAULT_PROMPTS.permission_prompt:
                await send(
                    {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "t1",
                        "title": "Write deft-testkit.txt",
                        "kind": "edit",
                        "status": "pending",
                    }
                )
                answer = await peer.request(
                    "session/request_permission",
                    {
                        "sessionId": session_id,
                        "title": "Write deft-testkit.txt",
                        "subject": {"type": "tool_call", "toolCall": {"toolCallId": "t1"}},
                        "options": OPTIONS,
                    },
                )
                if answer["outcome"]["outcome"] == "cancelled":
                    await cancelled.wait()
            else:
                await send({"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": {"type": "text", "text": "OK"}})
            await send(
                {
                    "sessionUpdate": "state_update",
                    "state": "idle",
                    "stopReason": "cancelled" if cancelled.is_set() else "end_turn",
                }
            )

        task = asyncio.ensure_future(run())
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return {"messageId": f"u-{session_id}"}

    _listen(
        peer,
        "initialize",
        lambda _p: {"protocolVersion": 2, "info": {"name": "bare-v2", "version": "1"}, "capabilities": {}, "authMethods": []},
    )
    _listen(peer, "session/new", new_session)
    _listen(peer, "session/prompt", prompt)
    peer.on_notification("session/cancel", cancel)
    peer.start()
    report = await check_agent(link.client, cancel_grace_ms=1000)
    assert failures(report) == [], format_report(report)
    assert re.search(r"agent chose 2", report[0].detail)


async def test_an_official_python_sdk_agent_in_a_process_passes_every_check():
    report = await check_agent_process(sys.executable, args=[str(SDK_AGENT)], cancel_grace_ms=2000)
    assert [r.id for r in report] == ALL_IDS, format_report(report)
    assert failures(report) == [], format_report(report)
    assert all(not r.skipped or r.id in OPTIONAL for r in report), format_report(report)


async def test_a_broken_agent_fails_the_checks_it_breaks():
    link = ByteLink()
    peer = bare_agent(link.agent, "sloppy")

    # Ignores cancel, sends nothing, accepts any session id, never asks permission.
    async def prompt(params: Any) -> Any:
        if text_of(params.get("prompt")) == DEFAULT_PROMPTS.long_prompt:
            await asyncio.sleep(3)
        return {"stopReason": "end_turn"}

    _listen(peer, "initialize", lambda _p: {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []})
    _listen(peer, "session/new", lambda _p: {"sessionId": "any"})
    _listen(peer, "session/prompt", prompt)
    peer.on_notification("session/cancel", lambda _p, _c: None)
    peer.start()
    # The long turn sends no update to cancel after; the suite gives up after turn_timeout_ms.
    report = await check_agent(link.client, cancel_grace_ms=1000, turn_timeout_ms=1000)
    assert summary(report) == [
        "initialize.version:pass",
        "auth.methods:pass",
        "session.new:pass",
        "config.set-current:skip",
        "session.delete:skip",
        "prompt.ends:pass",
        "prompt.updates-before-end:fail",
        "cancel.ends-cancelled:fail",
        "session.unknown:fail",
        "cancel.permission:skip",
    ]
    assert re.search(r"answered", next(r for r in report if r.id == "session.unknown").detail)
    assert re.search(r"FAIL  session\.unknown", format_report(report))
    await peer.close()


async def test_a_permission_turn_that_neither_asks_nor_ends_fails_cancel_permission_instead_of_skipping_it():
    link = ByteLink()

    async def stuck(turn: AgentTurn) -> str:
        await turn.signal.wait()
        return "cancelled"

    serve_agent(link.agent, name="stuck", prompt=stuck)
    # The turn never asks, so turn_timeout_ms always runs out; only the cancel afterwards needs time.
    report = await check_agent(link.client, only=["cancel.permission"], turn_timeout_ms=100, cancel_grace_ms=1000)
    assert summary(report) == ["cancel.permission:fail"]
    assert re.search(r"neither asked permission nor ended within 100 ms", report[0].detail)


@pytest.mark.parametrize("protocol", [1, 2])
async def test_a_permission_turn_that_fails_before_it_asks_fails_cancel_permission_instead_of_skipping_it(protocol):
    link = ByteLink()

    async def failing(_turn: AgentTurn) -> str:
        raise RuntimeError("no model")

    serve_agent(link.agent, name="failing", protocols=[protocol], prompt=failing)
    report = await check_agent(link.client, only=["cancel.permission"], cancel_grace_ms=1000)
    assert summary(report) == ["cancel.permission:fail"]
    # v1: the prompt request fails; v2: the turn ends with stopReason "error".
    expected = r"prompt failed: .*no model" if protocol == 1 else r"prompt failed: stopReason error"
    assert re.search(expected, report[0].detail)


@pytest.mark.parametrize("id", ["prompt.ends", "prompt.updates-before-end", "config.set-current"])
async def test_only_a_selected_check_runs_the_setup_it_needs_without_reporting_it(id: str):
    link = ByteLink()
    serve_agent(link.agent, name="good", prompt=well_behaved)
    report = await check_agent(link.client, only=[id])
    # serve_agent offers no config options, so config.set-current is skipped; it still ran.
    assert summary(report) == [f"{id}:{'skip' if id == 'config.set-current' else 'pass'}"], format_report(report)


async def test_only_failed_setup_is_reported_on_the_selected_checks_that_needed_it():
    link = ByteLink()

    def no_sessions(_request: Any) -> Any:
        raise RuntimeError("out of sessions")

    serve_agent(link.agent, name="no-sessions", new_session=no_sessions, prompt=well_behaved)
    report = await check_agent(link.client, only=["prompt.ends", "session.unknown"])
    assert summary(report) == ["prompt.ends:fail", "session.unknown:pass"], format_report(report)
    assert re.search(r"session/new failed: .*out of sessions", report[0].detail)
    # With session.new selected too, its failure is reported, and so is each check that needed the session.
    both = ByteLink()
    serve_agent(both.agent, name="no-sessions", new_session=no_sessions, prompt=well_behaved)
    with_new = await check_agent(both.client, only=["session.new", "prompt.ends"])
    assert summary(with_new) == ["session.new:fail", "prompt.ends:fail"], format_report(with_new)
    assert re.search(r"session/new failed: .*out of sessions", with_new[1].detail)

    other = ByteLink()
    future = bare_agent(other.agent, "future")
    _listen(future, "initialize", lambda _p: {"protocolVersion": 7, "agentCapabilities": {}, "authMethods": []})
    future.start()
    bad = await check_agent(other.client, only=["session.new", "prompt.ends"])
    assert summary(bad) == ["session.new:fail", "prompt.ends:fail"]
    assert re.search(r"initialize failed: asked v2, agent chose 7", bad[0].detail)
    await future.close()


async def test_trailing_update_ms_how_long_after_the_end_updates_are_still_counted():
    link = ByteLink()
    late: set[asyncio.Task[Any]] = set()

    async def late_update(turn: AgentTurn) -> str:
        await turn.say("OK")

        # An update sent 150 ms after the turn ended.
        async def later() -> None:
            await asyncio.sleep(0.15)
            try:
                await turn.say("late")
            except Exception:
                pass

        task = asyncio.ensure_future(later())
        late.add(task)
        return "end_turn"

    serve_agent(link.agent, name="late-update", prompt=late_update)
    report = await check_agent(
        link.client, only=["session.new", "prompt.ends", "prompt.updates-before-end"], trailing_update_ms=1000
    )
    assert summary(report) == ["session.new:pass", "prompt.ends:pass", "prompt.updates-before-end:fail"]
    assert re.search(r"1 after", report[2].detail)


async def test_an_agent_that_answers_cancel_too_late_fails_and_one_with_no_v1_or_v2_fails_initialize():
    link = ByteLink()

    async def slow_to_cancel(turn: AgentTurn) -> str:
        await turn.say("1\n")
        await turn.signal.wait()
        await asyncio.sleep(0.3)
        return "cancelled"

    serve_agent(link.agent, name="slow-to-cancel", prompt=slow_to_cancel)
    report = await check_agent(link.client, only=["cancel.ends-cancelled"], cancel_grace_ms=50)
    assert summary(report) == ["cancel.ends-cancelled:fail"]
    assert re.search(r"still running 50 ms after session/cancel", report[0].detail)

    other = ByteLink()
    future = bare_agent(other.agent, "future")
    _listen(future, "initialize", lambda _p: {"protocolVersion": 7, "agentCapabilities": {}, "authMethods": []})
    future.start()
    bad = await check_agent(other.client)
    assert summary(bad) == ["initialize.version:fail"]
    await future.close()


@pytest.mark.parametrize("via", ["modes", "config"])
async def test_mode_every_session_is_switched_before_its_turn(via):
    link = ByteLink()
    peer = bare_agent(link.agent, f"modes-{via}")
    current: dict[str, str] = {}
    prompted_in: list[str] = []
    available = [{"id": "auto", "name": "Auto"}, {"id": "ask", "name": "Ask"}]
    count = [0]

    def options(value: str) -> list[dict[str, Any]]:
        choices = [{"value": m["id"], "name": m["name"]} for m in available]
        return [{"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": value, "options": choices}]

    def new_session(_params: Any) -> Any:
        count[0] += 1
        session_id = f"s{count[0]}"
        current[session_id] = "auto"
        if via == "modes":
            return {"sessionId": session_id, "modes": {"currentModeId": "auto", "availableModes": available}}
        return {"sessionId": session_id, "configOptions": options("auto")}

    def set_mode(params: Any) -> Any:
        current[params["sessionId"]] = params["modeId"]
        return {}

    def set_config_option(params: Any) -> Any:
        current[params["sessionId"]] = str(params["value"])
        # The response carries the options as they are now (the spec requires it).
        return {"configOptions": options(str(params["value"]))}

    def prompt(params: Any) -> Any:
        prompted_in.append(current[params["sessionId"]])
        return {"stopReason": "end_turn"}

    _listen(peer, "initialize", lambda _p: {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []})
    _listen(peer, "session/new", new_session)
    _listen(peer, "session/set_mode", set_mode)
    _listen(peer, "session/set_config_option", set_config_option)
    _listen(peer, "session/prompt", prompt)
    peer.start()
    report = await check_agent(link.client, only=["session.new", "prompt.ends"], mode="ask")
    assert summary(report) == ["session.new:pass", "prompt.ends:pass"], f"{via}: {format_report(report)}"
    assert prompted_in == ["ask"], via
    await peer.close()


async def test_mode_an_unknown_mode_fails_session_new():
    link = ByteLink()
    serve_agent(link.agent, name="no-modes", prompt=well_behaved)
    report = await check_agent(link.client, only=["session.new"], mode="ask")
    assert summary(report) == ["session.new:fail"]
    assert re.search(r'offers no mode "ask"', report[0].detail)


def configurable_agent(link: ByteLink, broken: bool) -> RpcPeer:
    """A v2 agent offering login methods, config options and session/delete; `broken` gets each one wrong."""
    peer = bare_agent(link.agent, "configurable")
    sessions: list[str] = []
    model = ["small"]
    count = [0]

    def options() -> list[dict[str, Any]]:
        return [
            {
                "configId": "mode",
                "name": "Mode",
                "category": "mode",
                "type": "select",
                "currentValue": "auto",
                "options": [{"value": "auto", "name": "Auto"}],
            },
            {
                "configId": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": model[0],
                "options": [{"value": "small", "name": "Small"}, {"value": "large", "name": "Large"}],
            },
        ]

    auth = (
        [
            {"methodId": "key", "type": "agent", "name": "Key"},
            {"methodId": "key", "type": "agent", "name": "Key again"},
            {"methodId": "tui", "type": "terminal", "name": "Terminal"},
        ]
        if broken
        else [{"methodId": "key", "type": "agent", "name": "API key"}]
    )

    def new_session(_params: Any) -> Any:
        count[0] += 1
        session_id = f"s{count[0]}"
        sessions.append(session_id)
        return {"sessionId": session_id, "configOptions": options()}

    def set_config_option(params: Any) -> Any:
        if params.get("configId") == "model" and isinstance(params.get("value"), str):
            model[0] = params["value"]
        # Broken: answers without the option list the spec requires.
        return {} if broken else {"configOptions": options()}

    def delete(params: Any) -> Any:
        if not broken and params["sessionId"] in sessions:
            sessions.remove(params["sessionId"])
        return {}

    _listen(
        peer,
        "initialize",
        lambda _p: {
            "protocolVersion": 2,
            "info": {"name": "configurable", "version": "1"},
            "capabilities": {"session": {"delete": {}}},
            "authMethods": auth,
        },
    )
    _listen(peer, "session/new", new_session)
    _listen(peer, "session/set_config_option", set_config_option)
    _listen(peer, "session/delete", delete)
    _listen(peer, "session/list", lambda _p: {"sessions": [{"sessionId": s, "cwd": "/tmp"} for s in sessions]})
    return peer.start()


@pytest.mark.parametrize("broken", [False, True])
async def test_auth_config_and_delete_checks(broken):
    """A v2 agent that offers them passes; one that gets them wrong fails."""
    link = ByteLink()
    peer = configurable_agent(link, broken)
    report = await check_agent(link.client, only=["auth.methods", "session.new", "config.set-current", "session.delete"])
    verdict = "fail" if broken else "pass"
    assert summary(report) == [
        f"auth.methods:{verdict}",
        "session.new:pass",
        f"config.set-current:{verdict}",
        f"session.delete:{verdict}",
    ], format_report(report)

    def detail(id: str) -> str:
        return next(r for r in report if r.id == id).detail

    if broken:
        assert re.search(r"key is listed twice; #2 is a terminal method", detail("auth.methods"))
        assert re.search(r"with no configOptions", detail("config.set-current"))
        assert re.search(r"still in session/list", detail("session.delete"))
    else:
        assert detail("auth.methods") == "1 method(s): agent"
        # The model, not the mode: switching mode is what the mode option is for.
        assert re.search(r'^model = "small"', detail("config.set-current"))
    await peer.close()
