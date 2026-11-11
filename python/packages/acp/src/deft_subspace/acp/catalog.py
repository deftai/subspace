"""Agent files and the registry cache.

Layers, lowest first: the ACP registry (the bundled snapshot, or a newer
cached copy from `refresh_registry()`), the built-in agents, then
  - $XDG_CONFIG_HOME/subspace/agents.toml (default ~/.config/subspace/agents.toml),
  - the nearest subspace.toml, from cwd up,
  - each file in $SUBSPACE_AGENTS (path-separated) and `files`.

    [agents.claude]                # change one field of a built-in agent
    extra_args = ["--verbose"]

    [agents.mine]                  # a new agent
    command = "node"
    args = ["/path/to/agent.js"]
    mode = "ask"

    [agents.mine.quirks.slow-start]
    summary = "Takes 20 s to answer initialize"
    fix = "Nothing to do; just wait"

Keys may be snake_case or camelCase; definitions use snake_case.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import tomllib
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, time
from typing import Any, Literal, NamedTuple

from .agents import AgentCatalog, AgentDefinition, CatalogLayer, builtin_catalog
from .install import Env, installed_binaries, iso_now
from .registry import REGISTRY_SNAPSHOT, REGISTRY_SNAPSHOT_DATE, REGISTRY_URL, Registry, trim_registry


class AgentFileError(Exception):
    pass


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _snake(key: str) -> str:
    """TOML keys in snake_case or camelCase, as snake_case."""
    return re.sub(r"[A-Z]", lambda m: f"_{m.group(0).lower()}", key)


def _json(value: Any) -> str:
    """`JSON.stringify(value)`, near enough for an error message."""

    def default(v: Any) -> Any:
        return v.isoformat() if isinstance(v, (date, datetime, time)) else str(v)

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=default)


Want = Literal["string", "strings", "env", "mode", "boolean"]


def _check(source: str, path: str, value: Any, want: Want) -> Any:
    def fail(what: str) -> None:
        raise AgentFileError(f"{source}: {path} should be {what}, not {_json(value)}")

    if want == "string":
        if not isinstance(value, str):
            fail("a string")
    elif want == "boolean":
        if not isinstance(value, bool):
            fail("true or false")
    elif want == "mode":
        if not isinstance(value, str) and value is not False:
            fail("a mode name, or false to keep the agent's own")
    elif want == "strings":
        if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
            fail("a list of strings")
    elif want == "env":
        if not isinstance(value, dict) or any(not isinstance(v, str) for v in value.values()):
            fail('a table of strings (KEY = "value")')
    return value


_AGENT_FIELDS: dict[str, Want] = {
    "name": "string",
    "description": "string",
    "registry": "string",
    "command": "string",
    "args": "strings",
    "extra_args": "strings",
    "env": "env",
    "mode": "mode",
    "install": "string",
    "login": "string",
    "aliases": "strings",
    "enabled": "boolean",
}
_QUIRK_FIELDS: dict[str, Want] = {
    "summary": "string",
    "waives": "strings",
    "fix": "string",
    "seen": "string",
    "upstream": "string",
    "enabled": "boolean",
}
_APPLY_FIELDS: dict[str, Want] = {"mode": "mode", "args": "strings", "env": "env"}
_NAME = re.compile(r"[a-z0-9][a-z0-9._-]*", re.IGNORECASE)


def _unknown_key(source: str, path: str, key: str, known: Sequence[str]) -> AgentFileError:
    return AgentFileError(f"{source}: {path}.{key} is not a known field (known: {', '.join(known)})")


def parse_agent_file(text: str, source: str) -> CatalogLayer:
    """Parse and check an agents file's text (TOML with an [agents] table). Other top-level tables are ignored."""
    try:
        raw = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise AgentFileError(f"{source}: {error}") from error
    return parse_agent_table(raw.get("agents"), source)


def parse_agent_table(table: Any, source: str, at: str = "agents") -> CatalogLayer:
    """Check an already-parsed agents table (name: definition), such as one
    nested in another tool's config. `at` names it in errors (default "agents")."""
    agents: dict[str, AgentDefinition] = {}
    if table is None:
        return CatalogLayer(source=source, agents=agents)
    if not _is_record(table):
        raise AgentFileError(f"{source}: {at} should be a table ([{at}.<name>])")
    for name, value in table.items():
        path = f"{at}.{name}"
        if not _NAME.fullmatch(name):
            raise AgentFileError(f"{source}: {path}: names are letters, digits, ., _ and -")
        if not _is_record(value):
            raise AgentFileError(f"{source}: {path} should be a table")
        definition: dict[str, Any] = {}
        for raw_key, field in value.items():
            key = _snake(raw_key)
            if key == "quirks":
                if not _is_record(field):
                    raise AgentFileError(f"{source}: {path}.quirks should be a table ([{path}.quirks.<id>])")
                quirks: dict[str, Any] = {}
                for quirk_id, q in field.items():
                    qpath = f"{path}.quirks.{quirk_id}"
                    if not _is_record(q):
                        raise AgentFileError(f"{source}: {qpath} should be a table")
                    quirk: dict[str, Any] = {}
                    for raw_qkey, qv in q.items():
                        qkey = _snake(raw_qkey)
                        if qkey == "apply":
                            if not _is_record(qv):
                                raise AgentFileError(f"{source}: {qpath}.apply should be a table")
                            apply: dict[str, Any] = {}
                            for ak, av in qv.items():
                                want = _APPLY_FIELDS.get(_snake(ak))
                                if want is None:
                                    raise _unknown_key(source, f"{qpath}.apply", ak, list(_APPLY_FIELDS))
                                apply[_snake(ak)] = _check(source, f"{qpath}.apply.{ak}", av, want)
                            quirk["apply"] = apply
                        else:
                            want = _QUIRK_FIELDS.get(qkey)
                            if want is None:
                                raise _unknown_key(source, qpath, raw_qkey, [*_QUIRK_FIELDS, "apply"])
                            quirk[qkey] = _check(source, f"{qpath}.{raw_qkey}", qv, want)
                    quirks[quirk_id] = quirk
                definition["quirks"] = quirks
                continue
            want = _AGENT_FIELDS.get(key)
            if want is None:
                raise _unknown_key(source, path, raw_key, [*_AGENT_FIELDS, "quirks"])
            definition[key] = _check(source, f"{path}.{raw_key}", field, want)
        agents[name] = definition  # type: ignore[assignment]
    return CatalogLayer(source=source, agents=agents)


class AgentFile(NamedTuple):
    path: str
    exists: bool


def _environ(env: Env | None) -> Env:
    return os.environ if env is None else env


def agent_files(*, cwd: str | None = None, files: Sequence[str] | None = None, env: Env | None = None) -> list[AgentFile]:
    """The files `load_catalog()` reads, in order, and whether each exists."""
    environ = _environ(env)
    paths: list[str] = [os.path.join(environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config"), "subspace", "agents.toml")]
    folder = os.path.abspath(cwd if cwd is not None else os.getcwd())
    while True:
        candidate = os.path.join(folder, "subspace.toml")
        if os.path.exists(candidate):
            paths.append(candidate)
            break
        if os.path.dirname(folder) == folder:
            break
        folder = os.path.dirname(folder)
    for item in (environ.get("SUBSPACE_AGENTS") or "").split(os.pathsep):
        if item:
            paths.append(os.path.abspath(item))
    for item in files or []:
        paths.append(os.path.abspath(item))
    return [AgentFile(path, os.path.exists(path)) for path in paths]


def registry_cache_path(env: Env | None = None) -> str:
    environ = _environ(env)
    return os.path.join(environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache"), "subspace", "registry.json")


class LoadedRegistry(NamedTuple):
    registry: Registry
    source: str


def load_registry(env: Env | None = None) -> LoadedRegistry:
    """The registry to use: the cached copy if it is newer than the bundled snapshot."""
    cache = registry_cache_path(env)
    try:
        with open(cache, encoding="utf-8") as f:
            cached = json.load(f)
        fetched_at = cached.get("fetchedAt") if isinstance(cached, dict) else None
        if isinstance(fetched_at, str) and fetched_at and fetched_at[:10] >= REGISTRY_SNAPSHOT_DATE:
            return LoadedRegistry(trim_registry(cached.get("registry")), f"{cache} ({fetched_at[:10]})")
    except (OSError, ValueError):
        pass  # No cache, or unreadable: the snapshot.
    return LoadedRegistry(REGISTRY_SNAPSHOT, f"bundled snapshot ({REGISTRY_SNAPSHOT_DATE})")


class RefreshedRegistry(NamedTuple):
    agents: int
    path: str


def _urlopen_json(url: str) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{url}: HTTP {error.code}") from error


async def refresh_registry(
    *, url: str | None = None, env: Env | None = None, fetch: Callable[[str], Any] | None = None
) -> RefreshedRegistry:
    """Fetch the latest ACP registry into the cache.

    `fetch(url)` returns the registry: parsed JSON, or its text or bytes (plain or async).
    Default: `urllib.request` in a thread.
    """
    where = url or REGISTRY_URL
    if fetch is None:
        body: Any = await asyncio.to_thread(_urlopen_json, where)
    else:
        body = fetch(where)
        if inspect.isawaitable(body):
            body = await body
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8")
    if isinstance(body, str):
        body = json.loads(body)
    registry = trim_registry(body)
    if not registry["agents"]:
        raise RuntimeError(f"{where}: no agents in the registry; keeping the old one")
    path = registry_cache_path(env)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"fetchedAt": iso_now(), "url": where, "registry": registry}, indent=2, ensure_ascii=False) + "\n")
    return RefreshedRegistry(len(registry["agents"]), path)


def load_catalog(
    *, cwd: str | None = None, files: Sequence[str] | None = None, builtin_only: bool = False, env: Mapping[str, str | None] | None = None
) -> AgentCatalog:
    """The agent catalog: registry, built-ins, then agent files. Raises AgentFileError for a bad file.

    - `cwd`: where to look for subspace.toml (and up). Default `os.getcwd()`.
    - `files`: more agent files, after the others.
    - `builtin_only`: skip ~/.config/subspace/agents.toml, subspace.toml and $SUBSPACE_AGENTS
      (built-ins and registry only).
    - `env`: environment to read ($XDG_CONFIG_HOME, $XDG_CACHE_HOME, $SUBSPACE_AGENTS). Default `os.environ`.
    """
    registry, source = load_registry(env)
    catalog = builtin_catalog(registry, source)
    catalog.binaries = installed_binaries(env)
    if builtin_only:
        return catalog
    wanted = [os.path.abspath(f) for f in files or []]
    for path, exists in agent_files(cwd=cwd, files=files, env=env):
        if not exists:
            if path in wanted:
                raise AgentFileError(f"{path}: no such file")
            continue
        with open(path, encoding="utf-8") as f:
            catalog.layers.append(parse_agent_file(f.read(), path))
    return catalog
