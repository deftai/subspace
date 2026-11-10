/**
 * The agent side of MCP servers: typed `mcpServers` in serveAgent, advertised
 * transports, and calling `acp` servers with `turn.mcp(name)`, against our
 * client's `serveMcp()` (v1 and v2) and the official SDK's provider.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as unstableV1 from '@agentclientprotocol/sdk/unstable';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, agentEndpoint, McpCaller, McpError, parseMcpServers, serveAgent, tool, type McpOperationContext, type McpServer, type McpTool } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

/** Two pages of tools, an echo that reports progress, a tool that fails, an unknown tool, and one that waits to be cancelled. */
function toolsHandler(seen: McpOperationContext[], aborted: { value: boolean }) {
  return async (context: McpOperationContext) => {
    seen.push(context);
    const params = (context.params ?? {}) as { cursor?: string; name?: string; arguments?: Record<string, unknown> };
    if (context.method === 'tools/list') {
      return params.cursor
        ? { result: { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] } }
        : { result: { tools: [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object' } }], nextCursor: 'page2' } };
    }
    if (context.method !== 'tools/call') return { error: { code: -32601, message: `no method ${context.method}` } };
    if (params.name === 'echo') {
      await context.notify('notifications/progress', { progressToken: 'p', progress: 1, total: 1 });
      return { result: { resultType: 'complete', content: [{ type: 'text', text: String(params.arguments?.message) }], isError: false } };
    }
    if (params.name === 'slow') {
      return new Promise<never>((_, reject) =>
        context.signal.addEventListener('abort', () => {
          aborted.value = true;
          reject(new Error('stopped'));
        })
      );
    }
    return { error: { code: -32602, message: 'Unknown tool', data: { name: params.name } } };
  };
}

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: the agent advertises its transports, gets typed servers, and calls the client's tools`, async () => {
    const link = byteLink();
    let created: McpServer[] = [];
    const log: unknown[] = [];
    serveAgent(link.agent, {
      name: 'tool-user',
      protocols: [protocol],
      mcpTransports: ['stdio', 'http', 'acp'],
      newSession: ({ servers }) => void (created = servers),
      async prompt(turn) {
        if (turn.text === 'slow') {
          // The client cancels this turn; the call is cancelled with it.
          // The agent stops waiting at once (a local `aborted`); the client is sent $/cancel_request.
          await turn.mcp('tools').callTool('slow').catch((error: { kind?: string }) => log.push(['slow', error.kind]));
          return 'cancelled';
        }
        const tools = turn.mcp('tools');
        log.push(['servers', turn.mcpServers.map((s) => `${s.type}:${s.name}`)]);
        log.push(['tools', (await tools.listTools()).map((t: McpTool) => t.name)]);
        const progress: unknown[] = [];
        const echo = await tools.callTool('echo', { message: 'hi' }, { onNotification: (n) => progress.push(n.method) });
        log.push(['echo', echo.content, progress]);
        await tools.callTool('nope').catch((error: unknown) => log.push(['nope', error instanceof McpError && error.code]));
        assert.throws(() => turn.mcp('files'), /"files" is stdio: give serveAgent an `mcpConnector`/);
        await turn.say('done');
      },
    });
    const client = await AcpClient.connect(link.client);
    assert.deepEqual(client.supports.mcp, { stdio: true, http: true, sse: false, acp: true });
    const seen: McpOperationContext[] = [];
    const aborted = { value: false };
    const tools = client.serveMcp({ name: 'tools', handler: toolsHandler(seen, aborted) });
    const session = await client.newSession({
      cwd: '/tmp',
      mcpServers: [{ type: 'stdio', name: 'files', command: '/usr/bin/files-mcp', env: { A: '1' } }, tools],
    });
    assert.deepEqual(created, [
      { type: 'stdio', name: 'files', command: '/usr/bin/files-mcp', args: [], env: { A: '1' } },
      { type: 'acp', name: 'tools', serverId: tools.serverId },
    ]);

    const result = await session.prompt('go').done;
    assert.equal(result.text, 'done');
    assert.deepEqual(log, [
      ['servers', ['stdio:files', 'acp:tools']],
      ['tools', ['echo', 'slow']],
      ['echo', [{ type: 'text', text: 'hi' }], ['notifications/progress']],
      ['nope', -32602],
    ]);
    // Each request carried its own MCP context.
    assert.equal(seen[0]?.protocolVersion, '2026-07-28');
    assert.deepEqual(seen[0]?.clientInfo, { name: 'tool-user', version: '0.0.0' });
    assert.equal(new Set(seen.map((c) => c.requestId)).size, seen.length);

    const slow = session.prompt('slow');
    setTimeout(() => void slow.cancel(), 30);
    await slow.done;
    assert.deepEqual(log.at(-1), ['slow', 'aborted']);
    // The client's handler was aborted too.
    for (let i = 0; i < 50 && !aborted.value; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(aborted.value, true);
    await client.close();
  });
}

test('an agent that advertises no transports: v1 still takes stdio, v2 none', async () => {
  for (const protocol of [1, 2] as const) {
    const link = byteLink();
    serveAgent(link.agent, { name: 'plain', protocols: [protocol], prompt: () => 'end_turn' });
    const client = await AcpClient.connect(link.client);
    assert.deepEqual(client.supports.mcp, { stdio: protocol === 1, http: false, sse: false, acp: false });
    await client.close();
  }
});

test("our agent calls tools served by the official SDK's McpOverAcpProvider (v1)", async () => {
  const link = byteLink();
  const answers: unknown[] = [];
  serveAgent(link.agent, {
    name: 'tool-user',
    protocols: [1],
    mcpTransports: ['acp'],
    async prompt(turn) {
      const tools = turn.mcp('official-tools');
      answers.push((await tools.listTools()).map((t) => t.name));
      answers.push(await tools.callTool('echo', { message: 'from the SDK' }));
    },
  });
  const provider = new unstableV1.McpOverAcpProvider();
  const connection = unstableV1
    .client({ name: 'official-client' })
    .onRequest('mcp/message', provider.handleRequest)
    .onNotification('session/update', () => {})
    .connect(unstableV1.ndJsonStream(link.a.writable, link.a.readable));
  const served = provider.registerServer(connection.agent, {
    name: 'official-tools',
    handler: ({ method, params }) =>
      method === 'tools/list'
        ? { result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } }
        : { result: { content: [{ type: 'text', text: String((params?.arguments as { message?: string })?.message) }], isError: false } },
  });
  const init = await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual((init.agentCapabilities as { mcpCapabilities?: unknown })?.mcpCapabilities, { acp: true });
  const { sessionId } = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [served.declaration] as never });
  const done = await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
  assert.equal(done.stopReason, 'end_turn');
  assert.deepEqual(answers, [['echo'], { content: [{ type: 'text', text: 'from the SDK' }], isError: false }]);
  await connection.close();
});

test("McpCaller on a raw agentEndpoint: an agent outside serveAgent calls the client's acp MCP server", async () => {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  let servers: unknown;
  let caller!: McpCaller;
  const seen: unknown[] = [];
  const endpoint = agentEndpoint(agentEnd, {
    name: 'raw-proxy',
    async request(call) {
      if (call.method === 'initialize') {
        return { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { acp: true } }, agentInfo: { name: 'raw-proxy', version: '1' }, authMethods: [] };
      }
      if (call.method === 'session/new') {
        servers = (call.params as { mcpServers?: unknown }).mcpServers;
        return { sessionId: 's' };
      }
      if (call.method === 'session/prompt') {
        const { servers: parsed } = parseMcpServers(servers);
        const editor = caller.server(parsed[0] as McpServer & { type: 'acp' });
        seen.push((await editor.listTools()).map((t) => t.name));
        seen.push(await editor.callTool('shout', { text: 'hi' }));
        return { stopReason: 'end_turn' };
      }
      throw new Error(`unexpected ${call.method}`);
    },
    notification(call) {
      if (call.method === 'mcp/message') caller.receive(call.params);
    },
  });
  caller = new McpCaller(endpoint.client, { name: 'raw-proxy', version: '1' });
  const client = await AcpClient.connect(clientEnd, { permissions: 'reject' });
  const editor = client.serveTools({
    name: 'editor',
    tools: { shout: tool({ description: 'Upper-case', input: { type: 'object', properties: { text: { type: 'string' } } }, run: (i: { text: string }) => i.text.toUpperCase() }) },
  });
  const session = await client.newSession({ cwd: '/', mcpServers: [editor] });
  await session.prompt('go').done;
  assert.deepEqual(seen[0], ['shout']);
  assert.deepEqual(seen[1], { resultType: 'complete', content: [{ type: 'text', text: 'HI' }], isError: false });
  await client.close();
});
