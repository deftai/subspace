# Deft Subspace

A TypeScript library for the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), for both clients and agents.

- **One model for v1 and v2.** The client asks for v2 and accepts v1, and your code sees the same events either way.
- **Turns you can await:** async-iterable events, and a `done` result.
- **Cancellation that works:** open questions are answered `cancelled`, and a turn ends here if the agent doesn't confirm.
- **Permissions that fail closed.**
- **Current ACP:** sessions (load, resume, list, close, delete), modes, config options and models, login, elicitation, MCP servers (including MCP-over-ACP), agent terminals, and v2 background work.
- **Tested against real agents:** Grok Build, the Claude and Codex ACP adapters, and agents and clients built with the official `@agentclientprotocol/sdk`.

```ts
import { start } from '@deft-subspace/acp/node';

const agent = await start('claude', { onPermission: (request) => (request.toolCall?.kind === 'read' ? 'allow' : 'reject') });
try {
  await agent.run('What does this repo do?', { onMessage: (delta, { separator }) => process.stdout.write(separator + delta) });
} finally {
  await agent.close();
}
```

Or in one line: `await run('codex', 'What does this repo do?', { permissions: 'reject' })`. Or no code at all: `subspace run claude "What does this repo do?"`.

Also there: ready-made permission rules (`readOnly`, `allowInside(repo)`, `askInTerminal()`), a terminal renderer (`terminal()`), `agent.json(prompt, { schema })` for typed answers, `trace: 'run.jsonl'` to record a session, tools as data (`tool()`), and `modelAgent({ model: claude(), tools })` for an agent backed by a model. Underneath are `AcpClient`, `Session` and `Turn` (async-iterable events and an awaitable result) for full control, and `serveAgent` / `serveStdio` for writing agents.

## Packages

| Package | What it is |
|---|---|
| [`@deft-subspace/kernel`](./packages/kernel) | Channels, NDJSON framing, a JSON-RPC peer with timeouts and cancellation. Protocol-neutral; Node, Bun, Deno and browsers. |
| [`@deft-subspace/acp`](./packages/acp) | `AcpClient` and `serveAgent`, plus `./node` helpers to start agent programs and confine file and terminal access to a workspace. |
| [`@deft-subspace/acp-testkit`](./packages/acp-testkit) | Trace recording and replay, fault injection, conformance checks for agents and clients, and a corpus of real agents' quirks. |
| [`@deft-subspace/devtools`](./packages/devtools) | A trace analyzer and a standalone HTML trace viewer. |
| [`@deft-subspace/cli`](./packages/cli) | `subspace run`, `chat`, `agents`, `check` and `trace`: agents from the command line. |
| [`@deft-subspace/claude`](./packages/claude) | `claude()`: a Claude model for `modelAgent()`, so an ACP agent backed by Claude is a short file. |
| [`create-subspace`](./packages/create-subspace) | `npx create-subspace my-app --template script\|agent\|claude-agent` starts a project. |

**Start with the [guide](./docs/GUIDE.md).** It goes from a first turn to MCP, background work and writing an agent.

## Develop

```sh
pnpm install
pnpm test        # every package
pnpm run typecheck
pnpm run build   # dist/, for projects that link the packages
```

Tests and examples run the TypeScript sources directly (`node --conditions=subspace-source`, Node 22.19 or later).

## Status

This is an experiment: the packages are versioned `0.0.0-experiment` and are not published yet. [`EXPERIMENT.md`](./EXPERIMENT.md) records what is built, how it was checked against real agents, and what's next. The original `@deft/*` prototype packages from `main` are in [`legacy/`](./legacy).

## License

MIT
