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
