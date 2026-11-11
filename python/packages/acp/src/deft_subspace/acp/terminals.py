"""Terminals the agent runs and shows (v2 `terminal_update`, `terminal_output_chunk`).

Display only: the client cannot control them. A tool call refers to one with
content `{"type": "terminal", "terminalId": ...}`; look it up with
`session.terminals.get(terminal_id)`. Updates and the tool call may arrive in
either order, and a terminal can outlive its turn, so the session keeps them.

    async for event in turn:
        if event.type == "terminal":
            render(event.terminal.id, event.appended or event.terminal.output)

Output is bytes (it may split a UTF-8 character or an escape sequence);
`terminal_text()` decodes it for a plain transcript.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, replace
from typing import Any


@dataclass(frozen=True)
class TerminalExit:
    exit_code: int | None = None
    signal: str | None = None


@dataclass(frozen=True)
class TerminalSize:
    cols: int
    rows: int


@dataclass
class TerminalState:
    id: str
    #: Every byte the agent wants shown, so far.
    output: bytes = b""
    command: str | None = None
    #: Absolute.
    cwd: str | None = None
    #: The size the command runs with, in character cells.
    size: TerminalSize | None = None
    #: Present once the command has exited.
    exit_status: TerminalExit | None = None
    #: The agent lets the client stop it (`session.cancel_terminal()`).
    cancellable: bool = False

    def snapshot(self) -> TerminalState:
        return replace(self)


def _bytes(data: Any) -> bytes:
    """RFC 4648 base64 to bytes. Undecodable data gives no bytes."""
    if not isinstance(data, str):
        return b""
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return b""


def terminal_text(terminal: TerminalState) -> str:
    """The output as text, for a transcript (invalid UTF-8 becomes U+FFFD; escape sequences are kept)."""
    return terminal.output.decode("utf-8", errors="replace")


@dataclass(frozen=True)
class AppliedTerminal:
    terminal: TerminalState
    replaced: bool
    appended: bytes | None = None


class Terminals:
    def __init__(self, max_bytes: int = 1_000_000) -> None:
        self._by_id: dict[str, TerminalState] = {}
        #: Bytes kept per terminal; older output is dropped from the front past this.
        self._max = max_bytes

    def get(self, terminal_id: str) -> TerminalState | None:
        return self._by_id.get(terminal_id)

    @property
    def all(self) -> list[TerminalState]:
        return list(self._by_id.values())

    def __len__(self) -> int:
        return len(self._by_id)

    def __iter__(self):
        return iter(list(self._by_id.values()))

    def apply(self, update: dict[str, Any]) -> AppliedTerminal | None:
        """Apply a `terminal_update` or `terminal_output_chunk`.

        Returns the terminal after it and, for a chunk, the bytes appended; None if the
        update had no `terminalId`.
        """
        terminal_id = update.get("terminalId")
        if not isinstance(terminal_id, str) or not terminal_id:
            return None
        terminal = self._by_id.get(terminal_id)
        if terminal is None:
            terminal = TerminalState(id=terminal_id)
            self._by_id[terminal_id] = terminal
        if update.get("sessionUpdate") == "terminal_output_chunk":
            appended = _bytes(update.get("data"))
            terminal.output = self._cap(terminal.output + appended)
            return AppliedTerminal(terminal, False, appended)
        # terminal_update: an omitted field is unchanged, null clears it, a value replaces it.
        if "command" in update:
            terminal.command = update["command"] if isinstance(update["command"], str) else None
        if "cwd" in update:
            terminal.cwd = update["cwd"] if isinstance(update["cwd"], str) else None
        if "size" in update:
            size = update["size"]
            ok = isinstance(size, dict) and isinstance(size.get("cols"), int) and isinstance(size.get("rows"), int)
            terminal.size = TerminalSize(size["cols"], size["rows"]) if ok else None
        replaced = False
        if "output" in update:
            # A snapshot replaces everything kept so far.
            output = update["output"]
            terminal.output = self._cap(_bytes(output.get("data")) if isinstance(output, dict) else b"")
            replaced = True
        if "exitStatus" in update:
            status = update["exitStatus"]
            terminal.exit_status = (
                TerminalExit(
                    exit_code=status["exitCode"] if isinstance(status.get("exitCode"), int) and not isinstance(status.get("exitCode"), bool) else None,
                    signal=status["signal"] if isinstance(status.get("signal"), str) else None,
                )
                if isinstance(status, dict)
                else None
            )
        # capabilities: null clears, an object replaces.
        if "capabilities" in update:
            caps = update["capabilities"]
            terminal.cancellable = isinstance(caps, dict) and caps.get("cancel") is not None
        return AppliedTerminal(terminal, replaced)

    def _cap(self, output: bytes) -> bytes:
        return output[len(output) - self._max :] if len(output) > self._max else output
