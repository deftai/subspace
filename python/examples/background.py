"""v2 agent terminals and background work: the agent runs a dev server in a
terminal it shows the client, detaches it so it outlives the turn, and the
client stops it later with terminal/cancel.
"""

import asyncio

from deft_subspace.acp import AcpClient, AgentTurn, TerminalWork, serve_agent, terminal_text
from deft_subspace.kernel import channel_pair


async def dev_server(turn: AgentTurn) -> str:
    call = await turn.tool_call("npm run dev", kind="execute", status="in_progress")
    terminal = await turn.show_terminal(command="npm run dev", cwd="/work", cancellable=True)
    await call.update(content=[{"type": "terminal", "terminalId": terminal.id}])
    await terminal.write("listening on http://localhost:3000\n")

    # Keep it running after the turn; stop when the client cancels it (or closes the session).
    def stop(_reason: object) -> None:
        asyncio.ensure_future(terminal.exit(signal="SIGTERM"))

    terminal.signal.add_listener(stop)
    await terminal.detach()
    await call.complete()
    await turn.say("The dev server is running.")
    return "end_turn"


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(agent_end, name="dev-server", protocols=[2], prompt=dev_server)

    client = await AcpClient.connect(client_end)
    session = await client.new_session("/work")
    await session.prompt("Start the dev server")

    print(session.background)  # [TerminalWork(terminal_id='term-…')]
    item = (session.background or [None])[0]
    terminal_id = item.terminal_id if isinstance(item, TerminalWork) else ""
    state = session.terminals.get(terminal_id)
    assert state is not None
    print(terminal_text(state))  # "listening on http://localhost:3000"

    await session.cancel_terminal(terminal_id)
    await asyncio.sleep(0.02)
    print(state.exit_status, session.background)  # TerminalExit(exit_code=None, signal='SIGTERM') []
    await client.close()


asyncio.run(main())
