"""The scenario runner: expectations, workspaces, permissions, snapshots, bundles, reports and waivers (scenario.test.ts)."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import pytest
from deft_subspace.acp_testkit import (
    CheckResult,
    Scenario,
    ScenarioReport,
    TurnOutcome,
    TurnReport,
    apply_waivers,
    define_scenario,
    format_junit,
    format_report,
    format_scenarios,
    load_scenarios,
    run_scenario,
)

HERE = Path(__file__).resolve().parent
WRITER = HERE / "fixtures" / "writer_agent.py"
AGENT: dict[str, Any] = {"command": sys.executable, "args": [str(WRITER)]}


@pytest.fixture(autouse=True)
def own_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Your own agents.toml and agents files are not read; no CI variable unless a test sets it."""
    config = tmp_path / "config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config))
    monkeypatch.delenv("SUBSPACE_AGENTS", raising=False)
    monkeypatch.delenv("CI", raising=False)
    return config


async def test_a_passing_scenario_workspace_copied_from_a_fixture_files_tool_calls_permissions_and_text_checked():
    report = await run_scenario(
        define_scenario(
            {
                "name": "writes a file",
                "agent": AGENT,  # type: ignore[typeddict-item]
                "workspace": {"from": "fixtures/greeting"},
                "permissions": "allow",
                "turns": [
                    {
                        "prompt": "hi",
                        "expect": {
                            "end": "completed",
                            "text": {"contains": "Hello", "notContains": "Wrote"},
                            "toolCalls": {"max": 0},
                        },
                    },
                    {
                        "prompt": "write hello.txt hi there",
                        "expect": {
                            "text": {"matches": r"^Wrote hello\.txt"},
                            "toolCalls": {"min": 1, "titles": ["Write hello"], "kinds": ["edit"], "allCompleted": True},
                            "permissions": {"min": 1, "titles": ["Write hello.txt"]},
                            "files": {
                                "hello.txt": {"equals": "hi there"},
                                "existing.txt": {"contains": "seed"},
                                "nope.txt": {"exists": False},
                            },
                        },
                    },
                ],
            }
        ),
        base_dir=HERE,
    )
    assert report.passed, format_scenarios([report])
    assert report.bundle is None
    assert len(report.turns[1].permissions) == 1


async def test_a_failing_scenario_lists_what_failed_and_leaves_a_bundle(tmp_path):
    """Trace, report, files; refusals keep files unwritten."""
    artifacts = tmp_path / "artifacts"
    report = await run_scenario(
        {
            "name": "refused write",
            "agent": AGENT,  # type: ignore[typeddict-item]
            "permissions": "reject",
            "turns": [
                {
                    "prompt": "write a.txt x",
                    "expect": {"files": {"a.txt": {"exists": True}}, "toolCalls": {"allCompleted": True}, "end": "completed"},
                }
            ],
        },
        artifacts=artifacts,
    )
    assert not report.passed
    assert report.turns[0].failures == ['tool call "Write a.txt" ended failed', "a.txt does not exist"]
    assert report.bundle is not None
    bundle = Path(report.bundle)
    assert "session/request_permission" in (bundle / "trace.jsonl").read_text(encoding="utf-8")
    assert json.loads((bundle / "report.json").read_text(encoding="utf-8"))["name"] == "refused write"
    # A scenario whose agent cannot start is a failure with the reason, not a raise.
    missing = await run_scenario(
        {"name": "no agent", "agent": {"command": "/no/such/agent"}, "turns": [{"prompt": "hi"}]}, artifacts=artifacts
    )
    assert not missing.passed
    assert re.search(r"no.such.agent", missing.error or "")


async def test_a_scenario_with_no_turns_fails_it_would_check_nothing(tmp_path):
    report = await run_scenario({"name": "empty", "agent": AGENT, "turns": []}, artifacts=tmp_path)  # type: ignore[typeddict-item]
    assert not report.passed
    assert re.search(r"no turns", report.error or "")


def greets(*prompts: str, snapshot: str = "greets.snapshot.json") -> Scenario:
    return {"name": "greets", "agent": AGENT, "snapshot": snapshot, "turns": [{"prompt": p} for p in prompts]}  # type: ignore[typeddict-item]


async def test_snapshots_written_once_matched_after_a_change_differs_until_accepted(tmp_path):
    d = tmp_path
    assert (await run_scenario(greets("hi"), base_dir=d, require_snapshots=False)).snapshot == "written"
    assert (await run_scenario(greets("hi"), base_dir=d)).snapshot == "matched"
    changed = await run_scenario(greets("hello"), base_dir=d, artifacts=d / "artifacts")
    assert changed.snapshot == "differed"
    assert not changed.passed
    assert re.search(r"differs from the snapshot", changed.turns[0].failures[0])
    assert (await run_scenario(greets("hello"), base_dir=d, update_snapshots=True)).snapshot == "written"
    assert (await run_scenario(greets("hello"), base_dir=d)).snapshot == "matched"


async def test_snapshots_are_replaced_whole_never_rewritten_in_place(tmp_path):
    """A reader sees the old file or the new one."""
    d = tmp_path / "snapshots"
    d.mkdir()
    assert (await run_scenario(greets("hi"), base_dir=d, require_snapshots=False)).snapshot == "written"
    # A second name for the same file: a write in place would change it too.
    before = (d / "greets.snapshot.json").read_text(encoding="utf-8")
    os.link(d / "greets.snapshot.json", d / "old.json")
    assert (await run_scenario(greets("hello"), base_dir=d, update_snapshots=True)).snapshot == "written"
    assert (d / "old.json").read_text(encoding="utf-8") == before
    assert (d / "greets.snapshot.json").read_text(encoding="utf-8") != before
    assert sorted(os.listdir(d)) == ["greets.snapshot.json", "old.json"]


async def test_snapshots_are_the_typescript_format(tmp_path):
    assert (await run_scenario(greets("hi"), base_dir=tmp_path, require_snapshots=False)).snapshot == "written"
    raw = (tmp_path / "greets.snapshot.json").read_bytes()
    assert raw.endswith(b"]\n") and b"\r\n" not in raw
    assert json.loads(raw) == [{"end": "completed", "stopReason": "end_turn", "text": "Hello! You said: hi", "toolCalls": []}]


async def test_snapshots_a_differing_turn_fails_in_every_report_and_so_does_a_different_number_of_turns(tmp_path):
    d = tmp_path
    assert (await run_scenario(greets("hi", "hi"), base_dir=d, require_snapshots=False)).snapshot == "written"
    changed = await run_scenario(greets("hello", "hi"), base_dir=d, artifacts=d / "artifacts")
    assert [t.passed for t in changed.turns] == [False, True]
    assert re.search(r"no  1\.", format_scenarios([changed]))
    assert re.search(r'failures="1"', format_junit([changed]))
    shorter = await run_scenario(greets("hi"), base_dir=d, artifacts=d / "artifacts")
    assert not shorter.passed
    assert [t.passed for t in shorter.turns] == [True]
    assert re.search(r"snapshot: 1 turns, the snapshot has 2", format_scenarios([shorter]))
    junit = format_junit([shorter])
    assert re.search(r'failures="1"', junit)
    assert re.search(r'name="snapshot"><failure message="1 turns, the snapshot has 2', junit)


def project(tmp_path: Path) -> Path:
    """A project folder whose subspace.toml defines local-writer."""
    folder = tmp_path / "project"
    folder.mkdir()
    args = ", ".join(json.dumps(a) for a in AGENT["args"])
    (folder / "subspace.toml").write_text(
        f"[agents.local-writer]\ncommand = {json.dumps(AGENT['command'])}\nargs = [{args}]\n", encoding="utf-8"
    )
    return folder


NAMED: Any = {"name": "local", "agent": "local-writer", "turns": [{"prompt": "hi"}]}


async def test_a_named_agent_the_projects_subspace_toml_is_skipped_with_one_warning_while_its_folder_is_not_trusted(tmp_path):
    folder = project(tmp_path)
    warnings: list[str] = []
    report = await run_scenario(NAMED, base_dir=folder, artifacts=tmp_path / "artifacts", on_warning=warnings.append)
    assert not report.passed
    assert re.search(r"local-writer", report.error or "")
    assert len(warnings) == 1
    assert re.match(r"subspace: skipped .*subspace\.toml: its folder is not trusted", warnings[0])
    # The folder as found (symlinks and Windows short names may be resolved).
    shown = [f"  [trust]\n  folders = [{json.dumps(str(p))}]\n" for p in (folder, os.path.realpath(folder))]
    assert any(s in warnings[0] for s in shown), warnings[0]


async def test_a_named_agent_is_looked_up_in_the_scenarios_trusted_project_not_the_temporary_workspace(tmp_path, own_config):
    folder = project(tmp_path)
    (own_config / "subspace").mkdir(parents=True)
    (own_config / "subspace" / "agents.toml").write_text(f"[trust]\nfolders = [{json.dumps(str(folder))}]\n", encoding="utf-8")
    warnings: list[str] = []
    report = await run_scenario(NAMED, base_dir=folder, artifacts=tmp_path / "artifacts", on_warning=warnings.append)
    assert report.error is None
    assert report.passed
    assert warnings == []


async def test_trust_project_reads_an_untrusted_project_subspace_toml_for_one_run(tmp_path):
    folder = project(tmp_path)
    warnings: list[str] = []
    report = await run_scenario(
        NAMED, base_dir=folder, artifacts=tmp_path / "artifacts", trust_project=True, on_warning=warnings.append
    )
    assert report.error is None
    assert report.passed
    assert warnings == []


async def test_an_agent_given_as_a_command_does_not_read_the_catalog(tmp_path):
    """An untrusted subspace.toml beside it is not warned about."""
    folder = project(tmp_path)
    warnings: list[str] = []
    report = await run_scenario(
        {"name": "command", "agent": AGENT, "turns": [{"prompt": "hi"}]},  # type: ignore[typeddict-item]
        base_dir=folder,
        artifacts=tmp_path / "artifacts",
        on_warning=warnings.append,
    )
    assert report.error is None
    assert report.passed
    assert warnings == []


async def test_load_scenarios_reads_json_files_text_and_junit_reports(tmp_path):
    file = tmp_path / "suite.json"
    file.write_text(
        json.dumps(
            {
                "scenarios": [
                    {"name": "one", "agent": AGENT, "turns": [{"prompt": "hi", "expect": {"text": {"contains": "Nope"}}}]}
                ]
            }
        )
    )
    [scenario] = load_scenarios(file)
    report = await run_scenario(scenario, artifacts=tmp_path / "artifacts")
    text = format_scenarios([report])
    assert re.search(r"FAIL  one", text)
    assert re.search(r'- text does not contain "Nope"', text)
    assert re.search(r"1 of 1 scenarios failed", text)
    junit = format_junit([report])
    assert re.search(r'<testsuite name="one" tests="1" failures="1"', junit)
    assert re.search(r'<failure message="text does not contain &quot;Nope&quot;">', junit)
    (tmp_path / "bad.json").write_text('{"nothing": true}')
    with pytest.raises(ValueError, match=r"not a scenario file"):
        load_scenarios(tmp_path / "bad.json")


def test_waivers_turn_a_known_failure_into_waive_a_waiver_for_a_passing_check_is_dropped():
    report = apply_waivers(
        [
            CheckResult("session.unknown", "unknown session", False, "error -32602"),
            CheckResult("prompt.ends", "a prompt ends", True, ""),
        ],
        {"session.unknown": "answers -32602", "prompt.ends": "never needed"},
    )
    assert report[0].passed
    assert report[0].waived == "answers -32602"
    assert report[1].waived is None
    assert re.search(r"^WAIVE session\.unknown .*\[waived: answers -32602\]", format_report(report), re.MULTILINE)


async def test_relative_agent_paths_are_relative_to_the_scenario_file_same_as_compares_two_workspace_files(tmp_path):
    report = await run_scenario(
        {
            "name": "relative agent",
            "agent": {"command": sys.executable, "args": ["./fixtures/writer_agent.py"]},
            "workspace": {"from": "fixtures/greeting"},
            "permissions": "allow",
            "turns": [
                {"prompt": "write a.txt same words"},
                {"prompt": "write b.txt same words", "expect": {"files": {"b.txt": {"sameAs": "a.txt"}}}},
                {"prompt": "write c.txt other words", "expect": {"files": {"c.txt": {"sameAs": "a.txt"}}}},
            ],
        },
        base_dir=HERE,
        artifacts=tmp_path,
    )
    assert report.turns[1].passed, format_scenarios([report])
    assert report.turns[2].failures == ["c.txt differs from a.txt"]


async def test_snapshots_an_unreadable_snapshot_fails_and_is_kept_in_ci_mode_a_missing_one_fails(tmp_path, monkeypatch):
    d = tmp_path
    (d / "greets.snapshot.json").write_text('[{"end": "completed", <<<<<<< merge conflict')
    broken = await run_scenario(greets("hi"), base_dir=d, artifacts=d / "artifacts")
    assert not broken.passed
    assert broken.snapshot == "unreadable"
    assert "merge conflict" in (d / "greets.snapshot.json").read_text()
    assert re.search(r"snapshot: .*greets\.snapshot\.json", format_scenarios([broken]))
    # update_snapshots still replaces it.
    assert (await run_scenario(greets("hi"), base_dir=d, update_snapshots=True)).snapshot == "written"

    missing = await run_scenario(
        greets("hi", snapshot="new.snapshot.json"), base_dir=d, artifacts=d / "artifacts", require_snapshots=True
    )
    assert not missing.passed
    assert missing.snapshot == "missing"
    assert not (d / "new.snapshot.json").exists()
    assert re.search(r'name="snapshot"><failure', format_junit([missing]))
    # The CI environment variable turns it on by default.
    monkeypatch.setenv("CI", "true")
    assert (
        await run_scenario(greets("hi", snapshot="other.snapshot.json"), base_dir=d, artifacts=d / "artifacts")
    ).snapshot == "missing"


async def test_a_passing_scenario_removes_its_workspace_and_trace_bundles_are_unique_and_stay_inside_the_artifacts_folder(
    tmp_path,
):
    passed = await run_scenario({"name": "quiet", "agent": AGENT, "turns": [{"prompt": "hi"}]})  # type: ignore[typeddict-item]
    assert passed.passed
    assert not os.path.exists(passed.workspace)
    assert not os.path.exists(os.path.dirname(passed.trace))
    kept = await run_scenario({"name": "kept", "agent": AGENT, "turns": [{"prompt": "hi"}]}, keep=True)  # type: ignore[typeddict-item]
    assert os.path.exists(kept.workspace)

    artifacts = tmp_path / "bundles"

    def failing(name: str) -> Scenario:
        return {"name": name, "agent": AGENT, "turns": [{"prompt": "hi", "expect": {"text": {"contains": "Nope"}}}]}  # type: ignore[typeddict-item]

    a = await run_scenario(failing(".."), artifacts=artifacts)
    b = await run_scenario(failing(".."), artifacts=artifacts)
    assert a.bundle is not None and b.bundle is not None
    assert Path(a.bundle).parent == artifacts
    assert a.bundle != b.bundle
    assert len(os.listdir(artifacts)) == 2
    assert (Path(a.bundle) / "report.json").is_file()
    assert not Path(a.bundle).name.startswith(".")
    # A failed run keeps its workspace for the bundle.
    assert os.path.exists(a.workspace)


def test_junit_drops_characters_xml_cannot_carry():
    outcome = TurnOutcome(end="completed", stop_reason="end_turn", text="")
    turn = TurnReport(
        prompt="a\x01b", passed=False, failures=["bad \x1b[31mred\x00"], outcome=outcome, updates=0, permissions=[], duration_ms=1
    )
    junit = format_junit([ScenarioReport(name="ctl", passed=False, turns=[turn], workspace="", trace="", duration_ms=1)])
    assert not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", junit)
    assert re.search(r'name="1\. ab"', junit)


def test_load_scenarios_imports_a_python_module(tmp_path):
    folder = tmp_path / "scenario module #1"
    folder.mkdir()
    (folder / "suite.py").write_text("scenarios = [{'name': 'm', 'agent': 'claude', 'turns': [{'prompt': 'hi'}]}]\n")
    [scenario] = load_scenarios(folder / "suite.py")
    assert scenario["name"] == "m"
