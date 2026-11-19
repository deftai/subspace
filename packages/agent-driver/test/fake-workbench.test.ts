import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeWorkbench, isCancelled } from '../src/index.ts';

test('W1/W5: records events, asks, service calls and turn boundaries in arrival order', async () => {
  const wb = new FakeWorkbench({
    agent: { name: 'demo', identity: 'demo.test' },
    project: { path: '/repo', env: { FOO: 'bar' }, settings: { theme: 'dark' } },
    asks: {
      permission: [{ optionId: 'allow-1' }],
    },
    files: {
      readText: async ({ path }) => `contents of ${path}`,
    },
  });

  wb.turnStarted('turn-1');
  wb.emit({ type: 'message', messageId: 'm1', delta: 'Hi', text: 'Hi' });
  const text = await wb.files.readText({ sessionId: 's1', path: 'a.txt' });
  assert.equal(text, 'contents of a.txt');

  const answer = await wb.ask({
    kind: 'permission',
    request: {
      sessionId: 's1',
      title: 'Run command',
      options: [{ optionId: 'allow-1', name: 'Allow', kind: 'allow_once' }],
    },
  });
  assert.deepEqual(answer, { optionId: 'allow-1' });
  wb.turnEnded('turn-1', 'end_turn');

  assert.equal(wb.project.path, '/repo');
  assert.equal(wb.project.env.FOO, 'bar');
  assert.equal(wb.project.setting('theme'), 'dark');
  assert.equal(wb.openAskCount, 0);

  assert.deepEqual(
    wb.records.map((r) => r.kind),
    ['turn_started', 'event', 'service', 'ask', 'turn_ended'],
  );
  const serviceRec = wb.records[2];
  assert.equal(serviceRec?.kind, 'service');
  assert.equal(serviceRec.result, 'contents of a.txt');
});

test('W1: emit never throws even if given non-cloneable data, and records cloneError', () => {
  const wb = new FakeWorkbench();
  const badEvent = { type: 'prompt_suggestion', text: 'hi', fn: () => {} } as unknown as Parameters<typeof wb.emit>[0];
  assert.doesNotThrow(() => wb.emit(badEvent));
  assert.equal(wb.records.length, 1);
  const rec = wb.records[0];
  assert.equal(rec?.kind, 'event');
  assert.ok(rec.cloneError && rec.cloneError.length > 0);
});

test('W2/§8.2: child() returns the same workbench for the same id and shares the ask registry', async () => {
  const wb = new FakeWorkbench({
    asks: (_ask, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true });
      }),
  });

  const c1 = wb.child('sub-1');
  const c1Again = wb.child('sub-1');
  const c2 = wb.child('sub-2');
  assert.equal(c1, c1Again);
  assert.notEqual(c1, c2);

  wb.turnStarted('turn-1');
  c1.emit({ type: 'message', messageId: 'm1', delta: 'from child', text: 'from child' });

  const childAsk = c1.ask({
    kind: 'key',
    request: { message: 'Press', keys: [{ key: 'y', label: 'Yes' }] },
  });
  const mainAsk = wb.ask({
    kind: 'key',
    request: { message: 'Press main', keys: [{ key: 'n', label: 'No' }] },
  });

  // Both are in the single registry.
  assert.equal(wb.openAskCount, 2);

  // Ending the parent's turn settles both the parent's and the child's ask.
  wb.turnEnded('turn-1', 'end_turn');
  assert.equal(wb.openAskCount, 0);
  assert.ok(isCancelled(await childAsk));
  assert.ok(isCancelled(await mainAsk));

  assert.equal(wb.records[1]?.workbench, 'sub-1');
  assert.equal(wb.records[2]?.workbench, 'sub-1');
  assert.equal(wb.records[3]?.workbench, 'main');
});

test('W3/§4.8: detached asks survive turnEnded and settle on signal abort or workbench close', async () => {
  const wb = new FakeWorkbench({
    asks: (_ask, ctx) =>
      new Promise(() => {
        // Stays pending until cancelled.
        void ctx.signal;
      }),
  });

  wb.turnStarted('turn-1');

  const turnAsk = wb.ask({
    kind: 'permission',
    request: { sessionId: 's1', title: 'Foreground', options: [] },
  });
  const ac = new AbortController();
  const detachedSignalAsk = wb.ask(
    { kind: 'permission', request: { sessionId: 's1', title: 'Background 1', options: [] } },
    { detached: true, signal: ac.signal },
  );
  const detachedCloseAsk = wb.ask(
    { kind: 'permission', request: { sessionId: 's1', title: 'Background 2', options: [] } },
    { detached: true },
  );

  assert.equal(wb.openAskCount, 3);

  wb.turnEnded('turn-1', 'end_turn');
  assert.ok(isCancelled(await turnAsk));
  // Both detached asks remain open after turnEnded.
  assert.equal(wb.openAskCount, 2);

  ac.abort();
  assert.ok(isCancelled(await detachedSignalAsk));
  assert.equal(wb.openAskCount, 1);

  wb.close();
  assert.ok(isCancelled(await detachedCloseAsk));
  assert.equal(wb.openAskCount, 0);

  // Asking after close settles cancelled immediately.
  const afterClose = await wb.ask({
    kind: 'key',
    request: { message: 'Late', keys: [{ key: 'x', label: 'X' }] },
  });
  assert.ok(isCancelled(afterClose));
});

test('§4: unknown ask kind and unscripted asks settle cancelled immediately', async () => {
  const wb = new FakeWorkbench();

  const unknown = await wb.ask({ kind: 'not_a_real_kind', request: { foo: 1 } });
  assert.ok(isCancelled(unknown));

  const unscripted = await wb.ask({
    kind: 'plan_approval',
    request: { toolCallId: 'tc-1', plan: 'Step 1' },
  });
  assert.ok(isCancelled(unscripted));
  assert.equal(wb.openAskCount, 0);
});
