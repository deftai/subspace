"""Testing with the testkit: run the conformance checks against an agent,
and replay a recorded real-agent trace to a client.
"""

import asyncio
import sys
from pathlib import Path

from deft_subspace.acp import AcpClient, AgentTurn, serve_agent
from deft_subspace.acp_testkit import DEFAULT_PROMPTS, check_agent, failures, format_report, load_trace, replay_agent
from deft_subspace.kernel import channel_pair


async def under_test(turn: AgentTurn) -> str:
    if turn.text == DEFAULT_PROMPTS.long_prompt:
        for i in range(1, 301):
            if turn.signal.aborted:
                break
            await turn.say(f"{i}\n")
            await asyncio.sleep(0.005)
        return "cancelled" if turn.signal.aborted else "end_turn"
    await turn.say("OK")
    return "end_turn"


async def main() -> None:
    # 1. Conformance: check_agent drives any agent over a channel and reports each check.
    agent_end, checker_end = channel_pair()
    serve_agent(agent_end, name="under-test", prompt=under_test)
    report = await check_agent(checker_end, permission_prompt=None)
    print(format_report(report))
    if failures(report):
        sys.exit(1)

    # 2. Replay: a real Grok Build session, recorded once, played back to our client.
    trace = await load_trace(Path(__file__).parent / "../../packages/acp-testkit/corpus/grok-plain.trace.jsonl")
    replay_end, client_end = channel_pair()
    replay = replay_agent(replay_end, trace)
    client = await AcpClient.connect(client_end)
    session = await client.new_session("/workspace")
    prompt = trace[0].get("meta", {}).get("prompt", "")
    print((await session.prompt(prompt)).text)
    await replay.done  # raises ReplayDivergence (expected vs got) if the client did something else
    await client.close()


asyncio.run(main())
