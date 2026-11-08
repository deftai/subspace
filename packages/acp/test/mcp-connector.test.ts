/**
 * The agent's own MCP connections: a session's stdio and http servers used
 * through `turn.mcp(name)` with `mcpConnector()` (the official MCP SDK),
 * against a real MCP server (also the official SDK).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, McpError, serveAgent, type AgentTurn, type McpServer } from '@deft-subspace/acp';
import { mcpConnector } from '@deft-subspace/acp/node';
import { mcpServer, stopped } from './fixtures/mcp-server.ts';

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.ts', import.meta.url));
const stdioServer = (env: Record<string, string> = {}): McpServer => ({ type: 'stdio', name: 'fixture', command: process.execPath, args: [fixture], env });
const text = (result: Record<string, unknown>) => ((result.content as Array<{ text: string }>)[0]!).text;

/** An agent whose turns run `work`, and a client connected to it. */
async function connect(protocol: 1 | 2, work: (turn: AgentTurn) => Promise<void>, agent: { connector?: boolean } = {}) {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const errors: unknown[] = [];
  serveAgent(agentEnd, {
    name: 'mcp-user',
    protocols: [protocol],
    ...(agent.connector === false ? {} : { mcpConnector: mcpConnector({ stderr: 'ignore' }) }),
    async prompt(turn) {
      try {
        await work(turn);
      } catch (error) {
        errors.push(error);
      }
    },
  });
  const client = await AcpClient.connect(clientEnd);
  return { client, errors };
}

/** createMcpHandler (web Request/Response) behind node:http. */
async function httpServer() {
  const handler = createMcpHandler(() => mcpServer());
  const seen: Array<string | undefined> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    seen.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    // The client hanging up (how a 2026-07-28 HTTP call is cancelled) aborts the request.
    const hangUp = new AbortController();
    res.on('close', () => res.writableFinished || hangUp.abort());
    const response = await handler.fetch(
      new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, signal: hangUp.signal, ...(body ? { body } : {}) })
    );
    res.writeHead(response.status, Object.fromEntries([...(response.headers as unknown as Iterable<[string, string]>)]));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, seen, close: async () => (await handler.close(), await new Promise<void>((resolve) => server.close(() => resolve()))) };
}

for (const protocol of [1, 2] as const) {
  test(`v${protocol} stdio: the agent starts the server in the session's cwd with its env, lists and calls tools, and keeps it for later turns`, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'subspace-mcp-')));
    const seen: Array<Record<string, unknown>> = [];
    const { client, errors } = await connect(protocol, async (turn) => {
      const fixture = turn.mcp('fixture');
      assert.equal(fixture.type, 'stdio');
      seen.push({
        tools: (await fixture.listTools()).map((t) => t.name).sort(),
        echo: text(await fixture.callTool('echo', { message: 'hi' })),
        where: JSON.parse(text(await fixture.callTool('where'))),
        count: text(await fixture.callTool('count')),
      });
      // A tool that failed (here: bad arguments) is a result; a protocol error is { error } from request(), McpError from the helpers.
      assert.equal((await fixture.callTool('echo', { message: 7 })).isError, true);
      const unknown = await fixture.request('no/such/method');
      assert.ok('error' in unknown && unknown.error.code === -32601, JSON.stringify(unknown));
    });
    // The connector's transports are advertised.
    assert.equal(client.supports.mcp.stdio, true);
    assert.equal(client.supports.mcp.http, true);
    const session = await client.newSession({ cwd, mcpServers: [stdioServer({ SUBSPACE_TEST_ENV: 'from the client' })] });
    await session.prompt('one').done;
    await session.prompt('two').done;
    assert.deepEqual(errors, []);
    assert.deepEqual(seen[0], { tools: ['count', 'echo', 'slow', 'where'], echo: 'hi', where: { cwd, env: 'from the client' }, count: '1' });
    assert.equal(seen[1]!.count, '2', 'the same server process on the next turn');

    // Closing the session stops it: a new session gets a new process.
    await session.close();
    const again = await client.newSession({ cwd, mcpServers: [stdioServer()] });
    await again.prompt('three').done;
    assert.equal(seen[2]!.count, '1');
    assert.equal(seen[2]!.where && (seen[2]!.where as { env: unknown }).env, null);
    await client.close();
  });
}

test('http: headers go to the server; progress reaches onNotification; cancelling a call stops it', async () => {
  const http = await httpServer();
  const results: Record<string, unknown> = {};
  const { client, errors } = await connect(2, async (turn) => {
    const remote = turn.mcp('remote');
    results.echo = text(await remote.callTool('echo', { message: 'over http' }));
    const progress: unknown[] = [];
    const stop = new AbortController();
    const call = remote.callTool('slow', {}, {
      signal: stop.signal,
      onNotification: (n) => {
        progress.push(n);
        stop.abort(new Error('enough'));
      },
    });
    await assert.rejects(call);
    results.progress = progress;
    // The server's handler saw the cancel.
    for (let i = 0; i < 50 && !stopped.length; i++) await new Promise((r) => setTimeout(r, 10));
    results.stopped = stopped.length;
  });
  const session = await client.newSession({ cwd: '/', mcpServers: [{ type: 'http', name: 'remote', url: http.url, headers: { Authorization: 'Bearer t' } }] });
  await session.prompt('go').done;
  await client.close();
  await http.close();
  assert.deepEqual(errors, []);
  assert.equal(results.echo, 'over http');
  assert.equal(results.stopped, 1, 'the server stopped the call');
  assert.deepEqual(results.progress, [{ method: 'notifications/progress', params: { progress: 1, total: 2, message: 'half way' } }]);
  assert.ok(http.seen.length > 0 && http.seen.every((h) => h === 'Bearer t'), 'the Authorization header on every request');
});

test('without a connector, or for an unknown name, turn.mcp() says what is missing', async () => {
  const messages: string[] = [];
  const { client } = await connect(
    1,
    async (turn) => {
      for (const name of ['fixture', 'nope']) {
        try {
          turn.mcp(name);
        } catch (e) {
          messages.push((e as Error).message);
        }
      }
    },
    { connector: false }
  );
  const session = await client.newSession({ cwd: '/', mcpServers: [stdioServer()] });
  await session.prompt('go').done;
  await client.close();
  assert.match(messages[0]!, /"fixture" is stdio: give serveAgent an `mcpConnector`/);
  assert.match(messages[1]!, /no MCP server "nope" \(servers: fixture\)/);
});

test('a server that never answers times out on connect and is stopped; a missing one fails at once', async () => {
  const marker = `subspace-silent-${process.pid}`;
  const connector = mcpConnector({ stderr: 'ignore', connectTimeoutMs: 500 });
  const started = Date.now();
  await assert.rejects(
    connector.connect({ type: 'stdio', name: 'silent', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', marker] }, { cwd: tmpdir() })
  );
  assert.ok(Date.now() - started < 10_000, `gave up in ${Date.now() - started} ms`);
  await assert.rejects(connector.connect({ type: 'stdio', name: 'missing', command: '/no/such/mcp-server' }, { cwd: tmpdir() }));
  // The SDK stops a stdio server as MCP says: close its stdin, wait, then SIGTERM (about 2 s).
  const { execFileSync } = await import('node:child_process');
  const running = () => execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(marker));
  for (let i = 0; i < 50 && running().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(running(), [], 'no silent server left running');
});
