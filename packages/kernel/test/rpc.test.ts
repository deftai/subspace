import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cancelRequest,
  channelPair,
  ErrorCode,
  LocalError,
  ndjson,
  RpcError,
  RpcPeer,
  type Channel,
  type JsonRpcId,
  type PeerDiagnostic,
  type RpcPeerOptions,
} from '@deft-subspace/kernel';
import { manualClock, tick } from '@deft-subspace/kernel/testing';


function pair(a: RpcPeerOptions = {}, b: RpcPeerOptions = {}) {
  const [left, right] = channelPair<unknown>();
  const client = new RpcPeer(left, { name: 'client', ...a });
  const server = new RpcPeer(right, { name: 'server', ...b });
  return { client, server, start: () => (client.start(), server.start()) };
}

/** A raw end: read what the peer sends, write anything back. */
function raw() {
  const [left, right] = channelPair<unknown>();
  const sent: unknown[] = [];
  const writer = right.writable.getWriter();
  void (async () => {
    for await (const m of right.readable) sent.push(m);
  })();
  return { channel: left as Channel<unknown>, sent, send: (m: unknown) => writer.write(m), end: () => writer.close() };
}

test('the first request has id 0, and it can be cancelled', async () => {
  const { client, server, start } = pair(cancelRequest, cancelRequest);
  let seenId: unknown;
  let handlerSignal: AbortSignal | undefined;
  server.onRequest('slow', (_p, ctx) => {
    seenId = ctx.id;
    handlerSignal = ctx.signal;
    return new Promise(() => {}); // never answers
  });
  start();
  const controller = new AbortController();
  const result = client.request('slow', {}, { signal: controller.signal });
  await tick();
  assert.equal(seenId, 0);
  controller.abort();
  await assert.rejects(result, (e) => LocalError.is(e, 'aborted'));
  await tick();
  assert.equal(handlerSignal?.aborted, true, 'the server handler saw the cancel for id 0');
  assert.equal(client.pendingCount, 0);
});

test('a timeout is a timeout, not an abort, and tells the other side', async () => {
  const clock = manualClock();
  const { client, server, start } = pair({ ...cancelRequest, clock }, cancelRequest);
  let cancelled = false;
  server.onRequest('slow', (_p, ctx) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => ((cancelled = true), reject(ctx.signal.reason)))));
  start();
  const result = client.request('slow', {}, { timeoutMs: 5000 });
  await tick();
  clock.advance(4999);
  assert.equal(client.pendingCount, 1);
  clock.advance(1);
  await assert.rejects(result, (e) => LocalError.is(e, 'timeout') && !LocalError.is(e, 'aborted'));
  await tick();
  assert.equal(cancelled, true);
  assert.equal(clock.pendingTimers, 0, 'no timer left behind');
});

test('closing fails pending requests with closed, and aborts running handlers', async () => {
  const { client, server, start } = pair();
  let aborted = false;
  server.onRequest('slow', (_p, ctx) => new Promise(() => ctx.signal.addEventListener('abort', () => (aborted = true))));
  start();
  const result = client.request('slow');
  await tick();
  await server.close();
  await assert.rejects(result, (e) => LocalError.is(e, 'closed'));
  assert.equal(aborted, true);
  assert.deepEqual(await client.closed, { reason: 'remote-ended' });
});

test('a late answer is reported, never delivered', async () => {
  const diagnostics: PeerDiagnostic[] = [];
  const end = raw();
  const peer = new RpcPeer(end.channel, { onDiagnostic: (d) => diagnostics.push(d) }).start();
  const controller = new AbortController();
  const result = peer.request('x', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result);
  await end.send({ jsonrpc: '2.0', id: 0, result: 'too late' });
  await tick();
  assert.deepEqual(diagnostics.map((d) => d.kind), ['late-response']);
});

test('ids are matched by value and type: 0 and "0" are different requests', async () => {
  const end = raw();
  const peer = new RpcPeer(end.channel).start();
  const result = peer.request('x');
  await end.send({ jsonrpc: '2.0', id: '0', result: 'wrong' });
  await end.send({ jsonrpc: '2.0', id: 0, result: 'right' });
  assert.equal(await result, 'right');
});

test('remote errors keep their code and data', async () => {
  const { client, server, start } = pair();
  server.onRequest('find', () => {
    throw RpcError.notFound('no such session', { sessionId: 's1' });
  });
  start();
  await assert.rejects(client.request('find'), (e) => RpcError.is(e) && e.code === ErrorCode.ResourceNotFound && (e.data as { sessionId: string }).sessionId === 's1');
});

test('unknown methods get MethodNotFound; thrown errors become InternalError', async () => {
  const { client, server, start } = pair();
  server.onRequest('boom', () => {
    throw new Error('kaput');
  });
  start();
  await assert.rejects(client.request('nope'), (e) => RpcError.is(e) && e.code === ErrorCode.MethodNotFound);
  await assert.rejects(client.request('boom'), (e) => RpcError.is(e) && e.code === ErrorCode.InternalError && e.message === 'kaput');
});

test('a handler waiting on a call back to the other side does not block other messages', async () => {
  const { client, server, start } = pair();
  // The client answers "ask" only after "ping" has been handled.
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  client.onRequest('ask', async () => {
    await released;
    return 'answer';
  });
  server.onRequest('work', async (_p, ctx) => ctx.peer.request('ask'));
  server.onRequest('ping', () => 'pong');
  start();
  const work = client.request('work');
  assert.equal(await client.request('ping'), 'pong');
  release();
  assert.equal(await work, 'answer');
});

test('notifications are handled in arrival order', async () => {
  const { client, server, start } = pair();
  const seen: number[] = [];
  server.onNotification('n', (p: { i: number }) => void seen.push(p.i));
  start();
  for (let i = 0; i < 50; i++) void client.notify('n', { i });
  await client.request('*missing*').catch(() => {});
  assert.deepEqual(seen, Array.from({ length: 50 }, (_, i) => i));
});

test('malformed messages with a recoverable id get InvalidRequest; others are reported', async () => {
  const diagnostics: PeerDiagnostic[] = [];
  const end = raw();
  new RpcPeer(end.channel, { onDiagnostic: (d) => diagnostics.push(d) }).start();
  await end.send({ jsonrpc: '2.0', id: 7 }); // neither method nor result
  await end.send('banner text');
  await end.send({ jsonrpc: '2.0', id: { no: 'objects' }, method: 'x' });
  await end.send({ jsonrpc: '2.0', id: null, method: 'x' }); // valid JSON-RPC: answered, not rejected
  await tick();
  assert.deepEqual(
    end.sent.map((m) => [(m as { id: unknown }).id, (m as { error: { code: number } }).error.code]),
    [
      [7, ErrorCode.InvalidRequest],
      [null, ErrorCode.InvalidRequest],
      [null, ErrorCode.MethodNotFound],
    ]
  );
  assert.deepEqual(diagnostics.map((d) => d.kind), ['invalid-message', 'invalid-message']);
});

test('middleware wraps both directions', async () => {
  const log: string[] = [];
  const { client, server, start } = pair(
    {
      outbound: [
        async (call, next) => {
          log.push(`out ${call.method}`);
          return next({ ...(call.params as object), stamped: true });
        },
      ],
    },
    {
      inbound: [
        async (call, next) => {
          log.push(`in ${call.method}`);
          return next();
        },
      ],
    }
  );
  server.onRequest('echo', (p) => p);
  start();
  assert.deepEqual(await client.request('echo', { a: 1 }), { a: 1, stamped: true });
  assert.deepEqual(log, ['out echo', 'in echo']);
});

test('a request on a closed peer fails at once with closed', async () => {
  const { client, start } = pair();
  start();
  await client.close();
  await assert.rejects(client.request('x'), (e) => LocalError.is(e, 'closed'));
});

test('sendRaw writes a message as given, outside request tracking', async () => {
  const end = raw();
  const peer = new RpcPeer(end.channel).start();
  await peer.sendRaw({ id: 'never-received', result: 42 });
  await tick();
  assert.deepEqual(end.sent, [{ jsonrpc: '2.0', id: 'never-received', result: 42 }]);
  assert.equal(peer.pendingCount, 0);
});

test('when the other side ends, running handlers finish and their answers are sent', async () => {
  const end = raw();
  const peer = new RpcPeer(end.channel);
  peer.onRequest('x', async (_p, ctx) => {
    await tick();
    await ctx.peer.notify('progress', { done: true });
    return ctx.signal.aborted ? 'aborted' : 'answer';
  });
  peer.start();
  const asked = peer.request('ask');
  await end.send({ jsonrpc: '2.0', id: 1, method: 'x' });
  await end.end();
  await assert.rejects(asked, (e) => LocalError.is(e, 'closed'));
  assert.equal(peer.state, 'draining');
  assert.equal(peer.isClosed, false);
  await assert.rejects(peer.request('later'), (e) => LocalError.is(e, 'closed'));
  assert.deepEqual(await peer.closed, { reason: 'remote-ended' });
  assert.equal(peer.state, 'closed');
  await tick();
  assert.deepEqual(end.sent.slice(1), [
    { jsonrpc: '2.0', method: 'progress', params: { done: true } },
    { jsonrpc: '2.0', id: 1, result: 'answer' },
  ]);
});

test('handlers still running when the drain time is up are aborted', async () => {
  const clock = manualClock();
  const end = raw();
  const peer = new RpcPeer(end.channel, { clock, drainTimeoutMs: 1000 });
  let signal: AbortSignal | undefined;
  peer.onRequest('slow', (_p, ctx) => {
    signal = ctx.signal;
    return new Promise(() => {});
  });
  assert.equal(peer.state, 'idle');
  peer.start();
  assert.equal(peer.state, 'open');
  await end.send({ jsonrpc: '2.0', id: 1, method: 'slow' });
  await end.end();
  await tick();
  assert.equal(peer.state, 'draining');
  clock.advance(999);
  assert.equal(signal?.aborted, false);
  clock.advance(1);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(await peer.closed, { reason: 'remote-ended' });
  assert.equal(clock.pendingTimers, 0);
});

test('with nothing running, the other side ending closes at once', async () => {
  const end = raw();
  const peer = new RpcPeer(end.channel).start();
  await end.end();
  assert.deepEqual(await peer.closed, { reason: 'remote-ended' });
});

/** Two peers talking NDJSON over bytes, as over stdio. */
function bytePair(b: RpcPeerOptions = {}) {
  const aToB = new TransformStream<Uint8Array, Uint8Array>();
  const bToA = new TransformStream<Uint8Array, Uint8Array>();
  const client = new RpcPeer(ndjson({ readable: bToA.readable, writable: aToB.writable }), { name: 'client' });
  const server = new RpcPeer(ndjson({ readable: aToB.readable, writable: bToA.writable }), { name: 'server', ...b });
  return { client, server, start: () => (client.start(), server.start()) };
}

test('a request that cannot be encoded fails with send-failed, and the stream keeps working', async () => {
  const { client, server, start } = bytePair();
  server.onRequest('echo', (p) => p);
  start();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await assert.rejects(client.request('echo', { n: 1n }), (e) => LocalError.is(e, 'send-failed'));
  await assert.rejects(client.request('echo', cycle), (e) => LocalError.is(e, 'send-failed'));
  await assert.rejects(client.notify('echo', { n: 1n }));
  assert.equal(client.pendingCount, 0);
  assert.deepEqual(await client.request('echo', { ok: true }), { ok: true });
});

test('a result that cannot be encoded is answered with InternalError', async () => {
  const diagnostics: PeerDiagnostic[] = [];
  const { client, server, start } = bytePair({ onDiagnostic: (d) => diagnostics.push(d) });
  server.onRequest('big', () => ({ n: 10n }));
  server.onRequest('bad-error', () => {
    throw new RpcError(ErrorCode.InvalidParams, 'bad', { n: 1n });
  });
  start();
  await assert.rejects(client.request('big'), (e) => RpcError.is(e) && e.code === ErrorCode.InternalError);
  await assert.rejects(client.request('bad-error'), (e) => RpcError.is(e) && e.code === ErrorCode.InternalError);
  assert.deepEqual(diagnostics.map((d) => d.kind), ['send-failed', 'send-failed']);
});

test('a failed write of an answer is a send failure, with no second answer', async () => {
  const diagnostics: PeerDiagnostic[] = [];
  const [left, right] = channelPair<unknown>();
  const writes: unknown[] = [];
  const writer = left.writable.getWriter();
  const channel: Channel<unknown> = {
    readable: left.readable,
    writable: new WritableStream({
      write(message) {
        writes.push(message);
        if ('result' in (message as object)) throw new Error('pipe broke');
        return writer.write(message);
      },
    }),
  };
  const peer = new RpcPeer(channel, { onDiagnostic: (d) => diagnostics.push(d) });
  peer.onRequest('x', () => 'answer').start();
  await right.writable.getWriter().write({ jsonrpc: '2.0', id: 1, method: 'x' });
  await tick();
  assert.deepEqual(diagnostics.map((d) => d.kind), ['send-failed']);
  assert.equal(writes.length, 1);
});

test('a cancel id extractor that throws is reported, and the connection stays open', async () => {
  const diagnostics: PeerDiagnostic[] = [];
  const end = raw();
  const peer = new RpcPeer(end.channel, {
    cancelInbound: { method: 'cancel', id: (params) => (params as { requestId: JsonRpcId }).requestId },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  peer.onRequest('ping', () => 'pong').start();
  await end.send({ jsonrpc: '2.0', method: 'cancel' });
  await end.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await tick();
  assert.equal(peer.isClosed, false);
  assert.deepEqual(diagnostics.map((d) => d.kind), ['invalid-message']);
  assert.deepEqual(end.sent, [{ jsonrpc: '2.0', id: 1, result: 'pong' }]);
});

test('start() after close() does nothing', async () => {
  const end = raw();
  const peer = new RpcPeer(end.channel);
  let handled = false;
  peer.onNotification('hello', () => void (handled = true));
  await peer.close();
  void end.send({ jsonrpc: '2.0', method: 'hello' }).catch(() => {});
  peer.start();
  await tick();
  assert.equal(handled, false);
});

test('nothing more is dispatched once a handler closes the peer', async () => {
  const end = raw();
  const peer = new RpcPeer(end.channel);
  const seen: unknown[] = [];
  peer.onRequest('shutdown', async (_p, ctx) => {
    await ctx.peer.close();
    return null;
  });
  peer.onRequest('after', (_p, ctx) => void seen.push([peer.state, ctx.signal.aborted]));
  peer.onNotification('note', () => void seen.push('note'));
  void end.send({ jsonrpc: '2.0', id: 1, method: 'shutdown' }).catch(() => {});
  void end.send({ jsonrpc: '2.0', id: 2, method: 'after' }).catch(() => {});
  void end.send({ jsonrpc: '2.0', method: 'note' }).catch(() => {}); // refused once the peer stops reading
  peer.start();
  await peer.closed;
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(seen, []);
});

test('a request handled after the connection closed starts aborted', async () => {
  const end = raw();
  const peer = new RpcPeer(end.channel);
  const seen: boolean[] = [];
  peer.onRequest('x', (_p, ctx) => void seen.push(ctx.signal.aborted));
  peer.start();
  await peer.close();
  (peer as unknown as { handleRequest(id: number, method: string, params: unknown): void }).handleRequest(1, 'x', undefined);
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(seen, [true]);
});
