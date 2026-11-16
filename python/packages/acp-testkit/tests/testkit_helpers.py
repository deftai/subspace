"""Test helpers: byte links like stdio, and an agent that behaves well for check_agent's prompts."""

from __future__ import annotations

import asyncio
from typing import Any

from deft_subspace.acp import AgentTurn
from deft_subspace.acp_testkit import DEFAULT_PROMPTS
from deft_subspace.kernel import Channel, channel_pair, ndjson, pipe_channel
from deft_subspace.kernel.channel import Identity
from deft_subspace.kernel.testing import rechunk


class ByteLink:
    """Two byte ends joined as NDJSON, like stdio, re-chunked byte by byte."""

    def __init__(self) -> None:
        a, b = channel_pair()
        self.a: Channel[Any] = pipe_channel(a, read=rechunk(1), write=Identity())
        self.b: Channel[Any] = pipe_channel(b, read=rechunk(1), write=Identity())
        self.client: Channel[Any] = ndjson(self.a)
        self.agent: Channel[Any] = ndjson(self.b)


async def well_behaved(turn: AgentTurn) -> str:
    """A serve_agent prompt handler that behaves well for each of check_agent's default prompts."""
    if turn.text == DEFAULT_PROMPTS.long_prompt:
        for i in range(1, 301):
            if turn.signal.aborted:
                break
            await turn.say(f"{i}\n")
            await asyncio.sleep(0.005)
        return "end_turn"
    if turn.text == DEFAULT_PROMPTS.permission_prompt:
        call = await turn.tool_call("Write deft-testkit.txt", kind="edit")
        answer = await turn.request_permission("Write deft-testkit.txt", tool_call_id=call.id)
        if answer.allowed:
            await call.complete()
        else:
            await call.fail()
        # Answered cancelled: the cancel itself is on its way.
        if answer.outcome == "cancelled":
            await turn.signal.wait()
        return "end_turn"
    await turn.say("OK")
    return "end_turn"


def text_of(prompt: Any) -> str:
    return "".join(b.get("text", "") for b in prompt if isinstance(b, dict)) if isinstance(prompt, list) else ""
