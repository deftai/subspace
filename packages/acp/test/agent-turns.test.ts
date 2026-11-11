/**
 * The agent's turn lifecycle on the wire: a turn's last updates (failed tool
 * calls, the idle state) go out before the next queued turn starts, and a
 * turn that throws or never starts still frees the session. Then what the
 * turn tracks: open tool calls, background work, elicitation errors.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, RpcError, RpcPeer } from '@deft-subspace/kernel';
import { serveAgent, type AgentOptions } from '@deft-subspace/acp';
import { sleep } from './helpers.ts';

/** A raw client: initialize, one session, and every update it was sent. */
async function rawClient(
  protocol: 1 | 2,
  options: Omit<AgentOptions, 'name'>,
  client: { capabilities?: Record<string, unknown>; requests?: Record<string, (params: any) => unknown> } = {}
) {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, { name: 'turns', protocols: [protocol], ...options });
  const peer = new RpcPeer(clientEnd);
  const updates: Array<Record<string, any>> = [];
  peer.onNotification('session/update', (p: any) => void updates.push(p.update));
  for (const [method, handler] of Object.entries(client.requests ?? {})) peer.onRequest(method, handler);
  peer.start();
  await peer.request('initialize', { protocolVersion: protocol, [protocol === 2 ? 'capabilities' : 'clientCapabilities']: client.capabilities ?? {} });
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
  for (let i = 0; i < 400 && !states.length; i++) await sleep(5);
  // Not refused as busy: the first turn ended.
  await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] });
  for (let i = 0; i < 400 && states.length < 3; i++) await sleep(5);
  assert.deepEqual(states, ['idle:error', 'running', 'idle:end_turn']);
  await peer.close();
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: a tool call created already finished is not left open`, async () => {
    const c = await rawClient(protocol, {
      async prompt(turn) {
        await turn.toolCall({ title: 'done already', status: 'completed' });
        throw new Error('boom');
      },
    });
    await c.prompt('go').catch(() => {});
    if (protocol === 2) await c.until(() => c.idles().length === 1);
    const statuses = c.updates.filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update').map((u) => u.status);
    assert.deepEqual(statuses, ['completed']);
    await c.peer.close();
  });

  test(`v${protocol}: elicit lets an error answer through instead of answering cancel`, async () => {
    const seen: string[] = [];
    const c = await rawClient(
      protocol,
      {
        async prompt(turn) {
          try {
            seen.push((await turn.elicit({ message: 'name?' })).action);
          } catch (error) {
            seen.push(RpcError.is(error) ? `error ${error.code}` : `other ${String(error)}`);
          }
          return 'end_turn';
        },
      },
      { capabilities: { elicitation: { form: {} } }, requests: { 'elicitation/create': () => Promise.reject(new RpcError(-32603, 'client broke')) } }
    );
    await c.prompt('go');
    if (protocol === 2) await c.until(() => c.idles().length === 1);
    assert.deepEqual(seen, ['error -32603']);
    await c.peer.close();
  });
}

test('v2: a tool call finished through toolCallUpdate stops being cancellable background work', async () => {
  const c = await rawClient(2, {
    async prompt(turn) {
      const call = await turn.toolCall({ title: 'grep', cancellable: true });
      await turn.toolCallUpdate({ toolCallId: call.id, status: 'completed' });
      await turn.toolCallUpdate({ toolCallId: 'raw-1', title: 'raw', status: 'in_progress' }, { create: true });
      return 'end_turn';
    },
  });
  await c.prompt('go');
  await c.until(() => c.idles().length === 1);
  const id = c.updates.find((u) => u.sessionUpdate === 'tool_call_update')!.toolCallId as string;
  await assert.rejects(c.peer.request('tool_call/cancel', { sessionId: c.sessionId, toolCallId: id }), /No running tool call/);
  // A raw create is tracked like toolCall(): known, though not cancellable.
  await assert.rejects(c.peer.request('tool_call/cancel', { sessionId: c.sessionId, toolCallId: 'raw-1' }), /cannot be cancelled/);
  await c.peer.close();
});
