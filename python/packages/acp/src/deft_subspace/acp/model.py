"""One model for ACP v1 and v2.

Apps see messages, thoughts, tool calls, plans and permissions as the same
shapes whichever protocol version the agent speaks. On the wire everything is
plain JSON (dicts); the official SDK's pydantic models are here as `v1` and
`v2` for typing and validation. Nothing here is hand-written wire schema.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Union

from .lazy import Lazy, LazyField, stored

if TYPE_CHECKING:
    from acp import schema as v1
    from acp.experimental.v2 import schema as v2

    from .terminals import TerminalState


def __getattr__(name: str) -> Any:
    # The SDK's schema modules are large; they load on first use, not on import.
    if name == "v1":
        from acp import schema

        return schema
    if name == "v2":
        from acp.experimental.v2 import schema

        return schema
    raise AttributeError(name)

ProtocolVersion = Literal[1, 2]

ContentBlock = dict[str, Any]
"""A prompt content block, as on the wire (`{"type": "text", "text": ...}`). The same in v1 and v2."""
ToolCallContent = dict[str, Any]
PermissionOption = dict[str, Any]
"""`{"optionId", "name", "kind"}`; kind is allow_once, allow_always, reject_once or reject_always."""
PlanEntry = dict[str, Any]
"""`{"content", "priority", "status"}`."""

ToolCallStatus = Literal["pending", "in_progress", "paused", "completed", "failed", "cancelled"]
"""v2 adds `paused` (started, suspended until resumed) and `cancelled` (background work stopped)."""

StopReason = str
"""Why a turn ended: end_turn, max_tokens, max_turn_requests, refusal, cancelled, or error (v2's, and a failed v1 turn)."""


@dataclass
class ToolCall:
    """A tool call as it stands now: every update merged in."""

    id: str
    title: str = ""
    status: str = "pending"
    content: list[ToolCallContent] = field(default_factory=list)
    locations: list[Any] = field(default_factory=list)
    name: str | None = None
    kind: str | None = None
    raw_input: Any = None
    raw_output: Any = None
    #: v2: the agent lets the client cancel this tool call alone (`session.cancel_tool_call()`).
    cancellable: bool = False

    def snapshot(self) -> ToolCall:
        """A copy that later updates do not change.

        Content only grows by appending (a replacement is a new list), so the copy keeps
        the list and its length and copies that much the first time its `content` is read;
        from then on `content` is the copy's own list.
        """
        source = stored(self, "content")
        snap = ToolCall(
            id=self.id,
            title=self.title,
            status=self.status,
            locations=list(self.locations),
            name=self.name,
            kind=self.kind,
            raw_input=self.raw_input,
            raw_output=self.raw_output,
            cancellable=self.cancellable,
        )
        snap.__dict__["content"] = source if isinstance(source, _ContentAt) else _ContentAt(source, len(source))
        return snap


class _ContentAt(Lazy):
    """A tool call's content list as it was: the list and its length at the time."""

    __slots__ = ("items", "length")

    def __init__(self, items: list[Any], length: int) -> None:
        self.items = items
        self.length = length

    def read(self) -> list[Any]:
        return self.items[: self.length]


# Read through the descriptor: a snapshot's content is copied the first time it is read.
setattr(ToolCall, "content", LazyField("content", None))


class TextAt(Lazy):
    """A message's text as it was: its log and the length it had, read when looked at."""

    __slots__ = ("log", "length")

    def __init__(self, log: Any, length: int) -> None:
        self.log = log
        self.length = length

    def read(self) -> str:
        return self.log.text(self.length)


def text_source(event: Any) -> Any:
    """@internal The stored `text` of an event: a str or a `TextAt`, without reading it."""
    return stored(event, "text", "")


# ---- background work (v2) ----------------------------------------------------


@dataclass(frozen=True)
class TerminalWork:
    terminal_id: str
    type: Literal["terminal"] = field(default="terminal", init=False)


@dataclass(frozen=True)
class ToolCallWork:
    tool_call_id: str
    type: Literal["tool_call"] = field(default="tool_call", init=False)


@dataclass(frozen=True)
class SubagentWork:
    session_id: str
    type: Literal["subagent"] = field(default="subagent", init=False)


@dataclass(frozen=True)
class OtherWork:
    """A kind this client does not know. It still counts as running."""

    raw_type: str
    raw: dict[str, Any]
    type: Literal["other"] = field(default="other", init=False)


BackgroundItem = Union[TerminalWork, ToolCallWork, SubagentWork, OtherWork]
"""v2: work running independently of the session's foreground work, as the agent lists it on state updates."""


# ---- permissions ---------------------------------------------------------------


@dataclass(frozen=True)
class PermissionCommand:
    command: str
    cwd: str


@dataclass
class PermissionRequest:
    session_id: str
    title: str
    options: list[PermissionOption]
    protocol: ProtocolVersion
    #: The request exactly as the agent sent it.
    raw: Any
    #: The tool call this is about, if any, with the request's details merged in.
    tool_call: ToolCall | None = None
    #: v2: the command a `command` subject asks to run.
    command: PermissionCommand | None = None


@dataclass(frozen=True)
class PermissionOutcome:
    """What was answered. `selected` names the option; `allowed` says which side of the line it was."""

    outcome: Literal["selected", "cancelled"]
    option_id: str | None = None
    allowed: bool = False

    @staticmethod
    def selected(option_id: str, allowed: bool) -> PermissionOutcome:
        return PermissionOutcome("selected", option_id, allowed)

    @staticmethod
    def cancelled() -> PermissionOutcome:
        return PermissionOutcome("cancelled")


# ---- limits ----------------------------------------------------------------------


@dataclass(frozen=True)
class TurnLimits:
    """Limits on one turn. When one is reached the turn is cancelled the normal way
    (the agent is told, open permission questions are answered `cancelled`) and the
    result says which limit it was. Durations are milliseconds."""

    #: Longest the whole turn may run.
    max_duration_ms: float | None = None
    #: Longest the agent may go without sending anything (a stuck agent).
    idle_ms: float | None = None
    #: Most tool calls the turn may start. Starting one more ends it.
    max_tool_calls: int | None = None
    #: Most context tokens in use, as the agent's usage updates report them (v2).
    max_usage: float | None = None


@dataclass(frozen=True)
class Exhaustion:
    """Which limit ended a turn, its setting, and the value that crossed it."""

    limit: Literal["duration", "idle", "toolCalls", "usage"]
    max: float
    value: float


# ---- events ----------------------------------------------------------------------


@dataclass(frozen=True)
class MessageEvent:
    """Agent text. `delta` is what is new; `text` is the whole message so far."""

    message_id: str
    delta: str
    text: str
    type: Literal["message"] = field(default="message", init=False)


@dataclass(frozen=True)
class ThoughtEvent:
    message_id: str
    delta: str
    text: str
    type: Literal["thought"] = field(default="thought", init=False)


@dataclass(frozen=True)
class UserMessageEvent:
    """The user's own message, as the agent echoes it (v2) or replays it on load."""

    message_id: str
    delta: str
    text: str
    type: Literal["user_message"] = field(default="user_message", init=False)


# A text event's text may be a `TextAt`, read the first time it is looked at, so a turn's
# events do not each keep a copy of the message so far.
for _cls in (MessageEvent, ThoughtEvent, UserMessageEvent):
    setattr(_cls, "text", LazyField("text", ""))


@dataclass(frozen=True)
class MessageEndEvent:
    """A message stopped: something else came after it, or the turn ended.

    ACP has no end signal, so this is inferred; if an agent later continues the same
    message, it ends again, with the longer text. `complete` is False when the turn
    ended early (cancelled, failed, or any stop but `end_turn`) while it was open.
    """

    message_id: str
    text: str
    complete: bool
    type: Literal["message_end"] = field(default="message_end", init=False)


@dataclass(frozen=True)
class ThoughtEndEvent:
    message_id: str
    text: str
    complete: bool
    type: Literal["thought_end"] = field(default="thought_end", init=False)


@dataclass(frozen=True)
class UserMessageEndEvent:
    message_id: str
    text: str
    complete: bool
    type: Literal["user_message_end"] = field(default="user_message_end", init=False)


@dataclass(frozen=True)
class SessionInfoEvent:
    """Session title or update time changed. Also kept on `session.info`."""

    title: str | None = None
    updated_at: str | None = None
    type: Literal["session_info"] = field(default="session_info", init=False)


@dataclass(frozen=True)
class ToolCallEvent:
    """A tool call was created or changed. `tool_call` is a snapshot of its state at that moment."""

    tool_call: ToolCall
    created: bool
    type: Literal["tool_call"] = field(default="tool_call", init=False)


@dataclass(frozen=True)
class PlanEvent:
    entries: list[PlanEntry]
    type: Literal["plan"] = field(default="plan", init=False)


@dataclass(frozen=True)
class PermissionEvent:
    request: PermissionRequest
    outcome: PermissionOutcome
    type: Literal["permission"] = field(default="permission", init=False)


@dataclass(frozen=True)
class UsageEvent:
    used: float
    size: float
    cost: Any = None
    type: Literal["usage"] = field(default="usage", init=False)


@dataclass(frozen=True)
class TerminalEvent:
    """v2: a terminal the agent runs changed. `terminal` is a snapshot; `appended` holds a
    chunk's new bytes; `replaced` means the output was replaced (redraw from `terminal.output`)."""

    terminal: TerminalState
    replaced: bool
    appended: bytes | None = None
    type: Literal["terminal"] = field(default="terminal", init=False)


@dataclass(frozen=True)
class StateEvent:
    """v2 only: the agent's run state. `background` is the work running in the background at
    that moment (a snapshot); None when the agent does not report it."""

    state: str
    background: list[BackgroundItem] | None = None
    type: Literal["state"] = field(default="state", init=False)


@dataclass(frozen=True)
class ExhaustedEvent:
    """A turn limit was reached; the turn is being cancelled."""

    limit: Literal["duration", "idle", "toolCalls", "usage"]
    max: float
    value: float
    type: Literal["exhausted"] = field(default="exhausted", init=False)


@dataclass(frozen=True)
class UpdateEvent:
    """Anything else, unchanged (available commands, config options, notices, ...)."""

    session_update: str
    update: Any
    type: Literal["update"] = field(default="update", init=False)


TextEvent = Union[MessageEvent, ThoughtEvent, UserMessageEvent]
TextEndEvent = Union[MessageEndEvent, ThoughtEndEvent, UserMessageEndEvent]
TurnEvent = Union[
    MessageEvent,
    ThoughtEvent,
    UserMessageEvent,
    MessageEndEvent,
    ThoughtEndEvent,
    UserMessageEndEvent,
    SessionInfoEvent,
    ToolCallEvent,
    PlanEvent,
    PermissionEvent,
    UsageEvent,
    TerminalEvent,
    StateEvent,
    ExhaustedEvent,
    UpdateEvent,
]
"""Everything that can happen during a turn, in order. Narrow with `match` or on `event.type`."""


@dataclass
class TurnResult:
    stop_reason: StopReason
    #: All agent message text of the turn, messages separated by a blank line.
    text: str
    tool_calls: list[ToolCall]
    #: True when the turn was cancelled from this side.
    cancelled: bool
    #: True when the agent did not confirm a cancel in time and the turn was ended here.
    forced: bool = False
    #: v2: the error an `error` stop carried.
    error: Any = None
    #: Set when a turn limit ended the turn.
    exhausted: Exhaustion | None = None
    #: How many of the agent's permission requests this side refused (rejected, or answered
    #: cancelled while the turn was not being cancelled). Some agents (Grok, Codex) end a turn
    #: whose request was refused with stop reason "cancelled" though nobody cancelled:
    #: `cancelled` False and `refused` set tells that apart from a real cancel (see `turn_end`).
    refused: int = 0


TurnEnd = Literal["completed", "cancelled", "refused", "limit", "error"]


def turn_end(result: TurnResult) -> TurnEnd:
    """Why a turn ended, in one word, with the agent quirks taken out.

    `limit` (a turn limit), `cancelled` (cancelled from this side, or by the agent
    unprompted), `refused` (the agent stopped after a permission request was refused),
    `error` (a v2 error stop), or `completed` (any other stop: end_turn, max_tokens, ...).
    """
    if result.exhausted is not None:
        return "limit"
    if result.cancelled:
        return "cancelled"
    if result.stop_reason == "error":
        return "error"
    if result.stop_reason == "cancelled":
        return "refused" if result.refused else "cancelled"
    return "completed"


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


def deep_copy(value: Any) -> Any:
    return copy.deepcopy(value)
