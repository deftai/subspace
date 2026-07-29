# `@deft/acp-harness`

Early **Path A** ACP coding-agent harness (stub model — not production).

## Happy path (≤10 lines)

```ts
import { defineLinkedChannels } from "@deft/acp-wire";
import { defineAcpClientProduct } from "@deft/acp-client";
import { defineHarness } from "@deft/acp-harness";

const { client, agent } = defineLinkedChannels().connect();
const server = await defineHarness().listen(agent); // StubModelAdapter by default
const product = await defineAcpClientProduct().connect(client);
const session = await product.sessions.create();
for await (const ev of session.prompt("hello")) { /* stub:hello chunks */ }
```

Defaults live in `resolveHarnessOptions` (`StubModelAdapter`, name `@deft/acp-harness`, version `0.1.0`).

## Modules

| File | Role |
|------|------|
| `model.ts` | `ModelAdapter`, `StubModelAdapter` |
| `session.ts` | Session map / cancel flags |
| `options.ts` | `resolveHarnessOptions` |
| `handlers.ts` | Explicit method map |
| `listen.ts` | `listenHarness`, `defineHarness` |
| `index.ts` | Re-exports only |

Uses `@deft/acp-agent` helpers (`promptToText`, `notifyAgentMessageChunk`, `defaultInitializeResult`).

## Honest scope

- **Stub model only** — no network, no provider SDK
- No tools empire, MCP, Bridge, or §5.2 handlers bag

## Probe

```bash
pnpm exec node --experimental-strip-types packages/acp-probe/bin/acp-probe.ts \
  --command node --arg --experimental-strip-types \
  --arg packages/acp-harness/bin/stub-harness-agent.ts \
  --prompt hello --permission deny
```

## License

MIT
