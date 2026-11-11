"""The ACP agent registry (the "ACP Agent Registry" RFD): manifests of ACP
agents and how to run them, published at REGISTRY_URL. Subspace bundles a
snapshot (`registry_snapshot.json`) and can fetch the latest into a cache
(`subspace agents --refresh`).

`registry_snapshot.json` is generated from REGISTRY_URL (the same data as the
TypeScript package's `registry-snapshot.ts`); do not edit it.
"""

from __future__ import annotations

import json
import re
from importlib import resources
from typing import Any, NotRequired, TypedDict

REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"


class RegistryLaunch(TypedDict):
    package: str
    args: NotRequired[list[str]]
    env: NotRequired[dict[str, str]]


class RegistryBinary(TypedDict):
    archive: str
    #: The archive's SHA-256, hex. `subspace agents install` refuses a binary without one.
    sha256: NotRequired[str]
    cmd: str
    args: NotRequired[list[str]]
    env: NotRequired[dict[str, str]]


class RegistryDistribution(TypedDict, total=False):
    npx: RegistryLaunch
    uvx: RegistryLaunch
    #: Keyed by target: darwin-aarch64, darwin-x86_64, linux-aarch64, linux-x86_64, windows-aarch64, windows-x86_64.
    binary: dict[str, RegistryBinary]


class RegistryAgent(TypedDict):
    id: str
    name: str
    version: str
    description: str
    repository: NotRequired[str]
    website: NotRequired[str]
    license: NotRequired[str]
    distribution: RegistryDistribution


class Registry(TypedDict):
    version: str
    agents: list[RegistryAgent]


def _js_string(value: Any) -> str:
    """`String(value)` as JavaScript writes it (true, 2 rather than True, 2.0)."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _strings(value: Any) -> list[str] | None:
    return [_js_string(v) for v in value] if isinstance(value, list) else None


def _env(value: Any) -> dict[str, str] | None:
    return {str(k): _js_string(v) for k, v in value.items()} if isinstance(value, dict) else None


def _launch(value: Any) -> RegistryLaunch | None:
    if not isinstance(value, dict) or not isinstance(value.get("package"), str):
        return None
    out: RegistryLaunch = {"package": value["package"]}
    args = _strings(value.get("args"))
    variables = _env(value.get("env"))
    if args:
        out["args"] = args
    if variables:
        out["env"] = variables
    return out


_SHA256 = re.compile(r"[0-9a-f]{64}", re.IGNORECASE)


def trim_registry(raw: Any) -> Registry:
    """Keep the fields Subspace uses, and drop entries that do not parse."""
    source = raw if isinstance(raw, dict) else {}
    agents: list[RegistryAgent] = []
    entries = source.get("agents")
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not isinstance(entry.get("distribution"), dict):
            continue
        d = entry["distribution"]
        binary: dict[str, RegistryBinary] = {}
        binaries = d.get("binary")
        for target, b in (binaries if isinstance(binaries, dict) else {}).items():
            if not isinstance(b, dict) or not isinstance(b.get("cmd"), str) or not isinstance(b.get("archive"), str):
                continue
            item: dict[str, Any] = {"archive": b["archive"]}
            sha256 = b.get("sha256")
            if isinstance(sha256, str) and _SHA256.fullmatch(sha256):
                item["sha256"] = sha256.lower()
            item["cmd"] = b["cmd"]
            args = _strings(b.get("args"))
            variables = _env(b.get("env"))
            if args:
                item["args"] = args
            if variables:
                item["env"] = variables
            binary[str(target)] = item  # type: ignore[assignment]
        npx = _launch(d.get("npx"))
        uvx = _launch(d.get("uvx"))
        if not npx and not uvx and not binary:
            continue
        distribution: RegistryDistribution = {}
        if npx:
            distribution["npx"] = npx
        if uvx:
            distribution["uvx"] = uvx
        if binary:
            distribution["binary"] = binary
        agent: dict[str, Any] = {
            "id": entry["id"],
            "name": entry["name"] if isinstance(entry.get("name"), str) else entry["id"],
            "version": "" if entry.get("version") is None else _js_string(entry["version"]),
            "description": "" if entry.get("description") is None else _js_string(entry["description"]),
        }
        for key in ("repository", "website", "license"):
            if isinstance(entry.get(key), str):
                agent[key] = entry[key]
        agent["distribution"] = distribution
        agents.append(agent)  # type: ignore[arg-type]
    version = source.get("version")
    return {"version": "" if version is None else _js_string(version), "agents": agents}


def registry_target(platform: str, arch: str) -> str:
    """This machine's registry target, e.g. darwin-aarch64.

    Takes Node's names (darwin, win32; arm64, x64) and Python's (`sys.platform`,
    `platform.machine()`: arm64, aarch64, x86_64, AMD64).
    """
    os_name = "windows" if platform == "win32" else "linux" if platform.startswith("linux") else platform
    machine = arch.lower()
    cpu = "aarch64" if machine in ("arm64", "aarch64") else "x86_64" if machine in ("x64", "x86_64", "amd64") else arch
    return f"{os_name}-{cpu}"


def _load_snapshot() -> tuple[str, Registry]:
    data = json.loads(resources.files(__package__ or "deft_subspace.acp").joinpath("registry_snapshot.json").read_text(encoding="utf-8"))
    return data["date"], data["registry"]


REGISTRY_SNAPSHOT_DATE, REGISTRY_SNAPSHOT = _load_snapshot()
"""The bundled registry snapshot, and the day it was taken."""
