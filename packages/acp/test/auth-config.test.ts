/**
 * Logging in, deleting sessions and config options, against agents written
 * with the official SDK (which checks the params we send), v1 and v2.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
import * as officialV2 from '@agentclientprotocol/sdk/experimental/v2';
import { AcpClient, CapabilityError } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

/** Config options as Claude's adapter sends them: a model select, a grouped effort select, an on/off switch. */
const v1Options = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sonnet', options: [
    { value: 'sonnet', name: 'Sonnet' },
    { value: 'opus', name: 'Opus', description: 'Most capable' },
  ] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
    { group: 'g', name: 'Levels', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ] },
  { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'boolean', currentValue: false },
] as const;

test('v1: authMethods, authenticate, logout', async () => {
  const link = byteLink();
  const calls: Array<[string, unknown]> = [];
  officialV1
    .agent({ name: 'auth-v1' })
    .onRequest('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { auth: { logout: {} } },
      authMethods: [
        { id: 'cached_token', name: 'cached_token', description: 'Cached token' },
        { id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' },
      ],
    }))
    .onRequest('authenticate', ({ params }) => {
      calls.push(['authenticate', params]);
      return {};
    })
    .onRequest('logout', ({ params }) => {
      calls.push(['logout', params]);
      return {};
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  assert.deepEqual(
    client.authMethods.map((m) => [m.id, m.type]),
    [['cached_token', 'agent'], ['grok.com', 'agent']]
  );
  await client.authenticate('grok.com');
  await assert.rejects(client.authenticate('nope'), /no login method "nope"/);
  assert.equal(client.canLogout, true);
  await client.logout();
  assert.deepEqual(calls, [['authenticate', { methodId: 'grok.com' }], ['logout', {}]]);
  await client.close();
});

test('v1: no logout capability, no logout', async () => {
  const link = byteLink();
  officialV1
    .agent({ name: 'auth-v1' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'a', name: 'A' }] }))
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  assert.equal(client.canLogout, false);
  await assert.rejects(client.logout(), CapabilityError);
  await client.close();
});

test('v2: auth/login, auth/logout, terminal methods only when the client says it can run them', async () => {
  for (const terminalAuth of [false, true]) {
    const link = byteLink();
    const calls: Array<[string, unknown]> = [];
    let advertised: unknown;
    officialV2
      .agent({ name: 'auth-v2' })
      .onRequest('initialize', ({ params }) => {
        advertised = params.capabilities?.auth;
        return {
          protocolVersion: 2,
          info: { name: 'auth-v2', version: '1' },
          capabilities: {},
          authMethods: [
            { methodId: 'chat-gpt', type: 'agent', name: 'ChatGPT' },
            ...(params.capabilities?.auth?.terminal
              ? [{ methodId: 'tui', type: 'terminal' as const, name: 'Log in in a terminal', args: ['login'], env: [{ name: 'MODE', value: 'tty' }] }]
              : []),
          ],
        };
      })
      .onRequest('auth/login', ({ params }) => {
        calls.push(['auth/login', params]);
        return {};
      })
      .onRequest('auth/logout', ({ params }) => {
        calls.push(['auth/logout', params]);
        return {};
      })
      .connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));
    const client = await AcpClient.connect(link.client, { terminalAuth });
    if (terminalAuth) {
      assert.deepEqual(advertised, { terminal: {} });
      const tui = client.authMethods.find((m) => m.id === 'tui');
      assert.deepEqual(tui && { type: tui.type, args: tui.args, env: tui.env }, { type: 'terminal', args: ['login'], env: { MODE: 'tty' } });
    } else {
      assert.equal(advertised, undefined);
      assert.deepEqual(client.authMethods.map((m) => m.id), ['chat-gpt']);
    }
    await client.authenticate('chat-gpt');
    await client.logout();
    assert.deepEqual(calls, [['auth/login', { methodId: 'chat-gpt' }], ['auth/logout', {}]]);
    await client.close();
  }
});

test('session/delete: refused without the capability; closes an open session first', async () => {
  for (const capable of [false, true]) {
    const link = byteLink();
    const deleted: unknown[] = [];
    officialV1
      .agent({ name: 'delete-v1' })
      .onRequest('initialize', () => ({
        protocolVersion: 1,
        agentCapabilities: capable ? { sessionCapabilities: { delete: {} } } : {},
        authMethods: [],
      }))
      .onRequest('session/new', () => ({ sessionId: 's1' }))
      .onRequest('session/delete', ({ params }) => {
        deleted.push(params);
        return {};
      })
      .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
    const client = await AcpClient.connect(link.client);
    if (!capable) {
      await assert.rejects(client.deleteSession('old'), CapabilityError);
    } else {
      await client.newSession({ cwd: '/tmp' });
      await client.deleteSession('s1');
      assert.deepEqual(deleted, [{ sessionId: 's1' }]);
      // Forgotten here: the same id can be opened again.
      await client.newSession({ cwd: '/tmp' });
    }
    await client.close();
  }
});

test('v1 config options: read, model helper, select and boolean set, updates', async () => {
  const link = byteLink();
  const sets: unknown[] = [];
  let current: Record<string, string | boolean> = { model: 'sonnet', effort: 'low', fast: false };
  const options = () => v1Options.map((o) => ({ ...o, currentValue: current[o.id] })) as officialV1.SessionConfigOption[];
  officialV1
    .agent({ name: 'config-v1' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's', configOptions: options() }))
    .onRequest('session/set_config_option', ({ params }) => {
      sets.push(params);
      current = { ...current, [params.configId]: params.value };
      return { configOptions: options() };
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      current = { ...current, effort: 'high' };
      await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options() } });
      return { stopReason: 'end_turn' };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/tmp' });

  assert.deepEqual(session.configOptions.map((o) => [o.id, o.type, o.currentValue]), [
    ['model', 'select', 'sonnet'],
    ['effort', 'select', 'low'],
    ['fast', 'boolean', false],
  ]);
  const effort = session.configOption('effort');
  assert.deepEqual(effort?.type === 'select' && 'choices' in effort && effort.choices[1], { value: 'high', name: 'High', group: 'Levels' });
  assert.equal(session.model?.id, 'model');
  assert.deepEqual(session.model?.choices.map((c) => c.value), ['sonnet', 'opus']);

  await session.setModel('opus');
  await session.setConfigOption('fast', true);
  assert.deepEqual(sets, [
    { sessionId: 's', configId: 'model', value: 'opus' },
    { sessionId: 's', configId: 'fast', type: 'boolean', value: true },
  ]);
  assert.equal(session.model?.currentValue, 'opus');
  assert.equal(session.configOption('fast')?.currentValue, true);

  // Refused here, without asking the agent.
  await assert.rejects(session.setModel('gpt'), /no choice "gpt"/);
  await assert.rejects(session.setConfigOption('fast', 'yes'), /true or false/);
  await assert.rejects(session.setConfigOption('colour', 'red'), /no config option "colour"/);
  assert.equal(sets.length, 2);

  await session.prompt('hi').done;
  assert.equal(session.configOption('effort')?.currentValue, 'high');
  await client.close();
});

test('v2 config options: configId, type id for selects', async () => {
  const link = byteLink();
  const sets: unknown[] = [];
  let current: Record<string, string | boolean> = { model: 'gpt-5', web: true };
  const options = (): officialV2.SessionConfigOption[] => [
    { configId: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current.model as string, options: [
      { value: 'gpt-5', name: 'GPT-5' },
      { value: 'gpt-5-mini', name: 'GPT-5 mini' },
    ] },
    { configId: 'web', name: 'Web search', type: 'boolean', currentValue: current.web as boolean },
  ];
  officialV2
    .agent({ name: 'config-v2' })
    .onRequest('initialize', () => ({ protocolVersion: 2, info: { name: 'config-v2', version: '1' }, capabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's', configOptions: options() }))
    .onRequest('session/set_config_option', ({ params }) => {
      sets.push(params);
      current = { ...current, [params.configId]: params.value as string | boolean };
      return { configOptions: options() };
    })
    .connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/tmp' });
  assert.deepEqual(session.configOptions.map((o) => o.id), ['model', 'web']);
  await session.setModel('gpt-5-mini');
  await session.setConfigOption('web', false);
  assert.deepEqual(sets, [
    { sessionId: 's', configId: 'model', type: 'id', value: 'gpt-5-mini' },
    { sessionId: 's', configId: 'web', type: 'boolean', value: false },
  ]);
  assert.deepEqual(session.configOptions.map((o) => o.currentValue), ['gpt-5-mini', false]);
  await client.close();
});

test('overlapping config changes apply in the order they were made', async () => {
  const link = byteLink();
  let calls = 0;
  let current: Record<string, string | boolean> = { model: 'sonnet', effort: 'low', fast: false };
  const options = (model: string) => v1Options.map((o) => ({ ...o, currentValue: o.id === 'model' ? model : current[o.id] })) as officialV1.SessionConfigOption[];
  officialV1
    .agent({ name: 'config-order' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's', configOptions: options('sonnet') }))
    .onRequest('session/set_config_option', async ({ params }) => {
      // The first change is answered slowly, the second at once.
      if (calls++ === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      current = { ...current, [params.configId]: params.value };
      return { configOptions: options(String(params.value)) };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/tmp' });
  await Promise.all([session.setModel('opus'), session.setModel('sonnet')]);
  assert.equal(session.model?.currentValue, 'sonnet', 'the later change wins');
  await client.close();
});
