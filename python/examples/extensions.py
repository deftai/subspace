"""Typed vendor extensions: names start with "_", as ACP requires. Optional
validators (pydantic models) check params where they arrive and results where they return.
"""

import asyncio
import os

from deft_subspace.acp import AcpClient, extension_request, handle, serve_agent
from deft_subspace.kernel import channel_pair
from pydantic import BaseModel


class Steer(BaseModel):
    sessionId: str
    text: str


class Steered(BaseModel):
    ok: bool


steer = extension_request("_acme/steer", params=Steer, result=Steered)


async def main() -> None:
    agent_end, client_end = channel_pair()
    serve_agent(
        agent_end,
        name="steerable",
        prompt=lambda _turn: "end_turn",
        extensions=[handle(steer, lambda params, _context: Steered(ok=len(params.text) > 0))],
    )

    client = await AcpClient.connect(client_end)
    session = await client.new_session(os.getcwd())
    print(await client.call(steer, {"sessionId": session.id, "text": "focus on the tests"}))  # ok=True
    await client.close()


asyncio.run(main())
