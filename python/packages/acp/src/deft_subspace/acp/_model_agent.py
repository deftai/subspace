"""An ACP agent backed by a model: the turn loop, written once.

    serve_stdio(**model_agent(name="helper", model=my_model, system="You are terse.", tools={"list_files": list_files}))

Each ACP session gets its own conversation with the model. Per turn: the prompt
goes to the model; its text streams as agent messages and its thinking as
thoughts; each tool call is checked, shown, asked about if the tool says so,
run, and its result sent back; until the model stops calling tools (or
`max_steps`). A refused tool is reported to the model, which decides what to do
next. Cancelling the turn stops the model and the tools.

The model side is an adapter (`ModelAdapter`), so any model fits.
"""

from __future__ import annotations

import inspect
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, Union

from deft_subspace.kernel import AbortSignal

from .agent import AgentTurn, NewSessionRequest, PermissionDenied
from .model import ContentBlock
from .tools import ToolContext, ToolSet, check_tool_input, tool_input_schema, tool_output_text, tool_title


@dataclass(frozen=True)
class ModelTool:
    """A tool as the model sees it."""

    name: str
    description: str
    input_schema: dict[str, Any]
    #: The tool checks its input itself (so the adapter may stream inputs unchecked).
    validated: bool


@dataclass(frozen=True)
class ModelToolCall:
    id: str
    name: str
    input: Any


@dataclass(frozen=True)
class ModelReply:
    #: Why the model stopped: end_turn, tool_use, max_tokens, refusal, ...
    stop_reason: str
    tool_calls: list[ModelToolCall] = field(default_factory=list)


@dataclass(frozen=True)
class ToolResult:
    id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class PromptInput:
    prompt: list[ContentBlock]
    #: Results of the previous turn's tool calls that ran but the model never heard back
    #: about (the turn hit `max_steps` or was cancelled): give them to the model before the
    #: prompt. A call with no result never ran. A conversation that does not know the field
    #: still gets the prompt.
    interrupted_tool_results: list[ToolResult] = field(default_factory=list)


@dataclass(frozen=True)
class ToolResultsInput:
    tool_results: list[ToolResult]


ModelInput = Union[PromptInput, ToolResultsInput]
"""What goes to the model next: the user's prompt, or the results of its tool calls."""


@dataclass(frozen=True)
class ModelStream:
    on_text: Callable[[str], Awaitable[None]]
    on_thinking: Callable[[str], Awaitable[None]]
    signal: AbortSignal


class ModelConversation(Protocol):
    """One conversation with a model (one ACP session). It keeps its own history."""

    async def send(self, input: ModelInput, stream: ModelStream) -> ModelReply: ...


@dataclass(frozen=True)
class ConversationSetup:
    tools: list[ModelTool]
    cwd: str
    system: str | None = None


class ModelAdapter(Protocol):
    def conversation(self, setup: ConversationSetup) -> ModelConversation: ...


def model_agent(
    *,
    model: ModelAdapter,
    system: str | Callable[[str], str] | None = None,
    tools: ToolSet | None = None,
    max_steps: int = 50,
    close_session: Callable[[str], Any] | None = None,
    connection_closed: Callable[[list[str]], Any] | None = None,
    **agent_options: Any,
) -> dict[str, Any]:
    """`serve_agent` keyword arguments for an agent backed by a model.

    `system` is the system prompt, or a function of the session's folder. `max_steps`: model
    calls per turn before it is stopped (`max_turn_requests`). Other keyword arguments go to
    `serve_agent` as they are.
    """
    tool_set = tools or {}
    conversations: dict[str, ModelConversation] = {}
    cwds: dict[str, str] = {}
    #: Results of tool calls that ran after the model last heard back, for the next prompt.
    unsent: dict[str, list[ToolResult]] = {}
    model_tools = [
        ModelTool(name, d.description, tool_input_schema(d), d.schema is not None) for name, d in tool_set.items()
    ]

    def conversation_for(turn: AgentTurn) -> ModelConversation:
        conversation = conversations.get(turn.session_id)
        if conversation is None:
            cwd = cwds.get(turn.session_id, ".")
            prompt = system(cwd) if callable(system) else system
            conversation = model.conversation(ConversationSetup(tools=model_tools, cwd=cwd, system=prompt or None))
            conversations[turn.session_id] = conversation
        return conversation

    def new_session(request: NewSessionRequest) -> dict[str, str]:
        session_id = str(uuid.uuid4())
        cwds[session_id] = request.cwd
        return {"sessionId": session_id}

    def forget(session_id: str) -> None:
        conversations.pop(session_id, None)
        cwds.pop(session_id, None)
        unsent.pop(session_id, None)

    async def on_close(session_id: str) -> None:
        forget(session_id)
        if close_session is not None:
            result = close_session(session_id)
            if inspect.isawaitable(result):
                await result

    async def on_connection_closed(session_ids: list[str]) -> None:
        # A closed connection does not close its sessions: drop their conversations here.
        for session_id in session_ids:
            forget(session_id)
        if connection_closed is not None:
            result = connection_closed(session_ids)
            if inspect.isawaitable(result):
                await result

    async def prompt(turn: AgentTurn) -> str:
        conversation = conversation_for(turn)
        stream = ModelStream(on_text=turn.say, on_thinking=turn.think, signal=turn.signal)
        nxt: ModelInput = PromptInput(list(turn.prompt), unsent.pop(turn.session_id, []))

        def stop_with(stop: str, results: list[ToolResult]) -> str:
            # Tools that ran but whose results the model has not had yet: kept for the next prompt,
            # unless the session was forgotten (closed, or its connection closed) while the turn unwound.
            if results and conversations.get(turn.session_id) is conversation:
                unsent[turn.session_id] = results
            return stop

        for _step in range(max_steps):
            reply = await conversation.send(nxt, stream)
            if turn.signal.aborted:
                return "cancelled"
            if not reply.tool_calls:
                return _stop_reason_of(reply.stop_reason)
            results: list[ToolResult] = []
            for call in reply.tool_calls:
                if turn.signal.aborted:
                    return stop_with("cancelled", results)
                results.append(await _run_tool_call(turn, tool_set, call))
            if turn.signal.aborted:
                return stop_with("cancelled", results)
            nxt = ToolResultsInput(results)
        # The last input was never sent.
        return stop_with("max_turn_requests", nxt.tool_results if isinstance(nxt, ToolResultsInput) else nxt.interrupted_tool_results)

    return {
        **agent_options,
        "new_session": new_session,
        "close_session": on_close,
        "connection_closed": on_connection_closed,
        "prompt": prompt,
    }


async def _run_tool_call(turn: AgentTurn, tools: ToolSet, call: ModelToolCall) -> ToolResult:
    definition = tools.get(call.name)
    if definition is None:
        return ToolResult(call.id, f"There is no tool named {call.name}.", True)
    ok, value = check_tool_input(definition, call.input)
    if not ok:
        return ToolResult(call.id, f"Invalid input: {'; '.join(value)}", True)

    async def run(handle: Any) -> str:
        output = definition.run(value, ToolContext(handle.signal))
        if inspect.isawaitable(output):
            output = await output
        return tool_output_text(output)

    try:
        output = await turn.tool(
            tool_title(call.name, definition, value),
            run,
            id=call.id,
            kind=definition.kind or "other",
            raw_input=value,
            ask=definition.ask,
        )
        return ToolResult(call.id, output)
    except PermissionDenied:
        return ToolResult(call.id, "The user did not allow this tool call.", True)
    except Exception as error:  # noqa: BLE001
        return ToolResult(call.id, str(error) or type(error).__name__, True)


def _stop_reason_of(reason: str) -> str:
    if reason in ("max_tokens", "refusal"):
        return reason
    return "end_turn"
