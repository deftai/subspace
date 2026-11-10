/**
 * The raw agent endpoint and its layer contract (docs/AGENT-LAYERS.md):
 * pass-through, exclusive handlers, continuation rules, per-endpoint state,
 * ordering, close, and request cancellation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelRequest, channelPair, RpcError, RpcPeer } from '@deft-subspace/kernel';
import { agentEndpoint, stateKey, type AgentEndpointOptions, type AgentLayer } from '@deft-subspace/acp';

/** An endpoint and a raw client peer connected to it. */
function connect(options: AgentEndpointOptions) {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const endpoint = agentEndpoint(agentEnd, options);
  const notes: Array<{ method: string; params: unknown }> = [];
  const client = new RpcPeer(clientEnd, { name: 'client', ...cancelRequest });
  client.onNotification('*', (params, ctx) => void notes.push({ method: ctx.method, params }));
  client.start();
  return { endpoint, client, notes };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('unknown requests and notifications reach the handlers as sent; results and RpcErrors go back intact', async () => {
  const seen: unknown[] = [];
  const { client } = connect({
    name: 'raw',
    request(call) {
      seen.push(['request', call.method, call.params]);
      if (call.method === '_x/fail') throw new RpcError(-32050, 'nope', { why: 'because' });
      return { echoed: call.params };
    },
    notification(call) {
      seen.push(['notification', call.method, call.params]);
    },
  });
  assert.deepEqual(await client.request('_vendor/anything', { a: 1 }), { echoed: { a: 1 } });
  await assert.rejects(client.request('_x/fail'), (e: unknown) => RpcError.is(e) && e.code === -32050 && (e.data as { why: string }).why === 'because');
  await client.notify('_vendor/note', { b: 2 });
  await tick();
  assert.deepEqual(seen, [
    ['request', '_vendor/anything', { a: 1 }],
    ['request', '_x/fail', undefined],
    ['notification', '_vendor/note', { b: 2 }],
  ]);
  await client.close();
});

test('without a request handler, anything unanswered is method not found; $/cancel_request is not passed on', async () => {
  const notes: string[] = [];
  const { client } = connect({ name: 'bare', notification: (call) => void notes.push(call.method) });
  await assert.rejects(client.request('session/new', {}), (e: unknown) => RpcError.is(e) && e.code === -32601);
  await client.notify('$/cancel_request', { requestId: 99 });
  await client.notify('_x/other');
  await tick();
  assert.deepEqual(notes, ['_x/other']);
  await client.close();
});

test('two layers answering the same method fail when the stack is built', () => {
  const a: AgentLayer = { name: 'a', requests: { 'session/new': () => ({}) } };
  const b: AgentLayer = { name: 'b', requests: { 'session/new': () => ({}) } };
  assert.throws(() => connect({ name: 'dup', layers: [a, b] }), /layers "a" and "b" both answer the request session\/new/);
});

test('a layer that requires state no earlier layer provides fails when the stack is built', () => {
  const sessions = stateKey<Map<string, unknown>>('sessions');
  const turns: AgentLayer = { name: 'turns', requires: [sessions] };
  const provider: AgentLayer = { name: 'sessions', provides: [sessions], create: (ctx) => ctx.set(sessions, new Map()) };
  assert.throws(() => connect({ name: 'order', layers: [turns, provider] }), /"turns" requires "sessions"/);
  assert.doesNotThrow(() => connect({ name: 'ok', layers: [provider, turns] }));
});

test('next() runs at most once; a rewrite changes the method dispatched and the params the handler sees', async () => {
  const errors: string[] = [];
  const twice: AgentLayer = {
    name: 'twice',
    async inbound(call, _ctx, _state, next) {
      if (call.method !== 'session/prompt') return next();
      const first = await next();
      await next().catch((e: Error) => errors.push(e.message));
      return first;
    },
  };
  const rename: AgentLayer = {
    name: 'rename',
    inbound: (call, _ctx, _state, next) => (call.method === '_old/name' ? next({ method: '_new/name', params: { rewritten: true } }) : next()),
  };
  const answers: AgentLayer = { name: 'answers', requests: { '_new/name': (call) => ({ got: call.params }) } };
  let prompts = 0;
  const { client } = connect({
    name: 'rewrite',
    layers: [twice, rename, answers],
    request: (call) => (call.method === 'session/prompt' ? { n: ++prompts } : null),
  });
  assert.deepEqual(await client.request('_old/name', { original: true }), { got: { rewritten: true } });
  assert.deepEqual(await client.request('session/prompt', {}), { n: 1 });
  assert.equal(prompts, 1, 'the prompt ran once');
  assert.match(errors[0]!, /next\(\) called twice/);
  await client.close();
});

test('layer state is per endpoint: one configured layer on two endpoints shares nothing', async () => {
  const counter: AgentLayer<{ n: number }> = {
    name: 'counter',
    create: () => ({ n: 0 }),
    requests: { '_x/count': (_call, _ctx, state) => ++state.n },
  };
  const one = connect({ name: 'one', layers: [counter] });
  const two = connect({ name: 'two', layers: [counter] });
  assert.equal(await one.client.request('_x/count'), 1);
  assert.equal(await one.client.request('_x/count'), 2);
  assert.equal(await two.client.request('_x/count'), 1);
  await one.client.close();
  await two.client.close();
});

test('outbound hooks get the endpoint context and see requests and their results; the first layer is outermost', async () => {
  const order: string[] = [];
  const hook = (name: string): AgentLayer => ({
    name,
    async outbound(call, ctx, _state, next) {
      order.push(`${name} in ${call.kind} ${call.method} (${ctx.name})`);
      const result = await next();
      order.push(`${name} out ${JSON.stringify(result ?? null)}`);
      return result;
    },
  });
  const { endpoint, client } = connect({ name: 'hooks', layers: [hook('outer'), hook('inner')] });
  client.onRequest('fs/read_text_file', () => ({ content: 'x' }));
  assert.deepEqual(await endpoint.client.request('fs/read_text_file', { path: 'a' }), { content: 'x' });
  assert.deepEqual(order, [
    'outer in request fs/read_text_file (hooks)',
    'inner in request fs/read_text_file (hooks)',
    'inner out {"content":"x"}',
    'outer out {"content":"x"}',
  ]);
  await client.close();
});

test('notifications keep their order even when a hook is slow for the first one', async () => {
  const slowFirst: AgentLayer = {
    name: 'slow-first',
    async outbound(call, _ctx, _state, next) {
      if ((call.params as { n: number }).n === 1) await tick(30);
      return next();
    },
  };
  const { endpoint, client, notes } = connect({ name: 'order', layers: [slowFirst] });
  await Promise.all([1, 2, 3].map((n) => endpoint.client.notify('session/update', { n })));
  await tick();
  assert.deepEqual(notes.map((m) => (m.params as { n: number }).n), [1, 2, 3]);
  await client.close();
});

test('$/cancel_request aborts that request’s signal and the handler sees it', async () => {
  let aborted = false;
  const { client } = connect({
    name: 'cancel',
    request: (_call, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => ((aborted = true), reject(ctx.signal.reason)), { once: true });
      }),
  });
  const stop = new AbortController();
  const call = client.request('_x/slow', {}, { signal: stop.signal });
  await tick(5);
  stop.abort();
  await assert.rejects(call);
  await tick(5);
  assert.equal(aborted, true, 'the handler saw the cancel');
  await client.close();
});

test('closed hooks run with the endpoint context and their state', async () => {
  const closed: string[] = [];
  const layer: AgentLayer<{ id: string }> = {
    name: 'cleanup',
    create: () => ({ id: 'state-1' }),
    closed: (info, ctx, state) => void closed.push(`${ctx.name} ${state.id} ${info.reason}`),
  };
  const { client, endpoint } = connect({ name: 'closing', layers: [layer] });
  await client.close();
  await endpoint.peer.closed;
  await tick();
  assert.deepEqual(closed, ['closing state-1 remote-ended']);
});
