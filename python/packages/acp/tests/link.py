"""Client and agent joined in one process, through NDJSON bytes chunked byte by byte."""

from __future__ import annotations

from typing import Any

from deft_subspace.acp.agent import serve_agent
from deft_subspace.acp.client import AcpClient
from deft_subspace.kernel import channel_pair, ndjson, pipe_channel
from deft_subspace.kernel.channel import Identity
from deft_subspace.kernel.testing import rechunk


def byte_link():
    a, b = channel_pair()
    return ndjson(pipe_channel(a, read=rechunk(1), write=Identity())), ndjson(pipe_channel(b, read=rechunk(1), write=Identity()))


async def connect(agent: dict[str, Any], **client: Any) -> AcpClient:
    client_end, agent_end = byte_link()
    serve_agent(agent_end, **{"name": "test-agent", **agent})
    return await AcpClient.connect(client_end, **client)
