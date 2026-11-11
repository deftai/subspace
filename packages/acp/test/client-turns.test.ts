import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, RpcPeer, type Channel } from '@deft-subspace/kernel';
import { AcpClient, Turn, type ClientOptions, type ProtocolVersion } from '@deft-subspace/acp';
import { sleep } from './helpers.ts';

/** An agent written by hand, message by message, for timings serveAgent will not produce. */
async function fakeAgent(
  protocol: ProtocolVersion,
  onPrompt: (agent: RpcPeer, params: { prompt: unknown }, n: number) => unknown,
  options: ClientOptions & { capabilities?: Record<string, unknown>; wrap?: (channel: Channel<unknown>) => Channel<unknown> } = {}
) {
  const [a, b] = channelPair<unknown>();
  const agent = new RpcPeer(b, { name: 'fake' });
  let n = 0;
  const cancels: unknown[] = [];
  agent.onRequest('initialize', () => ({ protocolVersion: protocol, agentCapabilities: options.capabilities ?? {}, capabilities: options.capabilities ?? {} }));
  agent.onRequest('session/new', () => ({ sessionId: 's1' }));
  agent.onRequest('session/prompt', (p: { prompt: unknown }) => onPrompt(agent, p, ++n));
  agent.onNotification('session/cancel', () => {});
  agent.onNotification('$/cancel_request', (p) => void cancels.push(p));
  agent.start();
  const { capabilities: _, wrap, ...clientOptions } = options;
  const client = await AcpClient.connect(wrap ? wrap(a) : a, { protocol, timeouts: { cancelGraceMs: 50 }, ...clientOptions });
  return { client, agent, cancels };
}

const update = (agent: RpcPeer, u: Record<string, unknown>) => agent.notify('session/update', { sessionId: 's1', update: u });
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

test("v2: a force-ended turn's late updates and idle do not land in the next turn", async () => {
  // The agent confirms the cancel only after the client has force-ended the turn, during the drain.
  let confirm!: () => void;
  const confirmed = new Promise<void>((resolve) => (confirm = resolve));
  const { client } = await fakeAgent(2, (agent, _p, n) => {
    if (n === 1) {
      void confirmed.then(async () => {
        await update(agent, chunk('late '));
        await update(agent, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
      });
      return {};
    }
    setTimeout(async () => {
      await update(agent, chunk('second turn answer'));
      await update(agent, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    }, 20);
    return {};
  }, { timeouts: { cancelGraceMs: 200 } });
  const session = await client.newSession({ cwd: '/' });
  const first = session.prompt('one');
  await sleep(10);
  await first.cancel();
  const second = session.prompt('two', { queue: true });
  const r1 = await first.done;
  assert.equal(r1.forced, true);
  assert.equal(session.busy, false);
  confirm();
  const r2 = await second.done;
  assert.equal(r2.stopReason, 'end_turn');
  assert.equal(r2.text, 'second turn answer');
  await client.close();
});

test("v1: queued prompts wait for a force-ended turn's answer; its late updates are not the next turn's", async () => {
  const order: string[] = [];
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const { client } = await fakeAgent(1, async (agent, _p, n) => {
    order.push(`prompt ${n}`);
    if (n === 1) {
      await answered; // only after the client has force-ended the turn

      await update(agent, chunk('late '));
      await update(agent, { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'old', status: 'pending' });
      order.push('answer 1');
      return { stopReason: 'cancelled' };
    }
    await update(agent, chunk('second'));
    return { stopReason: 'end_turn' };
  }, { timeouts: { cancelGraceMs: 200 } });
  const session = await client.newSession({ cwd: '/' });
  const first = session.prompt('one');
  await sleep(10);
  await first.cancel();
  const second = session.prompt('two', { queue: true });
  assert.equal((await first.done).forced, true);
  answer();
  const r2 = await second.done;
  assert.equal(r2.text, 'second');
  assert.equal(r2.toolCalls.length, 0);
  assert.deepEqual(order, ['prompt 1', 'answer 1', 'prompt 2']);
  assert.ok(session.toolCalls.has('old'), 'the late tool call is kept with the session');
  await client.close();
});

test('v1: a force-ended prompt the agent never answers is given up on with $/cancel_request', async () => {
  const { client, cancels } = await fakeAgent(1, (_agent, _p, n) => (n === 1 ? new Promise(() => {}) : { stopReason: 'end_turn' }));
  const session = await client.newSession({ cwd: '/' });
  const first = session.prompt('one');
  await sleep(10);
  await first.cancel();
  assert.equal((await first.done).forced, true);
  const second = await session.prompt('two', { queue: true }).done;
  assert.equal(second.stopReason, 'end_turn');
  assert.equal(cancels.length, 1, 'the first prompt request was cancelled');
  assert.equal(client.peer.pendingCount, 0);
  await client.close();
});

test('the cancel deadline runs even when the session/cancel write never completes', async () => {
  // The agent stops reading: writes after the prompt never finish.
  let stuck = false;
  const wrap = (channel: Channel<unknown>): Channel<unknown> => {
    const writer = channel.writable.getWriter();
    return {
      readable: channel.readable,
      writable: new WritableStream({
        write: (message) => (stuck ? new Promise(() => {}) : writer.write(message)),
      }),
    };
  };
  const { client } = await fakeAgent(2, () => {
    stuck = true;
    return {};
  }, { wrap });
  const session = await client.newSession({ cwd: '/' });
  const turn = session.prompt('go');
  await sleep(10);
  void turn.cancel();
  const result = await turn.done;
  assert.equal(result.forced, true);
  assert.equal(result.cancelled, true);
  await client.close();
});

test('a tool call id the agent reuses in a later turn belongs to that turn', async () => {
  const { client } = await fakeAgent(1, async (agent, _p, n) => {
    await update(agent, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: `turn ${n}`, status: 'pending' });
    await update(agent, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
    return { stopReason: 'end_turn' };
  });
  const session = await client.newSession({ cwd: '/' });
  const r1 = await session.prompt('a').done;
  const r2 = await session.prompt('b').done;
  assert.deepEqual([r1.toolCalls.length, r2.toolCalls.length], [1, 1]);
  assert.equal(r2.toolCalls[0]?.title, 'turn 2');
  assert.equal(r2.toolCalls[0]?.status, 'completed');
  await client.close();
});

test("the client's onQuestion answers questions outside a turn", async () => {
  const { client, agent } = await fakeAgent(2, () => ({}), {
    onQuestion: () => ({ action: 'accept', content: { name: 'Ada' } }),
  });
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
  const noSession = await agent.request('elicitation/create', { mode: 'form', message: 'Name?', requestedSchema: schema });
  assert.deepEqual(noSession, { action: 'accept', content: { name: 'Ada' } });
  await client.newSession({ cwd: '/' });
  const betweenTurns = await agent.request('elicitation/create', { sessionId: 's1', mode: 'form', message: 'Name?', requestedSchema: schema });
  assert.deepEqual(betweenTurns, { action: 'accept', content: { name: 'Ada' } });
  await client.close();
});

test('updates for a session closed here are dropped, not replayed by a later load', async () => {
  const { client, agent } = await fakeAgent(1, () => ({ stopReason: 'end_turn' }), { capabilities: { loadSession: true } });
  agent.onRequest('session/load', () => ({}));
  const session = await client.newSession({ cwd: '/' });
  await session.close();
  await update(agent, chunk('after close'));
  await sleep(10);
  const { replayed } = await client.loadSession({ sessionId: 's1', cwd: '/' });
  assert.deepEqual(replayed, []);
  await client.close();
});

test('caughtUp stops waiting once the handlers have failed, and leaves nothing behind', async () => {
  const turn = new Turn('t', async () => {});
  let release!: () => void;
  turn.observe({
    onMessage: async (delta) => {
      if (delta === 'slow') await new Promise<void>((resolve) => (release = resolve));
      throw new Error('handler failed');
    },
  });
  turn.push({ type: 'message', messageId: 'm', text: 'slow', delta: 'slow' } as never);
  // The timeout wins: its check is removed.
  await turn.caughtUp(20);
  assert.equal((turn as unknown as { progress: Set<unknown> }).progress.size, 0);
  release();
  await sleep(0);
  turn.push({ type: 'message', messageId: 'm', text: 'slow more', delta: ' more' } as never);
  const started = Date.now();
  await turn.caughtUp();
  assert.ok(Date.now() - started < 500, 'no handler will run again: nothing to wait for');
});

test('a mode change replaces session.modes instead of changing the object an app holds', async () => {
  const { client, agent } = await fakeAgent(1, () => ({ stopReason: 'end_turn' }));
  agent.onRequest('session/new', () => ({
    sessionId: 's1',
    modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'plan', name: 'Plan' }] },
  }));
  agent.onRequest('session/set_mode', () => ({}));
  const session = await client.newSession({ cwd: '/' });
  const before = session.modes;
  await session.setMode('plan');
  assert.equal(session.modes?.current, 'plan');
  const afterSet = session.modes;
  await update(agent, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  await sleep(10);
  assert.equal(session.modes?.current, 'auto');
  assert.equal(before?.current, 'auto', 'unchanged since it was read');
  assert.equal(afterSet?.current, 'plan', 'unchanged since it was read');
  await client.close();
});
