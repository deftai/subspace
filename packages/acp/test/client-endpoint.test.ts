import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LocalError, channelPair, RpcError, RpcPeer, cancelRequest } from '@deft-subspace/kernel';
import {
  AcpClient,
  agentEndpoint,
  bothSpellings,
  clientEndpoint,
  NEGOTIATED_AGENT,
  serveAgent,
  stateKey,
  type ClientLayer,
} from '../src/index.ts';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// C1 & C2: raw clientEndpoint and contract tests
// ---------------------------------------------------------------------------

test('C1: unknown requests and notifications from agent reach handlers as sent; results and RpcErrors go back intact', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();
  const notifications: Array<{ method: string; params: unknown }> = [];

  const endpoint = clientEndpoint(clientCh, {
    name: 'client',
    request(call) {
      if (call.method === 'x.ai/custom_err') throw new RpcError(-32055, 'vendor nope', { detail: 7 });
      return { echoed: call.method, params: call.params };
    },
    notification(call) {
      notifications.push({ method: call.method, params: call.params });
    },
  });

  const agent = new RpcPeer(agentCh, { name: 'agent' });
  agent.start();
  try {
    const res = await agent.request('x.ai/ping', { a: 1 });
    assert.deepEqual(res, { echoed: 'x.ai/ping', params: { a: 1 } });

    await assert.rejects(
      () => agent.request('x.ai/custom_err', {}),
      (err: unknown) => err instanceof RpcError && err.code === -32055 && (err.data as { detail?: number })?.detail === 7,
    );

    await agent.notify('x.ai/note', { n: 2 });
    await delay(10);
    assert.deepEqual(notifications, [{ method: 'x.ai/note', params: { n: 2 } }]);
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});

test('C1: without a request handler, unanswered requests get MethodNotFound; $/cancel_request is not passed on', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();
  const seen: string[] = [];

  const endpoint = clientEndpoint(clientCh, {
    name: 'client',
    notification(call) {
      seen.push(call.method);
    },
  });
  const agent = new RpcPeer(agentCh, { name: 'agent', ...cancelRequest });
  agent.start();
  try {
    await assert.rejects(
      () => agent.request('nope/method', {}),
      (err: unknown) => err instanceof RpcError && err.code === -32601,
    );
    await agent.notify('$/cancel_request', { requestId: 99 });
    await agent.notify('other/note', {});
    await delay(10);
    assert.deepEqual(seen, ['other/note']);
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});

test('C2: two layers answering the same request or notification method fail when the stack is built', () => {
  const [ch1] = channelPair<unknown>();
  assert.throws(
    () =>
      clientEndpoint(ch1, {
        name: 'client',
        layers: [
          { name: 'a', requests: { 'foo/bar': () => 1 } },
          { name: 'b', requests: { 'foo/bar': () => 2 } },
        ],
      }),
    /both answer the request foo\/bar/,
  );

  const [ch2] = channelPair<unknown>();
  assert.throws(
    () =>
      clientEndpoint(ch2, {
        name: 'client',
        layers: [
          { name: 'a', notifications: { 'foo/note': () => {} } },
          { name: 'b', notifications: { 'foo/note': () => {} } },
        ],
      }),
    /both answer the notification foo\/note/,
  );
});

test('C1: a layer that requires state no earlier layer provides fails when the stack is built', () => {
  const key = stateKey<string>('missing-key');
  const [ch] = channelPair<unknown>();
  assert.throws(
    () =>
      clientEndpoint(ch, {
        name: 'client',
        layers: [{ name: 'consumer', requires: [key] }],
      }),
    /requires "missing-key"/,
  );
});

test('C2: next() runs at most once; inbound rewrite changes dispatched method and params', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();
  let doubleNextErr: unknown;

  const rewriteLayer: ClientLayer = {
    name: 'rewrite',
    async inbound(call, _ctx, _state, next) {
      if (call.method === 'double') {
        const res = await next();
        try {
          await next();
        } catch (err) {
          doubleNextErr = err;
        }
        return res;
      }
      if (call.method === 'old') {
        return next({ ...call, method: 'new', params: { rewritten: true } });
      }
      return next();
    },
  };
  const handlerLayer: ClientLayer = {
    name: 'handler',
    requests: {
      new: (call) => ({ handled: 'new', params: call.params }),
      double: () => ({ ok: true }),
    },
  };

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: [rewriteLayer, handlerLayer] });
  const agent = new RpcPeer(agentCh, { name: 'agent' });
  agent.start();
  try {
    assert.deepEqual(await agent.request('old', { x: 1 }), { handled: 'new', params: { rewritten: true } });
    assert.deepEqual(await agent.request('double', {}), { ok: true });
    assert.match(String(doubleNextErr), /next\(\) called twice/);
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});

test('C1/C2: layer state is per endpoint: one configured layer on two endpoints shares nothing', async () => {
  const counterLayer: ClientLayer<{ count: number }> = {
    name: 'counter',
    create: () => ({ count: 0 }),
    requests: {
      inc: (_call, _ctx, state) => ++state.count,
    },
  };

  const [c1, a1] = channelPair<unknown>();
  const [c2, a2] = channelPair<unknown>();
  const ep1 = clientEndpoint(c1, { name: 'ep1', layers: [counterLayer] });
  const ep2 = clientEndpoint(c2, { name: 'ep2', layers: [counterLayer] });
  const p1 = new RpcPeer(a1, { name: 'a1' });
  const p2 = new RpcPeer(a2, { name: 'a2' });
  p1.start();
  p2.start();
  try {
    assert.equal(await p1.request('inc'), 1);
    assert.equal(await p1.request('inc'), 2);
    assert.equal(await p2.request('inc'), 1);
  } finally {
    await Promise.all([p1.close(), p2.close(), ep1.peer.close(), ep2.peer.close()]);
  }
});

test('C1: outbound hooks run outermost-first, notifications keep order, $/cancel_request aborts signal, closed runs with state', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();
  const trace: string[] = [];
  const receivedNotes: unknown[] = [];
  let aborted = false;
  let closedState: string | undefined;

  const outer: ClientLayer<{ tag: string }> = {
    name: 'outer',
    create: () => ({ tag: 'outer-state' }),
    async outbound(call, _ctx, _state, next) {
      trace.push(`outer:out:${call.method}`);
      if (call.kind === 'notification' && (call.params as { seq?: number })?.seq === 1) {
        await delay(25);
      }
      const res = await next();
      trace.push(`outer:back:${call.method}`);
      return res;
    },
    closed(_info, _ctx, state) {
      closedState = state.tag;
    },
  };
  const inner: ClientLayer = {
    name: 'inner',
    async outbound(call, _ctx, _state, next) {
      trace.push(`inner:out:${call.method}`);
      const res = await next();
      trace.push(`inner:back:${call.method}`);
      return res;
    },
    requests: {
      slow: (_call, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new RpcError(-32800, 'cancelled'));
            },
            { once: true },
          );
        }),
    },
  };

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: [outer, inner] });
  const agent = new RpcPeer(agentCh, { name: 'agent', ...cancelRequest });
  agent.onRequest('echo', (p) => p);
  agent.onNotification('note', (p) => receivedNotes.push(p));
  agent.start();

  try {
    assert.deepEqual(await endpoint.agent.request('echo', { hi: 1 }), { hi: 1 });
    assert.deepEqual(trace, ['outer:out:echo', 'inner:out:echo', 'inner:back:echo', 'outer:back:echo']);

    const n1 = endpoint.agent.notify('note', { seq: 1 });
    const n2 = endpoint.agent.notify('note', { seq: 2 });
    await Promise.all([n1, n2]);
    await delay(10);
    assert.deepEqual(receivedNotes, [{ seq: 1 }, { seq: 2 }]);

    const ac = new AbortController();
    const slowReq = agent.request('slow', {}, { signal: ac.signal });
    await delay(10);
    ac.abort();
    await assert.rejects(() => slowReq);
    await delay(10);
    assert.equal(aborted, true);
  } finally {
    await endpoint.peer.close();
    await agent.close();
    await delay(10);
  }
  assert.equal(closedState, 'outer-state');
});

// ---------------------------------------------------------------------------
// C3: vendor layer answers before the base (via hook or service, never duplicate handler)
// ---------------------------------------------------------------------------

test('C3: vendor layer answers before base via inbound hook or service, without duplicate method registration', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();

  type OverrideFn = (params: unknown) => unknown | undefined;
  const OVERRIDES = stateKey<OverrideFn[]>('test:overrides');

  const baseLayer: ClientLayer = {
    name: 'base',
    provides: [OVERRIDES],
    create(ctx) {
      ctx.set(OVERRIDES, []);
    },
    requests: {
      'base/op': (call, ctx) => {
        for (const fn of ctx.get(OVERRIDES)) {
          const taken = fn(call.params);
          if (taken !== undefined) return taken;
        }
        return { from: 'base', params: call.params };
      },
      'base/hooked': (call) => ({ from: 'base', params: call.params }),
    },
  };

  const vendorLayer: ClientLayer = {
    name: 'vendor',
    requires: [OVERRIDES],
    create(ctx) {
      ctx.get(OVERRIDES).push((params) => {
        if ((params as { vendor?: boolean })?.vendor) return { from: 'vendor-service' };
        return undefined;
      });
    },
    inbound(call, _ctx, _state, next) {
      if (call.kind === 'request' && call.method === 'base/hooked' && (call.params as { intercept?: boolean })?.intercept) {
        return { from: 'vendor-hook' };
      }
      return next();
    },
  };

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: [baseLayer, vendorLayer] });
  const agent = new RpcPeer(agentCh, { name: 'agent' });
  agent.start();
  try {
    assert.deepEqual(await agent.request('base/op', { vendor: true }), { from: 'vendor-service' });
    assert.deepEqual(await agent.request('base/op', { vendor: false }), { from: 'base', params: { vendor: false } });
    assert.deepEqual(await agent.request('base/hooked', { intercept: true }), { from: 'vendor-hook' });
    assert.deepEqual(await agent.request('base/hooked', { intercept: false }), { from: 'base', params: { intercept: false } });
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});

// ---------------------------------------------------------------------------
// C4: AcpClient rebuilt on clientEndpoint — close order and cancellation pinned
// ---------------------------------------------------------------------------

test('C4: AcpClient close order (turns fail before custom layer closed) and cancel aborts permission + notifies outbound', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();
  const events: string[] = [];
  let permSignalAborted = false;

  const agent = serveAgent(agentCh, {
    name: 'test-agent',
    async prompt(turn) {
      const decision = await turn.requestPermission({
        title: 'Proceed?',
        options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
      });
      return decision.outcome === 'cancelled' ? 'cancelled' : 'end_turn';
    },
  });

  const observerLayer: ClientLayer = {
    name: 'observer',
    async outbound(call, _ctx, _state, next) {
      if (call.method === 'session/cancel') events.push('outbound:session/cancel');
      return next();
    },
    closed() {
      events.push('layer:closed');
    },
  };

  const client = await AcpClient.connect(clientCh, {
    protocol: 1,
    layers: [observerLayer],
    permissions: async (_req, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            permSignalAborted = true;
            resolve('cancel');
          },
          { once: true },
        );
      }),
  });

  const session = await client.newSession({ cwd: '/repo' });

  // 1. Cancel aborts open permission and sends session/cancel through outbound hooks.
  const turn1 = session.prompt('first');
  await delay(15);
  await turn1.cancel();
  const res1 = await turn1.done;
  assert.equal(res1.cancelled, true);
  assert.equal(permSignalAborted, true);
  assert.ok(events.includes('outbound:session/cancel'));

  // 2. Close fails running + queued turns before custom layer closed hook runs.
  const turn2 = session.prompt('second', { queue: true });
  const turn3 = session.prompt('third', { queue: true });
  void turn2.done.catch((err) => {
    if (err instanceof LocalError && err.kind === 'closed') events.push('turn2:closed');
  });
  void turn3.done.catch((err) => {
    if (err instanceof LocalError && err.kind === 'closed') events.push('turn3:closed');
  });
  await delay(15);
  await client.close();
  await delay(15);
  await agent.close();

  const t2Idx = events.indexOf('turn2:closed');
  const t3Idx = events.indexOf('turn3:closed');
  const layerIdx = events.indexOf('layer:closed');
  assert.ok(t2Idx >= 0 && t3Idx >= 0 && layerIdx >= 0, `expected close events, got ${JSON.stringify(events)}`);
  assert.ok(t2Idx < layerIdx && t3Idx < layerIdx, `turns must fail before custom layer closed: ${JSON.stringify(events)}`);
});

// ---------------------------------------------------------------------------
// C5 & C7: adding _meta to initialize, session/new, load, resume, prompt;
//          reading NEGOTIATED_AGENT (with capabilities._meta) after initialize
// ---------------------------------------------------------------------------

test('C5/C7: client layer adds _meta to initialize, session/new, load, resume and prompt, and reads agent _meta after initialize', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();
  const receivedMeta: Record<string, unknown> = {};

  const agent = new RpcPeer(agentCh, { name: 'fake-agent' });
  agent.onRequest('initialize', (p: Record<string, unknown>) => {
    const caps = p.clientCapabilities as { _meta?: unknown } | undefined;
    receivedMeta.initialize = caps?._meta;
    return {
      protocolVersion: 1,
      agentInfo: { name: 'vendor-agent', title: 'Vendor Agent', version: '2.0.0' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        _meta: { 'deft.co': { emptyPrompt: {}, stopTerminal: {} } },
      },
      authMethods: [{ id: 'oauth', name: 'OAuth', type: 'agent' }],
    };
  });
  agent.onRequest('session/new', (p: Record<string, unknown>) => {
    receivedMeta['session/new'] = p._meta;
    return { sessionId: 's-1' };
  });
  agent.onRequest('session/load', (p: Record<string, unknown>) => {
    receivedMeta['session/load'] = p._meta;
    return {};
  });
  agent.onRequest('session/resume', (p: Record<string, unknown>) => {
    receivedMeta['session/resume'] = p._meta;
    return {};
  });
  agent.onRequest('session/prompt', (p: Record<string, unknown>) => {
    receivedMeta['session/prompt'] = p._meta;
    return { stopReason: 'end_turn' };
  });
  agent.start();

  let seenAgentMeta: unknown;
  let seenAgentTitle: string | undefined;

  const metaLayer: ClientLayer = {
    name: 'meta-layer',
    requires: [NEGOTIATED_AGENT],
    async outbound(call, ctx, _state, next) {
      const p = (call.params ?? {}) as Record<string, unknown>;
      if (call.method === 'initialize') {
        const clientCaps = (p.clientCapabilities ?? {}) as Record<string, unknown>;
        const existingMeta = (clientCaps._meta ?? {}) as Record<string, unknown>;
        return next({
          ...call,
          params: {
            ...p,
            clientCapabilities: { ...clientCaps, _meta: { ...existingMeta, 'deft.co': { waitForKey: {} } } },
          },
        });
      }
      if (
        call.method === 'session/new' ||
        call.method === 'session/load' ||
        call.method === 'session/resume' ||
        call.method === 'session/prompt'
      ) {
        const neg = ctx.get(NEGOTIATED_AGENT);
        seenAgentMeta = neg.capabilities._meta;
        seenAgentTitle = neg.info.title;
        return next({
          ...call,
          params: { ...p, _meta: { tag: call.method } },
        });
      }
      return next();
    },
  };

  const client = await AcpClient.connect(clientCh, { protocol: 1, layers: [metaLayer] });
  try {
    const s1 = await client.newSession({ cwd: '/repo' });
    await s1.prompt('hi').done;
    await client.loadSession({ sessionId: 's-2', cwd: '/repo' });
    await client.resumeSession({ sessionId: 's-3', cwd: '/repo' });

    assert.deepEqual((receivedMeta.initialize as Record<string, unknown>)?.['deft.co'], { waitForKey: {} });
    assert.deepEqual(receivedMeta['session/new'], { tag: 'session/new' });
    assert.deepEqual(receivedMeta['session/load'], { tag: 'session/load' });
    assert.deepEqual(receivedMeta['session/resume'], { tag: 'session/resume' });
    assert.deepEqual(receivedMeta['session/prompt'], { tag: 'session/prompt' });

    assert.deepEqual(seenAgentMeta, { 'deft.co': { emptyPrompt: {}, stopTerminal: {} } });
    assert.equal(seenAgentTitle, 'Vendor Agent');
  } finally {
    await client.close();
    await agent.close();
  }
});

// ---------------------------------------------------------------------------
// C6: bothSpellings registers bare and _-prefixed extension methods at once
// ---------------------------------------------------------------------------

test('C6: bothSpellings registers both bare and _-prefixed spellings for requests and notifications', async () => {
  const [clientCh, agentCh] = channelPair<unknown>();
  const notes: Array<{ method: string; params: unknown }> = [];

  const vendorLayer: ClientLayer = {
    name: 'xai-like',
    requests: bothSpellings({
      'x.ai/ask_user_question': (call) => ({ method: call.method, ok: true }),
    }),
    notifications: bothSpellings({
      'x.ai/session_notification': (call) => {
        notes.push({ method: call.method, params: call.params });
      },
    }),
  };

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: [vendorLayer] });
  const agent = new RpcPeer(agentCh, { name: 'agent' });
  agent.start();
  try {
    assert.deepEqual(await agent.request('x.ai/ask_user_question', {}), { method: 'x.ai/ask_user_question', ok: true });
    assert.deepEqual(await agent.request('_x.ai/ask_user_question', {}), { method: '_x.ai/ask_user_question', ok: true });

    await agent.notify('x.ai/session_notification', { n: 1 });
    await agent.notify('_x.ai/session_notification', { n: 2 });
    await delay(10);
    assert.deepEqual(notes, [
      { method: 'x.ai/session_notification', params: { n: 1 } },
      { method: '_x.ai/session_notification', params: { n: 2 } },
    ]);
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }

  // Collision check: bare in one layer and prefixed in another still fails at build time.
  const [ch] = channelPair<unknown>();
  assert.throws(
    () =>
      clientEndpoint(ch, {
        name: 'client',
        layers: [
          { name: 'a', requests: bothSpellings({ 'x.ai/foo': () => 1 }) },
          { name: 'b', requests: { '_x.ai/foo': () => 2 } },
        ],
      }),
    /both answer the request _x\.ai\/foo/,
  );
});

// ---------------------------------------------------------------------------
// Proxy test through clientEndpoint
// ---------------------------------------------------------------------------

test('Phase 2 proxy: forwards an unknown request and an unknown notification both ways through a clientEndpoint', async () => {
  const [appCh, proxyUpCh] = channelPair<unknown>();
  const [proxyDownCh, agentCh] = channelPair<unknown>();

  // Downstream side of proxy is a clientEndpoint; upstream side is an agentEndpoint.
  let upstream!: ReturnType<typeof agentEndpoint>;
  const downstream = clientEndpoint(proxyDownCh, {
    name: 'proxy-down',
    request(call, ctx) {
      return upstream.client.request(call.method, call.params, { signal: ctx.signal });
    },
    notification(call) {
      void upstream.client.notify(call.method, call.params);
    },
  });
  upstream = agentEndpoint(proxyUpCh, {
    name: 'proxy-up',
    request(call, ctx) {
      return downstream.agent.request(call.method, call.params, { signal: ctx.signal });
    },
    notification(call) {
      void downstream.agent.notify(call.method, call.params);
    },
  });

  const app = new RpcPeer(appCh, { name: 'app' });
  const agent = new RpcPeer(agentCh, { name: 'agent' });
  const appNotes: unknown[] = [];
  const agentNotes: unknown[] = [];

  app.onRequest('vendor/from_agent', (p) => ({ handledBy: 'app', p }));
  app.onNotification('vendor/agent_note', (p) => appNotes.push(p));

  agent.onRequest('vendor/from_app', (p) => {
    if ((p as { fail?: boolean })?.fail) throw new RpcError(-32042, 'agent failed', { reason: 'boom' });
    return { handledBy: 'agent', p };
  });
  agent.onNotification('vendor/app_note', (p) => agentNotes.push(p));

  app.start();
  agent.start();
  try {
    // App -> proxy (agentEndpoint -> clientEndpoint) -> Agent
    assert.deepEqual(await app.request('vendor/from_app', { x: 1 }), { handledBy: 'agent', p: { x: 1 } });
    await assert.rejects(
      () => app.request('vendor/from_app', { fail: true }),
      (err: unknown) => err instanceof RpcError && err.code === -32042 && (err.data as { reason?: string })?.reason === 'boom',
    );
    await app.notify('vendor/app_note', { hello: 'agent' });

    // Agent -> proxy (clientEndpoint -> agentEndpoint) -> App
    assert.deepEqual(await agent.request('vendor/from_agent', { y: 2 }), { handledBy: 'app', p: { y: 2 } });
    await agent.notify('vendor/agent_note', { hello: 'app' });

    await delay(15);
    assert.deepEqual(agentNotes, [{ hello: 'agent' }]);
    assert.deepEqual(appNotes, [{ hello: 'app' }]);
  } finally {
    await Promise.all([app.close(), agent.close(), upstream.peer.close(), downstream.peer.close()]);
  }
});

// ---------------------------------------------------------------------------
// C8: docs/AGENT-LAYERS.md updated
// ---------------------------------------------------------------------------

test('C8: docs/AGENT-LAYERS.md documents clientEndpoint and ClientLayer as built', () => {
  const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'AGENT-LAYERS.md'), 'utf8');
  assert.doesNotMatch(doc, /Nothing here is built yet\./);
  assert.match(doc, /clientEndpoint/);
  assert.match(doc, /ClientLayer/);
  assert.match(doc, /bothSpellings/);
  assert.match(doc, /NEGOTIATED_AGENT/);
});
