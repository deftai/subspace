"""Faults on a channel: banners, odd chunks, delays, disconnects (faults.test.ts)."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from deft_subspace.acp import AcpClient, AgentTurn, serve_agent
from deft_subspace.acp_testkit import (
    close_when,
    coalesce,
    delay,
    disconnect_after,
    fault_channel,
    inject_lines,
    is_update,
    rechunk,
)
from deft_subspace.kernel import FramingDiagnostic, LocalError, channel_pair, ndjson
from testkit_helpers import ByteLink


async def chatty(turn: AgentTurn) -> str:
    for word in ["one ", "two ", "three"]:
        await turn.say(word)
        await asyncio.sleep(0.002)
    return "end_turn"


def faulty_bytes(*faults: Any) -> tuple[Any, Any]:
    """A byte link whose agent-to-client direction runs through `faults`."""
    client, agent = channel_pair()
    return fault_channel(client, read=list(faults)), agent


@pytest.mark.parametrize(
    "make",
    [
        lambda: [inject_lines(), rechunk(3)],
        lambda: [inject_lines(['{"not": "closed'], every=2), coalesce(5)],
    ],
    ids=["banner+rechunk", "broken-json+coalesce"],
)
async def test_banner_lines_odd_chunks_and_merged_chunks_do_not_change_the_turn(make):
    client_bytes, agent_bytes = faulty_bytes(*make())
    serve_agent(ndjson(agent_bytes), name="chatty", prompt=chatty)
    skipped: list[FramingDiagnostic] = []
    client = await AcpClient.connect(ndjson(client_bytes, on_diagnostic=skipped.append))
    result = await (await client.new_session("/tmp")).prompt("go")
    assert result.text == "one two three"
    assert len(skipped) >= 2 and all(d.kind == "invalid-json" for d in skipped), f"skipped {len(skipped)}"
    await client.close()


async def test_delay_holds_messages_but_keeps_their_order():
    a, b = channel_pair()
    serve_agent(b, name="chatty", prompt=chatty)
    slow = fault_channel(a, read=[delay(lambda m: 20 if is_update()(m) else 0)], write=[delay(5)])
    client = await AcpClient.connect(slow)
    started = time.monotonic()
    result = await (await client.new_session("/tmp")).prompt("go")
    assert result.text == "one two three"
    # Three updates, 20 ms each (a timer may fire one clock tick early on Windows).
    assert (time.monotonic() - started) * 1000 >= 45
    await client.close()


async def test_disconnect_after_n_messages_the_client_sees_the_connection_close():
    a, b = channel_pair()
    serve_agent(b, name="chatty", protocols=[1], prompt=chatty)
    # initialize answer, session/new answer, then one update.
    client = await AcpClient.connect(fault_channel(a, read=[disconnect_after(3)]))
    turn = (await client.new_session("/tmp")).prompt("go")
    with pytest.raises(LocalError) as raised:
        await turn
    assert raised.value.kind == "closed"
    assert turn.text == "one "


@pytest.mark.parametrize("protocol", [1, 2])
async def test_close_mid_turn_at_the_first_message_chunk(protocol):
    link = ByteLink()
    serve_agent(link.agent, name="chatty", protocols=[protocol], prompt=chatty)
    cut = fault_channel(link.client, read=[close_when(is_update("agent_message_chunk"), including=False)])
    client = await AcpClient.connect(cut)
    turn = (await client.new_session("/tmp")).prompt("go")
    with pytest.raises(LocalError) as raised:
        await turn
    assert raised.value.kind == "closed"
    assert turn.text == ""


def test_inject_lines_every_must_be_a_whole_number_of_at_least_1():
    for every in [0, -1, 1.5, float("nan"), True]:
        with pytest.raises(ValueError):
            inject_lines(every=every)  # type: ignore[arg-type]
    inject_lines(every=3)


async def test_a_fault_on_the_writing_side_the_agent_never_hears_the_prompt():
    a, b = channel_pair()
    prompted: list[bool] = []

    def deaf(_turn: AgentTurn) -> None:
        prompted.append(True)

    serve_agent(b, name="deaf", prompt=deaf)
    client = await AcpClient.connect(fault_channel(a, write=[disconnect_after(2)]))
    turn = (await client.new_session("/tmp")).prompt("go")
    with pytest.raises(LocalError):
        await turn
    assert prompted == []
    await client.close()


async def test_a_kernel_transform_works_as_a_fault_and_close_flushes_what_faults_hold():
    a, b = channel_pair()
    # coalesce holds chunks for a long time; closing passes them on first.
    held = fault_channel(a, write=[coalesce(10_000), rechunk(2)])
    await held.send(b"abc")
    await held.send(b"de")
    await held.close()
    received = []
    while True:
        try:
            received.append(await b.receive())
        except Exception:
            break
    assert received == [b"ab", b"cd", b"e"]
