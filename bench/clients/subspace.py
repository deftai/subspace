"""The benchmark client on Subspace (Python)."""

import asyncio
import os

from common import parse_args, run
from deft_subspace.acp import AcpClient
from deft_subspace.kernel import ndjson, spawn_process


class SubspaceDriver:
    def __init__(self, child, client: AcpClient) -> None:
        self.child, self.client, self.sessions = child, client, {}

    async def new_session(self) -> str:
        session = await self.client.new_session(cwd=os.getcwd())
        self.sessions[session.id] = session
        return session.id

    async def prompt(self, session: str, text: str) -> str:
        return (await self.sessions[session].prompt(text)).text

    async def close(self) -> None:
        await self.client.close()
        await self.child.ended()


async def main() -> None:
    args = parse_args()

    async def connect() -> SubspaceDriver:
        child = await spawn_process(args.agent[0], args=args.agent[1:])
        client = await AcpClient.connect(ndjson(child.channel), name="bench", permissions="allow", protocol=2 if os.environ.get("BENCH_PROTOCOL") == "2" else 1)
        return SubspaceDriver(child, client)

    await run(args, connect)


asyncio.run(main())
