/**
 * Our client against agents written with the official @agentclientprotocol/sdk,
 * protocol v1 and v2. If the reference implementation and we disagree, these
 * fail.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
import * as officialV2 from '@agentclientprotocol/sdk/experimental/v2';
import { AcpClient } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

test('official SDK agent, protocol v1', async () => {
  const link = byteLink();
  const app = officialV1
    .agent({ name: 'official-v1' })
    .onRequest('initialize', () => ({
      protocolVersion: 1,
      agentInfo: { name: 'official-v1', version: '1.0.0' },
      agentCapabilities: {},
      authMethods: [],
    }))
    .onRequest('session/new', () => ({ sessionId: 'official-session' }))
    .onRequest('session/prompt', async ({ params, client }) => {
      const send = (update: officialV1.SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi ' } });
      await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'List files', kind: 'read', status: 'pending' });
      const permission = await client.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 't1' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const ok = permission.outcome.outcome === 'selected' && permission.outcome.optionId === 'yes';
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: ok ? 'completed' : 'failed' });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ok ? 'done' : 'denied' } });
      return { stopReason: 'end_turn' };
    });
  app.connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));

  const client = await AcpClient.connect(link.client, { permissions: 'allow' });
  assert.equal(client.protocol, 1);
  assert.equal(client.agent.name, 'official-v1');
  const session = await client.newSession({ cwd: '/tmp' });
  const result = await session.prompt('list files').done;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.text, 'Hi \n\ndone');
  assert.equal(result.toolCalls[0]?.title, 'List files');
  assert.equal(result.toolCalls[0]?.status, 'completed');
  await client.close();
});

test('official SDK agent, protocol v2', async () => {
  const link = byteLink();
  const app = officialV2
    .agent({ name: 'official-v2' })
    .onRequest('initialize', () => ({
      protocolVersion: 2,
      info: { name: 'official-v2', version: '2.0.0' },
      capabilities: {},
      authMethods: [],
    }))
    .onRequest('session/new', () => ({ sessionId: 'official-session-2' }))
    .onRequest('session/prompt', ({ params, client }) => {
      const send = (update: officialV2.SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update });
      // v2: answer the prompt at once; the turn ends with an idle state update.
      setTimeout(async () => {
        await send({ sessionUpdate: 'state_update', state: 'running' });
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'Hi ' } });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'List files', kind: 'read', status: 'in_progress' });
        await send({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 't1', content: { type: 'content', content: { type: 'text', text: 'a.txt' } } });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        await send({ sessionUpdate: 'agent_message_chunk', messageId: 'a2', content: { type: 'text', text: 'done' } });
        await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 5);
      return { messageId: 'user-1' };
    });
  app.connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));

  const client = await AcpClient.connect(link.client);
  assert.equal(client.protocol, 2);
  assert.equal(client.agent.name, 'official-v2');
  const session = await client.newSession({ cwd: '/tmp' });
  const turn = session.prompt('list files');
  const result = await turn.done;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.text, 'Hi \n\ndone');
  assert.equal(result.toolCalls[0]?.status, 'completed');
  assert.equal(result.toolCalls[0]?.content.length, 1);
  assert.deepEqual(turn.history.filter((e) => e.type === 'state').map((e) => e.type === 'state' && e.state), ['running', 'idle']);
  await client.close();
});

test('a v1-only official agent accepts our v2-first initialize and we fall back to v1', async () => {
  const link = byteLink();
  let asked: unknown;
  officialV1
    .agent({ name: 'v1-only' })
    .onRequest('initialize', ({ params }) => {
      asked = params.protocolVersion;
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  assert.equal(asked, 2);
  assert.equal(client.protocol, 1);
  await client.close();
});

test('modes, v1 style: modes from session/new, set_mode, current_mode_update', async () => {
  const link = byteLink();
  const calls: unknown[] = [];
  officialV1
    .agent({ name: 'moded-v1' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({
      sessionId: 's',
      modes: {
        currentModeId: 'auto',
        availableModes: [
          { id: 'auto', name: 'Auto' },
          { id: 'default', name: 'Ask first' },
        ],
      },
    }))
    .onRequest('session/set_mode', async ({ params, client }) => {
      calls.push(params);
      await client.notify('session/update', { sessionId: 's', update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId } });
      return {};
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/tmp' });
  assert.equal(session.modes?.via, 'modes');
  assert.equal(session.modes?.current, 'auto');
  assert.deepEqual(session.modes?.available.map((m) => m.id), ['auto', 'default']);
  await session.setMode('default');
  assert.equal(session.modes?.current, 'default');
  assert.deepEqual(calls, [{ sessionId: 's', modeId: 'default' }]);
  await assert.rejects(session.setMode('yolo'), /offers no mode "yolo".*auto, default/);
  await client.close();
});

test('modes, v2 style: a config option with category mode, set_config_option', async () => {
  const link = byteLink();
  const calls: unknown[] = [];
  const configOptions = (current: string) => [
    {
      type: 'select' as const,
      configId: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: current,
      options: [
        { value: 'read-only', name: 'Read only' },
        { value: 'agent', name: 'Agent' },
      ],
    },
  ];
  officialV2
    .agent({ name: 'moded-v2' })
    .onRequest('initialize', () => ({ protocolVersion: 2, info: { name: 'moded-v2', version: '1' }, capabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's2', configOptions: configOptions('agent') }))
    .onRequest('session/set_config_option', ({ params }) => {
      calls.push(params);
      return { configOptions: configOptions(String(params.value)) };
    })
    .connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  assert.equal(client.protocol, 2);
  const session = await client.newSession({ cwd: '/tmp' });
  assert.deepEqual({ via: session.modes?.via, current: session.modes?.current }, { via: 'config', current: 'agent' });
  await session.setMode('read-only');
  assert.equal(session.modes?.current, 'read-only');
  assert.deepEqual(calls, [{ sessionId: 's2', configId: 'mode', type: 'id', value: 'read-only' }]);
  await client.close();
});

test('turn.text and turn.toolCalls show progress during the turn', async () => {
  const link = byteLink();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  officialV1
    .agent({ name: 'progress' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's' }))
    .onRequest('session/prompt', async ({ client }) => {
      await client.notify('session/update', { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } } });
      await client.notify('session/update', { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Build', status: 'in_progress' } });
      await gate;
      return { stopReason: 'end_turn' };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/tmp' });
  const turn = session.prompt('go');
  for await (const event of turn) if (event.type === 'tool_call') break;
  assert.equal(turn.text, 'Working');
  assert.deepEqual(turn.toolCalls.map((c) => [c.title, c.status]), [['Build', 'in_progress']]);
  release();
  await turn.done;
  await client.close();
});

test('a permission request when no turn is running is cancelled, whatever the policy', async () => {
  const link = byteLink();
  let answer: unknown;
  officialV1
    .agent({ name: 'eager' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', async ({ client }) => {
      setTimeout(async () => {
        answer = await client.request('session/request_permission', {
          sessionId: 's',
          toolCall: { toolCallId: 'x', title: 'rm -rf' },
          options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
        });
      }, 10);
      return { sessionId: 's' };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client, { permissions: 'allow' });
  await client.newSession({ cwd: '/tmp' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(answer, { outcome: { outcome: 'cancelled' } });
  await client.close();
});
