"""Tools as data: one definition, used three ways.

    list_files = tool(
        description="List the files in a folder",
        input={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        kind="read",
        run=lambda args, ctx: os.listdir(args["path"]),
    )

- An agent built on a model offers it to the model (`model_agent(tools=...)`).
- Any agent runs it as a step: `await turn.use_tool(list_files, {"path": "."})`.
- A client serves it to the agent over the ACP connection: `client.serve_tools(name=..., tools=...)`.

`input` is the JSON Schema the model (or the MCP client) sees. `schema` is an
optional validator (see `schemas`: a pydantic model, ...) that checks the input
before `run`; if it can produce a JSON Schema itself, `input` may be left out.
`run(input, context)` may be a plain or a coroutine function.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from deft_subspace.kernel import AbortSignal

from . import schemas


@dataclass(frozen=True)
class ToolContext:
    #: Fires when the turn is cancelled.
    signal: AbortSignal


@dataclass(frozen=True)
class ToolDefinition:
    description: str
    run: Callable[[Any, ToolContext], Any]
    #: JSON Schema for the input (an object schema).
    input: dict[str, Any] | None = None
    #: Checks (and converts) the input before `run`.
    schema: schemas.Schema | None = None
    #: ACP tool kind: read, edit, delete, move, search, execute, think, fetch, other. Default other.
    kind: str | None = None
    #: Ask the user first (True, or the question to ask).
    ask: bool | str = False
    #: What the client shows for a call: a string, or a function of the input. Default: the tool's name.
    title: str | Callable[[Any], str] | None = None


ToolSet = dict[str, ToolDefinition]


def tool(
    *,
    description: str,
    run: Callable[[Any, ToolContext], Any],
    input: dict[str, Any] | None = None,
    schema: schemas.Schema | None = None,
    kind: str | None = None,
    ask: bool | str = False,
    title: str | Callable[[Any], str] | None = None,
) -> ToolDefinition:
    """Define a tool."""
    return ToolDefinition(description=description, run=run, input=input, schema=schema, kind=kind, ask=ask, title=title)


def tool_input_schema(definition: ToolDefinition) -> dict[str, Any]:
    """The JSON Schema for a tool's input: `input`, or one its validator can produce, or any object."""
    if definition.input is not None:
        return definition.input
    if definition.schema is not None:
        produced = schemas.json_schema(definition.schema)
        if produced:
            return produced
    return {"type": "object"}


def check_tool_input(definition: ToolDefinition, value: Any) -> tuple[bool, Any]:
    """`(True, input)` checked by the tool's validator (if it has one), or `(False, problems)`."""
    if definition.schema is None:
        return True, value
    return schemas.check(definition.schema, value)


def tool_output_text(output: Any) -> str:
    """A tool's output as text (for a model, or for MCP content): strings as they are, the rest as JSON."""
    if isinstance(output, str):
        return output
    if output is None:
        return ""
    output = schemas.to_json(output)
    try:
        return json.dumps(output, indent=2, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(output)


def tool_title(name: str, definition: ToolDefinition, value: Any) -> str:
    title = definition.title
    if callable(title):
        try:
            return title(value)
        except Exception:  # noqa: BLE001
            return name
    return title or name
