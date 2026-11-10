/**
 * v2 background work: cancellable tool calls and terminals, detached work
 * listed on state updates, tool_call/cancel and terminal/cancel, and what
 * session/cancel and session/close do to it. Our client against serveAgent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV2 from '@agentclientprotocol/sdk/experimental/v2';
import { RpcError } from '@deft-subspace/kernel';
import { AcpClient, CapabilityError, serveAgent, terminalText, type TurnEvent } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

const until = async (check: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('v2: detached work outlives the turn, survives session/cancel, and is cancelled one item at a time', async () => {
  const link = byteLink();
  const log: string[] = [];
  let askAboutWatch!: () => Promise<boolean>;
  serveAgent(link.agent, {
    name: 'background',
    protocols: [2],
    async prompt(turn) {
      if (turn.text === 'start') {
        const watch = await turn.toolCall({ id: 'watch', title: 'Watch deploy logs', status: 'in_progress', cancellable: true });
        const plain = await turn.toolCall({ id: 'plain', title: 'One step', status: 'in_progress' });
        await plain.complete();
        const dev = await turn.showTerminal({ id: 'dev', command: 'npm run dev', cwd: '/work', cancellable: true });
        await dev.write('listening on 3000\n');
        await watch.detach();
        await dev.detach();
        // Background: run until cancelled, then report it.
        watch.signal.addEventListener('abort', () => void watch.cancelled().then(() => log.push('watch cancelled')));
        dev.signal.addEventListener('abort', () => void dev.exit({ signal: 'SIGTERM' }).then(() => log.push('dev exited')));
        askAboutWatch = async () => (await turn.requestPermission({ title: 'Restart the deploy?', toolCallId: 'watch' })).allowed;
        await turn.say('started');
        return;
      }
      // A foreground turn the client cancels.
      await new Promise((resolve) => turn.signal.addEventListener('abort', resolve));
      return 'cancelled';
    },
  });
  const client = await AcpClient.connect(link.client, { permissions: 'allow' });
  const session = await client.newSession({ cwd: '/work' });
  const idle: TurnEvent[] = [];
  session.onIdleUpdate((event) => idle.push(event));

  const started = await session.prompt('start').done;
  assert.equal(started.text, 'started');
  assert.deepEqual(session.background, [
    { type: 'tool_call', toolCallId: 'watch' },
    { type: 'terminal', terminalId: 'dev' },
  ]);
  assert.equal(session.toolCalls.get('watch')?.cancellable, true);
  assert.equal(session.toolCalls.get('plain')?.cancellable, undefined);
  assert.equal(session.terminals.get('dev')?.cancellable, true);
  assert.equal(terminalText(session.terminals.get('dev')!), 'listening on 3000\n');

  // A question about listed background work is answered with no turn running.
  assert.equal(await askAboutWatch(), true);
  assert.equal(idle.filter((e) => e.type === 'permission').length, 1);

  // session/cancel stops the foreground turn only.
  const second = session.prompt('wait');
  setTimeout(() => void second.cancel(), 20);
  assert.equal((await second.done).stopReason, 'cancelled');
  assert.equal(session.toolCalls.get('watch')?.status, 'in_progress');
  assert.equal(session.background?.length, 2);
  assert.deepEqual(log, []);

  // One at a time.
  await assert.rejects(session.cancelToolCall('plain'), CapabilityError);
  await session.cancelToolCall('watch');
  await until(() => session.toolCalls.get('watch')?.status === 'cancelled');
  assert.equal(session.toolCalls.get('watch')?.cancellable, undefined);
  await until(() => session.background?.length === 1);
  await session.cancelTerminal('dev');
  await until(() => session.background?.length === 0);
  assert.deepEqual(session.terminals.get('dev')?.exitStatus, { signal: 'SIGTERM' });
  assert.equal(session.terminals.get('dev')?.cancellable, undefined);
  assert.deepEqual(log, ['watch cancelled', 'dev exited']);

  // The agent refuses what is unknown or finished, as the RFD says (-32602).
  for (const params of [
    { sessionId: session.id, toolCallId: 'watch' },
    { sessionId: session.id, toolCallId: 'nope' },
  ]) {
    await assert.rejects(client.peer.request('tool_call/cancel', params), (e: unknown) => RpcError.is(e) && e.code === -32602);
  }
  await client.close();
});

test('v2: session/close stops background work', async () => {
  const link = byteLink();
  let aborted = false;
  serveAgent(link.agent, {
    name: 'background',
    protocols: [2],
    async prompt(turn) {
      const job = await turn.toolCall({ id: 'job', title: 'Nightly job', status: 'pending', cancellable: true });
      job.signal.addEventListener('abort', () => (aborted = true));
      await job.detach();
    },
  });
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/work' });
  await session.prompt('go').done;
  assert.deepEqual(session.background, [{ type: 'tool_call', toolCallId: 'job' }]);
  await session.close();
  await until(() => aborted);
  await client.close();
});

test('v2: a closed connection stops background work', async () => {
  const link = byteLink();
  let reason: unknown;
  serveAgent(link.agent, {
    name: 'background',
    protocols: [2],
    async prompt(turn) {
      const job = await turn.toolCall({ id: 'job', title: 'Nightly job', status: 'pending', cancellable: true });
      job.signal.addEventListener('abort', () => (reason = job.signal.reason));
      await job.detach();
    },
  });
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/work' });
  await session.prompt('go').done;
  assert.deepEqual(session.background, [{ type: 'tool_call', toolCallId: 'job' }]);
  await client.close();
  await until(() => reason !== undefined);
  assert.match(String((reason as Error).message), /connection closed/);
});

test('v1: no background work: detach only keeps it from failing with the turn; nothing is cancellable', async () => {
  const link = byteLink();
  serveAgent(link.agent, {
    name: 'background',
    protocols: [1],
    async prompt(turn) {
      const job = await turn.toolCall({ id: 'job', title: 'Job', status: 'in_progress', cancellable: true });
      await job.detach();
      await assert.rejects(turn.showTerminal({ command: 'x' }), CapabilityError);
      await new Promise((resolve) => turn.signal.addEventListener('abort', resolve));
      return 'cancelled';
    },
  });
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/work' });
  const turn = session.prompt('go');
  setTimeout(() => void turn.cancel(), 20);
  const result = await turn.done;
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.toolCalls[0]?.status, 'in_progress', 'detached: not failed with the turn');
  assert.equal(result.toolCalls[0]?.cancellable, undefined);
  assert.equal(session.background, undefined);
  await client.close();
});

test("v2: an official-SDK agent's background list and tool_call/cancel", async () => {
  const link = byteLink();
  const cancels: unknown[] = [];
  officialV2
    .agent({ name: 'official-background' })
    .onRequest('initialize', () => ({ protocolVersion: 2, info: { name: 'official-background', version: '1' }, capabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's' }))
    .onRequest('tool_call/cancel', ({ params }) => {
      cancels.push(params);
      return {};
    })
    .onRequest('session/prompt', ({ params, client }) => {
      const send = (update: officialV2.SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update });
      setTimeout(async () => {
        await send({ sessionUpdate: 'state_update', state: 'running' });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'w', title: 'Watch', kind: 'other', status: 'in_progress', capabilities: { cancel: {} } });
        await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn', background: [{ type: 'tool_call', toolCallId: 'w' }] });
      }, 5);
      return { messageId: 'u' };
    })
    .connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/work' });
  await session.prompt('go').done;
  assert.deepEqual(session.background, [{ type: 'tool_call', toolCallId: 'w' }]);
  await session.cancelToolCall('w');
  assert.deepEqual(cancels, [{ sessionId: 's', toolCallId: 'w' }]);
  await client.close();
});

test('v2: background work that ends before the agent starts the next prompt does not end that turn', async () => {
  const link = byteLink();
  let prompts = 0;
  officialV2
    .agent({ name: 'late-background' })
    .onRequest('initialize', () => ({ protocolVersion: 2, info: { name: 'late-background', version: '1' }, capabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's' }))
    .onRequest('session/prompt', ({ params, client }) => {
      const send = (update: officialV2.SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update });
      const n = ++prompts;
      setTimeout(async () => {
        if (n === 2) {
          // The first turn's background job finishes before this prompt starts: an idle snapshot, no stop reason.
          await send({ sessionUpdate: 'tool_call_update', toolCallId: 'job', status: 'completed' });
          await send({ sessionUpdate: 'state_update', state: 'idle', background: [] });
          await new Promise((r) => setTimeout(r, 10));
        }
        await send({ sessionUpdate: 'state_update', state: 'running' });
        if (n === 1) await send({ sessionUpdate: 'tool_call_update', toolCallId: 'job', title: 'Job', kind: 'other', status: 'in_progress' });
        await send({ sessionUpdate: 'agent_message_chunk', messageId: `m${n}`, content: { type: 'text', text: `turn ${n}` } });
        const background = n === 1 ? [{ type: 'tool_call' as const, toolCallId: 'job' }] : [];
        await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn', background });
      }, 5);
      return { messageId: `u${n}` };
    })
    .connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/work' });
  assert.equal((await session.prompt('one').done).text, 'turn 1');
  const second = await session.prompt('two').done;
  assert.equal(second.stopReason, 'end_turn');
  assert.equal(second.text, 'turn 2');
  assert.deepEqual(session.background, []);
  await client.close();
});
