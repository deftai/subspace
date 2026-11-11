"""Handler options for a turn: callbacks instead of (or as well as) iterating.

    result = await session.prompt(
        "Fix the failing test",
        on_message=lambda delta, info, _e: print(info.separator + delta, end=""),
        on_tool_call=lambda call, info, _e: render(call),
        on_permission=lambda request, _signal: "allow" if request.tool_call and request.tool_call.kind == "read" else "reject",
    )

- Handlers run in event order, one at a time; an async handler is awaited
  before the next event.
- The turn's result is ready after every handler has run. If a handler
  raises, the turn is cancelled and awaiting it raises that error.
- `on_permission` and `on_question` answer this turn's questions, in place of
  the client's `permissions` and `elicitation` options. The others observe.
- Set defaults for every turn on the client (`handlers=` or flat keyword
  arguments); a prompt's own handlers replace them one by one.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from dataclasses import dataclass, fields, replace
from typing import Any, cast

from .lazy import LazyField
from .model import (
    ExhaustedEvent,
    MessageEndEvent,
    MessageEvent,
    PermissionEvent,
    PlanEvent,
    StateEvent,
    TerminalEvent,
    ThoughtEndEvent,
    ThoughtEvent,
    ToolCallEvent,
    TurnEvent,
    UsageEvent,
    TextAt,
    UserMessageEndEvent,
    UserMessageEvent,
    text_source,
)


@dataclass(frozen=True)
class TextInfo:
    """About one chunk of text, for `on_message`, `on_thought` and `on_user_message`."""

    #: The whole message so far.
    text: str
    message_id: str
    #: This is the message's first chunk.
    first: bool
    #: Which message of its kind in the turn this is, from 0.
    index: int
    #: What to write before this chunk so the stream reads like `result.text`: a blank line
    #: before a later message (unless the last one ended a line), else ''.
    separator: str


# Read from the message when looked at, as on the event.
setattr(TextInfo, "text", LazyField("text", ""))


@dataclass(frozen=True)
class TextEndInfo:
    """About a message that ended, for `on_message_end`, `on_thought_end` and `on_user_message_end`."""

    message_id: str
    index: int
    #: False when the turn ended early (cancelled, failed, not `end_turn`) while it was open.
    complete: bool


@dataclass(frozen=True)
class ToolCallInfo:
    created: bool


Handler = Callable[..., Any]


@dataclass(frozen=True)
class TurnHandlers:
    """Each handler may be a plain function or a coroutine function.

    - `on_message(delta, info, event)`, `on_thought(...)`, `on_user_message(...)`: text chunks.
    - `on_message_end(text, info, event)` (and thought, user message): a message stopped;
      `text` is its final text.
    - `on_tool_call(tool_call, info, event)`: created (`info.created`) or changed; a snapshot.
    - `on_plan(entries, event)`, `on_usage(usage_event)`, `on_terminal(event)`,
      `on_state(state, background, event)`, `on_permission_answered(event)`, `on_limit(event)`.
    - `on_event(event)`: every event, after its own handler.
    - `on_permission`: answer this turn's permission questions (a policy: "allow", "reject", or a handler).
    - `on_question(request, signal)`: answer this turn's questions to the user (elicitation).
    """

    on_message: Handler | None = None
    on_thought: Handler | None = None
    on_user_message: Handler | None = None
    on_message_end: Handler | None = None
    on_thought_end: Handler | None = None
    on_user_message_end: Handler | None = None
    on_tool_call: Handler | None = None
    on_plan: Handler | None = None
    on_usage: Handler | None = None
    on_terminal: Handler | None = None
    on_state: Handler | None = None
    on_permission_answered: Handler | None = None
    on_limit: Handler | None = None
    on_event: Handler | None = None
    on_permission: Any = None
    on_question: Handler | None = None


HANDLER_KEYS = tuple(f.name for f in fields(TurnHandlers))
_ANSWERING = ("on_permission", "on_question")


def merge_handlers(defaults: TurnHandlers | None, options: dict[str, Any]) -> TurnHandlers | None:
    """The handlers in `options`, over `defaults`; None when there are none."""
    changes: dict[str, Any] = {}
    for key in HANDLER_KEYS:
        value = options.get(key)
        # on_permission may also be a fixed answer.
        fixed = key == "on_permission" and value in ("allow", "reject")
        if callable(value) or fixed:
            changes[key] = value
    merged = replace(defaults, **changes) if defaults else TurnHandlers(**changes)
    return merged if any(getattr(merged, key) is not None for key in HANDLER_KEYS) else None


def observes(handlers: TurnHandlers | None) -> bool:
    """Whether any handler observes events (on_permission and on_question answer, they do not observe)."""
    return handlers is not None and any(getattr(handlers, key) is not None for key in HANDLER_KEYS if key not in _ANSWERING)


class TextTracker:
    """Per turn: which messages of each kind were seen, and how the last one ended."""

    def __init__(self) -> None:
        self._kinds: dict[str, tuple[dict[str, int], list[str]]] = {}

    def info(self, kind: str, message_id: str, text: Any, delta: str | None = None) -> TextInfo:
        """`text` is the message so far: a str, or an event's stored text (read only if looked at)."""
        ids, last = self._kinds.setdefault(kind, ({}, [""]))
        index = ids.get(message_id)
        first = index is None
        if index is None:
            index = len(ids)
            ids[message_id] = index
        # Same rule as result.text: messages are joined by a blank line unless the earlier ends a line.
        separator = "\n\n" if first and index > 0 and last[0] != "\n" else ""
        # The text ends with the delta: reading the delta does not join the whole text.
        if delta:
            last[0] = delta[-1]
        else:
            whole = text.read() if isinstance(text, TextAt) else text
            if whole:
                last[0] = whole[-1]
        return TextInfo(text=cast(str, text), message_id=message_id, first=first, index=index, separator=separator)

    def end(self, kind: str, message_id: str, complete: bool) -> TextEndInfo:
        ids = self._kinds.get(kind, ({}, [""]))[0]
        return TextEndInfo(message_id=message_id, index=ids.get(message_id, 0), complete=complete)


async def _call(handler: Handler | None, *args: Any) -> None:
    if handler is None:
        return
    result = handler(*args)
    if inspect.isawaitable(result):
        await result


async def dispatch(event: TurnEvent, h: TurnHandlers, text: TextTracker | None = None) -> None:
    """Call the handler for one event, then `on_event`."""
    tracker = text or TextTracker()
    # Text is always tracked, so the end handlers know each message's index.
    if isinstance(event, MessageEvent):
        await _call(h.on_message, event.delta, tracker.info("message", event.message_id, text_source(event), event.delta), event)
    elif isinstance(event, ThoughtEvent):
        await _call(h.on_thought, event.delta, tracker.info("thought", event.message_id, text_source(event), event.delta), event)
    elif isinstance(event, UserMessageEvent):
        await _call(h.on_user_message, event.delta, tracker.info("user_message", event.message_id, text_source(event), event.delta), event)
    elif isinstance(event, MessageEndEvent):
        await _call(h.on_message_end, event.text, tracker.end("message", event.message_id, event.complete), event)
    elif isinstance(event, ThoughtEndEvent):
        await _call(h.on_thought_end, event.text, tracker.end("thought", event.message_id, event.complete), event)
    elif isinstance(event, UserMessageEndEvent):
        await _call(h.on_user_message_end, event.text, tracker.end("user_message", event.message_id, event.complete), event)
    elif isinstance(event, ToolCallEvent):
        await _call(h.on_tool_call, event.tool_call, ToolCallInfo(event.created), event)
    elif isinstance(event, PlanEvent):
        await _call(h.on_plan, event.entries, event)
    elif isinstance(event, UsageEvent):
        await _call(h.on_usage, event)
    elif isinstance(event, TerminalEvent):
        await _call(h.on_terminal, event)
    elif isinstance(event, StateEvent):
        await _call(h.on_state, event.state, event.background, event)
    elif isinstance(event, PermissionEvent):
        await _call(h.on_permission_answered, event)
    elif isinstance(event, ExhaustedEvent):
        await _call(h.on_limit, event)
    await _call(h.on_event, event)
