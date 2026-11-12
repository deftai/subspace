"""An ACP proxy on the raw agent endpoint: client -> proxy -> agent. Everything
passes through both ways (initialize, sessions, prompts, the agent's
permission and file requests, methods neither side knows), and one layer
tweaks the agent's messages on the way to the client.
"""

import asyncio
from dataclasses import replace
from typing import Any

from deft_subspace.acp import (
    AcpClient,
    AgentEndpoint,
    AgentLayer,
    AgentTurn,
    CallContext,
    EndpointCall,
    EndpointContext,
    agent_endpoint,
    serve_agent,
)
from deft_subspace.kernel import Channel, InboundContext, RpcPeer, cancel_request, channel_pair


def proxy(upstream: Channel[Any], downstream: Channel[Any], layers: list[AgentLayer[Any]] | None = None) -> AgentEndpoint:
    """Serve `upstream` (the client side) by forwarding to `downstream` (an agent)."""
    # The agent side of the proxy talks to the downstream agent as a raw peer.
    agent = RpcPeer(downstream, name="proxy->agent", **cancel_request)

    # Client -> agent. Passing the signal on sends $/cancel_request downstream when the client cancels.
    async def request(call: EndpointCall, ctx: CallContext) -> Any:
        return await agent.request(call.method, call.params, signal=ctx.signal)

    async def notification(call: EndpointCall, _ctx: CallContext) -> None:
        await agent.notify(call.method, call.params)

    endpoint = agent_endpoint(upstream, name="proxy", layers=layers, request=request, notification=notification)

    # Agent -> client: its requests (permissions, files, terminals, anything) and notifications.
    async def on_request(params: Any, ctx: InboundContext) -> Any:
        return await endpoint.client.request(ctx.method, params, signal=ctx.signal)

    async def on_notification(params: Any, ctx: InboundContext) -> None:
        if ctx.method != "$/cancel_request":
            await endpoint.client.notify(ctx.method, params)

    agent.on_request("*", on_request).on_notification("*", on_notification).start()
    return endpoint


def upper_case(call: EndpointCall, _ctx: EndpointContext, _state: Any, next_: Any) -> Any:
    update = (call.params or {}).get("update") or {}
    content = update.get("content") or {}
    if call.method != "session/update" or update.get("sessionUpdate") != "agent_message_chunk" or content.get("type") != "text":
        return next_()
    shouted = {**call.params, "update": {**update, "content": {**content, "text": content["text"].upper()}}}
    return next_(replace(call, params=shouted))


#: A tweak: agent text reaches the client in upper case.
shout = AgentLayer[None](name="shout", outbound=upper_case)


async def reader(turn: AgentTurn) -> str:
    answer = await turn.request_permission("Read notes.txt")
    await turn.say(f"notes.txt says: {await turn.read_file('/work/notes.txt')}" if answer.allowed else "not allowed")
    return "end_turn"


class Notes:
    def read_text_file(self, request: dict[str, Any]) -> str:
        return "hello"

    def write_text_file(self, request: dict[str, Any]) -> None:
        pass


async def main() -> None:
    client_end, proxy_up = channel_pair()
    proxy_down, agent_end = channel_pair()

    serve_agent(agent_end, name="reader", protocols=[1], prompt=reader)  # client file reads are ACP v1
    proxy(proxy_up, proxy_down, [shout])

    client = await AcpClient.connect(client_end, permissions="allow", files=Notes())
    session = await client.new_session("/work")
    result = await session.prompt("read my notes")
    print(client.agent.name, "->", result.text)  # reader -> NOTES.TXT SAYS: HELLO
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
