"""Terminal helpers: a renderer for turns, and a permission prompt.

    agent = await start("claude", handlers=terminal(), on_permission=first_of(read_only, ask_in_terminal()))
    client = await AcpClient.connect(channel, **terminal(), permissions="reject")

`terminal()` returns handlers: streamed text, thoughts dimmed, a line per
tool call with its final status, answered permission questions, plans and
limits. Colours only when the output is a terminal (and NO_COLOR is unset).
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, fields
from typing import Any, Literal, Protocol

from deft_subspace.kernel import AbortSignal

from .handlers import TurnHandlers
from .model import PermissionRequest
from .permissions import PermissionHandler


class Output(Protocol):
    def write(self, text: str, /) -> Any: ...


@dataclass(frozen=True)
class RenderHandlers(TurnHandlers):
    """`TurnHandlers` that also spread as keyword arguments (`**terminal()`)."""

    def keys(self) -> list[str]:
        return [f.name for f in fields(self) if getattr(self, f.name) is not None]

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)

    def __iter__(self) -> Iterator[str]:  # type: ignore[override]
        return iter(self.keys())


def _style(on: bool) -> dict[str, Callable[[str], str]]:
    def wrap(opening: str, closing: str) -> Callable[[str], str]:
        return lambda text: f"\x1b[{opening}m{text}\x1b[{closing}m" if on else text

    return {
        "dim": wrap("2", "22"),
        "bold": wrap("1", "22"),
        "green": wrap("32", "39"),
        "red": wrap("31", "39"),
        "yellow": wrap("33", "39"),
        "cyan": wrap("36", "39"),
    }


_FINAL = {"completed", "failed", "cancelled"}


def _is_tty(stream: Any) -> bool:
    isatty = getattr(stream, "isatty", None)
    try:
        return bool(isatty()) if callable(isatty) else bool(getattr(stream, "isTTY", False))
    except (OSError, ValueError):
        return False


def _number(value: float) -> str:
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def terminal(
    *,
    out: Output | None = None,
    color: bool | None = None,
    thoughts: bool = True,
    tools: bool = True,
    plans: bool = True,
) -> RenderHandlers:
    """Handlers that render a turn to a terminal. Pass them as `handlers=` or spread them
    (`**terminal()`) into `start()`, `AcpClient.connect()` or a prompt.

    - `out`: where to write. Default `sys.stdout`.
    - `color`: colours. Default: when `out` is a terminal and NO_COLOR is not set.
    - `thoughts`, `tools`, `plans`: show the agent's thoughts, tool calls, plans. Default True.
    """
    stream: Any = out if out is not None else sys.stdout
    use_color = color if color is not None else (_is_tty(stream) and not os.environ.get("NO_COLOR"))
    s = _style(use_color)
    state: dict[str, Any] = {"line_start": True, "blank": False, "last": None}
    finished: set[str] = set()

    def write(text: str, plain: str | None = None) -> None:
        """Write `text`; `plain` is the same without styling, which says how the output now ends."""
        if not text:
            return
        plain = text if plain is None else plain
        stream.write(text)
        flush = getattr(stream, "flush", None)
        if callable(flush):
            flush()
        state["blank"] = plain.endswith("\n\n") or (state["line_start"] and plain == "\n")
        state["line_start"] = plain.endswith("\n")

    def separate() -> None:
        """Separate a new block from the text before it by one blank line."""
        write("" if state["blank"] else "\n" if state["line_start"] else "\n\n")

    def line(text: str) -> None:
        """Start a new line for a block, separated from text before it."""
        if not state["line_start"]:
            write("\n")
        if state["last"] in ("message", "thought"):
            write("\n")
        write(f"{text}\n")
        state["last"] = "line"

    def on_message(delta: str, info: Any, _event: Any = None) -> None:
        if info.first and state["last"] and state["last"] != "message":
            separate()
        else:
            write(info.separator)
        write(delta)
        state["last"] = "message"

    def on_thought(delta: str, info: Any, _event: Any = None) -> None:
        if info.first and state["last"] and state["last"] != "thought":
            separate()
        # Without color a thought would read as the answer: label it.
        if info.first and not use_color:
            write("thinking: ")
        write(s["dim"](delta), delta)
        state["last"] = "thought"

    def on_tool_call(call: Any, info: Any, _event: Any = None) -> None:
        label = call.title or call.kind or "tool"
        if info.created:
            line(s["cyan"](f"• {label}"))
        if call.status in _FINAL and call.id not in finished:
            finished.add(call.id)
            mark = s["green"]("✓") if call.status == "completed" else s["red"]("⊘" if call.status == "cancelled" else "✗")
            line(f"  {mark} {s['dim'](label)}")

    def on_permission_answered(event: Any) -> None:
        allowed = event.outcome.outcome == "selected" and event.outcome.allowed
        verdict = s["green"]("allowed") if allowed else s["red"]("cancelled" if event.outcome.outcome == "cancelled" else "refused")
        line(s["yellow"](f"? {event.request.title}") + f" {verdict}")

    def on_plan(entries: list[Any], _event: Any = None) -> None:
        marks = {"completed": "[x]", "in_progress": "[~]"}
        body = "\n".join(f"  {marks.get(str(e.get('status')), '[ ]')} {e.get('content')}" for e in entries)
        line(s["bold"]("Plan") + "\n" + body)

    def on_limit(event: Any) -> None:
        line(s["red"](f"! stopped: {event.limit} limit ({_number(event.max)})"))

    return RenderHandlers(
        on_message=on_message,
        on_thought=on_thought if thoughts else None,
        on_tool_call=on_tool_call if tools else None,
        on_permission_answered=on_permission_answered,
        on_plan=on_plan if plans else None,
        on_limit=on_limit,
    )


Answer = Literal["allow", "reject", "allow_always", "cancelled"]


def ask_in_terminal(*, input: Any = None, output: Any = None) -> PermissionHandler:
    """Ask in the terminal: [y]es, [n]o, or [a]lways (for this kind of tool, for
    this handler's lifetime). With no terminal to ask on, it rejects, and says
    so on stderr once.

    - `input`: where to read answers (`readline()`). Default `sys.stdin`; it must be a terminal.
    - `output`: where to write the question. Default `sys.stderr`.
    """
    always: set[str] = set()
    warned = [False]
    lock: list[asyncio.Lock] = []
    #: A line being read that nobody took yet (its question was cancelled): the next question gets it.
    pending: list[asyncio.Future[str]] = []

    def read_line(source: Any) -> asyncio.Future[str]:
        if pending and not pending[0].done():
            return pending[0]
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()

        def settle(value: str | None, error: BaseException | None) -> None:
            if future.done():
                return
            if error is not None:
                future.set_exception(error)
            else:
                future.set_result(value or "")

        def read() -> None:
            # A daemon thread: a read nobody waits for any more does not keep the program alive.
            try:
                text = source.readline()
                loop.call_soon_threadsafe(settle, text if isinstance(text, str) else text.decode("utf-8", "replace"), None)
            except BaseException as error:
                try:
                    loop.call_soon_threadsafe(settle, None, error)
                except RuntimeError:
                    pass  # the loop is gone

        threading.Thread(target=read, name="ask_in_terminal", daemon=True).start()
        pending[:] = [future]
        return future

    async def ask(request: PermissionRequest, signal: AbortSignal) -> Answer:
        source = input if input is not None else sys.stdin
        sink = output if output is not None else sys.stderr
        kind = (request.tool_call.kind if request.tool_call else None) or "other"
        if kind in always:
            return "allow"
        if not _is_tty(source):
            if not warned[0]:
                sys.stderr.write(f'Refused "{request.title}": ask_in_terminal() has no terminal to ask on.\n')
            warned[0] = True
            return "reject"
        if not lock:
            lock.append(asyncio.Lock())
        # One question at a time.
        async with lock[0]:
            if signal.aborted:
                return "cancelled"
            sink.write(f"? Allow {request.title}? [y]es / [n]o / [a]lways for {kind} tools: ")
            flush = getattr(sink, "flush", None)
            if callable(flush):
                flush()
            line = read_line(source)
            aborted = asyncio.ensure_future(signal.wait())
            try:
                await asyncio.wait({line, aborted}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                aborted.cancel()
            if not line.done():
                return "cancelled"
            pending.clear()
            answer = line.result().strip().lower()
            if answer in ("a", "always"):
                always.add(kind)
                return "allow_always"
            return "allow" if answer in ("y", "yes") else "reject"

    return ask
