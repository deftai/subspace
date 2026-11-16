"""The quirks corpus: real agents' traces (packages/acp-testkit/corpus/*.trace.jsonl, shared with
the TypeScript testkit), replayed to our AcpClient. Each must give the TurnResult it gave live
(kept in the trace header's meta.expected). Ported from corpus.test.ts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from deft_subspace.acp import AcpClient, MessageEvent
from deft_subspace.acp_testkit import NormalizedTurn, load_trace, normalize_turn, replay_agent
from deft_subspace.kernel import channel_pair

CORPUS = Path(__file__).resolve().parents[4] / "packages" / "acp-testkit" / "corpus"
FILES = sorted(p.name for p in CORPUS.glob("*.trace.jsonl"))


async def replay_corpus(file: str) -> tuple[dict[str, Any], NormalizedTurn, int]:
    """Replay one corpus trace the way it was recorded: same mode, prompt and policy, cancel after the first message if it was."""
    records = await load_trace(CORPUS / file)
    meta = records[0]["meta"]
    agent_end, client_end = channel_pair()
    replay = replay_agent(agent_end, records)
    client = await AcpClient.connect(client_end, permissions=meta["permissions"])
    session = await client.new_session("/workspace")
    if meta.get("mode"):
        await session.set_mode(meta["mode"])
    turn = session.prompt(meta["prompt"])
    async for event in turn:
        if isinstance(event, MessageEvent) and meta.get("cancelAfterMs") is not None:
            await turn.cancel()
    result = normalize_turn(await turn)
    await replay.done
    await client.close()
    return meta, result, client.protocol


async def messages(file: str) -> list[dict[str, Any]]:
    """Every JSON-RPC message in a corpus trace."""
    return [r["msg"] for r in await load_trace(CORPUS / file) if r["kind"] == "message"]


def test_the_corpus_has_the_grok_claude_and_codex_traces():
    assert CORPUS.is_dir(), CORPUS
    for agent in ["grok", "claude", "codex"]:
        for name in [f"{agent}-plain", f"{agent}-write-rejected", f"{agent}-cancel"]:
            assert f"{name}.trace.jsonl" in FILES, name


@pytest.mark.parametrize("file", FILES)
async def test_replay_gives_the_recorded_turn_result(file):
    meta, result, protocol = await replay_corpus(file)
    assert protocol == meta["protocol"]
    assert result.to_json() == meta["expected"]
    assert NormalizedTurn.from_json(meta["expected"]) == result


async def test_quirk_grok_ends_a_turn_whose_write_was_rejected_with_stop_reason_cancelled_though_nobody_cancelled():
    _meta, result, _protocol = await replay_corpus("grok-write-rejected.trace.jsonl")
    assert result.stop_reason == "cancelled"
    assert result.cancelled is False, "not cancelled from this side"
    assert [(c.kind, c.status) for c in result.tool_calls] == [("edit", "failed")]


async def test_grok_confirms_a_cancel_mid_stream_the_turn_is_not_forced():
    _meta, result, _protocol = await replay_corpus("grok-cancel.trace.jsonl")
    assert (result.stop_reason, result.cancelled, result.forced) == ("cancelled", True, False)
    assert result.text.startswith("1\n2\n3")


async def test_grok_plain_turn_v1_end_turn_the_exact_text():
    _meta, result, protocol = await replay_corpus("grok-plain.trace.jsonl")
    assert protocol == 1
    assert (result.stop_reason, result.text) == ("end_turn", "SUBSPACE_OK")


async def test_quirk_codex_too_ends_a_turn_whose_write_was_rejected_with_stop_reason_cancelled_and_leaves_the_tool_call_pending():
    _meta, result, _protocol = await replay_corpus("codex-write-rejected.trace.jsonl")
    assert result.stop_reason == "cancelled"
    assert result.cancelled is False, "not cancelled from this side"
    assert [(c.kind, c.status) for c in result.tool_calls] == [("edit", "pending")]


async def test_claude_ends_a_turn_whose_write_was_rejected_normally_with_the_tool_call_failed():
    _meta, result, protocol = await replay_corpus("claude-write-rejected.trace.jsonl")
    assert protocol == 2
    assert result.stop_reason == "end_turn"
    assert [(c.kind, c.status) for c in result.tool_calls] == [("edit", "failed")]


@pytest.mark.parametrize("agent", ["claude", "codex"])
async def test_confirms_a_cancel_mid_stream_the_turn_is_not_forced(agent):
    _meta, result, _protocol = await replay_corpus(f"{agent}-cancel.trace.jsonl")
    assert (result.stop_reason, result.cancelled, result.forced) == ("cancelled", True, False)


# The catalog's quirks (deft_subspace.acp agents), as the corpus shows them.


async def starting_mode(file: str) -> str | None:
    """The mode a session starts in: the session/new result's mode option."""
    for msg in await messages(file):
        result = msg.get("result")
        options = result.get("configOptions") if isinstance(result, dict) else None
        for option in options or []:
            if option.get("category") == "mode" or option.get("id") == "mode":
                return option.get("currentValue")
    return None


async def test_quirk_starts_in_auto_mode_claude_starts_a_session_in_auto_mode():
    assert await starting_mode("claude-plain.trace.jsonl") == "auto"


async def test_quirk_starts_in_agent_mode_codex_starts_a_session_in_agent_mode():
    assert await starting_mode("codex-plain.trace.jsonl") == "agent"


async def test_quirk_reject_option_named_cancel_codex_offers_its_reject_option_as_cancel():
    ask = next(m for m in await messages("codex-write-rejected.trace.jsonl") if m.get("method") == "session/request_permission")
    reject = next(o for o in ask["params"]["options"] if o["kind"] == "reject_once")
    assert reject["optionId"] == "cancel"


async def test_quirk_account_in_auth_status_the_account_in_auth_status_update_is_redacted_in_the_corpus():
    for agent in ["claude", "codex"]:
        updates = [m for m in await messages(f"{agent}-plain.trace.jsonl") if m.get("method") == "_auth/status_update"]
        assert updates, f"{agent} sends _auth/status_update"
        for u in updates:
            for value in (u["params"]["authStatus"].get("account") or {}).values():
                assert value == "<redacted>"


async def test_quirk_vendor_notifications_grok_sends_x_ai_notifications_and_the_replay_ignores_them():
    vendor = [
        m for m in await messages("grok-plain.trace.jsonl") if str(m.get("method", "")).startswith("_x.ai/") and "id" not in m
    ]
    assert len(vendor) >= 10, f"{len(vendor)} _x.ai notifications"
    _meta, result, _protocol = await replay_corpus("grok-plain.trace.jsonl")
    assert result.stop_reason == "end_turn"
