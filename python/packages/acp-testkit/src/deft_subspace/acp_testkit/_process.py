"""Record a real agent, check a program, and read and write trace files.

    agent = await record_agent("grok", args=["agent", "stdio"], cwd=cwd, workspace=cwd, label="plain turn")
    session = await agent.client.new_session(cwd)
    await session.prompt("hi")
    await agent.close()
    await save_trace("corpus/grok-plain.trace.jsonl", agent.recorder.records)

These start processes; the rest of the testkit works on any channel.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from deft_subspace.acp import ConnectedAgent, connect_agent
from deft_subspace.kernel import TraceRecord, format_trace, ndjson, parse_trace, spawn_process

from ._check import CheckResult
from ._check_agent import check_agent
from ._record import Recorder, recorder


@dataclass
class RecordedAgent(ConnectedAgent):
    """A connected agent whose every message is recorded, from the client's side."""

    recorder: Recorder


async def record_agent(
    command: str,
    *,
    args: Sequence[str] = (),
    label: str | None = None,
    meta: dict[str, Any] | None = None,
    redact: Callable[[Any, Literal["in", "out"]], Any] | None = None,
    tap: Callable[[Literal["in", "out"], Any], None] | None = None,
    **options: Any,
) -> RecordedAgent:
    """`connect_agent()` (with its options), with every message recorded from the client's side
    (`peer: "client"`). `meta` goes in the trace header, with the command."""
    rec = recorder(peer="client", label=label, meta={"command": " ".join([command, *args]), **(meta or {})}, redact=redact)

    def both(direction: Literal["in", "out"], message: Any) -> None:
        rec.tap(direction, message)
        if tap is not None:
            tap(direction, message)

    agent = await connect_agent(command, args=args, tap=both, **options)
    return RecordedAgent(agent.client, agent.process, rec)


async def save_trace(path: str | os.PathLike[str], records: Sequence[TraceRecord]) -> None:
    """Write a trace file (JSON Lines), making its folder if needed."""
    text = format_trace(records)

    def write() -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Bytes, so Windows writes \n and the file is the same as one written in TypeScript.
        target.write_bytes(text.encode("utf-8"))

    await asyncio.to_thread(write)


async def load_trace(path: str | os.PathLike[str]) -> list[TraceRecord]:
    """Read a trace file. Raises ValueError for a line that is not a trace record."""
    text = await asyncio.to_thread(Path(path).read_text, encoding="utf-8")
    return parse_trace(text)


async def check_agent_process(
    command: str,
    *,
    args: Sequence[str] = (),
    env: Mapping[str, str] | None = None,
    on_stderr: Callable[[str], None] | None = None,
    cwd: str | None = None,
    **checks: Any,
) -> list[CheckResult]:
    """Start an agent program, run `check_agent()` (with its options) against it, and stop it.
    `cwd` is both the program's folder and the sessions' cwd."""
    child = await spawn_process(command, args=args, env=env, on_stderr=on_stderr, cwd=cwd)
    try:
        return await check_agent(ndjson(child.channel), cwd=cwd, **checks)
    finally:
        await child.stop()
