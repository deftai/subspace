"""Logging in to an agent, one shape for v1 and v2.

The agent lists its ways to log in (`authMethods`) in `initialize`. v1 calls
`authenticate` and `logout`; v2 calls `auth/login` and `auth/logout`. Kinds:

- `agent`: the agent does it itself (opens a browser, reads a cached token,
  asks for an API key in its own way). `client.authenticate(id)` is all it takes.
- `terminal`: the agent wants to be run again, interactively, with `args` and
  `env` added, so the user can log in there. Only listed when the client says
  it can (`terminal_auth`); running it is the app's job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ._util import as_list
from .model import ProtocolVersion


@dataclass(frozen=True)
class AuthMethod:
    id: str
    name: str
    #: `agent`, `terminal`, or another kind the agent names (sent as is).
    type: str = "agent"
    description: str | None = None
    #: For `terminal`: arguments to add when running the agent again.
    args: list[str] | None = None
    #: For `terminal`: environment variables to set when running the agent again.
    env: dict[str, str] | None = None
    #: The agent's `_meta` for this method (Codex: which API key provider).
    meta: dict[str, Any] | None = None


def _env(raw: Any) -> dict[str, str] | None:
    # v1: {NAME: value}; v2: [{name, value}].
    if isinstance(raw, list):
        return {e["name"]: str(e.get("value") if e.get("value") is not None else "") for e in raw if isinstance(e, dict) and isinstance(e.get("name"), str)}
    if isinstance(raw, dict):
        return {k: str(v) for k, v in raw.items()}
    return None


def auth_methods_from(init: dict[str, Any]) -> list[AuthMethod]:
    """The login methods in an `initialize` answer. v1 methods without a type are `agent` ones."""
    methods: list[AuthMethod] = []
    for m in as_list(init.get("authMethods")):
        if not isinstance(m, dict):
            continue
        method_id = m["methodId"] if isinstance(m.get("methodId"), str) else m["id"] if isinstance(m.get("id"), str) else None
        if not method_id:
            continue
        methods.append(
            AuthMethod(
                id=method_id,
                name=m["name"] if isinstance(m.get("name"), str) else method_id,
                type=m["type"] if isinstance(m.get("type"), str) else "agent",
                description=m["description"] if isinstance(m.get("description"), str) else None,
                args=[str(a) for a in m["args"]] if isinstance(m.get("args"), list) else None,
                env=_env(m.get("env")),
                meta=m["_meta"] if isinstance(m.get("_meta"), dict) else None,
            )
        )
    return methods


def auth_method_names(protocol: ProtocolVersion) -> tuple[str, str]:
    """The method names for logging in and out."""
    return ("auth/login", "auth/logout") if protocol == 2 else ("authenticate", "logout")


def can_logout(protocol: ProtocolVersion, capabilities: dict[str, Any], methods: list[AuthMethod]) -> bool:
    """v1 says so in `agentCapabilities.auth.logout`; v2 agents must support `auth/logout` whenever they list login methods."""
    if protocol == 2:
        return len(methods) > 0
    auth = capabilities.get("auth")
    return isinstance(auth, dict) and (auth.get("logout") is True or isinstance(auth.get("logout"), dict))
