"""Sessions, modes, config options and login with a real agent.
@typecheck-only (starts Codex's ACP adapter through npx)
"""

import asyncio
import os

from deft_subspace.acp import connect_agent


async def main() -> None:
    agent = await connect_agent("npx", args=["-y", "@agentclientprotocol/codex-acp"], cwd=os.getcwd())
    client = agent.client
    try:
        # Login, if the agent needs it: methods it handles itself ("agent"), or terminal ones (with terminal_auth).
        for method in client.auth_methods:
            print(f"login: {method.id} ({method.type})")

        session = await client.new_session(os.getcwd())

        # Modes, whichever way the agent offers them (session/set_mode or a "mode" config option).
        if session.modes:
            print("modes", [m.id for m in session.modes.available], "current", session.modes.current)
        await session.set_mode("read-only")  # Codex's ask-first mode

        # Config options: model, reasoning effort, on/off switches. Values the agent did not offer are refused here.
        for option in session.config_options:
            print(option.id, option.type, option.current_value)
        if session.model:
            await session.set_model(session.model.current_value or session.model.choices[0].value)

        # History, if the agent keeps it.
        if client.supports.list_sessions:
            sessions, _next_cursor = await client.list_sessions(cwd=os.getcwd())
            print(len(sessions), "sessions")
        await session.close()
        if client.supports.delete_session:
            await client.delete_session(session.id)
    finally:
        await agent.close()


asyncio.run(main())
