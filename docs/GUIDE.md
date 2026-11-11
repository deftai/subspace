# Subspace guide

> The documentation site (`site/`, run `pnpm docs:dev`) covers the same ground with tested examples and the API reference. This page stays as a single-file overview until the site is published.

Subspace is a TypeScript library for the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), for both sides:

- **Clients** (editors, terminals, orchestrators) connect to an agent, open sessions and run turns.
- **Agents** answer them.

It speaks ACP v1 and v2 and gives your code one model for both. It uses the official `@agentclientprotocol/sdk` for its types.

This guide goes from a first turn to the less common features. Each section stands on its own.

> Status: experiment. The packages are versioned `0.0.0-experiment` and are not on npm. Use them from a checkout (see [Install](#install)).

## Packages

| Package | What it is |
|---|---|
| `@deft-subspace/kernel` | Channels, NDJSON framing, and a JSON-RPC peer with timeouts and cancellation. No ACP in it. Runs in Node, Bun, Deno and browsers. |
| `@deft-subspace/acp` | The ACP client (`AcpClient`) and agent (`serveAgent`). `@deft-subspace/acp/node` adds starting agent programs and file and terminal helpers confined to a workspace. |
| `@deft-subspace/acp-testkit` | Recording and replay of traces, fault injection, and conformance checks for agents and clients. |
| `@deft-subspace/devtools` | A trace analyzer and a standalone HTML trace viewer (`deft-subspace-trace`). |

## Install

```sh
git clone https://github.com/deftai/subspace && cd subspace
git checkout experiment/deft-subspace-prototype
pnpm install
pnpm test
```

To use the packages from another project before they are published, link them. pnpm example:

```json
"dependencies": {
  "@deft-subspace/acp": "link:../subspace/packages/acp",
  "@deft-subspace/kernel": "link:../subspace/packages/kernel"
}
```

Run `pnpm run build` in Subspace after pulling, so the linked `dist/` is current. Inside the repo, tests and examples run the TypeScript sources directly: `node --conditions=subspace-source file.ts` (Node 22.19 or later).

## The quick way

```ts
import { run, start } from '@deft-subspace/acp/node';

// Start a known agent in its ask-first mode, in this folder, with a session ready.
const agent = await start('claude', { onPermission: (request) => (request.toolCall?.kind === 'read' ? 'allow' : 'reject') });
await agent.run('Summarize README.md', { onMessage: (delta, { separator }) => process.stdout.write(separator + delta) });
await agent.close();

// Or: start, one prompt, stop.
const { text } = await run('codex', 'What does this repo do?', { permissions: 'reject' });
```

`start()` requires a permission answer. Handler options (`onMessage`, `onToolCall`, `onPermission`, `onQuestion`, `onEvent`, ...) work on any turn, also with `session.prompt()`. On the agent side, `serveStdio(options)` serves on stdio and `turn.tool(init, run)` runs a tool as one step. The rest of this guide is the model underneath.

## A first turn

Start a real agent and send it a prompt:

```ts
import { connectAgent } from '@deft-subspace/acp/node';

const { client, close } = await connectAgent('npx', {
  args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  cwd: process.cwd(),
  workspace: process.cwd(), // serve the agent's file reads, confined here
});
try {
  const session = await client.newSession({ cwd: process.cwd() });
  const turn = session.prompt('Summarize README.md in one sentence.');
  for await (const event of turn) {
    if (event.type === 'message') process.stdout.write(event.delta);
    if (event.type === 'tool_call') console.log(`\n[${event.toolCall.title}: ${event.toolCall.status}]`);
  }
  const result = await turn.done;
  console.log(`\n${result.stopReason}, ${result.toolCalls.length} tool call(s)`);
} finally {
  await close(); // closes the connection and stops the agent's process group
}
```

What happens here:

- `connectAgent` starts the program, connects over stdio, and sends `initialize`. It asks for v2 and accepts v1. `client.protocol` says which one is in use.
- A `Turn` is async-iterable (its events, in order) and has `done` (the `TurnResult`). You can iterate it again later and get the same events.
- If startup fails, the error message includes the end of the agent's stderr.

`examples/quickstart.ts` in `packages/acp` runs an agent and a client in one process, with no external agent. `examples/live-turn.ts` runs one turn against any agent program.

## Events and results

The events are the same on v1 and v2:

| Event | Meaning |
|---|---|
| `message`, `thought` | Agent text. `delta` is what's new; `text` is the whole message so far. |
| `user_message` | The user's message as the agent echoes or replays it. |
| `tool_call` | A tool call was created or changed. `toolCall` is a snapshot: `title`, `kind`, `status`, `content`, `locations`, `rawInput`, `rawOutput`. |
| `permission` | The agent asked; `request` and `outcome` say what and how it was answered. |
| `plan` | The agent's plan entries. |
| `usage` | Context use (`used`, `size`, `cost`). |
| `terminal` | A terminal the agent runs changed (v2; see [Agent terminals](#agent-terminals)). |
| `state` | v2's run state (`running`, `requires_action`, `idle`), with `background` when reported. |
| `session_info` | Session title or update time. |
| `exhausted` | A turn limit fired (see [Limits](#limits)). |
| `update` | Anything else, unchanged (available commands, notices, vendor updates). |

`TurnResult` has `stopReason`, `text` (all agent message text), `toolCalls`, and `cancelled`. `forced` means the turn was ended here because the agent did not confirm a cancel in time. `refused` counts refused permission requests, and `exhausted` says which limit fired.

`turnEnd(result)` turns a result into `completed`, `cancelled`, `refused`, `limit` or `error`. Some agents (Grok Build, Codex) end a turn whose write you refused with stop reason `cancelled`, though nobody cancelled. `turnEnd` reports those as `refused`.

## Permissions

The default is `reject`: nothing is allowed unless you say so.

```ts
const client = await AcpClient.connect(channel, {
  permissions: async (request, signal) => {
    const yes = await askTheUser(request.title, request.toolCall, signal);
    return yes ? 'allow' : 'reject';
  },
});
```

- `'allow'` and `'reject'` pick the agent's once-only option of that kind. `'allow_always'` and `'reject_always'` prefer the always option, and `{ optionId }` picks exactly one.
- A handler that throws, or that returns an option the agent didn't offer, becomes a rejection.
- `signal` fires if the turn is cancelled while you decide. The question is then answered `cancelled`, as the spec requires.

## Cancelling

```ts
const turn = session.prompt('Count to 1000');
setTimeout(() => void turn.cancel(), 500);
const result = await turn.done; // stopReason 'cancelled'
```

`turn.cancel()` sends `session/cancel` and answers open permission questions `cancelled`. If the agent doesn't confirm within `timeouts.cancelGraceMs` (default 10 s), the turn ends here with `forced: true`, and open tool calls are marked failed.

## Limits

```ts
session.prompt(text, { limits: { maxDurationMs: 600_000, idleMs: 120_000, maxToolCalls: 50, maxUsage: 150_000 } });
```

A limit cancels the turn the normal way, emits an `exhausted` event, and sets `result.exhausted` to `{ limit, max, value }`. The client option `limits` sets defaults for every turn.

## Sessions

```ts
const session = await client.newSession({ cwd, additionalDirectories: ['/data'] });
const { sessions } = await client.listSessions({ cwd });
const { session: again, replayed } = await client.loadSession({ sessionId, cwd }); // with history
const resumed = await client.resumeSession({ sessionId, cwd });                     // without
await session.close();
await client.deleteSession(sessionId);
```

`client.supports` says what the agent offers, in one shape for v1 and v2. Calls the agent didn't offer throw a `CapabilityError` before any request is sent. That includes prompt content it doesn't take, like images.

A prompt sent while a turn is running throws, unless you pass `{ queue: true }` or the client option `queuePrompts`. Queued prompts run in order.

## Modes, config options and models

```ts
session.modes;                       // { current, available: [{ id, name }] }
await session.setMode('default');    // session/set_mode or the "mode" config option, whichever the agent uses

session.configOptions;               // [{ id, name, category, type: 'select' | 'boolean', currentValue, choices? }]
await session.setConfigOption('effort', 'high');
await session.setConfigOption('fast', true);
session.model;                       // the select option with category "model"
await session.setModel('opus');
```

A value the agent didn't offer is refused before anything is sent. The options stay current as the agent reports changes.

## Logging in

```ts
client.authMethods;                  // [{ id, name, type: 'agent' | 'terminal', args?, env? }]
await client.authenticate('chat-gpt'); // v1 authenticate, v2 auth/login
if (client.canLogout) await client.logout();
```

`agent` methods are handled by the agent itself, which may open a browser. `terminal` methods are listed only if you pass `terminalAuth: true`: they ask you to run the agent again in a terminal with `args` and `env` added.

## Files and terminals (v1)

ACP v1 lets an agent ask the client to read and write files and run commands. The `./node` helpers confine both to a workspace:

```ts
import { workspaceFiles, workspaceTerminals } from '@deft-subspace/acp/node';
const client = await AcpClient.connect(channel, {
  files: workspaceFiles(repo),          // paths can't leave repo, symbolic links included
  terminals: workspaceTerminals(repo),  // process groups, capped output, kill
});
```

Without these options the client advertises neither. ACP v2 removes these methods, because agents run their own tools and sandboxes. In v2, a client offers its own tools through MCP (next section).

## MCP servers

Give a session MCP servers. They are written in the agent's protocol and checked against the transports it advertises:

```ts
const session = await client.newSession({
  cwd,
  mcpServers: [
    { type: 'stdio', name: 'files', command: '/usr/local/bin/files-mcp', args: ['--root', cwd] },
    { type: 'http', name: 'search', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${token}` } },
  ],
});
```

### Serving tools from your app (MCP-over-ACP)

A client can serve MCP tools over the ACP connection itself, with no extra process or port. This follows the ACP "MCP-over-ACP" RFD (MCP 2026-07-28), and needs an agent that advertises it (`client.supports.mcp.acp`):

```ts
const tools = client.serveMcp({
  name: 'editor',
  handler: async ({ method, params, signal, notify }) => {
    if (method === 'tools/list') return { result: { tools: [{ name: 'open_buffers', inputSchema: { type: 'object' } }] } };
    if (method === 'tools/call') return { result: { content: [{ type: 'text', text: listBuffers() }], isError: false } };
    return { error: { code: -32601, message: `no ${method}` } };
  },
});
const session = await client.newSession({ cwd, mcpServers: [tools] });
```

The handler has the same shape as the official SDK's `McpRequestHandler`. So a server built with `@modelcontextprotocol/server` plugs in through `fromMcpServer()` from `@agentclientprotocol/sdk/experimental/mcp-server`. `tools.dispose()` stops serving.

## Agent terminals

Agents can show the client terminals they run themselves. These are display only. Each change is a `terminal` event, and the session keeps every terminal, across turns:

```ts
for await (const event of turn) {
  if (event.type === 'terminal') {
    if (event.replaced) redraw(event.terminal.id, event.terminal.output);
    else if (event.appended) append(event.terminal.id, event.appended);
  }
}
session.terminals.get(terminalId);   // { command, cwd, size, output: Uint8Array, exitStatus?, cancellable? }
```

Output is bytes, and a chunk may split a UTF-8 character or an escape sequence. `terminalText(terminal)` decodes the whole output for a transcript.

v2 has these terminals in the protocol. On v1 the client advertises the terminal extension that claude-agent-acp and codex-acp read (`_meta.terminal_output` and `terminal_output_delta`), and their `_meta.terminal_*` keys become the same events, so a command's output streams on v1 too. `agentTerminals: false` advertises neither; such an agent then puts command output in the tool call's content.

## Background work (v2)

Agents may keep work running after a turn ends: a dev server, a log watcher, a scheduled job.

```ts
session.background;                  // [{ type: 'terminal', terminalId }, { type: 'tool_call', toolCallId }, ...]
session.toolCalls.get(id);           // tool calls of earlier turns; background updates keep them current
await session.cancelToolCall(id);    // tool_call/cancel, when the tool call is cancellable
await session.cancelTerminal(id);    // terminal/cancel, when the terminal is cancellable
```

- `session.background` is undefined when the agent doesn't report background work. That means unknown, not "nothing running".
- `turn.cancel()` stops the foreground turn only; listed work keeps running. `session.close()` stops everything.
- Permission questions about listed work are answered by your permission policy, even with no turn running.

## Questions from the agent (elicitation)

```ts
const client = await AcpClient.connect(channel, {
  elicitation: async (request, signal) => {
    if (request.mode === 'form') return { action: 'accept', content: await showForm(request.message, request.requestedSchema, signal) };
    return { action: 'decline' };
  },
  elicitationModes: ['form'],        // advertise forms only; URL requests are then declined
});
```

An accepted form answer is checked against the agent's schema (`validateElicitation`). One that doesn't fit is sent as a decline.

## Writing an agent

```ts
import { Readable, Writable } from 'node:stream';
import { ndjson } from '@deft-subspace/kernel';
import { serveAgent } from '@deft-subspace/acp';

serveAgent(
  ndjson({
    readable: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  }),
  {
    name: 'my-agent',
    version: '0.1.0',
    async prompt(turn) {
      await turn.say(`You said: ${turn.text}`);
      const call = await turn.toolCall({ title: 'Look something up', kind: 'read', status: 'in_progress' });
      const ok = await turn.requestPermission({ title: 'Look it up?', toolCallId: call.id });
      if (!ok.allowed) {
        await call.fail();
        return 'end_turn';
      }
      if (turn.signal.aborted) return 'cancelled'; // the client cancelled
      await call.complete({ content: [{ type: 'content', content: { type: 'text', text: 'found it' } }] });
      return 'end_turn';
    },
  }
);
```

You write one handler, and the library handles the differences between v1 and v2 on the wire:

- **Tool calls:** v1 creates them with `tool_call`; v2 upserts every change.
- **The end of a turn:** v1 answers the prompt request; v2 sends an idle state update.

Unknown sessions get `-32002`. `session/cancel` fires `turn.signal`, and tool calls still open are then marked failed.

Also on the turn:

- **Client capabilities:** `turn.clientSupports` says what the client offers.
- **Client files and terminals (v1):** `turn.readFile()`, `turn.writeFile()`, `turn.terminal()`.
- **Asking the user:** `turn.elicit()`.
- **Agent terminals (v2):** `turn.showTerminal({ command, cancellable })`, with `write()`, `replace()`, `exit()` and `detach()`.
- **Background tool calls:** `turn.toolCall({ ..., cancellable: true })` returns a handle with its own `signal`; `detach()` keeps it running in the background after the turn.
- **MCP:** `turn.mcpServers` lists the session's servers, typed. `turn.mcp(name)` uses one: `listTools()`, `callTool()`, `request()`. `acp` servers go over the ACP connection. `stdio`, `http` and `sse` servers need `mcpConnector: mcpConnector()` (from `./node`, with `@modelcontextprotocol/client` installed); a server is connected on first use, kept for the session, and closed with it. Calls are cancelled with the turn. Advertise what you take with `mcpTransports` (default: the connector's transports).

Options to `serveAgent`:

- `newSession`, `loadSession` and `closeSession` hooks, and `connectionClosed` (the sessions still open when the connection closed);
- `queuePrompts`;
- typed vendor `extensions`;
- `capabilities`, merged into `initialize`.

## Vendor extensions

```ts
import { extensionRequest, handle } from '@deft-subspace/acp';
const steer = extensionRequest<{ sessionId: string; text: string }, { ok: boolean }>('_acme/steer');
await client.call(steer, { sessionId, text: 'focus on tests' });  // client side
serveAgent(channel, { name, prompt, extensions: [handle(steer, (params) => ({ ok: true }))] }); // agent side
```

Names must start with `_`, as ACP requires. Optional validators check params where they arrive and results where they return.

## Testing

`@deft-subspace/acp-testkit`:

- **Record and replay:** `recordAgent()` (`./node`) records a real agent into a trace. `replayAgent(channel, trace)` plays its side back to your client, matches your calls by method, and fails with expected vs got instead of hanging.
- **Faults:** `faultChannel()` adds delays, disconnects, odd chunking and banner lines.
- **Conformance:**
  - `checkAgent(channel)` checks any agent: initialize, sessions, a prompt's end, cancel, unknown sessions, permission during cancel, login methods, config options and delete.
  - `checkClient(connect)` plays an agent against any client.
  - `checkAgentProcess()` starts a program and checks it.
  - From the command line: `node --conditions=subspace-source packages/acp-testkit/scripts/check-agent.ts <agent command>`.
- **Quirks corpus:** `packages/acp-testkit/corpus/` holds real traces from Grok Build, Claude and Codex, replayed by the test suite. Its README lists each agent's known quirks.

`@deft-subspace/devtools`: `deft-subspace-trace trace.jsonl` writes a standalone HTML viewer for a trace, and `--summary` prints a text summary.

## The kernel

`@deft-subspace/kernel` is the protocol-neutral layer: a `Channel` (a readable and a writable stream of messages), `ndjson()` framing, and `RpcPeer`.

`RpcPeer` handles:

- requests and notifications;
- timeouts;
- cancellation through an `AbortSignal`, which sends `$/cancel_request` when configured;
- a `tap` that sees every message.

It is a fit for other JSON-RPC protocols too. `channelPair()` connects two ends in memory, which is handy for tests.

## Where things stand

See `EXPERIMENT.md` for what is built, how it was tested against real agents, and what is next. The original `@deft/*` prototype packages are in `legacy/`.
