"""Scenarios: describe what an agent should do, run it, and check.

    {
      "name": "writes a greeting",
      "agent": "claude",
      "workspace": {"from": "fixtures/empty"},
      "permissions": "allow",
      "turns": [
        {"prompt": "Create hello.txt containing hi",
         "expect": {"end": "completed", "files": {"hello.txt": {"contains": "hi"}}, "toolCalls": {"min": 1}}}
      ]
    }

A scenario is the same JSON in both ports (camelCase keys), so one file runs in
either. Each scenario runs in a fresh temporary workspace (empty, or a copy of
a fixture folder), through `start()`, with the connection recorded. A failing
scenario leaves a failure bundle: the trace, the results, and the workspace's
files; a passing one removes its workspace and trace. Regression snapshots
(`snapshot`) record each turn's outcome once and compare later runs to it. In
CI (`require_snapshots`, on when the CI variable is set) a missing snapshot
fails instead of being written.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

from deft_subspace.acp import (
    AgentCommand,
    PermissionPolicy,
    TurnEnd,
    TurnEvent,
    TurnResult,
    allow,
    first_of,
    load_catalog_async,
    read_only,
    reject,
    start,
    turn_end,
)

from ._tool_input import ToolInputSummary, check_tool_input, merge_tool_input, summarize_tool_input

# ---- the file format (shared with TypeScript) --------------------------------------


class TextExpectation(TypedDict, total=False):
    contains: str | list[str]
    notContains: str | list[str]
    matches: str


class ToolCallsExpectation(TypedDict, total=False):
    min: int
    max: int
    #: Each must be (part of) some tool call's title.
    titles: list[str]
    #: Each kind must appear.
    kinds: list[str]
    #: Every tool call ended completed.
    allCompleted: bool


class CountExpectation(TypedDict, total=False):
    min: int
    max: int
    titles: list[str]


class FileExpectation(TypedDict, total=False):
    exists: bool
    contains: str
    equals: str
    matches: str
    sameAs: str


class ToolInputExpectation(TypedDict, total=False):
    maxInvalidRate: float
    maxRepairRate: float
    minChecked: int


class Expectations(TypedDict, total=False):
    """What a turn should do. Keys as in the scenario file."""

    #: How the turn ended (`turn_end`): completed, refused, cancelled, limit, error.
    end: TurnEnd | list[TurnEnd]
    #: The raw stop reason.
    stopReason: str | list[str]
    text: TextExpectation
    toolCalls: ToolCallsExpectation
    permissions: CountExpectation
    #: Paths relative to the workspace, checked after the turn.
    files: dict[str, FileExpectation]
    #: Session updates in the turn.
    updates: CountExpectation
    #: Tool-call argument robustness, from the outcomes the agent reports in
    #: `rawOutput.toolInput`. Unrepaired invalid calls fail by default (`maxInvalidRate` 0).
    toolInput: ToolInputExpectation


class _ScenarioTurnRequired(TypedDict):
    prompt: str


class ScenarioTurn(_ScenarioTurnRequired, total=False):
    expect: Expectations
    timeoutMs: float


class AgentCommandSpec(TypedDict, total=False):
    command: str
    args: list[str]
    env: dict[str, str]
    mode: str


ScenarioPermissions = Any
"""A permission answer in a file: "allow", "reject", "read-only", or
`{"allow": [kinds], "reject": [kinds]}` (the rest rejected)."""


class _ScenarioRequired(TypedDict):
    name: str
    #: A known agent's name, or a command (args, env, an optional mode). The agent runs in the
    #: workspace; arguments starting with ./ or ../ are paths relative to the scenario file.
    agent: str | AgentCommandSpec
    #: At least one: a scenario with none fails.
    turns: list[ScenarioTurn]


class Scenario(_ScenarioRequired, total=False):
    """A scenario, as in a scenario file."""

    #: Session mode; False keeps the agent's own. Default: the preset's ask-first mode.
    mode: str | Literal[False]
    #: `{"from": folder}`: a folder to copy into the workspace (relative to the scenario file).
    workspace: dict[str, str]
    permissions: ScenarioPermissions
    #: Per turn, unless the turn sets its own. Default 120 s.
    timeoutMs: float
    #: A snapshot file (relative to the scenario file) to compare each turn's outcome with.
    snapshot: str


def define_scenario(scenario: Scenario) -> Scenario:
    """A scenario in Python (an identity function that keeps the types)."""
    return scenario


# ---- reports --------------------------------------------------------------------------


@dataclass(frozen=True)
class OutcomeToolCall:
    title: str
    status: str
    kind: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"title": self.title}
        if self.kind:
            out["kind"] = self.kind
        out["status"] = self.status
        return out


@dataclass(frozen=True)
class TurnOutcome:
    """What a regression snapshot keeps of a turn: what should not change from run to run.
    `to_json()` is the snapshot file's form, the same as TypeScript's."""

    end: TurnEnd
    stop_reason: str
    text: str
    tool_calls: list[OutcomeToolCall] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "end": self.end,
            "stopReason": self.stop_reason,
            "text": self.text,
            "toolCalls": [c.to_json() for c in self.tool_calls],
        }


@dataclass
class TurnReport:
    prompt: str
    passed: bool
    failures: list[str]
    outcome: TurnOutcome
    updates: int
    permissions: list[str]
    duration_ms: float
    #: Tool-call argument outcomes, when the agent reported any.
    tool_input: ToolInputSummary | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "prompt": self.prompt,
            "pass": self.passed,
            "failures": list(self.failures),
            "outcome": self.outcome.to_json(),
            "updates": self.updates,
            "permissions": list(self.permissions),
        }
        if self.tool_input is not None:
            out["toolInput"] = self.tool_input.to_json()
        out["durationMs"] = self.duration_ms
        return out


SnapshotStatus = Literal["written", "matched", "differed", "missing", "unreadable"]


@dataclass
class ScenarioReport:
    name: str
    passed: bool
    turns: list[TurnReport]
    #: The temporary workspace; removed after a pass unless `keep`.
    workspace: str
    #: The connection trace; removed after a pass unless `keep`.
    trace: str
    duration_ms: float = 0
    #: Set when the scenario could not run (it has no turns, the agent did not start, a turn raised).
    error: str | None = None
    #: Where the failure bundle is, when it failed.
    bundle: str | None = None
    #: The turns' tool-call argument outcomes together, when the agent reported any.
    tool_input: ToolInputSummary | None = None
    #: written (new or `update_snapshots`), matched, differed, missing (with `require_snapshots`),
    #: or unreadable (not valid JSON; left as it is). Only written and matched pass.
    snapshot: SnapshotStatus | None = None
    #: How the run differs from the snapshot beyond single turns (a different number of turns,
    #: a missing or unreadable file).
    snapshot_failures: list[str] | None = None

    def to_json(self) -> dict[str, Any]:
        """The report as TypeScript writes it (`report.json` in a failure bundle)."""
        out: dict[str, Any] = {"name": self.name, "pass": self.passed}
        if self.error is not None:
            out["error"] = self.error
        out["turns"] = [t.to_json() for t in self.turns]
        out["workspace"] = self.workspace
        out["trace"] = self.trace
        if self.bundle is not None:
            out["bundle"] = self.bundle
        if self.tool_input is not None:
            out["toolInput"] = self.tool_input.to_json()
        if self.snapshot is not None:
            out["snapshot"] = self.snapshot
        if self.snapshot_failures is not None:
            out["snapshotFailures"] = list(self.snapshot_failures)
        out["durationMs"] = self.duration_ms
        return out


def _list(value: Any) -> list[Any]:
    if value is None:
        return []
    return list(value) if isinstance(value, list) else [value]


def _js(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def permission_policy(permissions: ScenarioPermissions | None) -> PermissionPolicy:
    """The client's permission answer for a scenario's `permissions`."""
    if permissions is None or permissions == "reject":
        return "reject"
    if permissions == "allow":
        return "allow"
    if permissions == "read-only":
        return first_of(read_only, "reject")
    if not isinstance(permissions, dict):
        raise ValueError(
            f'permissions must be "allow", "reject", "read-only" or {{"allow": [...], "reject": [...]}}, not {permissions!r}'
        )
    rules: list[Any] = []
    if permissions.get("reject"):
        rules.append(reject(kinds=list(permissions["reject"])))
    if permissions.get("allow"):
        rules.append(allow(kinds=list(permissions["allow"])))
    return first_of(*rules, "reject")


def outcome_of(result: TurnResult) -> TurnOutcome:
    return TurnOutcome(
        end=turn_end(result),
        stop_reason=str(result.stop_reason),
        text=result.text,
        tool_calls=[OutcomeToolCall(title=c.title, status=str(c.status), kind=c.kind or None) for c in result.tool_calls],
    )


def _read_text(path: str) -> str | None:
    try:
        # As Node's readFile(path, 'utf8'): bytes that are not UTF-8 become U+FFFD, so a binary file still exists.
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            return f.read()
    except OSError:
        return None


async def check_turn(
    expect: Expectations, *, result: TurnResult, updates: int, permissions: Sequence[str], workspace: str
) -> list[str]:
    """What is wrong with a turn, given what was expected; empty when it passes."""
    failures: list[str] = []
    end = turn_end(result)
    if "end" in expect and end not in _list(expect["end"]):
        failures.append(f"ended {end}, expected {' or '.join(_list(expect['end']))}")
    if "stopReason" in expect and str(result.stop_reason) not in _list(expect["stopReason"]):
        failures.append(f"stop reason {result.stop_reason}, expected {' or '.join(_list(expect['stopReason']))}")
    text = result.text
    want_text = expect.get("text") or {}
    for want in _list(want_text.get("contains")):
        if want not in text:
            failures.append(f"text does not contain {_js(want)}")
    for unwanted in _list(want_text.get("notContains")):
        if unwanted in text:
            failures.append(f"text contains {_js(unwanted)}")
    pattern = want_text.get("matches")
    if pattern and not re.search(pattern, text):
        failures.append(f"text does not match /{pattern}/")
    calls = result.tool_calls
    t = expect.get("toolCalls")
    if t:
        if "min" in t and len(calls) < t["min"]:
            failures.append(f"{len(calls)} tool calls, expected at least {t['min']}")
        if "max" in t and len(calls) > t["max"]:
            failures.append(f"{len(calls)} tool calls, expected at most {t['max']}")
        for title in t.get("titles", []):
            if not any(title in c.title for c in calls):
                failures.append(f"no tool call titled like {_js(title)}")
        for kind in t.get("kinds", []):
            if not any(c.kind == kind for c in calls):
                failures.append(f"no {kind} tool call")
        if t.get("allCompleted"):
            for c in calls:
                if c.status != "completed":
                    failures.append(f"tool call {_js(c.title)} ended {c.status}")
    p = expect.get("permissions")
    if p:
        if "min" in p and len(permissions) < p["min"]:
            failures.append(f"{len(permissions)} permission questions, expected at least {p['min']}")
        if "max" in p and len(permissions) > p["max"]:
            failures.append(f"{len(permissions)} permission questions, expected at most {p['max']}")
        for title in p.get("titles", []):
            if not any(title in q for q in permissions):
                failures.append(f"no permission question like {_js(title)}")
    for path, want in (expect.get("files") or {}).items():
        content = await asyncio.to_thread(_read_text, os.path.join(workspace, path))
        if want.get("exists") is False:
            if content is not None:
                failures.append(f"{path} exists")
            continue
        if content is None:
            failures.append(f"{path} does not exist")
            continue
        if "contains" in want and want["contains"] not in content:
            failures.append(f"{path} does not contain {_js(want['contains'])}")
        if "equals" in want and content != want["equals"]:
            failures.append(f"{path} is not {_js(want['equals'])}")
        if "matches" in want and not re.search(want["matches"], content):
            failures.append(f"{path} does not match /{want['matches']}/")
        if "sameAs" in want:
            other = await asyncio.to_thread(_read_text, os.path.join(workspace, want["sameAs"]))
            if other is None:
                failures.append(f"{want['sameAs']} does not exist")
            elif other != content:
                failures.append(f"{path} differs from {want['sameAs']}")
    u = expect.get("updates") or {}
    if "min" in u and updates < u["min"]:
        failures.append(f"{updates} updates, expected at least {u['min']}")
    if "max" in u and updates > u["max"]:
        failures.append(f"{updates} updates, expected at most {u['max']}")
    if "toolInput" in expect:
        limits = expect["toolInput"] or {}
        failures += check_tool_input(
            summarize_tool_input(result.tool_calls),
            max_invalid_rate=limits.get("maxInvalidRate"),
            max_repair_rate=limits.get("maxRepairRate"),
            min_checked=limits.get("minChecked"),
        )
    return failures


def _list_files(root: str) -> list[str]:
    out: list[str] = []
    for folder, _dirs, files in os.walk(root):
        for name in files:
            out.append(os.path.relpath(os.path.join(folder, name), root))
    return sorted(out)


def _in_ci() -> bool:
    ci = os.environ.get("CI")
    return bool(ci) and ci not in ("false", "0")


def _now_ms() -> float:
    return time.monotonic() * 1000


async def run_scenario(
    scenario: Scenario,
    *,
    base_dir: str | os.PathLike[str] | None = None,
    artifacts: str | os.PathLike[str] | None = None,
    update_snapshots: bool = False,
    require_snapshots: bool | None = None,
    keep: bool = False,
    on_event: Callable[[TurnEvent, str], Any] | None = None,
    trust_project: bool = False,
    on_warning: Callable[[str], None] | None = None,
) -> ScenarioReport:
    """Run one scenario. Never raises for the agent's failures: they are in the report.

    - `base_dir`: resolve `workspace.from`, `snapshot` and ./ agent arguments against this
      folder (the scenario file's). Default: the current directory.
    - `artifacts`: where failure bundles go. Default `<tmp>/subspace-scenarios`.
    - `update_snapshots`: write snapshots instead of comparing with them.
    - `require_snapshots`: a missing snapshot fails instead of being written. Default: on when
      the CI environment variable is set (not "false" or "0").
    - `keep`: keep the workspace and trace of a passing scenario (a failing one's are always kept).
    - `on_event(event, scenario_name)`: each event of each turn, for progress output.
    - `trust_project`: read the nearest subspace.toml (from `base_dir` up) for a named agent
      even if its folder is not in your agents.toml's [trust] folders. Default False: an
      untrusted one is skipped with a warning, as `load_catalog()` does.
    - `on_warning`: told about a subspace.toml skipped because its folder is not trusted.
      Default: once per file, on stderr.
    """
    started = _now_ms()
    base = os.path.abspath(base_dir if base_dir is not None else os.getcwd())
    workspace = tempfile.mkdtemp(prefix="subspace-scenario-")
    source = (scenario.get("workspace") or {}).get("from")
    trace_path = os.path.join(tempfile.mkdtemp(prefix="subspace-trace-"), "trace.jsonl")
    report = ScenarioReport(name=scenario.get("name", ""), passed=False, turns=[], workspace=workspace, trace=trace_path)

    # ./ and ../ arguments are relative to the scenario file (the agent itself runs in the workspace).
    def local(arg: str) -> str:
        return os.path.normpath(os.path.join(base, arg)) if arg.startswith(("./", "../")) else arg

    spec = scenario.get("agent")
    target: str | AgentCommand
    env: Mapping[str, str] | None = None
    agent = None
    try:
        if source:
            await asyncio.to_thread(shutil.copytree, os.path.join(base, source), workspace, dirs_exist_ok=True)
        if isinstance(spec, str):
            target = spec
        elif isinstance(spec, dict) and isinstance(command := spec.get("command"), str):
            target = AgentCommand(local(command), tuple(local(a) for a in spec.get("args", [])), mode=spec.get("mode") or None)
            env = spec.get("env")
        else:
            raise ValueError("the scenario's agent must be a name or {command, args}")
        # Without turns nothing is checked: that is not a pass.
        if not scenario.get("turns"):
            raise ValueError("the scenario has no turns")
        options: dict[str, Any] = {}
        if isinstance(target, str):
            # A named agent is looked up from the scenario's project (its subspace.toml), not the
            # temporary workspace, with the same trust check as everywhere else.
            options["catalog"] = await load_catalog_async(cwd=base, trust_project=trust_project, on_warning=on_warning)
        if "mode" in scenario:
            options["mode"] = scenario["mode"]
        if env:
            options["env"] = env
        agent = await start(
            target,
            cwd=workspace,
            permissions=permission_policy(scenario.get("permissions")),
            trace=trace_path,
            quiet=True,
            handle_signals=False,
            **options,
        )
        for step in scenario["turns"]:
            turn_started = _now_ms()
            counts = {"updates": 0}
            permissions: list[str] = []
            name = report.name

            def on_turn_event(event: TurnEvent) -> Any:
                if event.type != "state":
                    counts["updates"] += 1
                if event.type == "permission":
                    permissions.append(event.request.title)
                if on_event is not None:
                    return on_event(event, name)
                return None

            timeout_ms = step.get("timeoutMs", scenario.get("timeoutMs", 120_000))
            result = await agent.run(step["prompt"], timeout_ms=timeout_ms, on_event=on_turn_event)
            expect = step.get("expect")
            failures = (
                await check_turn(expect, result=result, updates=counts["updates"], permissions=permissions, workspace=workspace)
                if expect
                else []
            )
            tool_input = summarize_tool_input(result.tool_calls)
            report.turns.append(
                TurnReport(
                    prompt=step["prompt"],
                    passed=not failures,
                    failures=failures,
                    outcome=outcome_of(result),
                    updates=counts["updates"],
                    permissions=permissions,
                    tool_input=tool_input if tool_input.checked else None,
                    duration_ms=round(_now_ms() - turn_started),
                )
            )
    except Exception as error:  # noqa: BLE001 - the scenario could not run: in the report
        report.error = str(error) or type(error).__name__
    finally:
        if agent is not None:
            try:
                await agent.close()
            except Exception:  # noqa: BLE001
                pass

    reported = [t.tool_input for t in report.turns if t.tool_input is not None]
    if reported:
        report.tool_input = merge_tool_input(reported)
    snapshot_file = scenario.get("snapshot")
    if snapshot_file and report.error is None:
        strict = require_snapshots if require_snapshots is not None else _in_ci()
        path = os.path.join(base, snapshot_file)
        report.snapshot = await asyncio.to_thread(_compare_snapshot, path, report, update_snapshots, strict)
    report.passed = (
        report.error is None and all(t.passed for t in report.turns) and report.snapshot in (None, "written", "matched")
    )
    report.duration_ms = round(_now_ms() - started)
    if not report.passed:
        folder = artifacts if artifacts is not None else os.path.join(tempfile.gettempdir(), "subspace-scenarios")
        report.bundle = await asyncio.to_thread(_write_bundle, report, os.fspath(folder))
    elif not keep:
        await asyncio.to_thread(shutil.rmtree, workspace, True)
        await asyncio.to_thread(shutil.rmtree, os.path.dirname(trace_path), True)
    return report


def _compare_snapshot(path: str, report: ScenarioReport, update: bool, require: bool) -> SnapshotStatus:
    outcomes = [t.outcome.to_json() for t in report.turns]

    def write() -> SnapshotStatus:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Written beside it, then renamed over it: a run reading it at the same time sees the
        # old file or the new one, never half of one.
        temporary = f"{path}.{os.getpid()}.{uuid.uuid4()}.tmp"
        try:
            with open(temporary, "w", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(outcomes, indent=2, ensure_ascii=False) + "\n")
            os.replace(temporary, path)
        except BaseException:
            try:
                os.remove(temporary)
            except OSError:
                pass
            raise
        return "written"

    if update:
        return write()
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        if not require:
            return write()
        report.snapshot_failures = [
            f"no snapshot at {path} (snapshots are not written in CI; run without CI, or with update_snapshots, and commit it)"
        ]
        return "missing"
    except (OSError, UnicodeDecodeError) as error:
        report.snapshot_failures = [f"cannot read {path}: {error}"]
        return "unreadable"
    try:
        existing = json.loads(text)
        if not isinstance(existing, list):
            raise ValueError("not a list of turns")
    except ValueError as error:
        # Kept as it is: overwriting would hide a bad merge or a hand edit.
        report.snapshot_failures = [f"{path} is not a valid snapshot ({error}); fix it or rerun with update_snapshots"]
        return "unreadable"
    existing = cast(list[Any], existing)
    differing = [i for i, outcome in enumerate(outcomes) if i >= len(existing) or outcome != existing[i]]
    if not differing and len(existing) == len(outcomes):
        return "matched"
    for i in differing:
        report.turns[i].failures.append("differs from the snapshot (rerun with update_snapshots to accept)")
        report.turns[i].passed = False
    if len(existing) != len(outcomes):
        report.snapshot_failures = [
            f"{len(outcomes)} turns, the snapshot has {len(existing)} (rerun with update_snapshots to accept)"
        ]
    return "differed"


def _write_bundle(report: ScenarioReport, artifacts: str) -> str:
    """The trace, the report and the workspace's files, in one folder."""
    # One folder per run, inside the artifacts folder whatever the scenario is called.
    safe = re.sub(r"^[.-]+", "", re.sub(r"[^A-Za-z0-9._-]+", "-", report.name))[:80] or "scenario"
    os.makedirs(artifacts, exist_ok=True)
    folder = tempfile.mkdtemp(prefix=f"{safe}-", dir=artifacts)
    with open(os.path.join(folder, "report.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(report.to_json(), indent=2, ensure_ascii=False) + "\n")
    try:
        shutil.copyfile(report.trace, os.path.join(folder, "trace.jsonl"))
    except OSError:
        pass
    files = _list_files(report.workspace)
    with open(os.path.join(folder, "workspace-files.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(files) + "\n")
    return folder


def _is_scenario(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("name"), str) and isinstance(value.get("turns"), list)


def load_scenarios(path: str | os.PathLike[str]) -> list[Scenario]:
    """Scenarios from a file: JSON (one, a list, or `{"scenarios": [...]}`), or a Python module
    whose `scenarios` (a list) or `scenario` is them."""
    full = Path(path).resolve()
    value: Any
    if full.suffix == ".py":
        spec = importlib.util.spec_from_file_location(f"_subspace_scenarios_{uuid.uuid4().hex}", full)
        if spec is None or spec.loader is None:
            raise ValueError(f"{path}: cannot import it")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        value = getattr(module, "scenarios", getattr(module, "scenario", None))
    else:
        value = json.loads(full.read_text(encoding="utf-8"))
    scenarios = value if isinstance(value, list) else value.get("scenarios", [value]) if isinstance(value, dict) else [value]
    if not isinstance(scenarios, list) or not all(_is_scenario(s) for s in scenarios):
        raise ValueError(f"{path}: not a scenario file (each scenario needs a name, an agent and turns)")
    return cast(list[Scenario], scenarios)


def format_scenarios(reports: Sequence[ScenarioReport]) -> str:
    """A text summary of reports: one line per turn, failures indented."""
    lines: list[str] = []
    for r in reports:
        snapshot = f", snapshot {r.snapshot}" if r.snapshot else ""
        lines.append(f"{'PASS' if r.passed else 'FAIL'}  {r.name}  ({_n(r.duration_ms)} ms{snapshot})")
        if r.error:
            lines.append(f"        could not run: {r.error}")
        for i, t in enumerate(r.turns):
            prompt = t.prompt if len(t.prompt) <= 60 else f"{t.prompt[:57]}..."
            lines.append(
                f"  {'ok ' if t.passed else 'no '} {i + 1}. {_js(prompt)}  {t.outcome.end}, {len(t.outcome.tool_calls)} tool calls"
            )
            for f in t.failures:
                lines.append(f"        - {f}")
        for f in r.snapshot_failures or []:
            lines.append(f"        snapshot: {f}")
        if r.bundle:
            lines.append(f"        failure bundle: {r.bundle}")
    failed = len([r for r in reports if not r.passed])
    lines += ["", f"{failed} of {len(reports)} scenarios failed" if failed else f"All {len(reports)} scenarios passed"]
    return "\n".join(lines)


# Control characters (other than tab and newlines), U+FFFE, U+FFFF and lone surrogates are not
# allowed in XML at all: dropped.
_NOT_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿\ud800-\udfff]")
_XML_ESCAPES = {"<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;"}


def _xml(text: str) -> str:
    return re.sub(r'[<>&"]', lambda m: _XML_ESCAPES[m.group(0)], _NOT_XML.sub("", text))


def _seconds(ms: float) -> str:
    return f"{ms / 1000:.3f}"


def _n(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def format_junit(reports: Sequence[ScenarioReport]) -> str:
    """JUnit XML for CI: a test case per turn, grouped by scenario."""
    suites: list[str] = []
    for r in reports:
        cases: list[str] = []
        for i, t in enumerate(r.turns):
            name = _xml(f"{i + 1}. {t.prompt[:80]}")
            failure = f'<failure message="{_xml(t.failures[0])}">{_xml(chr(10).join(t.failures))}</failure>' if t.failures else ""
            cases.append(
                f'    <testcase classname="{_xml(r.name)}" name="{name}" time="{_seconds(t.duration_ms)}">{failure}</testcase>'
            )
        if r.error:
            cases.append(f'    <testcase classname="{_xml(r.name)}" name="start"><error message="{_xml(r.error)}"/></testcase>')
        snapshot = r.snapshot_failures or []
        if snapshot:
            cases.append(
                f'    <testcase classname="{_xml(r.name)}" name="snapshot"><failure message="{_xml(snapshot[0])}">'
                f"{_xml(chr(10).join(snapshot))}</failure></testcase>"
            )
        failures = len([t for t in r.turns if not t.passed]) + (1 if snapshot else 0)
        suites.append(
            f'  <testsuite name="{_xml(r.name)}" tests="{len(cases)}" failures="{failures}" errors="{1 if r.error else 0}" '
            f'time="{_seconds(r.duration_ms)}">\n' + "\n".join(cases) + "\n  </testsuite>"
        )
    return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n' + "\n".join(suites) + "\n</testsuites>\n"
