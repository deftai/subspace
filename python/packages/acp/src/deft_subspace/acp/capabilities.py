"""What each side said it can do in `initialize`, as one shape for v1 and v2.

v1 and v2 spell capabilities differently (v1 booleans and `sessionCapabilities`;
v2 marker objects under `session`, and some methods that are simply part of v2).
Read `client.supports` / `turn.client_supports` instead of the raw fields.
Helpers that need a capability raise a `CapabilityError` naming it, rather
than sending a request the other side said it cannot answer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .model import ProtocolVersion


@dataclass(frozen=True)
class PromptSupport:
    image: bool = False
    audio: bool = False
    embedded_context: bool = False


@dataclass(frozen=True)
class McpSupport:
    """MCP server transports the agent takes. v1 requires stdio of every agent; v2 advertises it.
    `acp`: servers the client serves over the ACP connection (MCP-over-ACP)."""

    stdio: bool = False
    http: bool = False
    sse: bool = False
    acp: bool = False

    def __getitem__(self, transport: str) -> bool:
        return bool(getattr(self, transport, False))


@dataclass(frozen=True)
class AgentSupport:
    #: Open a session and replay its history (v1 `session/load`, v2 `session/resume` from the start).
    load_session: bool
    #: Reopen a session without replay (`session/resume`).
    resume_session: bool
    close_session: bool
    list_sessions: bool
    delete_session: bool
    additional_directories: bool
    #: Content a prompt may carry besides text and resource links.
    prompt: PromptSupport
    mcp: McpSupport


@dataclass(frozen=True)
class ElicitationSupport:
    form: bool = False
    url: bool = False

    def __getitem__(self, mode: str) -> bool:
        return bool(getattr(self, mode, False))


@dataclass(frozen=True)
class ClientSupport:
    read_text_file: bool
    write_text_file: bool
    #: v1 only; v2 removed client terminals.
    terminal: bool
    elicitation: ElicitationSupport


class CapabilityError(Exception):
    def __init__(self, capability: str, who: Literal["agent", "client"]) -> None:
        super().__init__(f"The {who} does not offer {capability}")
        self.capability = capability
        self.who = who


def _rec(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _on(value: Any) -> bool:
    """v2 capability markers are objects; v1 uses booleans. Either counts."""
    return value is True or isinstance(value, dict)


def agent_support(protocol: ProtocolVersion, capabilities: dict[str, Any]) -> AgentSupport:
    if protocol == 2:
        session = _rec(capabilities.get("session"))
        prompt = _rec(session.get("prompt"))
        mcp = _rec(session.get("mcp"))
        return AgentSupport(
            load_session=True,
            resume_session=True,
            close_session=True,
            list_sessions=True,
            delete_session=_on(session.get("delete")),
            additional_directories=_on(session.get("additionalDirectories")),
            prompt=PromptSupport(_on(prompt.get("image")), _on(prompt.get("audio")), _on(prompt.get("embeddedContext"))),
            mcp=McpSupport(stdio=_on(mcp.get("stdio")), http=_on(mcp.get("http")), sse=False, acp=_on(mcp.get("acp"))),
        )
    session = _rec(capabilities.get("sessionCapabilities"))
    prompt = _rec(capabilities.get("promptCapabilities"))
    mcp = _rec(capabilities.get("mcpCapabilities"))
    return AgentSupport(
        load_session=capabilities.get("loadSession") is True,
        resume_session=_on(session.get("resume")),
        close_session=_on(session.get("close")),
        list_sessions=_on(session.get("list")),
        delete_session=_on(session.get("delete")),
        additional_directories=_on(session.get("additionalDirectories")),
        prompt=PromptSupport(prompt.get("image") is True, prompt.get("audio") is True, prompt.get("embeddedContext") is True),
        mcp=McpSupport(stdio=True, http=mcp.get("http") is True, sse=mcp.get("sse") is True, acp=mcp.get("acp") is True),
    )


def client_support(protocol: ProtocolVersion, capabilities: dict[str, Any]) -> ClientSupport:
    elicitation = _rec(capabilities.get("elicitation"))
    fs = _rec(capabilities.get("fs"))
    return ClientSupport(
        read_text_file=protocol == 1 and fs.get("readTextFile") is True,
        write_text_file=protocol == 1 and fs.get("writeTextFile") is True,
        terminal=protocol == 1 and capabilities.get("terminal") is True,
        elicitation=ElicitationSupport(_on(elicitation.get("form")), _on(elicitation.get("url"))),
    )
