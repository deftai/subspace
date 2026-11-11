"""The agent catalog: registry, built-ins, files; and start() by name."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import pytest
from deft_subspace.acp.agents import BUILTIN_AGENTS, builtin_catalog, list_agents, resolve_agent
from deft_subspace.acp.catalog import AgentFileError, agent_files, load_catalog, load_registry, parse_agent_file, refresh_registry
from deft_subspace.acp.registry import REGISTRY_SNAPSHOT, REGISTRY_SNAPSHOT_DATE, Registry, registry_target, trim_registry
from deft_subspace.acp.start import start

REGISTRY: Registry = {
    "version": "1.0.0",
    "agents": [
        {"id": "claude-acp", "name": "Claude Agent", "version": "9.9.9", "description": "from the registry", "distribution": {"npx": {"package": "@x/claude-acp@9.9.9"}}},
        {
            "id": "tool-bin",
            "name": "Tool",
            "version": "1.0.0",
            "description": "a binary",
            "distribution": {
                "binary": {
                    "darwin-aarch64": {"archive": "https://e/x.zip", "cmd": "./bin/tool", "args": ["acp"]},
                    "linux-x86_64": {"archive": "https://e/y.zip", "cmd": "./tool", "args": ["acp", "--linux"]},
                }
            },
        },
        {"id": "py", "name": "Py", "version": "2", "description": "uvx", "distribution": {"uvx": {"package": "py-acp==2", "args": ["-x"]}}},
    ],
}
HOST = {"platform": "darwin", "arch": "arm64"}


def test_builtins_take_launch_details_from_the_registry_and_settings_from_their_quirks():
    catalog = builtin_catalog(REGISTRY)
    claude = resolve_agent(catalog, "claude", **HOST)
    assert claude is not None
    assert claude.command == "npx"
    assert claude.args == ["-y", "@x/claude-acp@9.9.9"]
    assert claude.version == "9.9.9"
    assert claude.mode == "default"  # from the starts-in-auto-mode quirk
    assert claude.sources == ["registry", "built-in"]
    alias = resolve_agent(catalog, "claude-code", **HOST)
    assert alias is not None and alias.id == "claude"
    # grok has a command of its own: the registry's arguments do not apply.
    grok = resolve_agent(catalog, "grok", **HOST)
    assert grok is not None
    assert [grok.command, *grok.args] == ["grok", "--permission-mode", "default", "agent", "stdio"]
    assert grok.launch == "command"
    assert grok.waivers["session.unknown"] == grok.quirks["unknown-session-32602"].summary


def test_registry_ids_resolve_npx_uvx_and_binaries_for_this_platform():
    catalog = builtin_catalog(REGISTRY)
    binary = resolve_agent(catalog, "tool-bin", **HOST)
    assert binary is not None
    assert [binary.command, *binary.args] == ["tool", "acp"]
    assert binary.install is not None and "https://e/x.zip" in binary.install
    linux = resolve_agent(catalog, "tool-bin", platform="linux", arch="x64")
    assert linux is not None and linux.args == ["acp", "--linux"]
    # Python's names for the same machine.
    assert registry_target("linux", "x86_64") == registry_target("linux", "x64") == "linux-x86_64"
    assert registry_target("win32", "AMD64") == "windows-x86_64"
    py = resolve_agent(catalog, "py", **HOST)
    assert py is not None and [py.command, *py.args] == ["uvx", "py-acp==2", "-x"]
    assert resolve_agent(catalog, "nope", **HOST) is None
    # Not in this registry: a built-in falls back to its own command.
    codex = resolve_agent(catalog, "codex", **HOST)
    assert codex is not None
    assert [codex.command, *codex.args, codex.mode] == ["npx", "-y", "@agentclientprotocol/codex-acp", "read-only"]
    assert codex.sources == ["built-in"]
    # Listing: the defined agents first, then the registry's unclaimed ones (claude-acp is claimed by claude).
    ids = [a.id for a in list_agents(catalog)]
    assert ids.index("claude") < ids.index("tool-bin")
    assert "claude-acp" not in ids


def test_files_override_field_by_field_add_agents_and_quirks_and_can_turn_quirks_and_agents_off():
    catalog = builtin_catalog(REGISTRY)
    catalog.layers.extend(
        [
            parse_agent_file(
                """
[agents.claude]
extra_args = ["--verbose"]
env = { DEBUG = "1" }
[agents.claude.quirks.starts-in-auto-mode]
enabled = false
[agents.claude.quirks.mine]
summary = "Something we saw"
waives = ["prompt.cancel"]
apply = { args = ["--safe"], env = { SAFE = "1" } }

[agents.mine]
command = "node"
args = ["/a/agent.js"]
mode = false

[agents.gemini]
enabled = false
""",
                "user.toml",
            ),
            parse_agent_file('[agents.claude]\nmode = "plan"\n', "project.toml"),
        ]
    )
    claude = resolve_agent(catalog, "claude", **HOST)
    assert claude is not None
    assert claude.args == ["-y", "@x/claude-acp@9.9.9", "--safe", "--verbose"]
    assert claude.env == {"SAFE": "1", "DEBUG": "1"}
    assert claude.mode == "plan"  # the project file's own field wins
    assert "starts-in-auto-mode" not in claude.quirks
    assert claude.waivers["prompt.cancel"] == "Something we saw"
    assert claude.sources == ["registry", "built-in", "user.toml", "project.toml"]
    mine = resolve_agent(catalog, "mine", **HOST)
    assert mine is not None and [mine.command, *mine.args, mine.mode] == ["node", "/a/agent.js", None]
    assert resolve_agent(catalog, "gemini", **HOST) is None
    # The built-in layer itself is untouched.
    assert "extra_args" not in BUILTIN_AGENTS["claude"]


def test_camel_case_keys_work_too():
    layer = parse_agent_file('[agents.a]\ncommand = "x"\nextraArgs = ["-v"]\n', "x.toml")
    assert layer.agents["a"] == {"command": "x", "extra_args": ["-v"]}


@pytest.mark.parametrize(
    ("text", "pattern"),
    [
        ('[agents.a]\ncomand = "x"', r"x\.toml: agents\.a\.comand is not a known field \(known: .*command"),
        ('[agents.a]\nargs = "x"', r"agents\.a\.args should be a list of strings"),
        ('[agents.a.quirks.q]\nsumary = "x"', r"agents\.a\.quirks\.q\.sumary is not a known field"),
        ('[agents.a.quirks.q]\napply = { mood = "x" }', r"apply\.mood is not a known field"),
        ("[agents\n", r"x\.toml: "),
        ('[agents."a b"]\ncommand = "x"', r"names are letters, digits"),
    ],
)
def test_bad_files_say_where_and_what(text, pattern):
    with pytest.raises(AgentFileError, match=pattern):
        parse_agent_file(text, "x.toml")


def test_other_tables_are_not_ours():
    assert parse_agent_file("[other]\nx = 1\n", "x.toml").agents == {}


async def test_load_catalog_reads_agents_toml_the_nearest_subspace_toml_and_subspace_agents_and_a_newer_cache_wins(tmp_path):
    config = tmp_path / "config"
    cache = tmp_path / "cache"
    project = tmp_path / "project"
    (config / "subspace").mkdir(parents=True)
    (project / "deep" / "er").mkdir(parents=True)
    (config / "subspace" / "agents.toml").write_text('[agents.one]\ncommand = "one"\n')
    (project / "subspace.toml").write_text('[agents.two]\ncommand = "two"\n')
    (tmp_path / "extra.toml").write_text('[agents.three]\ncommand = "three"\n')
    env = {"XDG_CONFIG_HOME": str(config), "XDG_CACHE_HOME": str(cache), "SUBSPACE_AGENTS": str(tmp_path / "extra.toml")}
    catalog = load_catalog(cwd=str(project / "deep" / "er"), env=env)
    assert [layer.source for layer in catalog.layers] == [
        "built-in",
        str(config / "subspace" / "agents.toml"),
        str(project / "subspace.toml"),
        str(tmp_path / "extra.toml"),
    ]
    for name in ("one", "two", "three"):
        assert resolve_agent(catalog, name) is not None, name
    assert any(f.path.endswith("agents.toml") and f.exists for f in agent_files(cwd=str(tmp_path), env=env))
    with pytest.raises(AgentFileError, match="no such file"):
        load_catalog(env=env, files=[str(tmp_path / "missing.toml")])
    assert re.search("bundled snapshot", catalog.registry_source)

    urls: list[str] = []

    def fake(url: str) -> bytes:
        urls.append(url)
        return json.dumps(REGISTRY).encode()

    fetched = await refresh_registry(env=env, fetch=fake)
    assert fetched.agents == 3
    assert urls == ["https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"]
    saved = json.loads(Path(fetched.path).read_text())
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", saved["fetchedAt"])
    refreshed = load_catalog(env=env, builtin_only=True)
    assert "registry.json" in refreshed.registry_source
    claude = resolve_agent(refreshed, "claude")
    assert claude is not None and claude.version == "9.9.9"

    async def empty(_url: str) -> str:
        return '{"agents":[]}'

    with pytest.raises(RuntimeError, match="no agents"):
        await refresh_registry(env=env, fetch=empty)


def test_an_older_or_broken_cache_is_ignored(tmp_path):
    env = {"XDG_CACHE_HOME": str(tmp_path)}
    path = tmp_path / "subspace" / "registry.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"fetchedAt": "2000-01-01T00:00:00.000Z", "registry": REGISTRY}))
    assert load_registry(env).source == f"bundled snapshot ({REGISTRY_SNAPSHOT_DATE})"
    path.write_text("not json")
    assert load_registry(env).registry is REGISTRY_SNAPSHOT


def test_the_bundled_snapshot_is_trimmed_registry_data():
    assert len(REGISTRY_SNAPSHOT["agents"]) > 10
    assert trim_registry(REGISTRY_SNAPSHOT) == REGISTRY_SNAPSHOT


def test_trim_registry_keeps_what_subspace_uses():
    raw = {
        "version": 1,
        "agents": [
            {"id": "a", "version": 2, "distribution": {"npx": {"package": "a@2", "args": [], "env": {"X": 1}}}, "extra": True},
            {"id": "b", "distribution": {}},
            {"name": "no id", "distribution": {"npx": {"package": "x"}}},
            {"id": "c", "distribution": {"binary": {"linux-x86_64": {"archive": "https://x", "cmd": "c", "sha256": "A" * 64}, "bad": {"cmd": "c"}}}},
        ],
    }
    assert trim_registry(raw) == {
        "version": "1",
        "agents": [
            {"id": "a", "name": "a", "version": "2", "description": "", "distribution": {"npx": {"package": "a@2", "env": {"X": "1"}}}},
            {"id": "c", "name": "c", "version": "", "description": "", "distribution": {"binary": {"linux-x86_64": {"archive": "https://x", "sha256": "a" * 64, "cmd": "c"}}}},
        ],
    }


FIXTURE = Path(__file__).parent / "fixtures" / "echo_agent.py"


async def test_start_by_a_name_from_a_file_with_its_quirk_settings_and_unknown_names_list_the_known_ones(tmp_path):
    catalog = builtin_catalog(REGISTRY)
    catalog.layers.append(
        parse_agent_file(
            f"[agents.echo]\ncommand = {json.dumps(sys.executable)}\nargs = [{json.dumps(str(FIXTURE))}]\n"
            '[agents.echo.quirks.needs-env]\nsummary = "Reads ECHO_PREFIX"\napply = { env = { ECHO_PREFIX = "q:" } }\n',
            "f.toml",
        )
    )
    agent = await start("echo", catalog=catalog, cwd=str(tmp_path), permissions="reject", quiet=True, handle_signals=False)
    try:
        assert agent.agent is not None and agent.agent.id == "echo"
        assert agent.agent.env["ECHO_PREFIX"] == "q:"
        assert "q:" in (await agent.run("env ECHO_PREFIX")).text
    finally:
        await agent.close()
    with pytest.raises(TypeError, match=r'Unknown agent "nope"\. Known: claude, codex, grok, gemini, opencode, echo'):
        await start("nope", catalog=catalog, permissions="reject")


def test_no_network_needed_for_the_default_catalog(tmp_path):
    catalog = load_catalog(env={"XDG_CACHE_HOME": str(tmp_path), "XDG_CONFIG_HOME": str(tmp_path)}, cwd=str(tmp_path))
    assert catalog.registry is REGISTRY_SNAPSHOT
    assert os.path.basename(catalog.layers[0].source) == "built-in"


def test_a_name_that_is_not_a_string_is_an_agent_file_error():
    import pytest as _pytest

    from deft_subspace.acp.catalog import AgentFileError, parse_agent_table

    with _pytest.raises(AgentFileError):
        parse_agent_table({1: {"command": "x"}}, "test")
