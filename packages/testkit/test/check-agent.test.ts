/**
 * checkAgent against our serveAgent, against agents written with the official
 * @agentclientprotocol/sdk (v1 and v2), and against a broken agent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
import * as officialV2 from '@agentclientprotocol/sdk/experimental/v2';
import { serveAgent } from '@deft-subspace/acp';
import { AGENT_CHECKS, checkAgent, DEFAULT_PROMPTS, failures, formatReport, type CheckResult } from '@deft-subspace/acp-testkit';
import { byteLink, sleep, untilAborted, wellBehaved } from './helpers.ts';

const allIds = Object.keys(AGENT_CHECKS);
const summary = (report: CheckResult[]) => report.map((r) => `${r.id}:${r.skipped ? 'skip' : r.pass ? 'pass' : 'fail'}`);
const textOf = (prompt: Array<{ type: string; text?: string }>) => prompt.map((b) => b.text ?? '').join('');
const OPTIONS = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
];

for (const protocol of [1, 2] as const) {
  test(`serveAgent v${protocol} passes every check`, async () => {
    const link = byteLink();
    serveAgent(link.agent, { name: 'good', protocols: [protocol], prompt: wellBehaved });
    const report = await checkAgent(link.client, { cancelGraceMs: 1000 });
    assert.deepEqual(report.map((r) => r.id), allIds);
    assert.deepEqual(failures(report), [], formatReport(report));
    assert.ok(report.every((r) => !r.skipped), formatReport(report));
    assert.match(report[0]!.detail, new RegExp(`agent chose ${protocol}`));
  });
}

test('an official-SDK v1 agent passes every check', async () => {
  const link = byteLink();
  const running = new Map<string, AbortController>();
  let sessions = 0;
  officialV1
    .agent({ name: 'official-v1' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => {
      const sessionId = `s${++sessions}`;
      running.set(sessionId, new AbortController());
      return { sessionId };
    })
    .onNotification('session/cancel', ({ params }) => running.get(params.sessionId)?.abort())
    .onRequest('session/prompt', async ({ params, client }) => {
      const controller = running.get(params.sessionId);
      if (!controller) throw officialV1.RequestError.resourceNotFound(params.sessionId);
      const { signal } = controller;
      const say = (text: string) =>
        client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
      const text = textOf(params.prompt as never);
      if (text === DEFAULT_PROMPTS.longPrompt) {
        for (let i = 1; i <= 300 && !signal.aborted; i++) {
          await say(`${i}\n`);
          await sleep(5);
        }
      } else if (text === DEFAULT_PROMPTS.permissionPrompt) {
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write deft-testkit.txt', kind: 'edit', status: 'pending' },
        });
        const answer = (await client.request('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 't1' },
          options: OPTIONS,
        })) as officialV1.RequestPermissionResponse;
        if (answer.outcome.outcome === 'cancelled') await untilAborted(signal);
      } else {
        await say('OK');
      }
      return { stopReason: signal.aborted ? 'cancelled' : 'end_turn' };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const report = await checkAgent(link.client, { cancelGraceMs: 1000 });
  assert.deepEqual(failures(report), [], formatReport(report));
  assert.ok(report.every((r) => !r.skipped), formatReport(report));
});

test('an official-SDK v2 agent passes every check', async () => {
  const link = byteLink();
  const running = new Map<string, AbortController>();
  let sessions = 0;
  officialV2
    .agent({ name: 'official-v2' })
    .onRequest('initialize', () => ({ protocolVersion: 2, info: { name: 'official-v2', version: '1' }, capabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => {
      const sessionId = `s${++sessions}`;
      running.set(sessionId, new AbortController());
      return { sessionId };
    })
    .onNotification('session/cancel', ({ params }) => running.get(params.sessionId)?.abort())
    .onRequest('session/prompt', ({ params, client }) => {
      const controller = running.get(params.sessionId);
      if (!controller) throw officialV2.RequestError.resourceNotFound(params.sessionId);
      const { signal } = controller;
      const sessionId = params.sessionId;
      const send = (update: officialV2.SessionUpdate) => client.notify('session/update', { sessionId, update });
      const say = (text: string, n: number) => send({ sessionUpdate: 'agent_message_chunk', messageId: `m${n}`, content: { type: 'text', text } });
      const text = textOf(params.prompt as never);
      // v2: answer at once; the turn ends with an idle state update.
      setTimeout(async () => {
        await send({ sessionUpdate: 'state_update', state: 'running' });
        if (text === DEFAULT_PROMPTS.longPrompt) {
          for (let i = 1; i <= 300 && !signal.aborted; i++) {
            await say(`${i}\n`, 1);
            await sleep(5);
          }
        } else if (text === DEFAULT_PROMPTS.permissionPrompt) {
          await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Write deft-testkit.txt', kind: 'edit', status: 'pending' });
          const answer = await client.request('session/request_permission', {
            sessionId,
            title: 'Write deft-testkit.txt',
            subject: { type: 'tool_call', toolCall: { toolCallId: 't1' } },
            options: OPTIONS,
          });
          if (answer.outcome.outcome === 'cancelled') await untilAborted(signal);
        } else {
          await say('OK', 1);
        }
        await send(
          signal.aborted
            ? { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' }
            : { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }
        );
      }, 1);
      return { messageId: `u-${sessionId}` };
    })
    .connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));
  const report = await checkAgent(link.client, { cancelGraceMs: 1000 });
  assert.deepEqual(failures(report), [], formatReport(report));
  assert.match(report[0]!.detail, /agent chose 2/);
});

test('a broken agent fails the checks it breaks', async () => {
  const link = byteLink();
  officialV1
    .agent({ name: 'sloppy' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 'any' }))
    // Ignores cancel, sends nothing, accepts any session id, never asks permission.
    .onNotification('session/cancel', () => {})
    .onRequest('session/prompt', async ({ params }) => {
      if (textOf(params.prompt as never) === DEFAULT_PROMPTS.longPrompt) await sleep(400);
      return { stopReason: 'end_turn' };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  // The long turn sends no update to cancel after; the suite gives up after turnTimeoutMs.
  const report = await checkAgent(link.client, { cancelGraceMs: 100, turnTimeoutMs: 200 });
  assert.deepEqual(summary(report), [
    'initialize.version:pass',
    'session.new:pass',
    'prompt.ends:pass',
    'prompt.updates-before-end:fail',
    'cancel.ends-cancelled:fail',
    'session.unknown:fail',
    'cancel.permission:skip',
  ]);
  assert.match(report.find((r) => r.id === 'session.unknown')!.detail, /answered/);
  assert.match(formatReport(report), /FAIL  session\.unknown/);
});

test('an agent that answers cancel too late fails, and one with no v1/v2 fails initialize', async () => {
  const link = byteLink();
  serveAgent(link.agent, {
    name: 'slow-to-cancel',
    async prompt(turn) {
      await turn.say('1\n');
      await untilAborted(turn.signal);
      await sleep(300);
      return 'cancelled';
    },
  });
  const report = await checkAgent(link.client, { only: ['cancel.ends-cancelled'], cancelGraceMs: 50 });
  assert.deepEqual(summary(report), ['cancel.ends-cancelled:fail']);
  assert.match(report[0]!.detail, /still running 50 ms after session\/cancel/);

  const other = byteLink();
  officialV1
    .agent({ name: 'future' })
    .onRequest('initialize', () => ({ protocolVersion: 7, agentCapabilities: {}, authMethods: [] }))
    .connect(officialV1.ndJsonStream(other.b.writable, other.b.readable));
  const bad = await checkAgent(other.client);
  assert.deepEqual(summary(bad), ['initialize.version:fail']);
});
