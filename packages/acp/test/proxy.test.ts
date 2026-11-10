/**
 * A two-way ACP proxy on the raw agent endpoint (docs/AGENT-LAYERS.md,
 * contract point 7): client → proxy → agent, with everything passing through
 * in both directions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelRequest, channelPair, RpcError, RpcPeer, type Channel } from '@deft-subspace/kernel';
import { AcpClient, agentEndpoint, serveAgent, type AgentOptions, type AgentTurn, type ProtocolVersion } from '@deft-subspace/acp';

/** Forward `upstream` (from the client) to `downstream` (the agent), both ways. */
function proxy(upstream: Channel<unknown>, downstream: Channel<unknown>) {
  const agent = new RpcPeer(downstream, { name: 'proxy→agent', ...cancelRequest });
  const endpoint = agentEndpoint(upstream, {
    name: 'proxy',
    request: (call, ctx) => agent.request(call.method, call.params, { signal: ctx.signal }),
    notification: (call) => void agent.notify(call.method, call.params),
  });
  agent.onRequest('*', (params, ctx) => endpoint.client.request(ctx.method, params, { signal: ctx.signal }));
  agent.onNotification('*', (params, ctx) => {
    if (ctx.method !== '$/cancel_request') void endpoint.client.notify(ctx.method, params);
  });
  agent.start();
}

/** An agent behind a proxy, and a client connected to the proxy. */
async function throughProxy(protocol: ProtocolVersion, agent: Omit<AgentOptions, 'name' | 'protocols'>, client: Parameters<typeof AcpClient.connect>[1] = {}) {
  const [clientEnd, proxyUp] = channelPair<unknown>();
  const [proxyDown, agentEnd] = channelPair<unknown>();
  const agentPeer = serveAgent(agentEnd, { name: 'behind', protocols: [protocol], ...agent });
  proxy(proxyUp, proxyDown);
  return { agentPeer, client: await AcpClient.connect(clientEnd, client) };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: initialize and client capabilities pass through; a permission request travels up and its answer down`, async () => {
    let seenCaps: Record<string, unknown> | undefined;
    const answers: boolean[] = [];
    const { client } = await throughProxy(
      protocol,
      {
        async prompt(turn: AgentTurn) {
          seenCaps = turn.clientCapabilities;
          answers.push((await turn.requestPermission({ title: 'Run the tests' })).allowed);
          if (protocol === 1) await turn.say(await turn.readFile('/w/a.txt'));
          return 'end_turn';
        },
      },
      { permissions: 'allow', files: { readTextFile: async () => 'file text', writeTextFile: async () => {} } }
    );
    assert.equal(client.protocol, protocol);
    assert.equal(client.agent.name, 'behind', 'the agent’s own initialize answer');
    const session = await client.newSession({ cwd: '/w' });
    const result = await session.prompt('go').done;
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(answers, [true]);
    if (protocol === 1) {
      assert.equal(result.text, 'file text', 'fs/read_text_file went up and its answer down');
      assert.deepEqual((seenCaps as { fs?: unknown }).fs, { readTextFile: true, writeTextFile: true });
    }
    await client.close();
  });

  test(`v${protocol}: unknown requests and notifications pass both ways; a downstream error keeps its code and data`, async () => {
    const fromClient: unknown[] = [];
    const { client, agentPeer } = await throughProxy(protocol, {
      prompt: () => 'end_turn',
      methods: {
        '_x/echo': (params: unknown) => ({ echoed: params }),
        '_x/fail': () => {
          throw new RpcError(-32050, 'not today', { retryAfter: 5 });
        },
      },
    });
    agentPeer.onNotification('_x/hello', (params) => void fromClient.push(params));
    const toClient: unknown[] = [];
    client.peer.onNotification('_x/note', (params) => void toClient.push(params));
    client.peer.onRequest('_x/ask', (params) => ({ answered: params }));

    assert.deepEqual(await client.peer.request('_x/echo', { a: 1 }), { echoed: { a: 1 } });
    await assert.rejects(
      client.peer.request('_x/fail'),
      (e: unknown) => RpcError.is(e) && e.code === -32050 && e.message === 'not today' && (e.data as { retryAfter: number }).retryAfter === 5
    );
    await client.peer.notify('_x/hello', { from: 'client' });
    await agentPeer.notify('_x/note', { from: 'agent' });
    assert.deepEqual(await agentPeer.request('_x/ask', { q: 1 }), { answered: { q: 1 } });
    await tick(5);
    assert.deepEqual(fromClient, [{ from: 'client' }]);
    assert.deepEqual(toClient, [{ from: 'agent' }]);
    await client.close();
  });

  test(`v${protocol}: cancel crosses both hops (session/cancel, and $/cancel_request for one request)`, async () => {
    let methodSawCancel = false;
    const { client } = await throughProxy(protocol, {
      async prompt(turn: AgentTurn) {
        await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
        return 'cancelled';
      },
      methods: {
        '_x/slow': (_params: unknown, ctx: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            ctx.signal.addEventListener('abort', () => ((methodSawCancel = true), reject(ctx.signal.reason)), { once: true })
          ),
      },
    });
    const session = await client.newSession({ cwd: '/w' });
    const turn = session.prompt('wait');
    await tick(10);
    await turn.cancel();
    assert.equal((await turn.done).stopReason, 'cancelled');

    const stop = new AbortController();
    const slow = client.peer.request('_x/slow', {}, { signal: stop.signal });
    await tick(10);
    stop.abort();
    await assert.rejects(slow);
    for (let i = 0; i < 50 && !methodSawCancel; i++) await tick(5);
    assert.equal(methodSawCancel, true, 'the agent’s handler saw $/cancel_request');
    await client.close();
  });
}
