"""Blocking versions of the one-call helpers, for scripts and REPLs without an event loop.

    from deft_subspace.acp.sync import run

    result = run("codex", "What does this repo do?", permissions="reject")
    print(result.text)

Each call starts the agent, runs one turn and stops the agent, in an event loop of its own. Where
a loop is already running (Jupyter, async code), `await` the async `deft_subspace.acp.run()` instead.
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import TYPE_CHECKING, Any, TypeVar

from . import _start

if TYPE_CHECKING:
    from ._start import AgentCommand, AgentName
    from .client import PromptInput
    from .model import TurnResult

T = TypeVar("T")


def _blocking(work: Coroutine[Any, Any, T], name: str) -> T:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(work)
    work.close()
    raise RuntimeError(
        f"deft_subspace.acp.sync.{name}() blocks, so it cannot run inside an event loop (Jupyter, async code). "
        f"Use `await deft_subspace.acp.{name}(...)` there."
    )


def run(agent: AgentName | AgentCommand, prompt: PromptInput, **options: Any) -> TurnResult:
    """Start `agent`, run one prompt, stop the agent, and return the turn's result. The options are
    the async `run()`'s: `permissions=` or `on_permission=` (one is required), `cwd=`, handlers such
    as `on_message=`, and the rest."""
    return _blocking(_start.run(agent, prompt, **options), "run")


def text(agent: AgentName | AgentCommand, prompt: PromptInput, **options: Any) -> str:
    """`run()`, returning only the agent's message text."""
    return run(agent, prompt, **options).text


__all__ = ["run", "text"]
