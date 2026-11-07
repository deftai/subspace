# `@deft/acp-agent`

ACP agent (server) façade: thin request dispatch, reverse RPC, session-echo fixture, and **shared product helpers**.

## Shared helpers (DX first pass)

| Export | Job |
|--------|-----|
| `promptToText(prompt)` | String / content-array / null → one string |
| `agentMessageChunkUpdate(sessionId, text)` | Build `session/update` payload |
| `notifyAgentMessageChunk(bridge, sessionId, text)` | One-liner notify |
| `defaultInitializeResult({ name, version })` | Intelligent `initialize` result |
| `createDeferredBridge()` | Linked listen bind (handlers then `bind(server)`) |

Rich `on*` / wildcards / hooks bag (`acp.md` §5.2) is **provisional** — not here.

## Happy path

```ts
import {
  defineAcpServer,
  defineSessionEchoHandlers,
  createDeferredBridge,
  notifyAgentMessageChunk,
} from "@deft/acp-agent";

const { bridge, bind } = createDeferredBridge();
const handlers = defineSessionEchoHandlers(bridge);
// or hand-roll:
// handlers["session/prompt"] = async (params) => {
//   await notifyAgentMessageChunk(bridge, sessionId, "hi");
//   return { stopReason: "end_turn" };
// };
const server = await defineAcpServer({ handlers }).listen(agentTransport);
bind(server);
```

## License

MIT
