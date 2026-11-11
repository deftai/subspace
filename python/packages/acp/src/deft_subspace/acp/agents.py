"""Known agents: how to start them, and what they do that Subspace works around.

An agent comes from layers, each later one overriding the earlier field by field:

  1. the ACP agent registry (launch details and versions; see registry.py),
  2. Subspace's built-in curation (BUILTIN_AGENTS: short names, login and
     install hints, and quirks),
  3. files (`~/.config/subspace/agents.toml`, then `./subspace.toml`; see
     `load_catalog()` in catalog.py).

A quirk records something an agent does that it should not, or that a
client has to know: what it is (`summary`), which conformance checks it
explains (`waives`, used by `subspace check`), and the fix: text (`fix`:
what Subspace does about it), settings that are used (`apply`: a mode,
arguments, environment), or both. So every non-default setting says why.

    [agents.claude.quirks.starts-in-auto-mode]
    summary = "Starts in auto mode, where it writes and runs without asking"
    apply = { mode = "default" }

Definitions are dicts with snake_case keys (`extra_args`), as in the files.
"""

from __future__ import annotations

import platform as _platform
import re
import sys
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

from .registry import REGISTRY_SNAPSHOT, Registry, RegistryAgent, registry_target


class QuirkApply(TypedDict, total=False):
    """Settings used because of a quirk."""

    mode: str | Literal[False]
    args: list[str]
    env: dict[str, str]


class QuirkDefinition(TypedDict, total=False):
    """A quirk as a layer gives it: every field optional, so a file can change just one."""

    summary: str
    #: Conformance check ids this quirk explains; `subspace check` waives them.
    waives: list[str]
    #: What Subspace (or this agent's settings) does about it.
    fix: str
    #: Settings used because of it: a session mode, arguments appended, environment added.
    apply: QuirkApply
    #: Where or when it was seen (an agent version, a date).
    seen: str
    #: Where it is reported upstream (an issue URL).
    upstream: str
    #: False: ignore it (its settings are not used and its checks not waived).
    enabled: bool


@dataclass(frozen=True)
class Quirk:
    """An enabled quirk of a resolved agent."""

    summary: str
    waives: list[str] | None = None
    fix: str | None = None
    apply: QuirkApply | None = None
    seen: str | None = None
    upstream: str | None = None
    enabled: bool | None = None


class AgentFallback(TypedDict, total=False):
    command: str
    args: list[str]


class AgentDefinition(TypedDict, total=False):
    """An agent as a layer gives it: every field optional, so a file can change just one.

    - `registry`: take launch details (command, arguments, version) from this ACP registry entry.
    - `args`: replaces the arguments (the registry's, or an earlier layer's); `extra_args` are added after them.
    - `mode`: the session mode to switch to; False keeps the agent's own.
    - `aliases`: other names it answers to.
    - `enabled`: False hides it (a later layer can turn it back on).
    - `fallback`: how to start it when the registry has no entry for it (offline cache, a renamed id).
    """

    name: str
    description: str
    registry: str
    command: str
    args: list[str]
    extra_args: list[str]
    env: dict[str, str]
    mode: str | Literal[False]
    install: str
    login: str
    aliases: list[str]
    quirks: dict[str, QuirkDefinition]
    enabled: bool
    fallback: AgentFallback


@dataclass
class CatalogLayer:
    #: Where it came from: "built-in", a file path.
    source: str
    agents: dict[str, AgentDefinition]


@dataclass
class AgentCatalog:
    registry: Registry
    #: Where the registry came from: "snapshot (date)" or a cache file.
    registry_source: str
    #: Lowest first: later layers override earlier ones.
    layers: list[CatalogLayer]
    #: Registry binaries installed by `subspace agents install` (`install_agent`):
    #: `<id>@<version>` -> the folder they were unpacked into. Used by absolute path; PATH is not touched.
    binaries: dict[str, str] | None = None


LaunchKind = Literal["npx", "uvx", "binary", "command"]


@dataclass(frozen=True)
class ResolvedAgent:
    """An agent ready to start."""

    id: str
    name: str
    description: str
    command: str
    args: list[str]
    env: dict[str, str]
    #: How it is launched: a package runner (npx, uvx), a registry binary, or a plain command.
    launch: LaunchKind
    aliases: list[str]
    #: Enabled quirks, by id.
    quirks: dict[str, Quirk]
    #: Check id: reason, from the enabled quirks.
    waivers: dict[str, str]
    #: The layers that defined it, lowest first: "registry", "built-in", file paths.
    sources: list[str]
    #: From the registry, when it came from there.
    version: str | None = None
    mode: str | None = None
    install: str | None = None
    login: str | None = None
    registry: str | None = None


BUILTIN_AGENTS: dict[str, AgentDefinition] = {
    "claude": {
        "registry": "claude-acp",
        "aliases": ["claude-code"],
        "fallback": {"command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"]},
        "description": "Claude Code through its ACP adapter",
        "install": "Install Node.js (for npx); the adapter downloads on first start",
        "login": "Log in to Claude Code first: run `claude` and sign in, or set ANTHROPIC_API_KEY",
        "quirks": {
            "starts-in-auto-mode": {
                "summary": "Starts in auto mode, where it writes files and runs commands without asking",
                "apply": {"mode": "default"},
                "fix": "Sessions switch to its ask-first mode, so permission answers are consulted",
                "seen": "claude-agent-acp 0.101.0",
            },
            "refused-turn-ends-normally": {
                "summary": "A refused write ends the turn end_turn, with the tool call failed",
                "fix": "turn_end() reports completed; result.refused counts the refusal",
                "seen": "claude-agent-acp 0.101.0",
            },
            "account-in-auth-status": {
                "summary": "Sends the signed-in account (email, organization, plan) in _auth/status_update",
                "fix": "The testkit recorder redacts it from traces",
                "seen": "claude-agent-acp 0.101.0",
            },
        },
    },
    "codex": {
        "registry": "codex-acp",
        "fallback": {"command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"]},
        "install": "Install Node.js (for npx); the adapter downloads on first start",
        "login": "Log in to Codex first: run `codex login`, or set OPENAI_API_KEY",
        "quirks": {
            "starts-in-agent-mode": {
                "summary": "Starts in agent mode, where it runs commands without asking",
                "apply": {"mode": "read-only"},
                "fix": "Sessions switch to read-only mode, where it asks first (and still acts once allowed)",
                "seen": "codex-acp 2.5.0",
            },
            "refused-turn-ends-cancelled": {
                "summary": "A refused write ends the turn with stop reason cancelled, though nobody cancelled, "
                "and leaves the tool call pending",
                "fix": "turn_end() reports refused (result.refused counts it)",
                "seen": "codex-acp 2.5.0, 2026-11",
                "upstream": "https://github.com/agentclientprotocol/codex-acp/issues/556",
            },
            "reject-option-named-cancel": {
                "summary": "Its reject option is named cancel (kind reject_once)",
                "fix": "Permission answers pick options by kind, not name",
                "seen": "codex-acp 2.5.0",
            },
            "account-in-auth-status": {
                "summary": "Sends the signed-in account in _auth/status_update",
                "fix": "The testkit recorder redacts it from traces",
                "seen": "codex-acp 2.5.0",
            },
        },
    },
    "grok": {
        "registry": "grok-build",
        "command": "grok",
        "args": ["--permission-mode", "default", "agent", "stdio"],
        "install": "Install Grok Build (the `grok` command; also `npx @xai-official/grok`)",
        "login": "Log in to Grok Build first: run `grok` and sign in",
        "quirks": {
            "follows-always-approve": {
                "summary": "Follows an always-approve permission_mode in ~/.grok/config.toml, so it never asks",
                "fix": "Started with --permission-mode default (in its arguments), so it asks first",
            },
            "unknown-session-32602": {
                "summary": "Answers a prompt for an unknown session with -32602 Invalid params, not -32002",
                "waives": ["session.unknown"],
                "seen": "Grok Build, 2026-11",
            },
            "refused-turn-ends-cancelled": {
                "summary": "A refused write ends the turn with stop reason cancelled, though nobody cancelled",
                "fix": "turn_end() reports refused (result.refused counts it)",
                "seen": "Grok Build 1.0.77, 2026-11",
            },
            "vendor-notifications": {
                "summary": "Sends many _x.ai/* extension notifications around session/new and each turn",
                "fix": "The client ignores extension notifications it has no handler for",
                "seen": "Grok Build 1.0.77, 2026-11",
            },
        },
    },
    "gemini": {
        "registry": "gemini",
        "fallback": {"command": "npx", "args": ["-y", "@google/gemini-cli", "--acp"]},
        "install": "Install Node.js (for npx), or the Gemini CLI (npm install -g @google/gemini-cli)",
        "login": "Log in to the Gemini CLI first: run `gemini` and sign in, or set GEMINI_API_KEY",
    },
    "opencode": {
        "registry": "opencode",
        "fallback": {"command": "opencode", "args": ["acp"]},
        "install": "Install OpenCode (the `opencode` command)",
        "login": "Log in to OpenCode first: run `opencode auth login`",
    },
}
"""Subspace's curation of the agents it knows best. Launch details come from
the registry where it has them; quirks come from the testkit's recorded
corpus (packages/acp-testkit/corpus)."""

BuiltinAgentName = Literal["claude", "codex", "grok", "gemini", "opencode"]


def builtin_catalog(registry: Registry | None = None, registry_source: str = "snapshot") -> AgentCatalog:
    """A catalog of the built-in layer and the bundled registry snapshot (no files)."""
    return AgentCatalog(
        registry=REGISTRY_SNAPSHOT if registry is None else registry,
        registry_source=registry_source,
        layers=[CatalogLayer(source="built-in", agents=BUILTIN_AGENTS)],
    )


def _merge_quirks(into: dict[str, dict[str, Any]], source: dict[str, QuirkDefinition] | None) -> None:
    for quirk_id, quirk in (source or {}).items():
        into[quirk_id] = {**into.get(quirk_id, {}), **quirk}


def _canonical(catalog: AgentCatalog, name: str) -> str | None:
    """The name a lookup means: a defined name, an alias, or a registry id."""
    for layer in reversed(catalog.layers):
        if layer.agents.get(name) is not None:
            return name
    for layer in reversed(catalog.layers):
        for key, definition in layer.agents.items():
            if name in (definition.get("aliases") or []):
                return key
    if any(a["id"] == name for a in catalog.registry["agents"]):
        return name
    return None


def _registry_launch(entry: RegistryAgent, platform: str, arch: str, binaries: dict[str, str] | None) -> dict[str, Any]:
    d = entry["distribution"]
    npx = d.get("npx")
    if npx:
        return {"command": "npx", "args": ["-y", npx["package"], *npx.get("args", [])], "env": npx.get("env", {}), "launch": "npx"}
    uvx = d.get("uvx")
    if uvx:
        return {"command": "uvx", "args": [uvx["package"], *uvx.get("args", [])], "env": uvx.get("env", {}), "launch": "uvx"}
    binary = d.get("binary") or {}
    own = binary.get(registry_target(platform, arch))
    target = own if own is not None else next(iter(binary.values()), None)
    # Installed by `subspace agents install`: run it from there.
    folder = (binaries or {}).get(f"{entry['id']}@{entry['version']}")
    if target and folder:
        cmd = target["cmd"][2:] if target["cmd"].startswith("./") else target["cmd"]
        command = f"{_trim_trailing_separators(folder)}/{cmd}"
        install = f"It was installed by `subspace agents install {entry['id']}` into {folder}; run that again if it is missing"
        return {
            "command": command,
            "args": target.get("args", []),
            "env": target.get("env", {}),
            "launch": "binary",
            "install": install,
            "installed": True,
        }
    # Otherwise it is expected on PATH under its command's name.
    command = re.split(r"[\\/]", target["cmd"] if target else entry["id"])[-1]
    # Only this machine's download can be installed.
    if not own:
        install = None
    elif own.get("sha256"):
        install = (
            f"Run `subspace agents install {entry['id']}`, or install {entry['name']} so `{command}` is on PATH "
            f"(download: {own['archive']})"
        )
    else:
        install = (
            f"Install {entry['name']} so `{command}` is on PATH (download: {own['archive']}; "
            "the registry lists no checksum for it, so Subspace does not install it)"
        )
    out: dict[str, Any] = {
        "command": command,
        "args": target.get("args", []) if target else [],
        "env": target.get("env", {}) if target else {},
        "launch": "binary",
    }
    if install:
        out["install"] = install
        out["installable"] = bool(own and own.get("sha256"))
    return out


def _host_platform() -> str:
    return sys.platform


def _host_arch() -> str:
    return _platform.machine() or "x64"


def resolve_agent(catalog: AgentCatalog, name: str, *, platform: str | None = None, arch: str | None = None) -> ResolvedAgent | None:
    """Resolve a name (a defined name, an alias, or a registry id). None when unknown.

    `platform` and `arch` pick a registry binary; default this machine.
    """
    host_platform = platform if platform is not None else _host_platform()
    host_arch = arch if arch is not None else _host_arch()
    agent_id = _canonical(catalog, name)
    if not agent_id:
        return None
    merged: dict[str, Any] = {}
    quirks: dict[str, dict[str, Any]] = {}
    sources: list[str] = []
    extra_args: list[str] = []
    env: dict[str, str] = {}
    aliases: dict[str, None] = {}
    #: An install hint from the user's own files (not the built-in one).
    own_install: str | None = None
    for layer in catalog.layers:
        definition = layer.agents.get(agent_id)
        if definition is None:
            continue
        sources.append(layer.source)
        if layer.source != "built-in" and definition.get("install") is not None:
            own_install = definition.get("install")
        fields = {k: v for k, v in definition.items() if k not in ("quirks", "extra_args", "env", "aliases")}
        # A layer that sets args starts the extra arguments over.
        if fields.get("args") is not None:
            extra_args.clear()
        merged.update({k: v for k, v in fields.items() if v is not None})
        _merge_quirks(quirks, definition.get("quirks"))
        extra_args.extend(definition.get("extra_args") or [])
        env.update(definition.get("env") or {})
        for alias in definition.get("aliases") or []:
            aliases[alias] = None
    if merged.get("enabled") is False:
        return None
    registry_id = merged.get("registry", agent_id)
    entry = next((a for a in catalog.registry["agents"] if a["id"] == registry_id), None)
    if entry is not None:
        sources.insert(0, "registry")
    launch: dict[str, Any] | None
    if entry is not None:
        launch = _registry_launch(entry, host_platform, host_arch, catalog.binaries)
    elif merged.get("fallback"):
        fallback = merged["fallback"]
        fallback_command = fallback.get("command")
        launch = {
            "command": fallback_command,
            "args": fallback.get("args") or [],
            "env": {},
            "launch": fallback_command if fallback_command in ("npx", "uvx") else "command",
        }
    else:
        launch = None
    launch_command = launch.get("command") if launch else None
    command = merged["command"] if merged.get("command") is not None else launch_command
    if not command:
        return None
    enabled = {
        quirk_id: Quirk(**{k: v for k, v in q.items() if k in Quirk.__dataclass_fields__})
        for quirk_id, q in quirks.items()
        if q.get("enabled") is not False and isinstance(q.get("summary"), str)
    }
    # Quirk settings first; the agent's own fields (from any layer) win over them.
    mode: str | Literal[False] | None = None
    quirk_args: list[str] = []
    quirk_env: dict[str, str] = {}
    for quirk in enabled.values():
        apply = quirk.apply or {}
        applied_mode = apply.get("mode")
        if applied_mode is not None:
            mode = applied_mode
        quirk_args.extend(apply.get("args") or [])
        quirk_env.update(apply.get("env") or {})
    if merged.get("mode") is not None:
        mode = merged["mode"]
    # A command of its own means the registry's arguments are not its arguments.
    own_command_set = bool(merged.get("command")) and merged.get("command") != launch_command
    if merged.get("args") is not None:
        base_args = list(merged["args"])
    else:
        base_args = [] if own_command_set else list(launch.get("args") or []) if launch else []
    waivers: dict[str, str] = {}
    for quirk in enabled.values():
        for check in quirk.waives or []:
            waivers[check] = quirk.summary
    # Your own hint wins. A command of your own makes the registry's hint beside the point.
    # Otherwise the registry knows better than the built-in hint when the binary is
    # installed, or Subspace can install it; the built-in hint covers the rest.
    own_command = merged.get("command") is not None and merged.get("command") != launch_command
    known = launch or {}
    if own_install is not None:
        install = own_install
    elif own_command:
        install = merged.get("install")
    elif known.get("installed") or known.get("installable"):
        install = known.get("install")
    else:
        install = merged["install"] if merged.get("install") is not None else known.get("install")
    return ResolvedAgent(
        id=agent_id,
        name=merged["name"] if merged.get("name") is not None else entry["name"] if entry is not None else agent_id,
        description=merged["description"] if merged.get("description") is not None else (entry["description"] if entry is not None else ""),
        version=entry["version"] if entry is not None and entry["version"] else None,
        command=command,
        args=[*base_args, *quirk_args, *extra_args],
        env={**({} if own_command_set else (known.get("env") or {})), **quirk_env, **env},
        mode=mode if mode else None,
        install=install if install else None,
        login=merged.get("login") or None,
        registry=entry["id"] if entry is not None else None,
        launch="command" if own_command_set else (known.get("launch") or "command"),
        aliases=list(aliases),
        quirks=enabled,
        waivers=waivers,
        sources=sources,
    )


def list_agents(catalog: AgentCatalog) -> list[ResolvedAgent]:
    """Every agent the layers define (in order), then the registry's other agents."""
    names: dict[str, None] = {}
    for layer in catalog.layers:
        for name in layer.agents:
            names[name] = None
    defined = [a for a in (resolve_agent(catalog, n) for n in names) if a is not None]
    claimed = {x for a in defined for x in (a.id, *([a.registry] if a.registry else []))}
    others = [
        a
        for a in (resolve_agent(catalog, entry["id"]) for entry in catalog.registry["agents"] if entry["id"] not in claimed)
        if a is not None
    ]
    return [*defined, *others]


def _trim_trailing_separators(folder: str) -> str:
    """`folder` without trailing slashes or backslashes (a loop, not a regex: linear on any input)."""
    end = len(folder)
    while end > 0 and folder[end - 1] in ("/", "\\"):
        end -= 1
    return folder[:end]
