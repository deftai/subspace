"""The public API: everything in `__all__` exists, and the TypeScript testkit's exports all have a Python name."""

import deft_subspace.acp_testkit as testkit

# The TypeScript exports (index.ts and node.ts), as the Python port names them.
TYPESCRIPT = {
    "recorder": "recorder",
    "redactKeys": "redact_keys",
    "replaceStrings": "replace_strings",
    "tapChannel": "tap_channel",
    "messagesOf": "messages_of",
    "replayAgent": "replay_agent",
    "ReplayDivergence": "ReplayDivergence",
    "closeWhen": "close_when",
    "coalesce": "coalesce",
    "delay": "delay",
    "disconnectAfter": "disconnect_after",
    "faultChannel": "fault_channel",
    "injectLines": "inject_lines",
    "isUpdate": "is_update",
    "merge": "merge",
    "rechunk": "rechunk",
    "normalizeTurn": "normalize_turn",
    "applyWaivers": "apply_waivers",
    "failures": "failures",
    "formatReport": "format_report",
    "AGENT_CHECKS": "AGENT_CHECKS",
    "checkAgent": "check_agent",
    "DEFAULT_PROMPTS": "DEFAULT_PROMPTS",
    "acpClientDriver": "acp_client_driver",
    "CLIENT_CHECKS": "CLIENT_CHECKS",
    "checkClient": "check_client",
    "checkToolInput": "check_tool_input",
    "mergeToolInput": "merge_tool_input",
    "summarizeToolInput": "summarize_tool_input",
    "toolInputOf": "tool_input_of",
    "recordAgent": "record_agent",
    "saveTrace": "save_trace",
    "loadTrace": "load_trace",
    "checkAgentProcess": "check_agent_process",
    "checkTurn": "check_turn",
    "defineScenario": "define_scenario",
    "formatJUnit": "format_junit",
    "formatScenarios": "format_scenarios",
    "loadScenarios": "load_scenarios",
    "outcomeOf": "outcome_of",
    "permissionPolicy": "permission_policy",
    "runScenario": "run_scenario",
}


def test_every_name_in_all_exists():
    missing = [name for name in testkit.__all__ if not hasattr(testkit, name)]
    assert missing == []


def test_every_typescript_export_has_a_python_name():
    assert [ts for ts, py in TYPESCRIPT.items() if py not in testkit.__all__] == []


def test_the_check_lists_match_typescript():
    assert list(testkit.AGENT_CHECKS)[0] == "initialize.version" and len(testkit.AGENT_CHECKS) == 10
    assert list(testkit.CLIENT_CHECKS) == [
        "permission.answered",
        "permission.cancelled-on-cancel",
        "fs.outside-workspace",
        "unknown-method",
    ]
