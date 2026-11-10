/**
 * MCP servers for sessions: typed declarations checked against the agent's
 * transports (v1 and v2), and MCP-over-ACP served by our client to an agent
 * that calls it with the official SDK's `McpOverAcpCaller`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
import * as unstableV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import { AcpClient, CapabilityError, McpBindingError, type McpOperationContext } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

test('v1 declarations: stdio without a type, http and sse with header lists; untaken transports refused before session/new', async () => {
  const link = byteLink();
  const received: unknown[] = [];
  officialV1
    .agent({ name: 'mcp-v1' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] }))
    .onRequest('session/new', ({ params }) => {
      received.push(params.mcpServers);
      return { sessionId: `s${received.length}` };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  assert.deepEqual(client.supports.mcp, { stdio: true, http: true, sse: false, acp: false });
  await client.newSession({
    cwd: '/tmp',
    mcpServers: [
      { type: 'stdio', name: 'files', command: 'files-mcp', args: ['--root', '/tmp'], env: { LOG: '1' } },
      { type: 'http', name: 'search', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer x' } },
    ],
  });
  assert.deepEqual(received[0], [
    { name: 'files', command: 'files-mcp', args: ['--root', '/tmp'], env: [{ name: 'LOG', value: '1' }] },
    { type: 'http', name: 'search', url: 'https://mcp.example.com', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
  ]);
  await assert.rejects(client.newSession({ cwd: '/tmp', mcpServers: [{ type: 'sse', name: 'old', url: 'https://x' }] }), CapabilityError);
  const tools = client.serveMcp({ name: 'tools', handler: () => ({ result: null }) });
  await assert.rejects(client.newSession({ cwd: '/tmp', mcpServers: [tools] }), /does not offer acp MCP servers/);
  assert.equal(received.length, 1);
  await client.close();
});

test('v2 declarations: stdio only when advertised, with an absolute command', async () => {
  for (const stdio of [false, true]) {
    const link = byteLink();
    const received: unknown[] = [];
    unstableV2
      .agent({ name: 'mcp-v2' })
      .onRequest('initialize', () => ({
        protocolVersion: 2,
        info: { name: 'mcp-v2', version: '1' },
        capabilities: { session: { mcp: stdio ? { stdio: {} } : {} } },
        authMethods: [],
      }))
      .onRequest('session/new', ({ params }) => {
        received.push(params.mcpServers);
        return { sessionId: 's' };
      })
      .connect(unstableV2.ndJsonStream(link.b.writable, link.b.readable));
    const client = await AcpClient.connect(link.client);
    const files = { type: 'stdio' as const, name: 'files', command: '/usr/local/bin/files-mcp' };
    if (!stdio) {
      await assert.rejects(client.newSession({ cwd: '/tmp', mcpServers: [files] }), CapabilityError);
    } else {
      await assert.rejects(client.newSession({ cwd: '/tmp', mcpServers: [{ ...files, command: 'files-mcp' }] }), /absolute command path/);
      await client.newSession({ cwd: '/tmp', mcpServers: [files] });
      assert.deepEqual(received, [[{ type: 'stdio', name: 'files', command: '/usr/local/bin/files-mcp', args: [], env: [] }]]);
    }
    await client.close();
  }
});

/** A v2 agent that calls the session's `acp` MCP servers with the official caller; `run` gets the caller and connection. */
function mcpAgent(link: ReturnType<typeof byteLink>, run: (call: Caller) => Promise<unknown>) {
  const caller = new unstableV2.McpOverAcpCaller({ clientInfo: { name: 'mcp-agent', version: '1' } });
  let servers: Array<{ type?: string; serverId?: string; name?: string }> = [];
  const results: unknown[] = [];
  unstableV2
    .agent({ name: 'mcp-agent' })
    .onRequest('initialize', () => ({
      protocolVersion: 2,
      info: { name: 'mcp-agent', version: '1' },
      capabilities: { session: { mcp: { acp: {} } } },
      authMethods: [],
    }))
    .onNotification('mcp/message', caller.handleNotification)
    .onRequest('session/new', ({ params }) => {
      servers = params.mcpServers as typeof servers;
      return { sessionId: 's' };
    })
    .onRequest('session/prompt', ({ params, client }) => {
      const send = (update: unstableV2.SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update });
      setTimeout(async () => {
        const call: Caller = (serverId, method, mcpParams, options) =>
          caller.request(client, serverId ?? servers[0]!.serverId!, method, mcpParams, options).then(
            (outcome) => ({ outcome }),
            (error: { code?: number; message?: string }) => ({ acpError: { code: error.code, message: error.message } })
          );
        results.push(await run(call));
        await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 5);
      return { messageId: 'u1' };
    })
    .connect(unstableV2.ndJsonStream(link.b.writable, link.b.readable));
  return { results, servers: () => servers };
}

type Caller = (
  serverId: string | undefined,
  method: string,
  params?: Record<string, unknown> | null,
  options?: { signal?: AbortSignal; onNotification?: (n: { method: string; params?: unknown }) => void }
) => Promise<{ outcome?: unknown; acpError?: { code?: number; message?: string } }>;

test('MCP-over-ACP: the agent calls a tool the client serves; progress, inner errors, unknown servers', async () => {
  const link = byteLink();
  const seen: McpOperationContext[] = [];
  const agent = mcpAgent(link, async (call) => {
    const progress: unknown[] = [];
    const echo = await call(undefined, 'tools/call', { name: 'echo', arguments: { message: 'hello' }, _meta: { progressToken: 'p1' } }, {
      onNotification: (n) => progress.push(n),
    });
    const unknownTool = await call(undefined, 'tools/call', { name: 'nope', arguments: {} });
    const oldVersion = await call(undefined, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } });
    const unknownServer = await call('no-such-server', 'tools/list', {});
    return { echo, progress, unknownTool, oldVersion, unknownServer };
  });

  const client = await AcpClient.connect(link.client);
  assert.equal(client.supports.mcp.acp, true);
  const tools = client.serveMcp({
    name: 'project-tools',
    handler: async (context) => {
      seen.push(context);
      if (context.method !== 'tools/call') return { result: { tools: [] } };
      const { name, arguments: args } = context.params as { name: string; arguments: { message?: string } };
      if (name !== 'echo') throw Object.assign(new Error('Unknown tool'), { toMcpError: () => ({ code: -32602, message: 'Unknown tool', data: { name } }) });
      await context.notify('notifications/progress', { progressToken: 'p1', progress: 1, total: 1 });
      return { result: { resultType: 'complete', content: [{ type: 'text', text: args.message }], isError: false } };
    },
  });
  const session = await client.newSession({ cwd: '/tmp', mcpServers: [tools] });
  assert.deepEqual(agent.servers(), [{ type: 'acp', name: 'project-tools', serverId: tools.serverId }]);
  await session.prompt('use the tools').done;

  const r = agent.results[0] as Record<string, { outcome?: unknown; acpError?: { code?: number } } | unknown[]>;
  assert.deepEqual(r.echo, { outcome: { result: { resultType: 'complete', content: [{ type: 'text', text: 'hello' }], isError: false } } });
  assert.deepEqual(r.progress, [{ method: 'notifications/progress', params: { progressToken: 'p1', progress: 1, total: 1 } }]);
  // An inner MCP error is a successful ACP answer.
  assert.deepEqual(r.unknownTool, { outcome: { error: { code: -32602, message: 'Unknown tool', data: { name: 'nope' } } } });
  assert.deepEqual((r.oldVersion as { outcome: { error: { code: number } } }).outcome.error.code, -32022);
  assert.equal((r.unknownServer as { acpError: { code: number } }).acpError.code, McpBindingError.serverUnavailable);
  // The handler saw the per-request MCP context the caller sent.
  assert.equal(seen[0]?.protocolVersion, '2026-07-28');
  assert.deepEqual(seen[0]?.clientInfo, { name: 'mcp-agent', version: '1' });
  assert.equal(seen.length, 2, 'the request with an old MCP version never reached the handler');
  await client.close();
});

test('MCP-over-ACP: cancelling a call aborts the handler (-32800); dispose makes the server unavailable', async () => {
  const link = byteLink();
  let disposeNow!: () => Promise<void>;
  let handlerAborted = false;
  const agent = mcpAgent(link, async (call) => {
    const controller = new AbortController();
    const slow = call(undefined, 'tools/call', { name: 'slow', arguments: {} }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const cancelled = await slow;
    await disposeNow();
    const afterDispose = await call(undefined, 'tools/list', {});
    return { cancelled, afterDispose };
  });
  const client = await AcpClient.connect(link.client);
  const tools = client.serveMcp({
    name: 'slow-tools',
    handler: (context) =>
      new Promise((_, reject) =>
        context.signal.addEventListener('abort', () => {
          handlerAborted = true;
          reject(new Error('stopped'));
        })
      ),
  });
  disposeNow = () => tools.dispose();
  const session = await client.newSession({ cwd: '/tmp', mcpServers: [tools.declaration] });
  await session.prompt('go').done;
  const r = agent.results[0] as { cancelled: { acpError?: { code?: number } }; afterDispose: { acpError?: { code?: number } } };
  assert.equal(handlerAborted, true);
  assert.equal(r.cancelled.acpError?.code, McpBindingError.cancelled);
  assert.equal(r.afterDispose.acpError?.code, McpBindingError.serverUnavailable);
  assert.throws(() => client.serveMcp({ name: 'again', serverId: tools.serverId, handler: () => ({ result: null }) }), /already used/);
  await client.close();
});
