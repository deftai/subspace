"""Ready-made permission answers, so nobody hand-writes `on_permission`.

    start("claude", on_permission=read_only)                                    # reads yes, the rest no
    start("claude", on_permission=first_of(allow_inside(repo), ask_in_terminal()))  # edits in the repo yes, ask about the rest
    start("claude", on_permission=first_of(allow(kinds=["read", "search"]), reject(commands=re.compile("rm -rf")), "allow"))

A rule returns a decision, or None for "no opinion". `first_of()` turns rules
into a handler: the first decision wins, and a fixed decision ("allow",
"reject") can end the list. With no decision it rejects.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Callable
from typing import Any, Union

from deft_subspace.kernel import AbortSignal

from .model import PermissionRequest
from .permissions import PermissionDecision, PermissionHandler

PermissionRule = Callable[[PermissionRequest, AbortSignal], Any]
Pattern = Union[str, "re.Pattern[str]"]

#: Tool kinds that only look.
READ_KINDS = ["read", "search", "fetch", "think"]


def _normalize(path: str) -> str:
    """`a/./b/../c` to `a/c`; POSIX paths."""
    absolute = path.startswith("/")
    parts: list[str] = []
    for part in path.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
        else:
            parts.append(part)
    return ("/" if absolute else "") + "/".join(parts)


def request_paths(request: PermissionRequest) -> list[str]:
    """The paths a request touches: its tool call's locations and the usual input fields."""
    paths: dict[str, None] = {}
    call = request.tool_call
    for location in call.locations if call else []:
        if isinstance(location, dict) and isinstance(location.get("path"), str):
            paths[location["path"]] = None
    raw = call.raw_input if call else None
    if isinstance(raw, dict):
        for key in ("path", "file_path", "filePath", "file", "target", "destination", "source"):
            if isinstance(raw.get(key), str):
                paths[raw[key]] = None
        if isinstance(raw.get("paths"), list):
            for p in raw["paths"]:
                if isinstance(p, str):
                    paths[p] = None
    for content in call.content if call else []:
        if isinstance(content, dict) and isinstance(content.get("path"), str):
            paths[content["path"]] = None
    return list(paths)


def request_command(request: PermissionRequest) -> str | None:
    """The command a request would run, if it is one."""
    if request.command is not None:
        return request.command.command
    raw = request.tool_call.raw_input if request.tool_call else None
    if isinstance(raw, dict):
        if isinstance(raw.get("command"), str):
            return raw["command"]
        if isinstance(raw.get("command"), list):
            return " ".join(str(c) for c in raw["command"])
        if isinstance(raw.get("cmd"), str):
            return raw["cmd"]
    return None


def _text_matches(pattern: Pattern, text: str | None) -> bool:
    if text is None:
        return False
    return pattern in text if isinstance(pattern, str) else pattern.search(text) is not None


def inside(root: str, paths: list[str]) -> bool:
    """Whether every path is inside `root` (relative paths are taken as relative to it)."""
    base = _normalize(root).rstrip("/")

    def within(p: str) -> bool:
        full = _normalize(p if p.startswith("/") else f"{base}/{p}")
        return full == base or full.startswith(f"{base}/")

    return len(paths) > 0 and all(within(p) for p in paths)


def _matches(request: PermissionRequest, kinds: list[str] | None, titles: Pattern | None, commands: Pattern | None, inside_root: str | None) -> bool:
    if kinds is not None and (request.tool_call.kind if request.tool_call else None) not in kinds:
        return False
    if titles is not None and not _text_matches(titles, request.title):
        return False
    if commands is not None and not _text_matches(commands, request_command(request)):
        return False
    if inside_root is not None and not inside(inside_root, request_paths(request)):
        return False
    return True


def allow(*, kinds: list[str] | None = None, titles: Pattern | None = None, commands: Pattern | None = None, inside: str | None = None) -> PermissionRule:
    """Allow requests that match (all the given conditions); no opinion on the rest.

    `kinds`: tool kinds. `titles`: the request's title (a string matches if contained).
    `commands`: the command to run. `inside`: every path the request touches is inside this folder.
    """
    return lambda request, _signal: "allow" if _matches(request, kinds, titles, commands, inside) else None


def reject(*, kinds: list[str] | None = None, titles: Pattern | None = None, commands: Pattern | None = None, inside: str | None = None) -> PermissionRule:
    """Reject requests that match; no opinion on the rest."""
    return lambda request, _signal: "reject" if _matches(request, kinds, titles, commands, inside) else None


def allow_inside(root: str) -> PermissionRule:
    """Allow requests whose every path is inside `root`; no opinion on the rest (including requests with no path)."""
    return allow(inside=root)


def first_of(*rules: PermissionRule | PermissionDecision) -> PermissionHandler:
    """The first rule with a decision wins; a fixed decision may end the list. No decision at all rejects."""

    async def handler(request: PermissionRequest, signal: AbortSignal) -> Any:
        for rule in rules:
            decision = rule(request, signal) if callable(rule) else rule
            if inspect.isawaitable(decision):
                decision = await decision
            if decision is not None:
                return decision
        return "reject"

    return handler


read_only: PermissionRule = allow(kinds=READ_KINDS)
"""Reads, searches and fetches yes; no opinion on the rest. On its own (as `on_permission`)
the rest is rejected; first in `first_of(read_only, ask)` the rest goes on to `ask`."""
