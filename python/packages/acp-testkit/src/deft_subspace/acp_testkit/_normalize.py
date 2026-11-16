"""A TurnResult without what changes from run to run, for comparing runs and replays."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from deft_subspace.acp import TurnResult


@dataclass(frozen=True)
class NormalizedToolCall:
    title: str
    status: str
    #: How many content items it has.
    content: int
    kind: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"title": self.title}
        if self.kind is not None:
            out["kind"] = self.kind
        out["status"] = self.status
        out["content"] = self.content
        return out


@dataclass(frozen=True)
class NormalizedTurn:
    """A TurnResult without ids and raw payloads. `to_json()` is the TypeScript `NormalizedTurn`
    (camelCase, `refused` left out when 0), as kept in corpus traces' `meta.expected`."""

    stop_reason: str
    cancelled: bool
    forced: bool
    text: str
    tool_calls: list[NormalizedToolCall] = field(default_factory=list)
    #: Permission requests refused.
    refused: int = 0

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "stopReason": self.stop_reason,
            "cancelled": self.cancelled,
            "forced": self.forced,
            "text": self.text,
            "toolCalls": [c.to_json() for c in self.tool_calls],
        }
        if self.refused:
            out["refused"] = self.refused
        return out

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> NormalizedTurn:
        return cls(
            stop_reason=str(value.get("stopReason", "")),
            cancelled=bool(value.get("cancelled", False)),
            forced=bool(value.get("forced", False)),
            text=str(value.get("text", "")),
            tool_calls=[
                NormalizedToolCall(
                    title=str(c.get("title", "")),
                    status=str(c.get("status", "")),
                    content=int(c.get("content", 0)),
                    kind=c.get("kind"),
                )
                for c in value.get("toolCalls", [])
            ],
            refused=int(value.get("refused", 0)),
        )


def normalize_turn(result: TurnResult) -> NormalizedTurn:
    return NormalizedTurn(
        stop_reason=str(result.stop_reason),
        cancelled=result.cancelled,
        forced=bool(result.forced),
        text=result.text,
        tool_calls=[
            NormalizedToolCall(title=c.title, status=str(c.status), content=len(c.content), kind=c.kind)
            for c in result.tool_calls
        ],
        refused=result.refused or 0,
    )
