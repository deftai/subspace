"""Tool-call argument robustness: outcomes from rawOutput.toolInput, counted, rated and checked (tool-input.test.ts)."""

from __future__ import annotations

import itertools
import re
from dataclasses import replace
from typing import Any

import pytest
from deft_subspace.acp import ToolCall, TurnResult
from deft_subspace.acp_testkit import (
    ToolInputCounts,
    ToolInputOutcome,
    check_tool_input,
    check_turn,
    merge_tool_input,
    summarize_tool_input,
    tool_input_of,
)

_ids = itertools.count(1)


def call(tool_input: Any = None, **extra: Any) -> ToolCall:
    fields: dict[str, Any] = {"id": f"t{next(_ids)}", "title": "Read notes.txt", "status": "completed"}
    if tool_input is not None:
        fields["raw_output"] = {"toolInput": tool_input}
    return ToolCall(**{**fields, **extra})


def valid(tool: str = "read_file", backend: str = "openai", model: str = "model-a") -> ToolCall:
    return call({"status": "valid", "tool": tool, "backend": backend, "model": model})


def repaired(kind: str, backend: str = "openai") -> ToolCall:
    return call(
        {
            "status": "repaired",
            "tool": "read_file",
            "backend": backend,
            "model": "model-a",
            "repairs": [{"path": "path", "kind": kind}],
        }
    )


def invalid(path: str, backend: str = "openai") -> ToolCall:
    issues = [{"path": path, "kind": "missing", "expected": "string", "received": "undefined"}]
    return call({"status": "invalid", "tool": "write_file", "backend": backend, "issues": issues})


def test_an_outcome_is_read_from_raw_output_tool_input_anything_else_is_not_reported():
    assert tool_input_of(repaired("unwrap_markdown_link")) == ToolInputOutcome(
        status="repaired",
        tool="read_file",
        backend="openai",
        model="model-a",
        repair_kinds=["unwrap_markdown_link"],
        issue_paths=[],
    )
    assert tool_input_of(call()) is None
    assert tool_input_of(call({"status": "maybe"})) is None
    # No tool name: the call's title.
    outcome = tool_input_of(call({"status": "valid"}))
    assert outcome is not None and outcome.tool == "Read notes.txt"


def test_counts_and_rates_by_backend_model_and_tool_repair_kinds_and_unrepaired_tool_path_each_call_once():
    first = repaired("omit_optional_null")
    calls = [valid(), first, replace(first), repaired("parse_json_array", "gemma"), invalid("content", "gemma"), call()]
    s = summarize_tool_input(calls)
    assert s.tool_calls == 5
    assert [s.checked, s.valid, s.repaired, s.invalid] == [4, 1, 2, 1]
    assert s.repair_rate == 0.5
    assert s.invalid_rate == 0.25
    assert s.repair_kinds == {"omit_optional_null": 1, "parse_json_array": 1}
    assert s.invalid_arguments == {"write_file:content": 1}
    assert s.by_backend["gemma"] == ToolInputCounts(checked=2, valid=0, repaired=1, invalid=1)
    assert s.by_model["model-a"] == ToolInputCounts(checked=3, valid=1, repaired=2, invalid=0)
    assert s.by_tool["write_file"] == ToolInputCounts(checked=1, valid=0, repaired=0, invalid=1)
    none = summarize_tool_input([call(), call()])
    assert [none.tool_calls, none.checked, none.repair_rate, none.invalid_rate] == [2, 0, None, None]


def test_names_from_the_agent_are_plain_keys():
    s = summarize_tool_input([call({"status": "valid", "tool": "__class__", "backend": "__proto__", "model": "constructor"})])
    assert list(s.by_tool) == ["__class__"]
    assert s.by_backend["__proto__"].checked == 1
    assert s.to_json()["byModel"] == {"constructor": {"checked": 1, "valid": 1, "repaired": 0, "invalid": 0}}


def test_summaries_merge_a_run_of_turns():
    merged = merge_tool_input(
        [summarize_tool_input([valid(), invalid("a")]), summarize_tool_input([repaired("k"), repaired("k")])]
    )
    assert [merged.tool_calls, merged.checked, merged.invalid, merged.repaired] == [4, 4, 1, 2]
    assert merged.invalid_rate == 0.25
    assert merged.repair_kinds == {"k": 2}
    assert merged.by_backend["openai"].checked == 4


def test_checks_invalid_calls_fail_by_default_repairs_only_when_gated_nothing_reported_passes_unless_min_checked():
    assert check_tool_input(summarize_tool_input([valid(), repaired("k")])) == []
    [failure] = check_tool_input(summarize_tool_input([valid(), invalid("content", "gemma")]))
    assert re.search(r"invalid rate 50% \(1/2\), expected at most 0%; unrepaired: write_file:content; worst: gemma 100%", failure)
    assert check_tool_input(summarize_tool_input([valid(), invalid("x")]), max_invalid_rate=0.5) == []
    assert re.search(
        r"repair rate 50%", check_tool_input(summarize_tool_input([valid(), repaired("k")]), max_repair_rate=0.25)[0]
    )
    assert check_tool_input(summarize_tool_input([call(), call()])) == []
    assert re.search(r"none reported a tool-input outcome", check_tool_input(summarize_tool_input([call()]), min_checked=1)[0])
    assert re.search(
        r"1 tool calls with a tool-input outcome, expected at least 3",
        check_tool_input(summarize_tool_input([valid()]), min_checked=3)[0],
    )


def test_percentages_round_as_in_typescript():
    s = summarize_tool_input([valid(), valid(), invalid("x")])
    assert "invalid rate 33.3% (1/3)" in check_tool_input(s)[0]


def test_mistyped_limits_raise_instead_of_turning_the_check_off():
    s = summarize_tool_input([valid()])
    with pytest.raises(ValueError, match=r"max_repair_rate must be a number from 0 to 1"):
        check_tool_input(s, max_repair_rate="0.5")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match=r"max_invalid_rate"):
        check_tool_input(s, max_invalid_rate=2)
    with pytest.raises(ValueError, match=r"min_checked"):
        check_tool_input(s, min_checked=0)


async def test_a_scenario_turn_expectation_tool_input():
    result = TurnResult(stop_reason="end_turn", text="", tool_calls=[valid(), invalid("path")], cancelled=False)
    turn: dict[str, Any] = {"result": result, "updates": 2, "permissions": [], "workspace": "/nonexistent"}
    assert re.search(r"invalid rate 50%", "\n".join(await check_turn({"toolInput": {}}, **turn)))
    assert await check_turn({"toolInput": {"maxInvalidRate": 0.5}}, **turn) == []
    assert await check_turn({}, **turn) == []
