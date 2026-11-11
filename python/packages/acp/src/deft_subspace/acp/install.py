"""Install registry binaries: `subspace agents install <name>`.

Safe enough, not more: only on request, never when an agent starts; only
archives the registry lists a SHA-256 for, checked while downloading; the
archive is unpacked into a fresh folder under the cache and the command must
stay inside it. The checksum comes from the same registry as the URL, so it
catches a changed or broken download, not a compromised registry.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .agents import _host_arch, _host_platform
from .registry import RegistryAgent, registry_target

MARKER = ".subspace-install.json"

Env = Mapping[str, str | None]


class InstallError(Exception):
    pass


@dataclass(frozen=True)
class Installed:
    id: str
    version: str
    #: The folder it was unpacked into.
    dir: str
    #: The command, by absolute path.
    command: str
    sha256: str
    #: Already installed with the same checksum: nothing was downloaded.
    reused: bool


def iso_now() -> str:
    """Now as JavaScript's `toISOString()` writes it: 2026-11-08T12:00:00.000Z."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _cache_home(env: Env) -> str:
    return env.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")


def binaries_path(env: Env | None = None) -> str:
    """Where installed binaries live: `<cache>/subspace/bin/<id>/<version>`."""
    return os.path.join(_cache_home(os.environ if env is None else env), "subspace", "bin")


def installed_binaries(env: Env | None = None) -> dict[str, str]:
    """Installed binaries, `<id>@<version>` -> folder (for `AgentCatalog.binaries`)."""
    root = binaries_path(env)
    found: dict[str, str] = {}
    if not os.path.exists(root):
        return found
    for agent_id in os.listdir(root):
        if agent_id.startswith("."):
            continue
        try:
            versions = os.listdir(os.path.join(root, agent_id))
        except OSError:
            continue
        for version in versions:
            folder = os.path.join(root, agent_id, version)
            if not version.startswith(".") and os.path.exists(os.path.join(folder, MARKER)):
                found[f"{agent_id}@{version}"] = folder
    return found


def _segment(value: str, what: str) -> str:
    """A path segment from registry data: no separators, no dot names."""
    if not value or value in (".", "..") or re.search(r"[\\/\0]", value):
        raise InstallError(f"the registry's {what} {json.dumps(value)} is not usable as a folder name")
    return value


def _inside(root: str, path: str) -> bool:
    try:
        rel = os.path.relpath(path, root)
    except ValueError:  # another drive (Windows)
        return False
    return rel not in ("", ".") and not rel.startswith("..") and not os.path.isabs(rel)


_TARS = re.compile(r"\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar)$")

Fetch = Callable[[str], Any]
"""`fetch(url)` returns a binary file-like response (`read(n)`, optionally `status`,
`reason` and `headers`), as `urllib.request.urlopen` does. It runs in a thread."""


async def install_agent(
    entry: RegistryAgent,
    *,
    env: Env | None = None,
    platform: str | None = None,
    arch: str | None = None,
    fetch: Fetch | None = None,
    max_bytes: int = 2 * 1024**3,
) -> Installed:
    """Download, check and unpack `entry`'s binary for this machine.

    - `env`: environment to read ($XDG_CACHE_HOME). Default `os.environ`.
    - `platform`, `arch`: the target. Default this machine.
    - `fetch`: how to download (see `Fetch`). Default `urllib.request.urlopen`.
    - `max_bytes`: refuse downloads larger than this. Default 2 GB.
    """
    target = registry_target(platform or _host_platform(), arch or _host_arch())
    binaries = entry["distribution"].get("binary") or {}
    binary = binaries.get(target)
    if not binary:
        has = list(binaries)
        raise InstallError(
            f"{entry['id']} has no binary for {target} (it has {', '.join(has)})" if has else f"{entry['id']} is not distributed as a binary"
        )
    sha256_wanted = binary.get("sha256")
    if not sha256_wanted:
        raise InstallError(
            f"the registry lists no sha256 for {entry['id']} on {target}, so Subspace does not install it; "
            f"install it yourself ({binary['archive']})"
        )
    url = urllib.parse.urlparse(binary["archive"])
    if url.scheme != "https":
        raise InstallError(f"{entry['id']}: refusing a download that is not https ({binary['archive']})")

    root = os.path.join(binaries_path(env), _segment(entry["id"], "id"))
    folder = os.path.join(root, _segment(entry["version"] or "unversioned", "version"))
    command = os.path.abspath(os.path.join(folder, binary["cmd"]))
    if not _inside(folder, command):
        raise InstallError(f"{entry['id']}: the command {json.dumps(binary['cmd'])} is outside its folder")
    marker_path = os.path.join(folder, MARKER)
    if os.path.exists(marker_path):
        with open(marker_path, encoding="utf-8") as f:
            marker = json.load(f)
        if isinstance(marker, dict) and marker.get("sha256") == sha256_wanted and os.path.exists(command):
            return Installed(entry["id"], entry["version"], folder, command, sha256_wanted, True)

    os.makedirs(root, exist_ok=True)
    tag = f"{os.getpid()}-{secrets.token_hex(4)}"
    download = os.path.join(root, f".download-{tag}")
    unpack = os.path.join(root, f".unpack-{tag}")
    try:
        sha256 = await asyncio.to_thread(_fetch_to, binary["archive"], download, fetch or urllib.request.urlopen, max_bytes)
        if sha256 != sha256_wanted:
            raise InstallError(f"{entry['id']}: the download's sha256 is {sha256}, the registry says {sha256_wanted}; not installed")

        os.mkdir(unpack)
        name = url.path.lower()
        if _TARS.search(name):
            await _run("tar", "-xf", download, "-C", unpack)
        elif name.endswith(".zip"):
            # bsdtar (macOS, Windows) reads zip files; GNU tar does not.
            if sys.platform.startswith("linux"):
                await _run("unzip", "-q", download, "-d", unpack)
            else:
                await _run("tar", "-xf", download, "-C", unpack)
        else:
            shutil.copyfile(download, os.path.join(unpack, os.path.basename(binary["cmd"])))

        # The command must exist and stay inside the folder, symlinks included.
        unpacked = os.path.abspath(os.path.join(unpack, binary["cmd"]))
        if not os.path.exists(unpacked):
            raise InstallError(f"{entry['id']}: the archive has no {binary['cmd']}")
        real = os.path.realpath(unpacked)
        if not _inside(os.path.realpath(unpack), real):
            raise InstallError(f"{entry['id']}: {binary['cmd']} points outside its folder")
        if not os.path.isfile(real):
            raise InstallError(f"{entry['id']}: {binary['cmd']} is not a file")
        if sys.platform != "win32":
            os.chmod(real, 0o755)

        marker = {"id": entry["id"], "version": entry["version"], "target": target, "archive": binary["archive"], "sha256": sha256, "installed": iso_now()}
        with open(os.path.join(unpack, MARKER), "w", encoding="utf-8") as f:
            f.write(json.dumps(marker, indent=2) + "\n")
        shutil.rmtree(folder, ignore_errors=True)
        os.rename(unpack, folder)
        return Installed(entry["id"], entry["version"], folder, command, sha256, False)
    finally:
        try:
            os.remove(download)
        except OSError:
            pass
        shutil.rmtree(unpack, ignore_errors=True)


async def _run(*command: str) -> None:
    await asyncio.to_thread(subprocess.run, list(command), check=True, capture_output=True)


def _fetch_to(url: str, path: str, fetch: Fetch, max_bytes: int) -> str:
    """Stream `url` into `path`, hashing as it goes; the hex SHA-256."""
    try:
        response = fetch(url)
    except urllib.error.HTTPError as error:
        raise InstallError(f"download failed: {error.code} {error.reason} ({url})") from error
    try:
        status = getattr(response, "status", None)
        if isinstance(status, int) and not 200 <= status < 300:
            raise InstallError(f"download failed: {status} {getattr(response, 'reason', '')} ({url})")
        headers = getattr(response, "headers", None)
        try:
            length = int(headers.get("content-length") or 0) if headers is not None else 0
        except (TypeError, ValueError):
            length = 0
        if length > max_bytes:
            raise InstallError(f"download is {length} bytes, over the {max_bytes} limit ({url})")
        digest = hashlib.sha256()
        count = 0
        with open(path, "wb") as out:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                count += len(chunk)
                if count > max_bytes:
                    raise InstallError(f"download is over the {max_bytes} byte limit ({url})")
                digest.update(chunk)
                out.write(chunk)
        return digest.hexdigest()
    finally:
        close = getattr(response, "close", None)
        if callable(close):
            close()
