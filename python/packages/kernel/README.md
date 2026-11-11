# deft-subspace-kernel

The protocol-neutral kernel of [Deft Subspace for Python](https://github.com/deftai/subspace/tree/main/python): channels, NDJSON framing, a JSON-RPC 2.0 peer (timeouts, cancellation, middleware, one owner for every request), abort signals, traces, and supervised child processes. Plain asyncio, Python 3.11 or later, no dependencies.

```python
from deft_subspace.kernel import RpcPeer, channel_pair

a, b = channel_pair()
server = RpcPeer(b).on_request("echo", lambda params, _ctx: params).start()
client = RpcPeer(a).start()
assert await client.request("echo", {"hi": 1}) == {"hi": 1}
```

Most programs want [`deft-subspace-acp`](https://pypi.org/project/deft-subspace-acp/), which builds the Agent Client Protocol on this.

MIT licensed.
