"""The kernel on its own: a JSON-RPC peer over any channel, with timeouts and
cancellation. No ACP involved.
"""

import asyncio
from typing import Any

from deft_subspace.kernel import AbortController, InboundContext, LocalError, RpcPeer, cancel_request, channel_pair


async def slow(_params: Any, context: InboundContext) -> str:
    await context.signal.wait()
    return "stopped"


async def main() -> None:
    a, b = channel_pair()
    server = RpcPeer(b, name="server", **cancel_request)
    server.on_request("add", lambda params, _context: params["x"] + params["y"])
    server.on_request("slow", slow)
    server.start()

    # cancel_request: send and honour $/cancel_request, as ACP does.
    client = RpcPeer(a, name="client", **cancel_request).start()
    print(await client.request("add", {"x": 2, "y": 3}))  # 5
    # Cancel a request with an AbortSignal; the other side's handler sees its own signal fire.
    # (Or pass timeout_ms= to give up after a deadline.)
    controller = AbortController()
    asyncio.get_running_loop().call_later(0.05, controller.abort)
    try:
        await client.request("slow", {}, signal=controller.signal)
    except LocalError as error:
        print(error)  # client: slow aborted
    await client.close()
    await server.close()


asyncio.run(main())
