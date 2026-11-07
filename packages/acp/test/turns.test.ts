import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, LocalError, RpcError, RpcPeer } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type AgentTurn, type ProtocolVersion, type TurnEvent } from '@deft-subspace/acp';
import { byteLink, sleep } from './helpers.ts';

/** One agent, written once. It runs unchanged on v1 and v2. */
async function scriptedAgent(turn: AgentTurn) {
  await turn.think('Looking at the file.');
  await turn.say('I will read ');
  await turn.say('the file.');
  const call = await turn.toolCall({ title: 'Read README.md', kind: 'read', rawInput: { path: 'README.md' } });
  await call.update({ status: 'in_progress' });
  const answer = await turn.requestPermission({ title: 'Read README.md', toolCallId: call.id });
  if (!answer.allowed) {
    await call.fail();
    await turn.say('Not allowed.');
    return 'end_turn';
  }
  await call.complete({ content: [{ type: 'content', content: { type: 'text', text: '# Hello' } }] });
  await turn.plan([{ content: 'Summarize', status: 'in_progress' }]);
  await turn.say('It says hello.');
  return 'end_turn';
}

async function start(protocol: ProtocolVersion, options: Parameters<typeof AcpClient.connect>[1] = {}) {
  const link = byteLink();
  serveAgent(link.agent, { name: 'scripted', protocols: [protocol], prompt: scriptedAgent });
  const client = await AcpClient.connect(link.client, { permissions: 'allow', ...options });
  return { client, link };
}

/** Events with ids normalised, so two runs can be compared. */
function shape(events: readonly TurnEvent[]) {
  return events
    .filter((e) => e.type !== 'state')
    .map((e) => {
      switch (e.type) {
        case 'message':
        case 'thought':
          return `${e.type}: ${JSON.stringify(e.delta)} => ${JSON.stringify(e.text)}`;
        case 'tool_call':
          return `tool ${e.created ? 'new' : 'upd'}: ${e.toolCall.title} [${e.toolCall.status}] content=${e.toolCall.content.length}`;
        case 'permission':
          return `permission: ${e.request.title} -> ${e.outcome.outcome === 'selected' ? (e.outcome.allowed ? 'allowed' : 'rejected') : 'cancelled'}`;
        case 'plan':
          return `plan: ${e.entries.map((x) => x.content).join(', ')}`;
        default:
          return e.type;
      }
    });
}

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: a turn streams events, and done comes after the last one`, async () => {
    const { client } = await start(protocol);
    assert.equal(client.protocol, protocol);
    const session = await client.newSession({ cwd: '/tmp' });
    const turn = session.prompt('What does the README say?');
    const seen: TurnEvent[] = [];
    for await (const event of turn) seen.push(event);
    const result = await turn.done;
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'I will read the file.\n\nIt says hello.');
    assert.equal(result.toolCalls[0]?.status, 'completed');
    assert.equal(result.toolCalls[0]?.title, 'Read README.md', 'the permission request did not rename the tool call');
    assert.deepEqual(seen, turn.history, 'iterating again gives the same events');
    await client.close();
  });
}

test('v1 and v2 give the same events for the same agent', async () => {
  const runs: string[][] = [];
  for (const protocol of [1, 2] as const) {
    const { client } = await start(protocol);
    const session = await client.newSession({ cwd: '/tmp' });
    const turn = session.prompt('go');
    await turn.done;
    runs.push(shape(turn.history));
    await client.close();
  }
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[0], [
    'thought: "Looking at the file." => "Looking at the file."',
    'message: "I will read " => "I will read "',
    'message: "the file." => "I will read the file."',
    'tool new: Read README.md [pending] content=0',
    'tool upd: Read README.md [in_progress] content=0',
    'permission: Read README.md -> allowed',
    'tool upd: Read README.md [completed] content=1',
    'plan: Summarize',
    'message: "It says hello." => "It says hello."',
  ]);
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: permissions fail closed`, async () => {
    // Default policy: reject. A throwing policy, an unknown option and a misspelt decision also reject.
    for (const permissions of [undefined, () => { throw new Error('ui crashed'); }, () => ({ optionId: 'made-up' }), async () => 'alow'] as const) {
      const { client } = await start(protocol, { permissions: permissions as never });
      const session = await client.newSession({ cwd: '/tmp' });
      const result = await session.prompt('go').done;
      assert.equal(result.text, 'I will read the file.\n\nNot allowed.');
      assert.equal(result.toolCalls[0]?.status, 'failed');
      await client.close();
    }
  });

  test(`v${protocol}: cancel ends the turn, answers the open permission question, fails open tool calls`, async () => {
    const link = byteLink();
    let sawAbort = false;
    serveAgent(link.agent, {
      name: 'slow',
      protocols: [protocol],
      async prompt(turn) {
        const call = await turn.toolCall({ title: 'Run tests', kind: 'execute', status: 'in_progress' });
        const answer = await turn.requestPermission({ title: 'Run tests', toolCallId: call.id });
        assert.equal(answer.outcome, 'cancelled');
        await new Promise<void>((resolve) => {
          if (turn.signal.aborted) resolve();
          turn.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        sawAbort = true;
        return 'end_turn'; // ignored: a cancelled turn ends cancelled
      },
    });
    // The user never answers; only the cancel can end this.
    const client = await AcpClient.connect(link.client, { permissions: () => new Promise(() => {}) });
    const session = await client.newSession({ cwd: '/tmp' });
    const turn = session.prompt('go');
    for await (const event of turn) {
      if (event.type === 'tool_call') {
        await sleep(20);
        await turn.cancel();
      }
    }
    const result = await turn.done;
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(result.cancelled, true);
    assert.equal(result.forced, undefined, 'the agent confirmed the cancel');
    assert.equal(sawAbort, true);
    assert.equal(result.toolCalls[0]?.status, 'failed');
    assert.deepEqual(
      turn.history.filter((e) => e.type === 'permission').map((e) => e.type === 'permission' && e.outcome.outcome),
      ['cancelled']
    );
    await client.close();
  });
}

test('a cancel the agent ignores ends the turn here after the grace period', async () => {
  const link = byteLink();
  serveAgent(link.agent, { name: 'stubborn', prompt: () => new Promise(() => {}) });
  const client = await AcpClient.connect(link.client, { timeouts: { cancelGraceMs: 50 } });
  const session = await client.newSession({ cwd: '/tmp' });
  const turn = session.prompt('go');
  await sleep(10);
  await turn.cancel();
  const result = await turn.done;
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.forced, true);
  assert.equal(session.busy, false, 'the session can take the next prompt');
  await client.close();
});

test('prompting an unknown session is ResourceNotFound, not a new session', async () => {
  const link = byteLink();
  serveAgent(link.agent, { name: 'strict', prompt: () => 'end_turn' });
  const peer = new RpcPeer(link.client).start();
  await peer.request('initialize', { protocolVersion: 1 });
  await assert.rejects(
    peer.request('session/prompt', { sessionId: 'nope', prompt: [] }),
    (e) => RpcError.is(e) && e.code === ErrorCode.ResourceNotFound
  );
  await peer.close();
});

test('if the agent goes away mid-turn, done rejects with closed and iteration ends', async () => {
  const link = byteLink();
  const agent = serveAgent(link.agent, { name: 'crashy', prompt: () => new Promise(() => {}) });
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/tmp' });
  const turn = session.prompt('go');
  await sleep(10);
  await agent.close();
  await assert.rejects(turn.done, (e) => LocalError.is(e, 'closed'));
  await assert.rejects(async () => {
    for await (const _ of turn) void _;
  }, (e) => LocalError.is(e, 'closed'));
});

test('a v2 whole-message upsert after streamed chunks does not repeat text', async () => {
  const link = byteLink();
  serveAgent(link.agent, {
    name: 'upsert',
    protocols: [2],
    async prompt(turn) {
      await turn.say('Hel');
      await turn.say('lo');
      return 'end_turn';
    },
  });
  // Rewrite the agent's chunks: after "lo", also send the whole message, as v2 allows.
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/tmp' });
  const turn = session.prompt('go');
  await turn.done;
  const projection = new (await import('@deft-subspace/acp')).TurnProjection('t');
  const first = projection.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello' } });
  const whole = projection.apply({ sessionUpdate: 'agent_message', messageId: 'm1', content: [{ type: 'text', text: 'Hello world' }] });
  assert.deepEqual(first.events.map((e) => e.type === 'message' && e.delta), ['Hello']);
  assert.deepEqual(whole.events.map((e) => e.type === 'message' && e.delta), [' world']);
  assert.equal(projection.text, 'Hello world');
  assert.equal((await turn.done).text, 'Hello');
  await client.close();
});
