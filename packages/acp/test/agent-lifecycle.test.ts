/**
 * serveAgent's teardown, pinned (docs/AGENT-LAYERS.md, contract point 6):
 * session/close stops the turn, then releases MCP connections, then calls
 * closeSession; a closed connection stops turns and closes MCP connections
 * but does not call closeSession.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, RpcError } from '@deft-subspace/kernel';
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
