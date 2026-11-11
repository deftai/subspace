import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, formatTrace, parseTrace, RpcPeer, traceTap, type TraceRecord } from '@deft-subspace/kernel';
import { manualClock } from '@deft-subspace/kernel/testing';

test('a trace tap records every message with time and direction, and round-trips', async () => {
  const clock = manualClock(1_700_000_000_000);
  const records: TraceRecord[] = [];
  const tap = traceTap((r) => records.push(r), {
    peer: 'client',
    label: 'demo',
    clock,
    redact: (m) => (JSON.stringify(m).includes('secret') ? undefined : m),
  });
  const [a, b] = channelPair<unknown>();
  const client = new RpcPeer(a, { tap }).start();
  new RpcPeer(b).onRequest('echo', (p) => p).start();
  clock.advance(5);
  assert.deepEqual(await client.request('echo', { n: 1 }), { n: 1 });
  await client.notify('secret', {});
  tap.note('done', { ok: true });
  await client.close();

  assert.deepEqual(
    records.map((r) => (r.kind === 'message' ? [r.kind, r.dir, r.t] : [r.kind])),
    [['header'], ['message', 'out', 5], ['message', 'in', 5], ['note']]
  );
  assert.equal(records[0]!.kind === 'header' && records[0]!.started, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(parseTrace(formatTrace(records)), records);
});

test('parseTrace names a bad line and requires a header', () => {
  assert.throws(() => parseTrace('{"v":1,"kind":"header","started":"x","peer":"c"}\nnope\n'), /line 2 is not JSON/);
  assert.throws(() => parseTrace('{"v":1,"kind":"note","t":0,"text":"x"}\n'), /starts with a header/);
  assert.throws(() => parseTrace('{"v":9,"kind":"header"}\n'), /line 1 is not a version 1/);
});

test('a trace record is a copy: changing the message later does not change it', () => {
  const records: TraceRecord[] = [];
  const tap = traceTap((r) => records.push(r), { peer: 'a' });
  const bytes = new Uint8Array([1, 2]);
  const message = { jsonrpc: '2.0', method: 'm', params: { list: [{ a: 1 }], nothing: null, bytes, when: new Date(0) } };
  tap('out', message);
  message.params.list[0]!.a = 2;
  message.params.list.push({ a: 3 });
  bytes[0] = 9;
  const recorded = (records[1] as { msg: typeof message }).msg;
  assert.deepEqual(recorded.params.list, [{ a: 1 }]);
  assert.equal(recorded.params.nothing, null);
  assert.deepEqual([...recorded.params.bytes], [1, 2]);
  assert.ok(recorded.params.when instanceof Date);
  assert.notEqual(recorded.params, message.params);
});

test('a trace tap records a cyclic or uncloneable message instead of throwing', () => {
  const records: TraceRecord[] = [];
  const tap = traceTap((r) => records.push(r), { peer: 'a' });
  const cyclic: Record<string, unknown> = { jsonrpc: '2.0', method: 'm', params: { list: [] as unknown[] } };
  (cyclic.params as { list: unknown[] }).list.push(cyclic);
  tap('out', cyclic);
  const recorded = (records[1] as { msg: typeof cyclic }).msg;
  assert.notEqual(recorded, cyclic);
  assert.equal((recorded.params as { list: unknown[] }).list[0], recorded);
  // Deeply nested, but not cyclic: copied all the same.
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 20_000; i++) deep = { next: deep };
  tap('out', deep);
  assert.equal(records.length, 3);
  // Not cloneable at all: recorded as it is.
  const withFunction = { method: 'm', params: new (class Params { f = () => {} })() };
  tap('in', withFunction);
  assert.equal((records[3] as { msg: unknown }).msg, withFunction);
});
