"""Smoke test for installed wheels: run from outside the repo, in a clean environment."""

import asyncio
import importlib.metadata as metadata
import sys

import deft_subspace.acp as acp
import deft_subspace.acp_testkit as testkit
import deft_subspace.kernel as kernel
from deft_subspace.acp import AcpClient, serve_agent
from deft_subspace.acp_testkit import normalize_turn, recorder, replay_agent
from deft_subspace.kernel import channel_pair

DISTRIBUTIONS = ("deft-subspace-kernel", "deft-subspace-acp", "deft-subspace-acp-testkit")


async def main() -> None:
    for module in (kernel, acp, testkit):
        assert "site-packages" in module.__file__, f"{module.__name__} came from {module.__file__}, not an installed wheel"
    versions = {name: metadata.version(name) for name in DISTRIBUTIONS}
    assert len(set(versions.values())) == 1, versions

    async def prompt(turn):
        await turn.tool("Read a.txt", lambda _call: "a", kind="read")
        await turn.say(f"echo: {turn.text}")

    for protocol in (1, 2):
        agent_end, client_end = channel_pair()
        serve_agent(agent_end, name="smoke", prompt=prompt, protocols=[protocol])
        rec = recorder(peer="client")
        client = await AcpClient.connect(client_end, permissions="allow", tap=rec.tap)
        session = await client.new_session("/")
        result = await session.prompt("hi")
        assert result.text == "echo: hi" and result.tool_calls[0].status == "completed", result
        await client.close()

        # The testkit: the recorded session, replayed to a fresh client, gives the same turn.
        replay_end, client_end = channel_pair()
        replay = replay_agent(replay_end, rec.records)
        client = await AcpClient.connect(client_end, permissions="allow")
        replayed = await (await client.new_session("/")).prompt("anything")
        assert normalize_turn(replayed) == normalize_turn(result), replayed
        await replay.done
        await client.close()
    assert acp.registry_target is not None and len(acp.BUILTIN_AGENTS) > 0
    assert acp.v1.InitializeRequest is not None and acp.v2.PromptResponse is not None
    print(f"smoke ok: {versions} on Python {sys.version.split()[0]}")


asyncio.run(main())
