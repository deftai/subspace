"""Installing registry binaries: checked downloads, unpacked under the cache, used by absolute path."""

from __future__ import annotations

import hashlib
import io
import os
import re
import subprocess
import sys
import tarfile
import time
import zipfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from deft_subspace.acp.agents import CatalogLayer, resolve_agent
from deft_subspace.acp.catalog import load_catalog
from deft_subspace.acp.install import InstallError, install_agent, installed_binaries
from deft_subspace.acp.registry import RegistryAgent

HOST = {"platform": "darwin", "arch": "arm64"}
TARGET = "darwin-aarch64"
POSIX = pytest.mark.skipif(sys.platform == "win32", reason="runs a shell script")


def archive(folder: Path, kind: str, files: dict[str, str]) -> tuple[str, str]:
    """An archive built from `files` (path -> content; '->x' makes a symlink to x), and its sha256."""
    path = folder / f"agent.{kind}"
    if kind == "zip":
        with zipfile.ZipFile(path, "w") as z:
            for name, content in files.items():
                info = zipfile.ZipInfo(name)
                info.external_attr = 0o100755 << 16
                z.writestr(info, content)
    else:
        with tarfile.open(path, "w:gz") as t:
            for name, content in files.items():
                info = tarfile.TarInfo(name)
                if content.startswith("->"):
                    info.type = tarfile.SYMTYPE
                    info.linkname = content[2:]
                    t.addfile(info)
                else:
                    data = content.encode()
                    info.size = len(data)
                    info.mode = 0o755
                    t.addfile(info, io.BytesIO(data))
    return str(path), hashlib.sha256(path.read_bytes()).hexdigest()


class Serving:
    """A fetch that serves one file for any URL, and counts calls."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.calls: list[str] = []

    def __call__(self, url: str) -> Any:
        self.calls.append(url)
        return open(self.path, "rb")


def entry(binary: dict[str, Any], agent_id: str = "tool") -> RegistryAgent:
    return {
        "id": agent_id,
        "name": "Tool",
        "version": "1.2.3",
        "description": "",
        "distribution": {"binary": {TARGET: {"archive": "https://example.com/tool.tar.gz", "cmd": "./bin/tool", **binary}}},  # type: ignore[typeddict-item]
    }


@pytest.fixture
def env(tmp_path):
    (tmp_path / "cache").mkdir()
    (tmp_path / "config").mkdir()
    return {"XDG_CACHE_HOME": str(tmp_path / "cache"), "XDG_CONFIG_HOME": str(tmp_path / "config")}


@POSIX
async def test_a_checksummed_tar_gz_is_unpacked_under_the_cache_then_reused_and_the_catalog_runs_it_by_absolute_path(tmp_path, env):
    path, sha256 = archive(tmp_path, "tar.gz", {"bin/tool": "#!/bin/sh\necho hi\n"})
    fetch = Serving(path)
    agent = entry({"sha256": sha256})
    first = await install_agent(agent, env=env, **HOST, fetch=fetch)
    assert first.reused is False
    assert first.command == os.path.join(env["XDG_CACHE_HOME"], "subspace", "bin", "tool", "1.2.3", "bin", "tool")
    assert subprocess.run([first.command], capture_output=True, text=True).stdout == "hi\n"
    again = await install_agent(agent, env=env, **HOST, fetch=fetch)
    assert again.reused is True
    assert len(fetch.calls) == 1, "downloaded once"

    assert installed_binaries(env) == {"tool@1.2.3": first.dir}
    catalog = load_catalog(env=env, builtin_only=True)
    catalog.registry = {"version": "1", "agents": [agent]}
    catalog.binaries = installed_binaries(env)
    resolved = resolve_agent(catalog, "tool", **HOST)
    assert resolved is not None
    assert resolved.command == first.command
    assert resolved.install is not None and "installed by `subspace agents install tool`" in resolved.install


@POSIX
async def test_a_zip_works_too(tmp_path, env):
    path, sha256 = archive(tmp_path, "zip", {"bin/tool": "#!/bin/sh\necho zipped\n"})
    installed = await install_agent(entry({"archive": "https://example.com/tool.zip", "sha256": sha256}), env=env, **HOST, fetch=Serving(path))
    assert subprocess.run([installed.command], capture_output=True, text=True).stdout == "zipped\n"


@POSIX
async def test_install_refuses_no_checksum_a_wrong_checksum_plain_http_a_command_outside_the_folder_a_symlink_out_of_it(tmp_path, env):
    path, sha256 = archive(tmp_path, "tar.gz", {"bin/tool": "x", "bin/link": "->/etc/hosts"})
    fetch = Serving(path)

    async def refused(binary: dict[str, Any], pattern: str) -> None:
        with pytest.raises(InstallError, match=pattern):
            await install_agent(entry(binary), env=env, **HOST, fetch=fetch)

    await refused({}, "lists no sha256")
    assert len(fetch.calls) == 0, "nothing downloaded without a checksum"
    await refused({"sha256": "0" * 64}, r"sha256 is [0-9a-f]{64}, the registry says 0{64}; not installed")
    await refused({"sha256": sha256, "archive": "http://example.com/tool.tar.gz"}, "not https")
    await refused({"sha256": sha256, "cmd": "../../escape"}, "outside its folder")
    await refused({"sha256": sha256, "cmd": "./bin/link"}, "points outside its folder")
    await refused({"sha256": sha256, "cmd": "./bin/missing"}, r"has no \./bin/missing")
    # Nothing was left installed, and no temporary files remain.
    assert installed_binaries(env) == {}
    assert os.listdir(os.path.join(env["XDG_CACHE_HOME"], "subspace", "bin", "tool")) == []


async def test_no_binary_for_this_machine_and_bad_names(env):
    with pytest.raises(InstallError, match=r"tool has no binary for linux-x86_64 \(it has darwin-aarch64\)"):
        await install_agent(entry({"sha256": "a" * 64}), env=env, platform="linux", arch="x86_64")
    npx: RegistryAgent = {"id": "n", "name": "N", "version": "1", "description": "", "distribution": {"npx": {"package": "n"}}}
    with pytest.raises(InstallError, match="is not distributed as a binary"):
        await install_agent(npx, env=env, **HOST)
    with pytest.raises(InstallError, match="not usable as a folder name"):
        await install_agent(entry({"sha256": "a" * 64}, agent_id=".."), env=env, **HOST)


async def test_a_download_over_the_limit_is_refused(tmp_path, env):
    path, sha256 = archive(tmp_path, "tar.gz", {"bin/tool": "x" * 1000})
    with pytest.raises(InstallError, match="byte limit"):
        await install_agent(entry({"sha256": sha256}), env=env, **HOST, fetch=Serving(path), max_bytes=10)


def test_without_an_install_a_checksummed_binary_suggests_subspace_agents_install_and_one_without_says_why_not(env):
    catalog = load_catalog(env=env, builtin_only=True)
    catalog.registry = {"version": "1", "agents": [entry({"sha256": "a" * 64}), entry({}, "plain")]}
    tool = resolve_agent(catalog, "tool", **HOST)
    assert tool is not None and tool.install is not None
    assert tool.install.startswith("Run `subspace agents install tool`")
    assert tool.command == "tool"
    plain = resolve_agent(catalog, "plain", **HOST)
    assert plain is not None and "lists no checksum for it, so Subspace does not install it" in (plain.install or "")


@POSIX
async def test_install_hints_the_registrys_beats_a_built_in_one_when_subspace_can_install_or_has_installed_it_and_your_own_beats_both(tmp_path, env):
    def opencode(binary: dict[str, Any], platform: str = TARGET) -> RegistryAgent:
        return {
            "id": "opencode",
            "name": "OpenCode",
            "version": "1.0.0",
            "description": "",
            "distribution": {"binary": {platform: {"archive": "https://example.com/opencode.tar.gz", "cmd": "./opencode", **binary}}},  # type: ignore[typeddict-item]
        }

    def hint(agent: RegistryAgent, **extra: Any):
        catalog = replace(load_catalog(env=env, builtin_only=True), **extra)
        catalog.registry = {"version": "1", "agents": [agent]}
        resolved = resolve_agent(catalog, "opencode", **HOST)
        assert resolved is not None
        return resolved

    # Installable: say so, before the built-in "Install OpenCode".
    assert (hint(opencode({"sha256": "a" * 64})).install or "").startswith("Run `subspace agents install opencode`, or install OpenCode")
    # No checksum, or no download for this machine: the built-in hint.
    assert (hint(opencode({})).install or "").startswith("Install OpenCode (the `opencode` command)")
    assert (hint(opencode({"sha256": "a" * 64}, "linux-x86_64")).install or "").startswith("Install OpenCode (the `opencode` command)")
    # Installed: run from the cache, and the hint says how it got there.
    path, sha256 = archive(tmp_path, "tar.gz", {"opencode": "#!/bin/sh\n"})
    agent = opencode({"sha256": sha256})
    installed = await install_agent(agent, env=env, **HOST, fetch=Serving(path))
    resolved = hint(agent, binaries=installed_binaries(env))
    assert resolved.command == installed.command
    assert re.fullmatch(r"It was installed by `subspace agents install opencode` into .*; run that again if it is missing", resolved.install or "")
    # Trailing separators on the folder are trimmed, in linear time.
    def with_dirs(f):
        return {key: f(folder) for key, folder in installed_binaries(env).items()}

    assert hint(agent, binaries=with_dirs(lambda d: f"{d}//")).command == installed.command
    started = time.monotonic()
    hint(agent, binaries=with_dirs(lambda d: f"{d}{'/' * 100_000}x"))
    assert time.monotonic() - started < 1
    # Your own agents file: its hint wins; your own command drops the registry's hint.
    def layers(layer: CatalogLayer) -> dict[str, Any]:
        return {"layers": [*load_catalog(env=env, builtin_only=True).layers, layer]}

    mine = CatalogLayer(source="/home/me/subspace.toml", agents={"opencode": {"install": "Ask IT for OpenCode"}})
    assert hint(agent, binaries=installed_binaries(env), **layers(mine)).install == "Ask IT for OpenCode"
    own = hint(opencode({"sha256": "a" * 64}), **layers(CatalogLayer(source="/home/me/subspace.toml", agents={"opencode": {"command": "/opt/opencode"}})))
    assert own.command == "/opt/opencode"
    assert (own.install or "").startswith("Install OpenCode (the `opencode` command)")
