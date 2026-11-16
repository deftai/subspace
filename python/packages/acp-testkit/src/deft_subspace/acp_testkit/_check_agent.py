"""check_agent: a client-driven conformance suite for any ACP agent.

    report = await check_agent(channel, cwd=cwd)
    print(format_report(report))

It speaks raw JSON-RPC (not AcpClient), so it sees exactly what the agent sends
and in which order. Each prompt runs in a fresh session. The prompts are
options, so a real agent can be steered into each situation.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Literal

from deft_subspace.acp import config_options_from, modes_from
from deft_subspace.kernel import Channel, ErrorCode, InboundContext, RpcError, RpcPeer, cancel_request

from ._check import TIMED_OUT, CheckResult, Outcome, apply_waivers, message, run_check, within

AGENT_CHECKS: dict[str, str] = {
    "initialize.version": "initialize answers with a protocol version we speak (1 or 2)",
    "auth.methods": "initialize lists login methods well formed (an id, a name, ids unique; v2: a type)",
    "session.new": "session/new returns a sessionId",
    "config.set-current": "setting a select config option to its current value answers with the full option list",
    "session.delete": "session/delete removes a session (when the agent offers it)",
    "prompt.ends": "a prompt ends (v1: prompt response, v2: idle state)",
    "prompt.updates-before-end": "updates arrive before the end, none after",
    "cancel.ends-cancelled": 'session/cancel ends the turn with stopReason "cancelled" in time',
    "session.unknown": "a prompt for an unknown session is error -32002",
    "cancel.permission": "a permission request open during a cancel, answered cancelled, ends the turn cancelled",
}
"""Each check's id and what it checks, in the order they run."""


class _DefaultPrompts:
    prompt = "Reply with exactly OK and nothing else. Do not use any tools."
    long_prompt = "Count from 1 to 300, one number per line. Do not use any tools."
    permission_prompt = "Create a file named deft-testkit.txt containing the word hi in the current directory."


DEFAULT_PROMPTS = _DefaultPrompts()
"""The prompts `check_agent()` sends unless told otherwise: `prompt`, `long_prompt`, `permission_prompt`."""

_UNSET: Any = object()


def _js(value: Any) -> str:
    """JSON as JavaScript's JSON.stringify writes it (for details that read the same in both ports)."""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return repr(value)


class _TurnWatch:
    """Watches one turn: its updates, and its end (v1 prompt answer, v2 idle after the answer)."""

    def __init__(self, protocol: Literal[1, 2]) -> None:
        self.protocol = protocol
        self.updates: list[dict[str, Any]] = []
        self.after_end = 0
        self.stop_reason: str | None = None
        self.answered = False
        self.error: BaseException | None = None
        self.ended = asyncio.Event()
        self.first_update = asyncio.Event()
        self._idle: str | None = None

    @property
    def is_ended(self) -> bool:
        return self.stop_reason is not None or self.error is not None

    def update(self, update: dict[str, Any]) -> None:
        if self.is_ended:
            self.after_end += 1
            return
        self.updates.append(update)
        self.first_update.set()
        if update.get("sessionUpdate") == "state_update" and update.get("state") == "idle":
            reason = update.get("stopReason")
            self._idle = reason if isinstance(reason, str) else "end_turn"
            if self.answered:
                self._end(self._idle)

    def answer(self, result: Any) -> None:
        self.answered = True
        if self.protocol == 1:
            reason = result.get("stopReason") if isinstance(result, dict) else None
            self._end("" if reason is None else str(reason))
        elif self._idle is not None:
            self._end(self._idle)

    def fail(self, error: BaseException) -> None:
        if self.is_ended:
            return
        self.error = error
        self.first_update.set()
        self.ended.set()

    def _end(self, stop_reason: str) -> None:
        self.stop_reason = stop_reason
        self.ended.set()


async def check_agent(
    channel: Channel[Any],
    *,
    cwd: str | None = None,
    protocol: Literal[1, 2] = 2,
    prompt: str | None = None,
    long_prompt: str | None = None,
    permission_prompt: str | None | Any = _UNSET,
    turn_timeout_ms: float = 120_000,
    cancel_grace_ms: float = 10_000,
    cancel_after_ms: float = 0,
    trailing_update_ms: float = 100,
    only: Sequence[str] | None = None,
    waive: Mapping[str, str] | None = None,
    mode: str | None = None,
) -> list[CheckResult]:
    """Run the agent checks (`AGENT_CHECKS`) against the agent on `channel` (JSON-RPC messages;
    use `ndjson()` for bytes) and report each.

    - `cwd`: the cwd for sessions. Default the temporary folder (`tempfile.gettempdir()`).
    - `protocol`: the protocol to ask for. Default 2 (an agent may answer 1).
    - `prompt`, `long_prompt`: a short turn, and one long enough to cancel (`DEFAULT_PROMPTS`).
    - `permission_prompt`: a turn in which the agent asks for permission. None skips that check.
    - `turn_timeout_ms`: how long a turn may take. Default 120 s.
    - `cancel_grace_ms`: how long a cancelled turn may take to end. Default 10 s.
    - `cancel_after_ms`: wait this long after the long turn's first update before cancelling.
    - `trailing_update_ms`: how long after a turn's end to keep watching for stray updates
      (`prompt.updates-before-end`). Default 100 ms.
    - `only`: run only these check ids. The setup a selected check needs (initialize, the
      first session) still runs, unreported; if it fails, the selected checks fail.
    - `waive`: failed checks to waive, as check id: reason (an agent's quirks carry its waivers:
      `resolve_agent(catalog, name).waivers`).
    - `mode`: switch every session to this mode before its turn, e.g. an ask-first mode
      (Claude "default", Codex "read-only"): in their starting modes some agents never ask
      permission, and `cancel.permission` is skipped.
    """
    folder = cwd if cwd is not None else tempfile.gettempdir()
    turn_timeout = turn_timeout_ms
    grace = cancel_grace_ms
    prompts = {
        "prompt": prompt if prompt is not None else DEFAULT_PROMPTS.prompt,
        "long": long_prompt if long_prompt is not None else DEFAULT_PROMPTS.long_prompt,
        "permission": DEFAULT_PROMPTS.permission_prompt if permission_prompt is _UNSET else permission_prompt,
    }

    def wanted(id: str) -> bool:
        return only is None or id in only

    report: list[CheckResult] = []

    async def check(id: str, body: Callable[[], Awaitable[Outcome]]) -> None:
        if wanted(id):
            report.append(await run_check(id, AGENT_CHECKS[id], body))

    def setup_failed(ids: Sequence[str], detail: str) -> None:
        """Setup that failed and was not reported itself (not in `only`): fail the selected checks that needed it."""
        for id in ids:
            if wanted(id):
                report.append(CheckResult(id, AGENT_CHECKS[id], False, detail))

    watches: dict[str, _TurnWatch] = {}
    # How this check answers permission requests, per session. Default: reject (or cancelled).
    permission_handlers: dict[str, Callable[[dict[str, Any]], Awaitable[Any]]] = {}
    tasks: set[asyncio.Task[Any]] = set()
    peer = RpcPeer(channel, name="deft-testkit", **cancel_request)

    def on_update(params: Any, _context: InboundContext) -> None:
        if isinstance(params, dict) and params.get("sessionId") and isinstance(params.get("update"), dict):
            watch = watches.get(params["sessionId"])
            if watch is not None:
                watch.update(params["update"])

    async def on_permission(params: Any, _context: InboundContext) -> Any:
        params = params if isinstance(params, dict) else {}
        handler = permission_handlers.get(str(params.get("sessionId")))
        if handler is not None:
            return await handler(params)
        options = [o for o in params.get("options", []) if isinstance(o, dict)] if isinstance(params.get("options"), list) else []
        reject = next((o for o in options if o.get("kind") == "reject_once"), None) or next(
            (o for o in options if o.get("kind") == "reject_always"), None
        )
        return {"outcome": {"outcome": "selected", "optionId": reject["optionId"]} if reject else {"outcome": "cancelled"}}

    peer.on_notification("session/update", on_update)
    peer.on_request("session/request_permission", on_permission)
    peer.start()

    negotiated: Literal[1, 2] | None = None
    init_answer: dict[str, Any] = {}
    init_detail = ""
    asked = protocol
    try:
        init_params: dict[str, Any] = {"protocolVersion": asked}
        if asked == 2:
            init_params.update(info={"name": "deft-testkit", "version": "0"}, capabilities={})
        init_params.update(
            clientInfo={"name": "deft-testkit", "version": "0"},
            clientCapabilities={"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
        )
        init = await within(peer.request("initialize", init_params), 60_000, TIMED_OUT)
        if init is not TIMED_OUT:
            version = init.get("protocolVersion") if isinstance(init, dict) else None
            if version in (1, 2) and not isinstance(version, bool):
                negotiated = 1 if version == 1 else 2
            init_answer = init if isinstance(init, dict) else {}
            chosen = negotiated
            init_detail = f"asked v{asked}, agent chose {_plain(version)}"

            async def version_check() -> Outcome:
                return Outcome(chosen is not None and chosen <= asked, init_detail)

            await check("initialize.version", version_check)
        else:
            init_detail = "no answer within 60 s"

            async def no_answer() -> Outcome:
                return Outcome(False, init_detail)

            await check("initialize.version", no_answer)
    except Exception as error:  # noqa: BLE001
        init_detail = f"error: {message(error)}"

        async def init_failed() -> Outcome:
            return Outcome(False, init_detail)

        await check("initialize.version", init_failed)
    if negotiated is None:
        # Every other check needs a connection.
        if not wanted("initialize.version"):
            ids = [
                id
                for id in AGENT_CHECKS
                if id != "initialize.version" and (id != "cancel.permission" or prompts["permission"] is not None)
            ]
            setup_failed(ids, f"initialize failed: {init_detail}")
        await peer.close()
        return apply_waivers(report, waive)
    v: Literal[1, 2] = negotiated

    async def auth_methods() -> Outcome:
        raw = init_answer.get("authMethods", _UNSET)
        if raw is _UNSET:
            return Outcome(True, "no authMethods (no login needed)")
        if not isinstance(raw, list):
            return Outcome(False, f"authMethods is {_js(raw)}, not a list")
        problems: list[str] = []
        ids: set[str] = set()
        for i, m in enumerate(raw):
            method = m if isinstance(m, dict) else {}
            id = method.get("methodId") if v == 2 else method.get("id")
            if not isinstance(id, str) or not id:
                problems.append(f"#{i} has no {'methodId' if v == 2 else 'id'}")
            elif id in ids:
                problems.append(f"{id} is listed twice")
            else:
                ids.add(id)
            if not isinstance(method.get("name"), str):
                problems.append(f"#{i} has no name")
            if v == 2 and not isinstance(method.get("type"), str):
                problems.append(f"#{i} has no type")
            # We advertised no terminal login, so none may be offered.
            if method.get("type") == "terminal":
                problems.append(f"#{i} is a terminal method, which this client did not advertise")
        kinds = [str(m.get("type", "agent")) if isinstance(m, dict) else "agent" for m in raw]
        return Outcome(not problems, "; ".join(problems) or f"{len(raw)} method(s): {', '.join(kinds) or 'none'}")

    await check("auth.methods", auth_methods)

    # What each session/new answered, by session id.
    created: dict[str, dict[str, Any]] = {}

    async def switch_mode(session_id: str, answer: dict[str, Any], mode_id: str) -> None:
        """session/set_mode (v1 modes) or session/set_config_option (a "mode" config option)."""
        modes = modes_from(answer)
        if modes is None or not any(m.id == mode_id for m in modes.available):
            available = ", ".join(m.id for m in modes.available) if modes is not None else ""
            raise RuntimeError(f'the agent offers no mode "{mode_id}" (available: {available or "none"})')
        if modes.via == "modes":
            await peer.request("session/set_mode", {"sessionId": session_id, "modeId": mode_id}, timeout_ms=30_000)
        else:
            params: dict[str, Any] = {"sessionId": session_id, "configId": modes.config_id, "value": mode_id}
            if v == 2:
                params["type"] = "id"
            await peer.request("session/set_config_option", params, timeout_ms=30_000)

    async def new_session() -> str:
        result = await peer.request("session/new", {"cwd": folder, "mcpServers": []}, timeout_ms=60_000)
        session_id = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeError(f"session/new returned {_js(result)}")
        created[session_id] = result
        if mode:
            await switch_mode(session_id, result, mode)
        return session_id

    def start_turn(session_id: str, text: str) -> _TurnWatch:
        watch = _TurnWatch(v)
        watches[session_id] = watch

        async def run() -> None:
            try:
                result = await peer.request(
                    "session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]}
                )
            except Exception as error:  # noqa: BLE001
                watch.fail(error)
            else:
                watch.answer(result)

        task = asyncio.ensure_future(run())
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return watch

    async def settle(session_id: str, watch: _TurnWatch) -> None:
        """Make sure a turn that did not end is not left running."""
        if watch.is_ended:
            return
        try:
            await peer.notify("session/cancel", {"sessionId": session_id})
        except Exception:  # noqa: BLE001
            pass
        await within(watch.ended.wait(), grace, TIMED_OUT, cancel=True)

    # The first session, for these checks: set up even when session.new is not selected, then not reported.
    holder: list[str] = []
    session_failed: str | None = None

    async def session_new() -> Outcome:
        holder.append(await new_session())
        return Outcome(True, f"sessionId {holder[0]}")

    if wanted("session.new"):
        await check("session.new", session_new)
    elif any(wanted(id) for id in ("config.set-current", "prompt.ends", "prompt.updates-before-end")):
        try:
            holder.append(await new_session())
        except Exception as error:  # noqa: BLE001
            session_failed = f"session/new failed: {message(error)}"
    session_id = holder[0] if holder else None

    if session_failed is not None:
        setup_failed(["config.set-current"], session_failed)
    if session_id is not None:
        answer = created.get(session_id, {})
        sid = session_id

        async def config_set_current() -> Outcome:
            options = config_options_from(answer.get("configOptions")) or []
            # A select other than the mode (the mode check already switches that), else the mode.
            selects = [o for o in options if o.type == "select" and isinstance(o.current_value, str)]
            target = next((o for o in selects if o.category != "mode"), None) or next(iter(selects), None)
            if target is None:
                return Outcome(True, f"no select config option ({len(options)} option(s))", skipped=True)
            value = target.current_value
            params: dict[str, Any] = {"sessionId": sid, "configId": target.id, "value": value}
            if v == 2:
                params["type"] = "id"
            result = await peer.request("session/set_config_option", params, timeout_ms=30_000)
            after = config_options_from(result.get("configOptions") if isinstance(result, dict) else None)
            if after is None:
                return Outcome(False, f"answered {_js(result)}, with no configOptions")
            now = next((o for o in after if o.id == target.id), None)
            current = now.current_value if now is not None else None
            return Outcome(
                current == value,
                f"{target.id} = {_js(value)}: answered {len(after)} option(s), {target.id} now {_js(current) if now is not None else 'undefined'}",
            )

        await check("config.set-current", config_set_current)

    async def session_delete() -> Outcome:
        caps = init_answer.get("capabilities") or init_answer.get("agentCapabilities") or {}
        session_caps = (caps.get("session") if v == 2 else caps.get("sessionCapabilities")) if isinstance(caps, dict) else None
        if not isinstance(session_caps, dict) or not _offered(session_caps.get("delete")):
            return Outcome(True, "the agent does not offer session/delete", skipped=True)
        id = await new_session()
        await peer.request("session/delete", {"sessionId": id}, timeout_ms=30_000)
        listed = v == 2 or _offered(session_caps.get("list"))
        if not listed:
            return Outcome(True, f"deleted {id}; no session/list to confirm")
        result = await peer.request("session/list", {"cwd": folder}, timeout_ms=30_000)
        sessions = result.get("sessions") if isinstance(result, dict) else None
        still = any(isinstance(s, dict) and s.get("sessionId") == id for s in (sessions if isinstance(sessions, list) else []))
        return Outcome(not still, f"{id} is still in session/list" if still else f"deleted {id}; gone from session/list")

    await check("session.delete", session_delete)

    if session_failed is not None:
        setup_failed(["prompt.ends", "prompt.updates-before-end"], session_failed)
    if session_id is not None and (wanted("prompt.ends") or wanted("prompt.updates-before-end")):
        watch = start_turn(session_id, prompts["prompt"])
        ended = await within(watch.ended.wait(), turn_timeout, TIMED_OUT, cancel=True)
        # Anything sent right after the end would show up now (later ones are not seen).
        await asyncio.sleep(trailing_update_ms / 1000)

        async def prompt_ends() -> Outcome:
            if ended is TIMED_OUT:
                return Outcome(False, f"no end within {_plain(turn_timeout)} ms (v{v})")
            if watch.error is not None:
                return Outcome(False, f"prompt failed: {message(watch.error)}")
            return Outcome(bool(watch.stop_reason), f"v{v}, stopReason {watch.stop_reason}")

        async def updates_before_end() -> Outcome:
            content = len([u for u in watch.updates if u.get("sessionUpdate") != "state_update"])
            return Outcome(
                watch.is_ended and content > 0 and watch.after_end == 0,
                f"{content} update(s) before the end, {watch.after_end} after",
            )

        await check("prompt.ends", prompt_ends)
        await check("prompt.updates-before-end", updates_before_end)
        await settle(session_id, watch)

    async def cancel_ends_cancelled() -> Outcome:
        id = await new_session()
        watch = start_turn(id, prompts["long"])
        if await within(watch.first_update.wait(), turn_timeout, TIMED_OUT, cancel=True) is TIMED_OUT:
            await settle(id, watch)
            return Outcome(False, f"no update within {_plain(turn_timeout)} ms to cancel after")
        if cancel_after_ms:
            await asyncio.sleep(cancel_after_ms / 1000)
        if watch.is_ended:
            return Outcome(False, f"the turn ended ({watch.stop_reason}) before the cancel; use a longer long_prompt")
        loop = asyncio.get_running_loop()
        sent = loop.time()
        await peer.notify("session/cancel", {"sessionId": id})
        if await within(watch.ended.wait(), grace, TIMED_OUT, cancel=True) is TIMED_OUT:
            return Outcome(False, f"still running {_plain(grace)} ms after session/cancel")
        if watch.error is not None:
            return Outcome(False, f"prompt failed: {message(watch.error)}")
        return Outcome(
            watch.stop_reason == "cancelled", f"stopReason {watch.stop_reason} after {round((loop.time() - sent) * 1000)} ms"
        )

    await check("cancel.ends-cancelled", cancel_ends_cancelled)

    async def session_unknown() -> Outcome:
        try:
            result = await peer.request(
                "session/prompt",
                {"sessionId": "deft-testkit-no-such-session", "prompt": [{"type": "text", "text": "hello"}]},
                timeout_ms=10_000,
            )
        except RpcError as error:
            return Outcome(error.code == ErrorCode.RESOURCE_NOT_FOUND, f"error {error.code}: {error.message}")
        except Exception as error:  # noqa: BLE001
            return Outcome(False, message(error))
        return Outcome(False, f"answered {_js(result)}")

    await check("session.unknown", session_unknown)

    permission_text = prompts["permission"]
    if permission_text is not None:
        text = str(permission_text)

        async def cancel_permission() -> Outcome:
            id = await new_session()
            asked_event = asyncio.Event()

            async def handler(_params: dict[str, Any]) -> Any:
                asked_event.set()
                # The user has not answered and the turn is cancelled: the spec says answer cancelled.
                await peer.notify("session/cancel", {"sessionId": id})
                return {"outcome": {"outcome": "cancelled"}}

            permission_handlers[id] = handler
            watch = start_turn(id, text)
            asked_wait = asyncio.ensure_future(asked_event.wait())
            ended_wait = asyncio.ensure_future(watch.ended.wait())
            try:
                done, _ = await asyncio.wait(
                    {asked_wait, ended_wait}, timeout=turn_timeout / 1000, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                asked_wait.cancel()
                ended_wait.cancel()
            if not asked_event.is_set():
                permission_handlers.pop(id, None)
                await settle(id, watch)
                # A turn that hangs is a failure; only one that ends without asking is skipped.
                if not done:
                    return Outcome(False, f"the turn neither asked permission nor ended within {_plain(turn_timeout)} ms")
                if watch.error is not None:
                    return Outcome(False, f"prompt failed: {message(watch.error)}")
                return Outcome(True, f"the agent asked no permission (stopReason {watch.stop_reason})", skipped=True)
            ended = await within(watch.ended.wait(), grace, TIMED_OUT, cancel=True)
            permission_handlers.pop(id, None)
            if ended is TIMED_OUT:
                return Outcome(False, f"still running {_plain(grace)} ms after the cancel")
            if watch.error is not None:
                return Outcome(False, f"prompt failed: {message(watch.error)}")
            return Outcome(watch.stop_reason == "cancelled", f"stopReason {watch.stop_reason}")

        await check("cancel.permission", cancel_permission)

    await peer.close()
    for task in list(tasks):
        task.cancel()
    return apply_waivers(report, waive)


def _offered(capability: Any) -> bool:
    """A capability is offered as `{}` (an object, empty or not) or true. An empty dict is
    falsy in Python and truthy in JavaScript, so `bool()` would read `{}` as not offered."""
    return capability is not None and capability is not False


def _plain(value: Any) -> str:
    """A number as JavaScript prints it (120000, not 120000.0); anything else as text."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)
