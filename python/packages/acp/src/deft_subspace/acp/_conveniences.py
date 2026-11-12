"""The conveniences `start()` and `connect_session()` give a session:

    await agent.run("Fix the test", on_message=...)              # the TurnResult
    answer = await agent.text("What does this repo do?")         # just the text
    async for chunk in agent.stream("Explain it"): print(chunk, end="")
    files = await agent.json("Which files need changing?", schema=list[str])

`json()` asks for JSON only, finds it in the reply (bare, or in a code
fence, or the first object or array), checks it with your schema (any
validator `schemas` takes: a pydantic model, a TypeAdapter, a type, an object
with `parse()`), and if it does not fit asks once more, saying what was wrong.

A consumer that stops a `stream()` early stops the turn once the generator is
closed; `async with contextlib.aclosing(agent.stream(...))` closes it at once.
"""

from __future__ import annotations

import asyncio
import inspect
import json as _json
import re
from collections import deque
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from deft_subspace.kernel import SubspaceError

from . import schemas

if TYPE_CHECKING:
    from .client import PromptInput, Session
    from .model import TurnResult
    from .turn import Turn


class JsonAnswerError(SubspaceError):
    """A JSON value can't be found in the reply, or it never fit the schema."""

    def __init__(self, message: str, reply: str, problems: list[str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.reply = reply
        self.problems = list(problems or [])


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _parse(text: str) -> Any:
    # Strict, like JSON.parse: no NaN or Infinity.
    return _json.loads(text, parse_constant=_reject_constant)


# [ \t]* (not \s*) before the newline: one way to match, so it stays linear (blank lines are trimmed below).
_FENCE = re.compile(r"```(?:json)?[ \t]*\r?\n([\s\S]*?)```")
_OPEN = re.compile(r"[\[{]")


def find_json(reply: str) -> Any:
    """The first JSON value in a reply: all of it, a ```json fence, or the first balanced object or array."""
    attempts: list[str] = [reply.strip()]
    for match in _FENCE.finditer(reply):
        attempts.append(match.group(1).strip())
    found = _OPEN.search(reply)
    if found:
        start = found.start()
        # Scan for the matching close, minding strings.
        opening = reply[start]
        closing = "}" if opening == "{" else "]"
        depth = 0
        quoted = False
        i = start
        while i < len(reply):
            c = reply[i]
            if quoted:
                if c == "\\":
                    i += 1
                elif c == '"':
                    quoted = False
            elif c == '"':
                quoted = True
            elif c == opening:
                depth += 1
            elif c == closing:
                depth -= 1
                if depth == 0:
                    attempts.append(reply[start : i + 1])
                    break
            i += 1
    for attempt in attempts:
        try:
            return _parse(attempt)
        except ValueError:
            continue
    raise JsonAnswerError("The reply has no JSON value in it", reply)


def _instructions(shape: str | object | None) -> str:
    described = ""
    if shape is not None:
        text = shape if isinstance(shape, str) else _json.dumps(shape, indent=2, ensure_ascii=False)
        described = f"\n\nThe JSON should look like this:\n{text}"
    return f"{described}\n\nReply with only the JSON value: no explanation and no code fence."


class SessionConveniences:
    """`run()`, `prompt()`, `text()`, `stream()` and `json()` on a session. Prompt
    options (`limits`, `signal`, `timeout_ms`, handlers) are passed through."""

    def __init__(self, session: Session) -> None:
        self._conveniences_session = session

    def prompt(self, prompt: PromptInput, **options: Any) -> Turn:
        """Start a turn; iterate it, or pass handlers."""
        return self._conveniences_session.prompt(prompt, **options)

    async def run(self, prompt: PromptInput, **options: Any) -> TurnResult:
        """Run one turn and return its result (after its handlers ran)."""
        return await self._conveniences_session.prompt(prompt, **options)

    async def text(self, prompt: PromptInput, **options: Any) -> str:
        """Run one turn and return its text."""
        return (await self.run(prompt, **options)).text

    async def stream(self, prompt: PromptInput, **options: Any) -> AsyncIterator[str]:
        """The turn's text as it streams, messages separated as in `result.text`."""
        queue: deque[str] = deque()
        wake = asyncio.Event()
        own = options.get("on_message")

        async def on_message(delta: str, info: Any, event: Any) -> None:
            queue.append(info.separator + delta)
            wake.set()
            if own is not None:
                result = own(delta, info, event)
                if inspect.isawaitable(result):
                    await result

        turn = self._conveniences_session.prompt(prompt, **{**options, "on_message": on_message})
        ended = False
        done = asyncio.ensure_future(turn.done)

        def on_done(future: asyncio.Future[Any]) -> None:
            nonlocal ended
            ended = True
            wake.set()
            if not future.cancelled():
                future.exception()  # retrieved here; raised below if the consumer is still reading

        done.add_done_callback(on_done)
        try:
            while True:
                while queue:
                    yield queue.popleft()
                if ended:
                    break
                wake.clear()
                await wake.wait()
            await done
        finally:
            # A consumer that stops early stops the turn.
            if not ended:
                await turn.cancel()

    async def json(
        self,
        prompt: str,
        *,
        schema: schemas.Schema = None,
        shape: str | object | None = None,
        retries: int = 1,
        **options: Any,
    ) -> Any:
        """Ask for JSON, check it, and return the value.

        - `schema`: checks the answer (and makes the result); see `schemas`.
        - `shape`: what the JSON should look like, told to the agent: a description, an example, or a JSON Schema.
        - `retries`: how many times to ask again when the answer is not valid. Default 1.
        """
        session = self._conveniences_session
        reply = await session.prompt(f"{prompt}{_instructions(shape)}", **options)
        attempt = 0
        while True:
            try:
                value = find_json(reply.text)
                if schema is None:
                    return value
                ok, checked = schemas.check(schema, value)
                if inspect.isawaitable(checked):
                    checked = await checked
                if ok:
                    return checked
                problems: list[str] = list(checked)
            except JsonAnswerError:
                problems = ["there was no JSON value in the reply"]
            if attempt >= retries:
                raise JsonAnswerError(f"The reply never fit: {'; '.join(problems)}", reply.text, problems)
            attempt += 1
            reply = await session.prompt(f"That answer was not right: {'; '.join(problems)}.{_instructions(shape)}", **options)


def conveniences(session: Session) -> SessionConveniences:
    """The conveniences for `session`."""
    return SessionConveniences(session)
