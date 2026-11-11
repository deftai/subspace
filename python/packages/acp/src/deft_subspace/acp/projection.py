"""Turn `session/update` notifications, v1 or v2, into TurnEvents.

v1 sends a tool call once (`tool_call`) and then partial updates; v2 sends
every change as an upsert (`tool_call_update`) plus appended content chunks.
v1 message ids are optional; when missing, text between two pieces of content
(a tool call, a plan, a terminal) is one message. Notices, usage, state and
title updates do not split it. Either way the app gets the same events.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .model import (
    BackgroundItem,
    MessageEvent,
    OtherWork,
    TextAt,
    PlanEvent,
    SessionInfoEvent,
    StateEvent,
    SubagentWork,
    TerminalEvent,
    TerminalWork,
    ThoughtEvent,
    ToolCall,
    ToolCallEvent,
    ToolCallWork,
    TurnEvent,
    UpdateEvent,
    UsageEvent,
    UserMessageEvent,
)
from ._util import as_list
from .terminals import AppliedTerminal, Terminals

TERMINAL_KEYS = ("terminal_info", "terminal_output", "terminal_output_delta", "terminal_exit")

TextKind = Literal["message", "thought", "user_message"]
_TEXT_EVENTS = {"message": MessageEvent, "thought": ThoughtEvent, "user_message": UserMessageEvent}


def _terminal_only(update: dict[str, Any]) -> bool:
    """Whether a v1 `tool_call_update` carries only terminal extension keys (and the
    stamps an agent repeats in `_meta`): no field of the tool call itself."""
    meta = update.get("_meta")
    if update.get("sessionUpdate") != "tool_call_update" or not isinstance(meta, dict):
        return False
    if not any(key in meta for key in TERMINAL_KEYS):
        return False
    return all(key in ("sessionUpdate", "toolCallId", "_meta") for key in update)


def _b64(text: str) -> str:
    """Text as the base64 of its UTF-8 bytes, as a v2 terminal carries output."""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _text_of(block: Any) -> str:
    return block["text"] if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str) else ""


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


@dataclass
class StateChange:
    state: str
    stop_reason: str | None = None
    error: Any = None
    #: The background list on this snapshot; None when not reported (or malformed).
    background: list[BackgroundItem] | None = None


def background_of(update: dict[str, Any]) -> list[BackgroundItem] | None:
    """A state update's `background`: a list of items with a string type, else not reported (None)."""
    items = update.get("background")
    if not isinstance(items, list):
        return None
    if not all(isinstance(item, dict) and isinstance(item.get("type"), str) for item in items):
        return None
    out: list[BackgroundItem] = []
    for item in items:
        kind = item["type"]
        if kind == "terminal" and isinstance(item.get("terminalId"), str):
            out.append(TerminalWork(item["terminalId"]))
        elif kind == "tool_call" and isinstance(item.get("toolCallId"), str):
            out.append(ToolCallWork(item["toolCallId"]))
        elif kind == "subagent" and isinstance(item.get("sessionId"), str):
            out.append(SubagentWork(item["sessionId"]))
        else:
            out.append(OtherWork(str(kind), item))
    return out


def _terminal_event(applied: AppliedTerminal) -> TerminalEvent:
    return TerminalEvent(terminal=applied.terminal.snapshot(), replaced=applied.replaced, appended=applied.appended)


class _TextLog:
    """A message's text: appended deltas, joined when read.

    An event keeps the log and the length it had, so a turn's events do not each hold a
    copy of the message so far (and appending is not a copy of it). A rewrite (v2 whole
    message) starts a new log.
    """

    __slots__ = ("_joined", "_pending", "length")

    def __init__(self, text: str = "") -> None:
        self._joined = text
        self._pending: list[str] = []
        self.length = len(text)

    def append(self, delta: str) -> None:
        self._pending.append(delta)
        self.length += len(delta)

    def text(self, length: int | None = None) -> str:
        """The text, or its first `length` characters (the text when an event was made)."""
        if self._pending:
            self._joined += "".join(self._pending)
            self._pending = []
        return self._joined if length is None or length == len(self._joined) else self._joined[:length]

    def at_now(self) -> TextAt:
        length = self.length
        return TextAt(lambda: self.text(length))


def _text_event(kind: TextKind, message_id: str, delta: str, log: _TextLog) -> TurnEvent:
    event = _TEXT_EVENTS[kind](message_id, delta, "")
    event.__dict__["_text"] = log.at_now()
    return event


@dataclass
class _Message:
    kind: TextKind
    log: _TextLog = field(default_factory=_TextLog)


class TurnProjection:
    def __init__(self, prefix: str, terminals: Terminals | None = None, tool_calls: dict[str, ToolCall] | None = None) -> None:
        self.tool_calls: dict[str, ToolCall] = tool_calls if tool_calls is not None else {}
        #: Agent terminals (v2), shared with the session so they outlive the turn.
        self.terminals = terminals if terminals is not None else Terminals()
        self._messages: dict[str, _Message] = {}
        #: `text`, until a message changes.
        self._text: str | None = None
        self._order: list[str] = []
        self._segment = 0
        self._last_kind: Literal["text", "other"] = "other"
        self._prefix = prefix
        #: The terminal of each v1 tool call that named one (`_meta.terminal_info`), by tool call id.
        self._v1_terminals: dict[str, str] = {}

    def apply(self, raw: Any) -> tuple[list[TurnEvent], StateChange | None]:
        """Apply one update. Returns the events it produced, and a state change if it was one."""
        if not isinstance(raw, dict) or not isinstance(raw.get("sessionUpdate"), str):
            return [], None
        update: dict[str, Any] = raw
        kind: str = update["sessionUpdate"]
        if kind in ("agent_message_chunk", "agent_thought_chunk"):
            return self._chunk("message" if kind == "agent_message_chunk" else "thought", update), None
        if kind in ("agent_message", "agent_thought"):
            return self._whole("message" if kind == "agent_message" else "thought", update), None
        if kind == "user_message_chunk":
            return self._chunk("user_message", update), None
        if kind == "user_message":
            return self._whole("user_message", update), None
        if kind == "session_info_update":
            return [
                SessionInfoEvent(
                    title=update["title"] if isinstance(update.get("title"), str) else None,
                    updated_at=update["updatedAt"] if isinstance(update.get("updatedAt"), str) else None,
                )
            ], None
        if kind in ("tool_call", "tool_call_update"):
            return self._tool(update, kind == "tool_call"), None
        if kind == "tool_call_content_chunk":
            return self._tool_chunk(update), None
        if kind == "plan":
            self._last_kind = "other"
            return [PlanEvent(as_list(update.get("entries")))], None
        if kind == "plan_update":
            self._last_kind = "other"
            plan = update.get("plan")
            return [PlanEvent(as_list(plan.get("entries")) if isinstance(plan, dict) else [])], None
        if kind in ("terminal_update", "terminal_output_chunk"):
            self._last_kind = "other"
            applied = self.terminals.apply(update)
            return ([_terminal_event(applied)] if applied else []), None
        if kind == "usage_update":
            return [UsageEvent(used=_number(update.get("used")), size=_number(update.get("size")), cost=update.get("cost"))], None
        if kind == "state_update":
            state = str(update.get("state"))
            background = background_of(update)
            change = StateChange(state=state, background=background)
            if state == "idle":
                stop = update.get("stopReason")
                change.stop_reason = stop if stop is not None else "end_turn"
                change.error = update.get("error")
            return [StateEvent(state, background)], change
        # A notice (available commands, mode, config, vendor updates) is not content: it does not split a message.
        return [UpdateEvent(kind, update)], None

    def merge_tool_call(self, update: dict[str, Any]) -> ToolCall | None:
        """Merge a permission request's tool call into the known state (v1 sends an update with it)."""
        if not isinstance(update.get("toolCallId"), str):
            return None
        # A tool call first seen here still separates the text before and after it.
        self._last_kind = "other"
        return self._upsert(update, False)[0]

    def fail_open_tool_calls(self, keep: Callable[[ToolCall], bool] = lambda _call: False) -> list[TurnEvent]:
        """Mark tool calls that never finished as failed, e.g. after a cancel. `keep` spares background work."""
        events: list[TurnEvent] = []
        for call in self.tool_calls.values():
            if call.status in ("pending", "in_progress", "paused") and not keep(call):
                call.status = "failed"
                events.append(ToolCallEvent(call.snapshot(), False))
        return events

    @property
    def text(self) -> str:
        """All agent message text, in order. Messages are separated by a blank line,
        except where the earlier one already ends a line."""
        if self._text is not None:
            return self._text
        parts: list[str] = []
        for message_id in self._order:
            message = self._messages[message_id]
            if message.kind != "message" or not message.log.length:
                continue
            if parts and not parts[-1].endswith("\n"):
                parts.append("\n\n")
            parts.append(message.log.text())
        self._text = "".join(parts)
        return self._text

    def _message_id(self, update: dict[str, Any], kind: TextKind) -> str:
        given = update.get("messageId")
        if isinstance(given, str) and given:
            return given
        if self._last_kind != "text":
            self._segment += 1
        return f"{self._prefix}:{kind}:{self._segment}"

    def _message(self, message_id: str, kind: TextKind) -> _Message:
        message = self._messages.get(message_id)
        if message is None:
            message = _Message(kind)
            self._messages[message_id] = message
            self._order.append(message_id)
        return message

    def _chunk(self, kind: TextKind, update: dict[str, Any]) -> list[TurnEvent]:
        delta = _text_of(update.get("content"))
        message_id = self._message_id(update, kind)
        self._last_kind = "text"
        message = self._message(message_id, kind)
        if not delta:
            return []
        message.log.append(delta)
        if message.kind == "message":
            self._text = None
        return [_text_event(kind, message_id, delta, message.log)]

    def _whole(self, kind: TextKind, update: dict[str, Any]) -> list[TurnEvent]:
        """v2 whole-message upsert: report only what is new, so streamed text is never shown twice."""
        message_id = self._message_id(update, kind)
        self._last_kind = "text"
        content = update.get("content")
        text = "".join(_text_of(b) for b in content) if isinstance(content, list) else ""
        message = self._message(message_id, kind)
        before = message.log.text()
        delta = text[len(before) :] if text.startswith(before) else text
        if text != before:
            message.log = _TextLog(text)
            if message.kind == "message":
                self._text = None
        return [_text_event(kind, message_id, delta, message.log)] if delta else []

    def _tool(self, update: dict[str, Any], create: bool) -> list[TurnEvent]:
        self._last_kind = "other"
        if not isinstance(update.get("toolCallId"), str):
            return []
        call, created = self._upsert(update, create)
        # The terminal before the tool call that shows it, as on v2.
        terminal = self._v1_terminal(update, call)
        # A v1 report that only carries terminal output changes nothing about the
        # tool call (v2 sends such output as terminal updates alone).
        if not create and not created and _terminal_only(update):
            return terminal
        return [*terminal, ToolCallEvent(call.snapshot(), created)]

    def _v1_terminal(self, update: dict[str, Any], call: ToolCall) -> list[TurnEvent]:
        """The terminal events of a v1 tool call report that carries the terminal extension in
        `_meta` (codex-acp, claude-agent-acp): `terminal_info` names the terminal,
        `terminal_output` is a snapshot, `terminal_output_delta` a chunk, and `terminal_exit`
        the exit. They become the v2 updates they stand for. The extension names no command:
        it is the tool call's `rawInput.command`."""
        # A report without `_meta` can still give a known terminal its command:
        # the first report of a streamed tool use has no input yet.
        meta = update.get("_meta") if isinstance(update.get("_meta"), dict) else {}
        assert isinstance(meta, dict)

        def part(key: str) -> dict[str, Any] | None:
            value = meta.get(key)
            return value if isinstance(value, dict) else None

        info, output, delta, exit_ = part("terminal_info"), part("terminal_output"), part("terminal_output_delta"), part("terminal_exit")

        def id_of(p: dict[str, Any] | None) -> str | None:
            value = p.get("terminal_id") if p else None
            return value if isinstance(value, str) and value else None

        terminal_id = id_of(info) or id_of(output) or id_of(delta) or id_of(exit_) or self._v1_terminals.get(call.id)
        if not terminal_id:
            return []
        self._v1_terminals[call.id] = terminal_id
        updates: list[dict[str, Any]] = []
        raw = call.raw_input
        command = raw["command"] if isinstance(raw, dict) and isinstance(raw.get("command"), str) and raw["command"] else None
        known = self.terminals.get(terminal_id)
        head: dict[str, Any] = {"sessionUpdate": "terminal_update", "terminalId": terminal_id}
        if command is not None and command != (known.command if known else None):
            head["command"] = command
        if output is not None:
            head["output"] = {"data": _b64(output["data"] if isinstance(output.get("data"), str) else "")}
        if known is None or len(head) > 2:
            updates.append(head)
        if delta is not None and isinstance(delta.get("data"), str) and delta["data"]:
            updates.append({"sessionUpdate": "terminal_output_chunk", "terminalId": terminal_id, "data": _b64(delta["data"])})
        # Output first, then the exit, when one report carries both.
        if exit_ is not None:
            status: dict[str, Any] = {}
            if isinstance(exit_.get("exit_code"), int) and not isinstance(exit_.get("exit_code"), bool):
                status["exitCode"] = exit_["exit_code"]
            if isinstance(exit_.get("signal"), str):
                status["signal"] = exit_["signal"]
            updates.append({"sessionUpdate": "terminal_update", "terminalId": terminal_id, "exitStatus": status})
        events: list[TurnEvent] = []
        for nxt in updates:
            applied = self.terminals.apply(nxt)
            if applied:
                events.append(_terminal_event(applied))
        return events

    def _tool_chunk(self, update: dict[str, Any]) -> list[TurnEvent]:
        self._last_kind = "other"
        if not isinstance(update.get("toolCallId"), str):
            return []
        call, created = self._upsert({"toolCallId": update["toolCallId"]}, False)
        # Appended in place: snapshots keep the length they had, so they do not change.
        if update.get("content") is not None:
            call.content.append(update["content"])
        return [ToolCallEvent(call.snapshot(), created)]

    def _upsert(self, update: dict[str, Any], create: bool) -> tuple[ToolCall, bool]:
        call_id: str = update["toolCallId"]
        call = self.tool_calls.get(call_id)
        created = call is None
        if call is None:
            call = ToolCall(id=call_id)
            self.tool_calls[call_id] = call
        if isinstance(update.get("title"), str):
            call.title = update["title"]
        if isinstance(update.get("name"), str):
            call.name = update["name"]
        if isinstance(update.get("kind"), str):
            call.kind = update["kind"]
        if isinstance(update.get("status"), str):
            call.status = update["status"]
        # Content and locations replace, as the spec says; chunks append (above).
        if isinstance(update.get("content"), list):
            call.content = list(update["content"])
        if isinstance(update.get("locations"), list):
            call.locations = list(update["locations"])
        if update.get("rawInput") is not None:
            call.raw_input = update["rawInput"]
        if update.get("rawOutput") is not None:
            call.raw_output = update["rawOutput"]
        # v2 capabilities: null clears, an object replaces; `cancel` makes it cancellable.
        if "capabilities" in update:
            caps = update["capabilities"]
            call.cancellable = isinstance(caps, dict) and caps.get("cancel") is not None
        return call, created
