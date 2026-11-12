"""text(), stream(), json(), file() and image(), and signal / timeout_ms on prompts."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import time
from pathlib import Path

import pytest
from deft_subspace.acp.agent import serve_agent
from deft_subspace.acp.content import file, image
from deft_subspace.acp._conveniences import JsonAnswerError, find_json
from deft_subspace.acp.open import connect_session
from deft_subspace.kernel import AbortController, channel_pair
from pydantic import BaseModel


def agent_replying(reply, capabilities=None):
    """An agent whose reply to each prompt comes from `reply(turn, n)`."""
    agent_end, client_end = channel_pair()
    count = [0]

    async def prompt(turn):
        n = count[0]
        count[0] += 1
        result = reply(turn, n)
        if asyncio.iscoroutine(result):
            await result

    serve_agent(agent_end, name="replier", capabilities=capabilities or {}, prompt=prompt)
    return client_end


async def test_text_and_stream_and_stopping_a_stream_early_cancels_the_turn():
    cancelled = [False]

    async def reply(turn, _n):
        await turn.say("One.")
        await turn.tool("step", lambda _call: "x")
        await turn.say("Two.")
        if turn.text == "long":
            for i in range(100):
                if turn.signal.aborted:
                    break
                await turn.say(f" {i}")
                await asyncio.sleep(0.005)
            cancelled[0] = turn.signal.aborted

    s = await connect_session(agent_replying(reply), cwd="/w", permissions="reject")
    assert await s.text("hi") == "One.\n\nTwo."
    streamed = ""
    async for chunk in s.stream("hi"):
        streamed += chunk
    assert streamed == "One.\n\nTwo."
    async with contextlib.aclosing(s.stream("long")) as chunks:
        async for chunk in chunks:
            if "3" in chunk:
                break
    await asyncio.sleep(0.03)
    assert cancelled[0] is True
    # A plain break works too, once the generator is collected (at once, in CPython).
    cancelled[0] = False
    async for chunk in s.stream("long"):
        if "3" in chunk:
            break
    await asyncio.sleep(0.05)
    assert cancelled[0] is True
    await s.close()


class Files(BaseModel):
    files: list[str]


async def test_json_finds_json_in_a_fence_checks_it_and_asks_again_once_when_it_does_not_fit():
    prompts: list[str] = []

    async def reply(turn, n):
        prompts.append(turn.text)
        if n == 0:
            await turn.say('Here you go:\n```json\n{"files": ["a.ts", "b.ts"]}\n```')
        elif n == 1:
            await turn.say('{"files": "a.ts"}')  # wrong shape
        elif n == 2:
            await turn.say('Sorry: {"files": ["a.ts"], "note": "fixed {braces} in \\"strings\\""} done')
        else:
            await turn.say("no json here")

    s = await connect_session(agent_replying(reply), cwd="/w", permissions="reject")
    first = await s.json("Which files?", schema=Files, shape={"files": ["path"]})
    assert first == Files(files=["a.ts", "b.ts"])
    assert "Reply with only the JSON value" in prompts[0]
    assert '"files"' in prompts[0]
    fixed = await s.json("Again", schema=Files)
    assert fixed == Files(files=["a.ts"])
    assert prompts[2].startswith("That answer was not right: files: ")
    with pytest.raises(JsonAnswerError, match="no JSON value"):
        await s.json("No", retries=0)
    assert find_json("Answer: [1, 2] and more") == [1, 2]
    await s.close()


def test_find_json_fenced_after_blank_lines_or_a_crlf_and_linear_on_a_fence_that_never_closes():
    assert find_json('Here:\n```json\n\n{"a": 1}\n```') == {"a": 1}
    assert find_json("Here:\r\n```json  \r\n[1]\r\n```") == [1]
    started = time.monotonic()
    with pytest.raises(JsonAnswerError, match="no JSON value"):
        find_json("```\n" + "\n " * 200_000)
    assert time.monotonic() - started < 1
    with pytest.raises(JsonAnswerError):
        find_json("NaN")


async def test_prompt_signal_and_timeout_ms_cancel_the_turn():
    async def reply(turn, _n):
        while not turn.signal.aborted:
            await asyncio.sleep(0.005)

    s = await connect_session(agent_replying(reply), cwd="/w", permissions="reject")
    controller = AbortController()
    asyncio.get_running_loop().call_later(0.02, controller.abort)
    assert (await s.run("wait", signal=controller.signal)).stop_reason == "cancelled"
    timed = await s.run("wait", timeout_ms=20)
    assert timed.stop_reason == "cancelled"
    assert timed.exhausted is not None and timed.exhausted.limit == "duration"
    await s.close()


def _recorder(received: list):
    """A reply function that records each turn's prompt."""

    def record(turn, _n):
        received.append(turn.prompt)

    return record


async def test_file_embedded_where_the_agent_takes_it_and_text_where_it_does_not(tmp_path):
    path = tmp_path / "notes.md"
    path.write_bytes(b"# Notes\nhi")
    for embedded in (True, False):
        received: list = []
        s = await connect_session(
            agent_replying(_recorder(received), {"promptCapabilities": {"embeddedContext": embedded}}),
            cwd=str(tmp_path),
            permissions="reject",
            protocol=1,
        )
        await s.run(["Summarize", file(path)])
        assert received[0][0] == {"type": "text", "text": "Summarize"}  # a string in the list is a text block
        block = received[0][1]
        if embedded:
            assert block == {"type": "resource", "resource": {"uri": path.as_uri(), "mimeType": "text/markdown", "text": "# Notes\nhi"}}
        else:
            assert block == {"type": "text", "text": f"{path}:\n\n```\n# Notes\nhi\n```"}
        await s.close()


def test_image_and_unknown_types(tmp_path: Path):
    png = tmp_path / "a.png"
    png.write_bytes(b"\x89PNG")
    assert image(png) == {"type": "image", "mimeType": "image/png", "data": base64.b64encode(b"\x89PNG").decode()}
    with pytest.raises(ValueError, match="not a known image type"):
        image(tmp_path / "a.bin")
    other = tmp_path / "x.unknown"
    other.write_bytes(b"t\r\n")
    assert file(other)["resource"]["mimeType"] == "text/plain"
    assert file(other)["resource"]["text"] == "t\r\n"
