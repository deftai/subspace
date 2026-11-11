"""The agent side of v2 background work (the "Background work" RFD): which
tool calls and terminals a session runs in the background, which the client
may cancel, and the `background` list on state snapshots.

- A cancellable item advertises `capabilities: {"cancel": {}}` and gets its
  own AbortSignal, fired by the client's `tool_call/cancel` or
  `terminal/cancel`, by `session/close`, and (until it is detached) by the
  turn's cancel.
- `detach()` moves an item to the background: it outlives the turn,
  `session/cancel` no longer stops it, and from then on every state update
  for the session carries the `background` list. Finishing it (a final
  status, or an exit) removes it, after its final update.
"""

from __future__ import annotations

import base64 as _b64
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from deft_subspace.kernel import AbortController, AbortSignal, RpcError

WorkKind = Literal["tool_call", "terminal"]
WorkState = Literal["running", "requires_action", "idle"]


@dataclass(eq=False)
class Work:
    kind: WorkKind
    id: str
    cancellable: bool
    controller: AbortController = field(default_factory=AbortController)
    listed: bool = False
    final: bool = False


class SessionWork:
    def __init__(self, send: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        #: True once anything was detached: every state update must then carry the list.
        self.reports = False
        self.state: WorkState = "idle"
        self._items: dict[str, Work] = {}
        #: Removes an item's listener on its turn's signal.
        self._unfollow: dict[Work, Callable[[], None]] = {}
        self._send = send

    def add(self, kind: WorkKind, id: str, cancellable: bool, turn_signal: AbortSignal | None = None) -> Work:
        work = Work(kind, id, cancellable)
        self._items[f"{kind}:{id}"] = work
        # Foreground work stops with its turn; detached work does not.
        if turn_signal is not None:
            signal = turn_signal

            def on_abort(_reason: Any) -> None:
                if not work.listed and not work.final:
                    work.controller.abort(signal.reason)

            self._unfollow[work] = signal.add_listener(on_abort)
        return work

    def get(self, kind: WorkKind, id: str) -> Work | None:
        return self._items.get(f"{kind}:{id}")

    def fields(self) -> dict[str, Any]:
        """The `background` field for a state update: present once the session reports background work."""
        return {"background": self.list()} if self.reports else {}

    def list(self) -> list[dict[str, Any]]:
        return [
            {"type": "terminal", "terminalId": w.id} if w.kind == "terminal" else {"type": "tool_call", "toolCallId": w.id}
            for w in self._items.values()
            if w.listed and not w.final
        ]

    async def detach(self, work: Work) -> None:
        """Move an item to the background and send a snapshot that lists it (announce it first)."""
        if work.final or work.listed:
            return
        work.listed = True
        self.reports = True
        await self.snapshot()

    async def finish(self, work: Work) -> None:
        """The item reached a final status (sent already): drop it from the list with a new snapshot."""
        if work.final:
            return
        work.final = True
        self._items.pop(f"{work.kind}:{work.id}", None)
        unfollow = self._unfollow.pop(work, None)
        if unfollow is not None:
            unfollow()
        if work.listed:
            await self.snapshot()

    def cancel(self, kind: WorkKind, id: str) -> None:
        """The client's tool_call/cancel or terminal/cancel. -32602 for unknown, finished or uncancellable items."""
        work = self.get(kind, id)
        if work is None or work.final:
            raise RpcError.invalid_params(f"No running {'terminal' if kind == 'terminal' else 'tool call'} {id}")
        if not work.cancellable:
            raise RpcError.invalid_params(f"{'Terminal' if kind == 'terminal' else 'Tool call'} {id} cannot be cancelled")
        work.controller.abort(Exception("cancelled by the client"))

    def close_all(self, reason: BaseException | None = None) -> None:
        """session/close, or the connection gone: stop everything."""
        reason = reason if reason is not None else Exception("session closed")
        for work in list(self._items.values()):
            work.controller.abort(reason)

    def snapshot(self) -> Awaitable[None]:
        return self._send({"sessionUpdate": "state_update", "state": self.state, **self.fields()})


def base64(data: str | bytes) -> str:
    """Bytes or text (as UTF-8) as RFC 4648 base64."""
    raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    return _b64.b64encode(raw).decode("ascii")
