"""The terminal renderer and permission prompt."""

from __future__ import annotations

import asyncio
import queue
import re

from deft_subspace.acp.agent import serve_agent
from deft_subspace.acp.client import AcpClient
from deft_subspace.acp.model import PermissionRequest, ToolCall
from deft_subspace.acp.terminal_ui import ask_in_terminal, terminal
from deft_subspace.kernel import AbortController, channel_pair


class Out:
    def __init__(self, tty: bool) -> None:
        self.written = ""
        self.tty = tty

    def write(self, text: str) -> None:
        self.written += text

    def isatty(self) -> bool:
        return self.tty


async def test_a_thought_that_ends_with_a_blank_line_gets_no_second_one_before_the_answer_colored_or_not():
    for color in (False, True):
        out = Out(color)
        agent_end, client_end = channel_pair()

        async def prompt(turn):
            await turn.think("Noting it.")
            await turn.think("\n\n")
            await turn.say("The answer.")

        serve_agent(agent_end, name="r", prompt=prompt)
        client = await AcpClient.connect(client_end, **terminal(out=out, color=color))
        session = await client.new_session("/w")
        await session.prompt("go")
        plain = re.sub(r"\x1b\[\d+m", "", out.written)
        assert plain == f"{'' if color else 'thinking: '}Noting it.\n\nThe answer.", f"color {color}"
        await client.close()


async def test_streams_text_dims_thoughts_shows_tool_calls_and_answered_permissions():
    out = Out(False)
    agent_end, client_end = channel_pair()

    async def prompt(turn):
        await turn.think("Looking.")
        await turn.say("Checking ")
        await turn.say("files.")
        await turn.tool("List files", lambda _c: "a", kind="read")
        try:
            await turn.tool("Delete a", lambda _c: "x", kind="delete", ask=True)
        except Exception:
            pass
        await turn.say("Done.")

    serve_agent(agent_end, name="r", prompt=prompt)
    client = await AcpClient.connect(client_end, handlers=terminal(out=out), on_permission="reject")
    session = await client.new_session("/w")
    await session.prompt("go")
    assert out.written == "\n".join(
        ["thinking: Looking.", "", "Checking files.", "", "• List files", "  ✓ List files", "• Delete a", "? Delete a refused", "  ✗ Delete a", "", "Done."]
    )
    await client.close()


def request(kind: str | None = None, title: str = "Do it") -> PermissionRequest:
    return PermissionRequest(
        session_id="s", title=title, options=[], protocol=2, raw={}, tool_call=ToolCall(id="t", title=title, kind=kind)
    )


class Keyboard:
    """A terminal to type answers on: readline() blocks until a line is typed."""

    def __init__(self, tty: bool = True) -> None:
        self.lines: queue.Queue[str] = queue.Queue()
        self.tty = tty

    def readline(self) -> str:
        return self.lines.get()

    def isatty(self) -> bool:
        return self.tty


async def test_ask_in_terminal_y_n_and_always_remembered_per_kind_and_no_terminal_rejects(capsys):
    keyboard = Keyboard()
    asked = Out(False)
    ask = ask_in_terminal(input=keyboard, output=asked)
    signal = AbortController().signal

    def answer(text: str) -> None:
        asyncio.get_running_loop().call_later(0.005, keyboard.lines.put, f"{text}\n")

    answer("y")
    assert await ask(request("edit", "Edit a"), signal) == "allow"
    answer("n")
    assert await ask(request("edit", "Edit b"), signal) == "reject"
    answer("a")
    assert await ask(request("execute", "Run x"), signal) == "allow_always"
    assert await ask(request("execute", "Run y"), signal) == "allow", "not asked again"
    assert "? Allow Edit a? [y]es / [n]o / [a]lways for edit tools: " in asked.written
    not_tty = ask_in_terminal(input=Keyboard(tty=False), output=asked)
    assert await not_tty(request("edit"), signal) == "reject"
    assert await not_tty(request("edit"), signal) == "reject"
    assert capsys.readouterr().err.count("has no terminal to ask on") == 1


async def test_ask_in_terminal_a_cancelled_question_is_cancelled_and_its_line_goes_to_the_next():
    keyboard = Keyboard()
    ask = ask_in_terminal(input=keyboard, output=Out(False))
    controller = AbortController()
    asyncio.get_running_loop().call_later(0.01, controller.abort)
    assert await ask(request("edit"), controller.signal) == "cancelled"
    keyboard.lines.put("y\n")
    assert await ask(request("edit"), AbortController().signal) == "allow"
