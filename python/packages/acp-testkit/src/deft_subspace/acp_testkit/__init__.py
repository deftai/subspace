"""Test ACP agents and clients: record and replay traces, inject faults, run conformance checks
and scenarios. Everything uses the kernel's trace format, the same as the TypeScript testkit's.

    from deft_subspace.acp_testkit import check_agent, format_report

    report = await check_agent(channel)
    print(format_report(report))

- Record: `recorder()`, `tap_channel()`, `record_agent()`; `replace_strings()` and `redact_keys()`.
- Replay: `replay_agent()`, `ReplayDivergence`; `load_trace()`, `save_trace()`.
- Faults: `fault_channel()` with `delay`, `disconnect_after`, `close_when(is_update(...))`, and
  for bytes `rechunk`, `merge`, `coalesce`, `inject_lines`.
- Conformance: `check_agent()`, `check_agent_process()`, `check_client()` with
  `acp_client_driver()`; `format_report()`, `failures()`, `apply_waivers()`.
- Tool-input robustness: `summarize_tool_input()`, `check_tool_input()`.
- Scenarios: `run_scenario()`, `load_scenarios()`, `format_scenarios()`, `format_junit()`.
"""

from ._check import CheckResult, apply_waivers, failures, format_report
from ._check_agent import AGENT_CHECKS, DEFAULT_PROMPTS, check_agent
from ._check_client import CLIENT_CHECKS, ClientDriver, ConnectClient, acp_client_driver, check_client
from ._faults import (
    Fault,
    FaultController,
    close_when,
    coalesce,
    delay,
    disconnect_after,
    fault_channel,
    inject_lines,
    is_update,
    merge,
    rechunk,
)
from ._normalize import NormalizedToolCall, NormalizedTurn, normalize_turn
from ._process import RecordedAgent, check_agent_process, load_trace, record_agent, save_trace
from ._record import Recorder, messages_of, recorder, redact_keys, replace_strings, tap_channel
from ._replay import Replay, ReplayDivergence, replay_agent
from ._scenario import (
    Expectations,
    OutcomeToolCall,
    Scenario,
    ScenarioPermissions,
    ScenarioReport,
    ScenarioTurn,
    SnapshotStatus,
    TurnOutcome,
    TurnReport,
    check_turn,
    define_scenario,
    format_junit,
    format_scenarios,
    load_scenarios,
    outcome_of,
    permission_policy,
    run_scenario,
)
from ._tool_input import (
    ToolInputCounts,
    ToolInputOutcome,
    ToolInputStatus,
    ToolInputSummary,
    check_tool_input,
    merge_tool_input,
    summarize_tool_input,
    tool_input_of,
)

__all__ = [
    "AGENT_CHECKS",
    "CLIENT_CHECKS",
    "DEFAULT_PROMPTS",
    "CheckResult",
    "ClientDriver",
    "ConnectClient",
    "Expectations",
    "Fault",
    "FaultController",
    "NormalizedToolCall",
    "NormalizedTurn",
    "OutcomeToolCall",
    "RecordedAgent",
    "Recorder",
    "Replay",
    "ReplayDivergence",
    "Scenario",
    "ScenarioPermissions",
    "ScenarioReport",
    "ScenarioTurn",
    "SnapshotStatus",
    "ToolInputCounts",
    "ToolInputOutcome",
    "ToolInputStatus",
    "ToolInputSummary",
    "TurnOutcome",
    "TurnReport",
    "acp_client_driver",
    "apply_waivers",
    "check_agent",
    "check_agent_process",
    "check_client",
    "check_tool_input",
    "check_turn",
    "close_when",
    "coalesce",
    "define_scenario",
    "delay",
    "disconnect_after",
    "failures",
    "fault_channel",
    "format_junit",
    "format_report",
    "format_scenarios",
    "inject_lines",
    "is_update",
    "load_scenarios",
    "load_trace",
    "merge",
    "merge_tool_input",
    "messages_of",
    "normalize_turn",
    "outcome_of",
    "permission_policy",
    "rechunk",
    "record_agent",
    "recorder",
    "redact_keys",
    "replace_strings",
    "replay_agent",
    "run_scenario",
    "save_trace",
    "summarize_tool_input",
    "tap_channel",
    "tool_input_of",
]
