/**
 * The agent's turn lifecycle on the wire: a turn's last updates (failed tool
 * calls, the idle state) go out before the next queued turn starts, and a
 * turn that throws or never starts still frees the session.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, RpcError, RpcPeer } from '@deft-subspace/kernel';
import { serveAgent, type AgentOptions } from '@deft-subspace/acp';
import { sleep } from './helpers.ts';

/** A raw client: initialize, one session, and every update it was sent. */
async function rawClient(protocol: 1 | 2, options: Omit<AgentOptions, 'name'>) {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, { name: 'turns', protocols: [protocol], ...options });
  const peer = new RpcPeer(clientEnd);
  const updates: Array<Record<string, any>> = [];
  peer.onNotification('session/update', (p: any) => void updates.push(p.update));
  peer.start();
  await peer.request('initialize', { protocolVersion: protocol, [protocol === 2 ? 'capabilities' : 'clientCapabilities']: {} });
  const { sessionId } = await peer.request<{ sessionId: string }>('session/new', { cwd: '/w', mcpServers: [] });
  const prompt = (text: string) => peer.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const idles = () => updates.filter((u) => u.sessionUpdate === 'state_update' && u.state === 'idle');
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await sleep(5);
    assert.ok(check(), 'timed out waiting');
  };
  return { peer, sessionId, updates, prompt, idles, until };
}

/** States and message text, in order. */
const flow = (updates: Array<Record<string, any>>) =>
  updates.flatMap((u) =>
    u.sessionUpdate === 'state_update' ? [u.state] : u.sessionUpdate === 'agent_message_chunk' ? [`say:${u.content.text}`] : []
  );

test('v2 queuePrompts: a turn goes idle before the next queued one starts', async () => {
  const c = await rawClient(2, {
    queuePrompts: true,
    async prompt(turn) {
      await sleep(10);
      await turn.say(turn.text);
      return 'end_turn';
    },
  });
  await c.prompt('one');
  await c.prompt('two');
  await c.until(() => c.idles().length === 2);
  assert.deepEqual(flow(c.updates), ['running', 'say:one', 'idle', 'running', 'say:two', 'idle']);
  await c.peer.close();
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: a prompt handler that throws fails its open tool calls`, async () => {
    const c = await rawClient(protocol, {
      async prompt(turn) {
        await turn.toolCall({ title: 'grep' });
        throw new Error('boom');
      },
    });
    if (protocol === 1) {
      await assert.rejects(c.prompt('go'), (error: unknown) => RpcError.is(error) && /boom/.test(error.message));
    } else {
      await c.prompt('go');
      await c.until(() => c.idles().length === 1);
      assert.equal(c.idles()[0]!.stopReason, 'error');
    }
    const statuses = c.updates.filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update').map((u) => u.status);
    assert.deepEqual(statuses, ['pending', 'failed']);
    // The session is free again.
    const again = c.prompt('again');
    if (protocol === 1) await assert.rejects(again, /boom/);
    else assert.ok((await again).messageId);
    await c.peer.close();
  });
}

test('v2: a turn whose running state fails to send still frees the session', async () => {
  let failNext = true;
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'turns',
    protocols: [2],
    prompt: () => 'end_turn',
    peer: {
      outbound: [
        async (call, next) => {
          const update = (call.params as { update?: { sessionUpdate?: string; state?: string } } | undefined)?.update;
          if (failNext && update?.sessionUpdate === 'state_update' && update.state === 'running') {
            failNext = false;
            throw new Error('send failed');
          }
          return next(call.params);
        },
      ],
    },
  });
  const peer = new RpcPeer(clientEnd);
  const states: string[] = [];
  peer.onNotification('session/update', (p: any) => void (p.update.sessionUpdate === 'state_update' && states.push(`${p.update.state}${p.update.stopReason ? `:${p.update.stopReason}` : ''}`)));
  peer.start();
  await peer.request('initialize', { protocolVersion: 2, capabilities: {} });
  const { sessionId } = await peer.request<{ sessionId: string }>('session/new', { cwd: '/w', mcpServers: [] });
  await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] });
  for (let i = 0; i < 100 && !states.length; i++) await sleep(5);
  // Not refused as busy: the first turn ended.
  await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] });
  for (let i = 0; i < 100 && states.length < 3; i++) await sleep(5);
  assert.deepEqual(states, ['idle:error', 'running', 'idle:end_turn']);
  await peer.close();
});
