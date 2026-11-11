import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
import * as officialV2 from '@agentclientprotocol/sdk/experimental/v2';
import { ErrorCode, LocalError, RpcError } from '@deft-subspace/kernel';
import {
  AcpClient,
  CapabilityError,
  extensionNotification,
  extensionRequest,
  handle,
  serveAgent,
  type AgentOptions,
  type ClientOptions,
  type ProtocolVersion,
} from '@deft-subspace/acp';
import { byteLink, sleep } from './helpers.ts';

async function pair(protocol: ProtocolVersion, agent: Partial<AgentOptions>, client: ClientOptions = {}) {
  const link = byteLink();
  serveAgent(link.agent, { name: 'open', protocols: [protocol], prompt: () => 'end_turn', ...agent });
  return AcpClient.connect(link.client, client);
}

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));

test('supports reads v1 booleans and v2 marker objects into one shape', async () => {
  for (const [protocol, init] of [
    [1, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { list: {}, close: {} } }, authMethods: [] }],
    [2, { protocolVersion: 2, info: { name: 'x', version: '1' }, capabilities: { session: { prompt: { image: {} }, mcp: { http: {} } } }, authMethods: [] }],
  ] as const) {
    const link = byteLink();
    // The two SDK versions' builders, as one callable shape.
    ((protocol === 1 ? officialV1 : officialV2) as typeof officialV1)
      .agent({ name: 'caps' })
      .onRequest('initialize', () => init as never)
      .connect((protocol === 1 ? officialV1 : officialV2).ndJsonStream(link.b.writable, link.b.readable));
    const client = await AcpClient.connect(link.client);
    assert.equal(client.supports.loadSession, true);
    assert.equal(client.supports.listSessions, true);
    assert.equal(client.supports.closeSession, true);
    assert.deepEqual(client.supports.prompt, { image: true, audio: false, embeddedContext: false });
    assert.equal(client.supports.mcp.http, true);
    await client.close();
  }
});

test('a prompt with content the agent does not take is a CapabilityError, before anything is sent', async () => {
  const client = await pair(1, {});
  const session = await client.newSession({ cwd: '/tmp' });
  assert.throws(() => session.prompt([{ type: 'image', data: 'AA==', mimeType: 'image/png' }]), (e) => e instanceof CapabilityError && e.capability === 'image prompts');
  assert.equal(session.busy, false);
  await client.close();
});

test('listSessions pages through the agent sessions; a v1 agent without it is a CapabilityError', async () => {
  const link = byteLink();
  officialV1
    .agent({ name: 'lister' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } }, authMethods: [] }))
    .onRequest('session/list', ({ params }) =>
      params.cursor ? { sessions: [{ sessionId: 'b', cwd: '/b' }] } : { sessions: [{ sessionId: 'a', cwd: '/a', title: 'First' }], nextCursor: 'p2' }
    )
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const first = await client.listSessions();
  assert.deepEqual(first, { sessions: [{ sessionId: 'a', cwd: '/a', title: 'First' }], nextCursor: 'p2' });
  assert.deepEqual((await client.listSessions({ cursor: first.nextCursor })).sessions.map((s) => s.sessionId), ['b']);
  await client.close();
  const plain = await pair(1, {});
  await assert.rejects(plain.listSessions(), (e) => e instanceof CapabilityError);
  await plain.close();
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: client-side queue runs prompts in order; cancelling a queued one never sends it`, async () => {
    const seen: string[] = [];
    const client = await pair(protocol, {
      prompt: async (turn) => {
        seen.push(turn.text);
        await sleep(20);
        await turn.say(`did ${turn.text}`);
        return 'end_turn';
      },
    });
    const session = await client.newSession({ cwd: '/tmp' });
    const a = session.prompt('a');
    const b = session.prompt('b', { queue: true });
    const c = session.prompt('c', { queue: true });
    assert.equal(session.queuedCount, 2);
    await b.cancel();
    assert.deepEqual(await b.done, { stopReason: 'cancelled', text: '', toolCalls: [], cancelled: true });
    assert.equal((await a.done).text, 'did a');
    assert.equal((await c.done).text, 'did c');
    assert.deepEqual(seen, ['a', 'c']);
    assert.throws(() => {
      session.prompt('x');
      session.prompt('y');
    }, /already has a turn running/);
    await client.close();
  });

  test(`v${protocol}: agent-side queuePrompts runs prompts in order; session/cancel cancels the queued ones too`, async () => {
    const order: string[] = [];
    const link = byteLink();
    serveAgent(link.agent, {
      name: 'queue',
      protocols: [protocol],
      queuePrompts: true,
      prompt: async (turn) => {
        order.push(`start ${turn.text}`);
        if (turn.text === 'slow') await untilAborted(turn.signal);
        else await sleep(10);
        order.push(`end ${turn.text}`);
        return 'end_turn';
      },
    });
    const client = await AcpClient.connect(link.client);
    const session = await client.newSession({ cwd: '/tmp' });
    // Two raw prompts at once, as a client without its own queue would send them.
    const first = client.peer.request('session/prompt', { sessionId: session.id, prompt: [{ type: 'text', text: 'one' }] });
    const second = client.peer.request('session/prompt', { sessionId: session.id, prompt: [{ type: 'text', text: 'two' }] });
    await Promise.all([first, second]);
    // On v2 the answer can come before the turn has ended: wait for it (up to 2 s).
    for (let i = 0; i < 400 && order.length < 4; i++) await sleep(5);
    assert.deepEqual(order, ['start one', 'end one', 'start two', 'end two']);
    if (protocol === 1) {
      order.length = 0;
      const slow = client.peer.request('session/prompt', { sessionId: session.id, prompt: [{ type: 'text', text: 'slow' }] });
      const queued = client.peer.request('session/prompt', { sessionId: session.id, prompt: [{ type: 'text', text: 'never' }] });
      await sleep(10);
      await client.peer.notify('session/cancel', { sessionId: session.id });
      assert.deepEqual(await Promise.all([slow, queued]), [{ stopReason: 'cancelled' }, { stopReason: 'cancelled' }]);
      assert.deepEqual(order, ['start slow', 'end slow']);
    }
    await client.close();
  });
}

test('without queuePrompts, an agent refuses a second prompt while one runs', async () => {
  const client = await pair(1, { prompt: (turn) => untilAborted(turn.signal).then(() => 'end_turn' as const) });
  const session = await client.newSession({ cwd: '/tmp' });
  const running = client.peer.request('session/prompt', { sessionId: session.id, prompt: [] });
  await sleep(5);
  await assert.rejects(client.peer.request('session/prompt', { sessionId: session.id, prompt: [] }), (e) => RpcError.is(e) && e.code === ErrorCode.InvalidParams);
  await client.peer.notify('session/cancel', { sessionId: session.id });
  await running;
  await client.close();
});

const steer = extensionRequest<{ sessionId: string; text: string }, { accepted: boolean }>('_acme/steer', {
  params: { parse: (v) => { const p = v as { sessionId?: unknown; text?: unknown }; if (typeof p?.text !== 'string' || !p.text) throw new Error('text is required'); return p as { sessionId: string; text: string }; } },
  result: { parse: (v) => { if (typeof (v as { accepted?: unknown })?.accepted !== 'boolean') throw new Error('bad result'); return v as { accepted: boolean }; } },
});
const progress = extensionNotification<{ percent: number }>('_acme/progress');
const askHost = extensionRequest<{ q: string }, string>('_acme/ask_host');

test('typed extensions: names must start with _, params and results are checked, both directions', async () => {
  assert.throws(() => extensionRequest('acme/steer' as `_${string}`), /start with "_"/);
  const steered: string[] = [];
  const progressSeen: number[] = [];
  const client = await pair(
    1,
    {
      extensions: [handle(steer, (p) => (steered.push(p.text), { accepted: true }))],
      prompt: async (turn) => {
        await turn.notify(progress, { percent: 50 });
        await turn.say(await turn.call(askHost, { q: 'branch?' }));
        return 'end_turn';
      },
    },
    {
      extensions: [handle(askHost, (p) => `main (asked: ${p.q})`), handle(progress, (p) => void progressSeen.push(p.percent))],
    }
  );
  const session = await client.newSession({ cwd: '/tmp' });
  assert.deepEqual(await client.call(steer, { sessionId: session.id, text: 'focus on tests' }), { accepted: true });
  await assert.rejects(client.call(steer, { sessionId: session.id, text: '' }), (e) => RpcError.is(e) && e.code === ErrorCode.InvalidParams && /text is required/.test(e.message));
  const result = await session.prompt('go').done;
  assert.equal(result.text, 'main (asked: branch?)');
  assert.deepEqual(steered, ['focus on tests']);
  assert.deepEqual(progressSeen, [50]);
  await client.close();
});

test('a result that fails its validator is an invalid-response error on the calling side', async () => {
  const client = await pair(1, { extensions: [handle(extensionRequest('_acme/steer'), () => ({ accepted: 'yes' }))] });
  await assert.rejects(client.call(steer, { sessionId: 's', text: 'x' }), (e) => LocalError.is(e, 'invalid-response'));
  await client.close();
});

test('URL elicitation returns its id, and elicitation/complete reaches the client', async () => {
  const completed: unknown[] = [];
  const client = await pair(
    2,
    {
      prompt: async (turn) => {
        const answer = await turn.elicit({ message: 'Sign in', url: 'https://example.test/login' });
        if (answer.elicitationId) await turn.completeElicitation(answer.elicitationId);
        await turn.say(answer.action);
        return 'end_turn';
      },
    },
    {
      elicitation: (request) => (request.mode === 'url' && request.url === 'https://example.test/login' ? { action: 'accept' } : { action: 'decline' }),
      onElicitationComplete: (n) => void completed.push(n),
    }
  );
  const session = await client.newSession({ cwd: '/tmp' });
  assert.equal((await session.prompt('go').done).text, 'accept');
  await sleep(10);
  assert.equal(completed.length, 1);
  assert.match((completed[0] as { elicitationId: string }).elicitationId, /^[0-9a-f-]{36}$/);
  await client.close();
});

test('agent file helpers go through the client and throw CapabilityError without fs', async () => {
  const files = new Map<string, string>([['a.txt', 'one\ntwo']]);
  let seen: unknown;
  const client = await pair(
    1,
    {
      prompt: async (turn) => {
        await turn.writeFile('b.txt', 'written');
        seen = [await turn.readFile('a.txt', { line: 2, limit: 1 }), files.get('b.txt')];
        return 'end_turn';
      },
    },
    {
      files: {
        readTextFile: async ({ path, line }) => (line === 2 ? 'two' : (files.get(path) ?? '')),
        writeTextFile: async ({ path, content }) => void files.set(path, content),
      },
    }
  );
  await (await client.newSession({ cwd: '/tmp' })).prompt('go').done;
  assert.deepEqual(seen, ['two', 'written']);
  await client.close();
  let error: unknown;
  const bare = await pair(1, { prompt: async (turn) => { await turn.readFile('x').catch((e) => (error = e)); return 'end_turn'; } });
  await (await bare.newSession({ cwd: '/tmp' })).prompt('go').done;
  assert.ok(error instanceof CapabilityError);
  await bare.close();
});
