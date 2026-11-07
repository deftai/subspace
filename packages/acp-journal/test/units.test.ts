import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, RpcError } from '@deft-subspace/kernel';
import { Admissions, JournalProjector, MessageCoalescer, PermissionBroker, type Gate, type GateAction } from '@deft-subspace/acp-journal';
import { MemoryJournal, sleep, world } from './fixture.ts';

const msg = (mode: 'delta' | 'full', text: string, messageId = 'm1') =>
  ({ kind: 'message', mode, channel: 'agent', messageId, text }) as const;

test('coalescing: deltas, then only the unsent suffix of the final message', () => {
  const c = new MessageCoalescer();
  assert.deepEqual([c.apply(msg('delta', 'Hel')), c.apply(msg('delta', 'lo')), c.apply(msg('full', 'Hello, world'))], ['Hel', 'lo', ', world']);
  assert.equal(c.apply(msg('full', 'Hello, world')), '', 'a repeated final message sends nothing');
  assert.equal(c.apply(msg('full', 'Whole', 'm2')), 'Whole', 'a final message with no deltas is sent whole');
  const seen: unknown[] = [];
  c.apply(msg('delta', 'abc', 'm3'));
  assert.equal(c.apply(msg('full', 'xyz', 'm3'), (d) => seen.push(d)), '', 'a diverging final message sends nothing');
  assert.equal(seen.length, 1);
});

function project(events: Array<[string, unknown]>, replay = false) {
  const journal = new MemoryJournal();
  for (const [type, payload] of events) journal.append('s', type, payload);
  const projector = new JournalProjector({ sessionId: 's' });
  const out = journal.events.flatMap((e) => projector.project(e, { replay }).notifications);
  return { projector, out, journal };
}

test('projection: stamped once per seq; a re-delivered row renders nothing', () => {
  const { projector, out, journal } = project([
    ['session.message.delta', { messageId: 'm', text: 'Hi ' }],
    ['session.message', { messageId: 'm', role: 'assistant', text: 'Hi there' }],
  ]);
  assert.deepEqual(
    out.map((n) => (n.params.update as { content: { text: string } }).content.text),
    ['Hi ', 'there']
  );
  assert.deepEqual((out[1]!.params.update as { _meta: unknown })._meta, { journal: { seq: 2, headSeq: 2 } });
  assert.deepEqual(projector.project(journal.events[1]!, { replay: false }).notifications, []);
});

test('projection: tool results resend input content; open calls fail on rewind, with a rewind signal', () => {
  const { out } = project([
    ['session.tool_request', { id: 't1', name: 'executeCode', input: { code: 'return 1' } }],
    ['session.tool_result', { id: 't1', output: { ok: true } }],
    ['session.tool_request', { id: 't2', name: 'read', input: { path: 'a.md' } }],
    ['session.tool_request', { id: 't2', name: 'read', input: { path: 'a.md' } }],
    ['session.rewind', { toSeq: 2 }],
  ]);
  const updates = out.filter((n) => n.method === 'session/update').map((n) => n.params.update as Record<string, any>);
  assert.equal(updates.length, 4, 'the duplicated request is shown once');
  assert.equal(updates[0]!.sessionUpdate, 'tool_call');
  assert.match(updates[1]!.content[0].content.text, /return 1/, 'the code is resent with the result');
  assert.equal(updates[1]!.content.length, 2);
  assert.deepEqual(updates[2]!.locations, [{ path: 'a.md' }]);
  assert.equal(updates[3]!.status, 'failed');
  assert.match(updates[3]!.content.at(-1).content.text, /Interrupted by session\.rewind/);
  assert.deepEqual(out.at(-1), { method: '_journal/rewind', params: { sessionId: 's', headSeq: 5, toSeq: 2 } });
});

test('projection: user messages only in replay; cursor carries the head and the last rewind', () => {
  const events: Array<[string, unknown]> = [
    ['session.prompt', { text: 'hi' }],
    ['session.message', { messageId: 'a', role: 'assistant', text: 'Echo' }],
    ['session.rewind', { toSeq: 1 }],
  ];
  assert.equal(project(events).out.filter((n) => (n.params.update as any)?.sessionUpdate === 'user_message_chunk').length, 0);
  const replay = project(events, true);
  assert.equal(replay.out.filter((n) => (n.params.update as any)?.sessionUpdate === 'user_message_chunk').length, 1);
  assert.deepEqual(replay.projector.cursor(3), { method: '_journal/cursor', params: { sessionId: 's', headSeq: 3, rewindToSeq: 1 } });
});

test('admission: one run per receipt; a reused id with other params is -32602; no id always runs', async () => {
  const a = new Admissions();
  let runs = 0;
  const work = async () => ++runs;
  const [x, y] = await Promise.all([a.admit('s', 'r1', 'p', work), a.admit('s', 'r1', 'p', work)]);
  assert.deepEqual([x, y, runs], [1, 1, 1]);
  await assert.rejects(a.admit('s', 'r1', 'other', work), (e: unknown) => RpcError.is(e) && e.code === ErrorCode.InvalidParams);
  assert.equal(await a.admit('t', 'r1', 'other', work), 2, 'scopes are separate');
  await a.admit('s', undefined, 'p', work);
  await a.admit('s', undefined, 'p', work);
  assert.equal(runs, 4);
  const failing = () => Promise.reject(new Error('refused'));
  await assert.rejects(a.admit('s', 'bad', 'p', failing));
  await assert.rejects(a.admit('s', 'bad', 'p', work), /refused/, 'a failure is a receipt too');
});

function broker(ask: (gate: Gate) => Promise<GateAction>, mode?: 'ask' | 'auto-allow') {
  const settled: Array<[string, GateAction]> = [];
  const b = new PermissionBroker({ mode, ask, settle: async (gate, action) => void settled.push([gate.permissionId, action]) });
  return { b, settled };
}
const request = (id: string) => ({ kind: 'permission_request', id }) as const;

test('broker: fails closed, maps cancelled to cancel, ignores replayed gates', async () => {
  const { b, settled } = broker(async (gate) => {
    if (gate.permissionId === 'boom') throw new Error('client gone');
    return (gate.permissionId === 'c' ? 'cancel' : 'weird') as GateAction;
  });
  b.observe('s1', 1, request('boom'), true);
  b.observe('s2', 2, request('c'), true);
  b.observe('s3', 3, request('w'), true);
  b.observe('s4', 4, request('old'), false);
  await sleep(5);
  assert.deepEqual(settled.sort(), [['boom', 'deny'], ['c', 'cancel'], ['w', 'deny']]);
});

test('broker: an answer recorded elsewhere, a cancel or a rewind withdraws the question; late answers are ignored', async () => {
  const asked: Gate[] = [];
  let answer!: (a: GateAction) => void;
  const { b, settled } = broker((gate) => {
    asked.push(gate);
    return new Promise((resolve) => (answer = resolve));
  });
  for (const closer of [
    { kind: 'permission_response', id: 'p' },
    { kind: 'interrupt', reason: 'cancelled' },
    { kind: 'interrupt', reason: 'rewind', toSeq: 1 },
  ] as const) {
    b.observe('s', 1, request('p'), true);
    await sleep(1);
    b.observe('s', 2, closer, true);
    assert.equal(asked.at(-1)!.signal.aborted, true);
    answer('allow');
    await sleep(1);
  }
  assert.deepEqual(settled, []);
  const auto = broker(() => Promise.reject(new Error('never asked')), 'auto-allow');
  auto.b.observe('s', 1, request('p'), true);
  await sleep(1);
  assert.deepEqual(auto.settled, [['p', 'allow']]);
});

test('registry: unknown ids are -32002; dispose cancels busy sessions, closes them, then the journal', async () => {
  const order: string[] = [];
  const w = world({ closeJournal: () => void order.push('journal') });
  await assert.rejects(w.registry.load('nope'), (e: unknown) => RpcError.is(e) && e.code === ErrorCode.ResourceNotFound);
  await assert.rejects(w.registry.get('nope'), (e: unknown) => RpcError.is(e) && e.code === ErrorCode.ResourceNotFound);
  const session = await w.registry.create({ cwd: '/w' });
  const fake = w.sessions.get(session.sessionId)!;
  const turn = fake.prompt({ text: 'tool read a.md', signal: new AbortController().signal });
  const close = fake.close.bind(fake);
  fake.close = () => {
    order.push('session');
    close();
  };
  await w.registry.dispose();
  assert.deepEqual(order, ['session', 'journal']);
  assert.equal((await turn).stopReason, 'cancelled');
  assert.ok(w.journal.types(session.sessionId).includes('session.cancelled'));
  await assert.rejects(w.registry.create({}), /shut down/);
});
