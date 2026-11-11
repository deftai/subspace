/**
 * serveAgent's teardown, pinned (docs/AGENT-LAYERS.md, contract point 6):
 * session/close stops the turn, then releases MCP connections, then calls
 * closeSession; a closed connection stops turns and closes MCP connections
 * but does not call closeSession.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, RpcError, RpcPeer } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type McpConnector } from '@deft-subspace/acp';

function recordingAgent(events: string[]) {
  const connector: McpConnector = {
    transports: ['stdio'],
    async connect() {
      return {
        request: async () => ({ result: { tools: [] } }),
        close: async () => void events.push('mcp closed'),
      };
    },
  };
  const [agentEnd, clientEnd] = channelPair<unknown>();
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  serveAgent(agentEnd, {
    name: 'lifecycle',
    protocols: [1],
    mcpConnector: connector,
    closeSession: (id) => void events.push(`closeSession ${id}`),
    async prompt(turn) {
      await turn.mcp('files').listTools();
      started();
      await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => (events.push('turn stopped'), resolve()), { once: true }));
      return 'cancelled';
    },
  });
  return { clientEnd, running };
}

const server = { type: 'stdio' as const, name: 'files', command: '/bin/true' };

test('session/close: the turn stops, then MCP connections close, then closeSession', async () => {
  const events: string[] = [];
  const { clientEnd, running } = recordingAgent(events);
  const client = await AcpClient.connect(clientEnd);
  const session = await client.newSession({ cwd: '/w', mcpServers: [server] });
  const turn = session.prompt('go');
  await running;
  await session.close();
  await turn.done.catch(() => {});
  assert.deepEqual(events, ['turn stopped', 'mcp closed', `closeSession ${session.id}`]);
  await client.close();
});

test('a closed connection stops turns and closes MCP connections, without closeSession', async () => {
  const events: string[] = [];
  const { clientEnd, running } = recordingAgent(events);
  const client = await AcpClient.connect(clientEnd);
  const session = await client.newSession({ cwd: '/w', mcpServers: [server] });
  void session.prompt('go').done.catch(() => {});
  await running;
  await client.close();
  for (let i = 0; i < 50 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events.sort(), ['mcp closed', 'turn stopped']);
});

test('session/close aborts an MCP connect still in flight instead of waiting for it', async () => {
  const events: string[] = [];
  let connecting!: () => void;
  const started = new Promise<void>((resolve) => (connecting = resolve));
  const connector: McpConnector = {
    transports: ['stdio'],
    connect: (_server, context) =>
      new Promise((_resolve, reject) => {
        connecting();
        context.signal?.addEventListener('abort', () => (events.push('connect aborted'), reject(context.signal!.reason)), { once: true });
      }),
  };
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'slow-mcp',
    protocols: [1],
    mcpConnector: connector,
    async prompt(turn) {
      await turn.mcp('files').listTools().catch(() => {});
      return 'cancelled';
    },
  });
  const client = await AcpClient.connect(clientEnd);
  const session = await client.newSession({ cwd: '/w', mcpServers: [server] });
  const turn = session.prompt('go');
  await started;
  const closed = await Promise.race([session.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
  assert.equal(closed, 'closed');
  assert.deepEqual(events, ['connect aborted']);
  await turn.done.catch(() => {});
  await client.close();
});

test('v1 capabilities merge into sessionCapabilities and mcpCapabilities', async () => {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'caps',
    protocols: [1],
    loadSession: () => {},
    mcpTransports: ['http'],
    capabilities: { sessionCapabilities: { list: {} }, mcpCapabilities: { sse: true } },
    prompt: () => 'end_turn',
  });
  const peer = new RpcPeer(clientEnd);
  peer.start();
  const result = await peer.request<{ agentCapabilities: unknown }>('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(result.agentCapabilities, {
    loadSession: true,
    sessionCapabilities: { close: {}, resume: {}, list: {} },
    mcpCapabilities: { http: true, sse: true },
  });
  await peer.close();
});

test('a second initialize is refused, and the protocol kept', async () => {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, { name: 'once', prompt: () => 'end_turn' });
  const peer = new RpcPeer(clientEnd);
  peer.start();
  assert.equal((await peer.request<{ protocolVersion: number }>('initialize', { protocolVersion: 2, capabilities: {} })).protocolVersion, 2);
  await assert.rejects(peer.request('initialize', { protocolVersion: 1, clientCapabilities: {} }), (error: unknown) => RpcError.is(error) && error.code === -32600);
  const { sessionId } = await peer.request<{ sessionId: string }>('session/new', { cwd: '/w', mcpServers: [] });
  // Still v2: the prompt is answered at once with a message id.
  assert.ok((await peer.request<{ messageId?: string }>('session/prompt', { sessionId, prompt: [] })).messageId);
  await peer.close();
});

test('a closed connection calls connectionClosed with its open sessions, after their teardown', async () => {
  const events: string[] = [];
  const connector: McpConnector = {
    transports: ['stdio'],
    async connect() {
      return { request: async () => ({ result: { tools: [] } }), close: async () => void events.push('mcp closed') };
    },
  };
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'hook',
    protocols: [1],
    mcpConnector: connector,
    closeSession: (id) => void events.push(`closeSession ${id}`),
    connectionClosed: (ids) => void events.push(`connectionClosed ${[...ids].sort().join(',')}`),
    async prompt(turn) {
      await turn.mcp('files').listTools();
      return 'end_turn';
    },
  });
  const client = await AcpClient.connect(clientEnd);
  const a = await client.newSession({ cwd: '/w', mcpServers: [server] });
  await a.prompt('go').done;
  const b = await client.newSession({ cwd: '/w' });
  const closed = await client.newSession({ cwd: '/w' });
  await closed.close();
  await client.close();
  for (let i = 0; i < 50 && !events.some((e) => e.startsWith('connectionClosed')); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events, [`closeSession ${closed.id}`, 'mcp closed', `connectionClosed ${[a.id, b.id].sort().join(',')}`]);
});

test('session/new returning an id that is already open is refused, and the open session is kept', async () => {
  const events: string[] = [];
  const connector: McpConnector = {
    transports: ['stdio'],
    async connect() {
      events.push('mcp connected');
      return { request: async () => ({ result: { tools: [] } }), close: async () => void events.push('mcp closed') };
    },
  };
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'fixed',
    protocols: [1],
    mcpConnector: connector,
    newSession: () => ({ sessionId: 'fixed' }),
    async prompt(turn) {
      await turn.mcp('files').listTools();
      return 'end_turn';
    },
  });
  const client = await AcpClient.connect(clientEnd);
  const session = await client.newSession({ cwd: '/w', mcpServers: [server] });
  await session.prompt('a').done;
  await assert.rejects(client.newSession({ cwd: '/w', mcpServers: [server] }), (error: unknown) => RpcError.is(error) && error.code === -32602);
  // The first session is untouched: same MCP connection, still usable.
  await session.prompt('b').done;
  assert.deepEqual(events, ['mcp connected']);
  await session.close();
  assert.deepEqual(events, ['mcp connected', 'mcp closed']);
  await client.close();
});
