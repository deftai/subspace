"""Tool-call argument robustness: how often an agent's model sends tool arguments that are
wrong, and how often the agent repairs them.

Some agents validate each tool call's arguments and repair safe near-misses (an optional
field sent as `null`, a JSON array sent as a string, a path wrapped in a markdown link). An
agent that does can report the outcome on the tool call's `rawOutput.toolInput`:

    {"status": "repaired", "tool": "read_file", "backend": "openai", "model": "gpt-oss-20b",
     "repairs": [{"path": "path", "kind": "unwrap_markdown_link"}]}

`status` is `valid`, `repaired` or `invalid`; an invalid outcome lists `issues` (`path`,
`kind`, ...). Values are never included, only shapes and paths. Agents that report nothing
are not failing: their calls are just not checked.

A high repair rate is a compatibility signal (the model needs help), not a failure. Only
unrepaired invalid calls are gated by default.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

ToolInputStatus = Literal["valid", "repaired", "invalid"]
_STATUSES = ("valid", "repaired", "invalid")


@dataclass
class ToolInputCounts:
    #: Tool calls whose argument outcome the agent reported.
    checked: int = 0
    valid: int = 0
    repaired: int = 0
    invalid: int = 0

    def _add(self, status: ToolInputStatus) -> None:
        self.checked += 1
        setattr(self, status, getattr(self, status) + 1)

    def _add_counts(self, other: ToolInputCounts) -> None:
        self.checked += other.checked
        self.valid += other.valid
        self.repaired += other.repaired
        self.invalid += other.invalid

    def to_json(self) -> dict[str, Any]:
        return {"checked": self.checked, "valid": self.valid, "repaired": self.repaired, "invalid": self.invalid}


@dataclass
class ToolInputSummary(ToolInputCounts):
    #: All tool calls seen, reported or not.
    tool_calls: int = 0
    #: `repaired / checked`, or None when nothing was checked.
    repair_rate: float | None = None
    #: `invalid / checked`, or None when nothing was checked.
    invalid_rate: float | None = None
    #: Repairs applied, by kind (e.g. `omit_optional_null`).
    repair_kinds: dict[str, int] = field(default_factory=dict)
    #: Unrepaired issues, by `tool:path`.
    invalid_arguments: dict[str, int] = field(default_factory=dict)
    by_backend: dict[str, ToolInputCounts] = field(default_factory=dict)
    by_model: dict[str, ToolInputCounts] = field(default_factory=dict)
    by_tool: dict[str, ToolInputCounts] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        """The TypeScript `ToolInputSummary` shape (camelCase)."""
        return {
            "toolCalls": self.tool_calls,
            **super().to_json(),
            "repairRate": self.repair_rate,
            "invalidRate": self.invalid_rate,
            "repairKinds": dict(self.repair_kinds),
            "invalidArguments": dict(self.invalid_arguments),
            "byBackend": {k: v.to_json() for k, v in self.by_backend.items()},
            "byModel": {k: v.to_json() for k, v in self.by_model.items()},
            "byTool": {k: v.to_json() for k, v in self.by_tool.items()},
        }

    def _rates(self) -> None:
        if self.checked:
            self.repair_rate = self.repaired / self.checked
            self.invalid_rate = self.invalid / self.checked


@dataclass(frozen=True)
class ToolInputOutcome:
    status: ToolInputStatus
    tool: str
    repair_kinds: list[str] = field(default_factory=list)
    issue_paths: list[str] = field(default_factory=list)
    backend: str | None = None
    model: str | None = None


def _text(value: dict[str, Any] | None, key: str) -> str | None:
    found = value.get(key) if value is not None else None
    return found if isinstance(found, str) and found else None


def _record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def tool_input_of(call: Any) -> ToolInputOutcome | None:
    """The outcome a tool call (anything with `title` and `raw_output`) reports in
    `rawOutput.toolInput`, if any."""
    raw = _record(getattr(call, "raw_output", None))
    data = _record(raw.get("toolInput")) if raw is not None else None
    status = data.get("status") if data is not None else None
    if data is None or not isinstance(status, str) or status not in _STATUSES:
        return None

    def items(key: str, name: str) -> list[str]:
        values = data.get(key)
        found = (_text(_record(item), name) for item in (values if isinstance(values, list) else []))
        return [item for item in found if item is not None]

    return ToolInputOutcome(
        status=cast(ToolInputStatus, status),
        tool=_text(data, "tool") or (getattr(call, "title", "") or "unknown"),
        repair_kinds=items("repairs", "kind"),
        issue_paths=items("issues", "path"),
        backend=_text(data, "backend"),
        model=_text(data, "model"),
    )


def summarize_tool_input(calls: Iterable[Any]) -> ToolInputSummary:
    """Count the outcomes of tool calls (anything with `id`, `title` and `raw_output`; each call
    once, by id: its latest state)."""
    latest: dict[str, Any] = {}
    anonymous = 0
    for call in calls:
        key = getattr(call, "id", "") or ""
        if not key:
            key = f"#{anonymous}"
            anonymous += 1
        latest[key] = call
    summary = ToolInputSummary(tool_calls=len(latest))
    for call in latest.values():
        outcome = tool_input_of(call)
        if outcome is None:
            continue
        summary._add(outcome.status)
        summary.by_tool.setdefault(outcome.tool, ToolInputCounts())._add(outcome.status)
        if outcome.backend:
            summary.by_backend.setdefault(outcome.backend, ToolInputCounts())._add(outcome.status)
        if outcome.model:
            summary.by_model.setdefault(outcome.model, ToolInputCounts())._add(outcome.status)
        for kind in outcome.repair_kinds:
            summary.repair_kinds[kind] = summary.repair_kinds.get(kind, 0) + 1
        if outcome.status == "invalid":
            for path in outcome.issue_paths or ["(arguments)"]:
                where = f"{outcome.tool}:{path}"
                summary.invalid_arguments[where] = summary.invalid_arguments.get(where, 0) + 1
    summary._rates()
    return summary


def merge_tool_input(summaries: Iterable[ToolInputSummary]) -> ToolInputSummary:
    """Add summaries (e.g. a run's turns) together; rates are recomputed."""
    out = ToolInputSummary()
    for s in summaries:
        out.tool_calls += s.tool_calls
        out._add_counts(s)
        for into, source in ((out.repair_kinds, s.repair_kinds), (out.invalid_arguments, s.invalid_arguments)):
            for key, n in source.items():
                into[key] = into.get(key, 0) + n
        for into_map, from_map in ((out.by_backend, s.by_backend), (out.by_model, s.by_model), (out.by_tool, s.by_tool)):
            for key, counts in from_map.items():
                into_map.setdefault(key, ToolInputCounts())._add_counts(counts)
    out._rates()
    return out


def _rate(value: Any, name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or value > 1:
        raise ValueError(f"tool_input {name} must be a number from 0 to 1, got {value!r}")
    return float(value)


def _percent(n: float) -> str:
    value = math.floor(n * 1000 + 0.5) / 10
    return f"{int(value) if value.is_integer() else value}%"


def check_tool_input(
    summary: ToolInputSummary,
    *,
    max_invalid_rate: float | None = None,
    max_repair_rate: float | None = None,
    min_checked: int | None = None,
) -> list[str]:
    """What is wrong with a summary, given the limits; empty when it passes.

    - `max_invalid_rate`: highest allowed `invalid / checked`. Default 0: every invalid call must be repaired.
    - `max_repair_rate`: highest allowed `repaired / checked`. Default: not gated.
    - `min_checked`: fewest checked calls required; fewer is a failure. Unset: an agent that
      reports no outcomes passes (it is not checked, not failing).

    Mistyped limits (a rate as a string, outside 0..1, `min_checked` below 1) raise ValueError
    rather than silently turning the check off.
    """
    invalid_limit = _rate(max_invalid_rate, "max_invalid_rate")
    invalid_limit = 0.0 if invalid_limit is None else invalid_limit
    repair_limit = _rate(max_repair_rate, "max_repair_rate")
    if min_checked is not None and (isinstance(min_checked, bool) or not isinstance(min_checked, int) or min_checked < 1):
        raise ValueError(f"tool_input min_checked must be a whole number of at least 1, got {min_checked!r}")
    if not summary.checked and min_checked is None:
        return []
    if min_checked is not None and summary.checked < min_checked:
        if summary.tool_calls and not summary.checked:
            return [f"{summary.tool_calls} tool calls, none reported a tool-input outcome (rawOutput.toolInput)"]
        return [f"{summary.checked} tool calls with a tool-input outcome, expected at least {min_checked}"]
    failures: list[str] = []

    def worst(name: Literal["invalid", "repaired"]) -> list[str]:
        rows = [(backend, c) for backend, c in summary.by_backend.items() if getattr(c, name) > 0]
        rows.sort(key=lambda row: -(getattr(row[1], name) / row[1].checked))
        return [f"{backend} {_percent(getattr(c, name) / c.checked)}" for backend, c in rows[:3]]

    if (summary.invalid_rate or 0) > invalid_limit:
        where = ", ".join(list(summary.invalid_arguments)[:5])
        backends = worst("invalid")
        failures.append(
            f"tool-input invalid rate {_percent(summary.invalid_rate or 0)} ({summary.invalid}/{summary.checked}), "
            f"expected at most {_percent(invalid_limit)}"
            + (f"; unrepaired: {where}" if where else "")
            + (f"; worst: {', '.join(backends)}" if backends else "")
        )
    if repair_limit is not None and (summary.repair_rate or 0) > repair_limit:
        backends = worst("repaired")
        failures.append(
            f"tool-input repair rate {_percent(summary.repair_rate or 0)} ({summary.repaired}/{summary.checked}), "
            f"expected at most {_percent(repair_limit)}" + (f"; worst: {', '.join(backends)}" if backends else "")
        )
    return failures
