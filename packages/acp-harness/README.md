# `@deft/acp-harness`

Early **Path A** ACP coding-agent harness.

Hosts talk to this package as the **agent**: `initialize` → `session/new` → `session/prompt` (streamed `session/update`) → `session/cancel`.

## Honest scope

- **Stub model only** (`StubModelAdapter`) — deterministic text, **no network**, no provider SDK.
- **Not** a production coding agent. No real tools drawer, MCP, skills, plugins, subagents, or OTel.
- Linear turn loop. Tools preferred zero (none in this cut).

## Surfaces

| Surface | How |
|---------|-----|
| **Linked** | `listenHarness(agentTransport)` or `defineHarness().listen(transport)` |
| **Stdio** | `bin/stub-harness-agent.ts` — spawn with Node `--experimental-strip-types` |

## Probe example

```bash
pnpm exec node --experimental-strip-types packages/acp-probe/bin/acp-probe.ts \
  --command node --arg --experimental-strip-types \
  --arg packages/acp-harness/bin/stub-harness-agent.ts \
  --prompt hello --permission deny
```

Expect a streamed agent message chunk containing `stub:hello` (default prefix).

## License

MIT
