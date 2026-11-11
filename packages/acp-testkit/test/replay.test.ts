import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, LocalError, parseTrace, RpcError, RpcPeer, type TraceRecord } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type AgentTurn } from '@deft-subspace/acp';
import { normalizeTurn, recorder, redactKeys, replayAgent, ReplayDivergence, replaceStrings, tapChannel } from '@deft-subspace/acp-testkit';
import { byteLink } from './helpers.ts';

async function scripted(turn: AgentTurn) {
  await turn.say('Reading ');
  const call = await turn.toolCall({ title: 'Read a.txt', kind: 'read' });
  const answer = await turn.requestPermission({ title: 'Read a.txt', toolCallId: call.id });
  if (answer.allowed) await call.complete();
  else await call.fail();
  await turn.say(answer.allowed ? 'done' : 'denied');
  return 'end_turn';
}

/** Run one turn of `scripted` and record it from the client's side, and the channel's. */
async function recordScripted(protocol: 1 | 2) {
  const link = byteLink();
  serveAgent(link.agent, { name: 'scripted', protocols: [protocol], prompt: scripted });
  const rec = recorder({ peer: 'client', label: `scripted v${protocol}` });
  const wire = recorder({ peer: 'client' });
  const client = await AcpClient.connect(tapChannel(link.client, wire.tap), { permissions: 'allow', tap: rec.tap });
  const session = await client.newSession({ cwd: '/tmp/project' });
  const result = normalizeTurn(await session.prompt('read a.txt').done);
  await client.close();
  return { rec, wire, result };
}

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: record a session, then replay it to a fresh client with the same result`, async () => {
    const { rec, wire, result } = await recordScripted(protocol);
    const records = parseTrace(rec.text());
    assert.equal(records[0]?.kind, 'header');
    const methods = records.flatMap((r) => (r.kind === 'message' && r.dir === 'out' && (r.msg as { method?: string }).method) || []);
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt']);
    // A channel tap sees the same messages as the peer's tap.
    const strip = (rs: TraceRecord[]) => rs.filter((r) => r.kind === 'message').map((r) => r.kind === 'message' && [r.dir, r.msg]);
    assert.deepEqual(strip(wire.records), strip(rec.records));

    const [agentEnd, clientEnd] = channelPair<unknown>();
    const replay = replayAgent(agentEnd, records);
    const client = await AcpClient.connect(clientEnd, { permissions: 'allow' });
    assert.equal(client.protocol, protocol);
    const session = await client.newSession({ cwd: '/elsewhere' }); // different params are fine
    const replayed = normalizeTurn(await session.prompt('something else').done);
    assert.deepEqual(replayed, result);
    assert.equal(replayed.text, 'Reading \n\ndone');
    await replay.done;
    await client.close();
  });
}

test('ids are remapped both ways', async () => {
  // A hand-written trace whose ids look nothing like the live client's.
  const at = (dir: 'in' | 'out', msg: unknown, t = 0) => JSON.stringify({ v: 1, kind: 'message', t, dir, msg });
  const text = [
    JSON.stringify({ v: 1, kind: 'header', started: new Date(0).toISOString(), peer: 'client' }),
    at('out', { jsonrpc: '2.0', id: 'init-a', method: 'initialize', params: {} }),
    at('in', { jsonrpc: '2.0', id: 'init-a', result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }),
    at('out', { jsonrpc: '2.0', id: 'new-b', method: 'session/new', params: {} }),
    at('in', { jsonrpc: '2.0', id: 'new-b', result: { sessionId: 's' } }),
    at('out', { jsonrpc: '2.0', id: 99, method: 'session/prompt', params: {} }),
    at('in', { jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 't', title: 'Run' }, options: [{ optionId: 'y', name: 'Yes', kind: 'allow_once' }] } }),
    at('out', { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'y' } } }),
    at('in', { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ran' } } } }),
    at('in', { jsonrpc: '2.0', id: 99, result: { stopReason: 'end_turn' } }),
  ].join('\n');
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const seen: unknown[] = [];
  const replay = replayAgent(tapChannel(agentEnd, (dir, m) => dir === 'out' && seen.push(m)), text);
  const client = await AcpClient.connect(clientEnd, { permissions: 'allow' });
  const session = await client.newSession({ cwd: '/tmp' });
  const result = await session.prompt('go').done;
  assert.equal(result.text, 'ran');
  await replay.done;
  const ids = seen.map((m) => (m as { id?: unknown }).id).filter((id) => id !== undefined);
  // Answers carry the live client's ids (0, 1, 2); the agent's request got a fresh id.
  assert.deepEqual(ids, [0, 1, 0, 2]);
  await client.close();
});

test('a trace recorded on the agent side replays too', async () => {
  const [a, b] = channelPair<unknown>();
  const rec = recorder({ peer: 'agent' });
  serveAgent(a, { name: 'echo', peer: { tap: rec.tap }, prompt: async (turn) => void (await turn.say(`echo: ${turn.text}`)) });
  const live = await AcpClient.connect(b);
  await (await live.newSession({ cwd: '/tmp' })).prompt('hi').done;
  await live.close();

  const [agentEnd, clientEnd] = channelPair<unknown>();
  const replay = replayAgent(agentEnd, rec.records);
  const client = await AcpClient.connect(clientEnd);
  const result = await (await client.newSession({ cwd: '/tmp' })).prompt('bye').done;
  assert.equal(result.text, 'echo: hi', 'the recorded answer, whatever was asked');
  await replay.done;
  await client.close();
});

test('a different request is a divergence: the request gets an error naming both, and the connection closes', async () => {
  const { rec } = await recordScripted(1);
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const replay = replayAgent(agentEnd, rec.records);
  const peer = new RpcPeer(clientEnd).start();
  await peer.request('initialize', { protocolVersion: 1 });
  await assert.rejects(peer.request('session/load', { sessionId: 'x' }), (e) => {
    assert.ok(RpcError.is(e));
    assert.match(e.message, /expected the client to send request "session\/new", got request "session\/load"/);
    return true;
  });
  await assert.rejects(replay.done, (e) => {
    assert.ok(e instanceof ReplayDivergence);
    assert.equal(e.step, 3);
    assert.equal((e.expected as { method?: string }).method, 'session/new');
    assert.equal((e.got as { method?: string }).method, 'session/load');
    return true;
  });
  const closed = await peer.closed;
  assert.equal(closed.reason, 'remote-ended');
});

test('requests sent together may arrive in another order; check sees the recorded message with live ids', async () => {
  const at = (dir: 'in' | 'out', msg: unknown) => JSON.stringify({ v: 1, kind: 'message', t: 0, dir, msg });
  const text = [
    JSON.stringify({ v: 1, kind: 'header', started: new Date(0).toISOString(), peer: 'client' }),
    at('out', { jsonrpc: '2.0', id: 'r-a', method: 'x/a', params: { n: 1 } }),
    at('out', { jsonrpc: '2.0', id: 'r-b', method: 'x/b', params: { n: 2 } }),
    at('out', { jsonrpc: '2.0', method: 'x/note', params: {} }),
    at('in', { jsonrpc: '2.0', id: 'r-a', result: { a: true } }),
    at('in', { jsonrpc: '2.0', id: 'r-b', result: { b: true } }),
  ].join('\n');
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const checked: Array<[unknown, unknown]> = [];
  const replay = replayAgent(agentEnd, text, { check: (expected, got) => void checked.push([expected.id, got.id]) });
  const peer = new RpcPeer(clientEnd).start();
  // Recorded a, b, note; sent note, b, a.
  peer.notify('x/note', {});
  const b = peer.request('x/b', { n: 2 });
  const a = peer.request('x/a', { n: 1 });
  assert.deepEqual(await Promise.all([a, b]), [{ a: true }, { b: true }]);
  await replay.done;
  assert.equal(checked.length, 3);
  for (const [expected, got] of checked) assert.equal(expected, got);
  await peer.close();
});

test('a client that never sends what was recorded fails within waitMs instead of hanging', async () => {
  const { rec } = await recordScripted(1);
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const replay = replayAgent(agentEnd, rec.records, { waitMs: 50 });
  const client = await AcpClient.connect(clientEnd, { permissions: 'allow' });
  // The recording continues with session/new; this client just waits.
  await assert.rejects(replay.done, /expected the client to send request "session\/new", got nothing within 50 ms/);
  await client.peer.closed;
  await assert.rejects(client.newSession({ cwd: '/tmp' }), (e) => LocalError.is(e, 'closed'));
});

test('requests after the end of the recording get an error', async () => {
  const { rec } = await recordScripted(1);
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const replay = replayAgent(agentEnd, rec.records);
  const client = await AcpClient.connect(clientEnd, { permissions: 'allow' });
  const session = await client.newSession({ cwd: '/tmp' });
  await session.prompt('go').done;
  await replay.done;
  await assert.rejects(client.newSession({ cwd: '/tmp' }), /Replay has ended; nothing was recorded for session\/new/);
  await client.close();
});

test('check makes params matter when you want them to', async () => {
  const { rec } = await recordScripted(1);
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const replay = replayAgent(agentEnd, rec.records, {
    check: (expected, got) =>
      expected.method === 'session/new' && JSON.stringify(expected.params) !== JSON.stringify(got.params)
        ? `session/new params differ: ${JSON.stringify(got.params)}`
        : undefined,
  });
  const client = await AcpClient.connect(clientEnd);
  await assert.rejects(client.newSession({ cwd: '/other' }), /session\/new params differ/);
  await assert.rejects(replay.done, ReplayDivergence);
});

test('pace keeps the recorded gaps', async () => {
  const at = (t: number, dir: 'in' | 'out', msg: unknown) => ({ v: 1 as const, kind: 'message' as const, t, dir, msg });
  const records: TraceRecord[] = [
    { v: 1, kind: 'header', started: new Date(0).toISOString(), peer: 'client' },
    at(0, 'out', { jsonrpc: '2.0', id: 0, method: 'ping' }),
    at(60, 'in', { jsonrpc: '2.0', id: 0, result: 'pong' }),
  ];
  for (const [pace, min, max] of [[0, 0, 40], [1, 55, 1000]] as const) {
    const [agentEnd, clientEnd] = channelPair<unknown>();
    replayAgent(agentEnd, records, { pace });
    const peer = new RpcPeer(clientEnd).start();
    const started = Date.now();
    assert.equal(await peer.request('ping'), 'pong');
    const took = Date.now() - started;
    assert.ok(took >= min && took < max, `pace ${pace} took ${took} ms`);
    await peer.close();
  }
});

test('replaceStrings and redactKeys redact at any depth', () => {
  const redact = replaceStrings([['/tmp/abc', '/workspace'], [/token-\w+/g, 'token-x']]);
  assert.deepEqual(redact({ cwd: '/tmp/abc', list: ['see /tmp/abc/a.txt', 3, { t: 'token-123 token-9' }] }), {
    cwd: '/workspace',
    list: ['see /workspace/a.txt', 3, { t: 'token-x token-x' }],
  });
  assert.deepEqual(redactKeys(['hostname'])({ _meta: [{ hostname: 'my-mac', keep: 1 }] }), { _meta: [{ hostname: '[redacted]', keep: 1 }] });
});
