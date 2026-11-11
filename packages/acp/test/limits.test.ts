import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpClient, serveAgent, type AgentOptions, type ProtocolVersion, type TurnLimits } from '@deft-subspace/acp';
import { byteLink, sleep } from './helpers.ts';

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));

async function run(protocol: ProtocolVersion, prompt: AgentOptions['prompt'], limits: TurnLimits, clientLimits?: TurnLimits) {
  const link = byteLink();
  serveAgent(link.agent, { name: 'bounded', protocols: [protocol], prompt });
  const client = await AcpClient.connect(link.client, { limits: clientLimits, timeouts: { cancelGraceMs: 200 } });
  const session = await client.newSession({ cwd: '/tmp' });
  const turn = session.prompt('go', clientLimits ? {} : { limits });
  const result = await turn.done;
  await client.close();
  return { result, turn };
}

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: maxDurationMs ends a turn that runs too long`, async () => {
    const { result, turn } = await run(protocol, async (t) => {
      await t.say('working');
      await untilAborted(t.signal);
    }, { maxDurationMs: 60 });
    assert.deepEqual(result.exhausted, { limit: 'duration', max: 60, value: 60 });
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(result.forced, undefined, 'the agent confirmed the cancel');
    assert.ok(turn.history.some((e) => e.type === 'exhausted' && e.limit === 'duration'));
  });

  test(`v${protocol}: idleMs ends a turn whose agent goes quiet, and activity resets it`, async () => {
    const { result } = await run(protocol, async (t) => {
      for (let i = 0; i < 4; i++) {
        await t.say(`step ${i} `);
        await sleep(50); // well under the idle limit each time, even on a busy machine
      }
      await untilAborted(t.signal); // then silence
    }, { idleMs: 500 });
    assert.equal(result.exhausted?.limit, 'idle');
    assert.equal(result.text, 'step 0 step 1 step 2 step 3 ');
  });

  test(`v${protocol}: maxToolCalls ends the turn when one more tool call starts`, async () => {
    const { result } = await run(protocol, async (t) => {
      for (let i = 1; i <= 5; i++) {
        if (t.signal.aborted) return;
        const call = await t.toolCall({ title: `step ${i}`, kind: 'execute' });
        await call.complete();
        await sleep(5);
      }
    }, { maxToolCalls: 2 });
    assert.deepEqual(result.exhausted, { limit: 'toolCalls', max: 2, value: 3 });
    assert.equal(result.toolCalls.length, 3);
    assert.equal(result.stopReason, 'cancelled');
  });

  test(`v${protocol}: a turn within its limits is not touched`, async () => {
    const { result } = await run(protocol, async (t) => {
      await t.say('quick');
      return 'end_turn';
    }, { maxDurationMs: 5000, idleMs: 5000, maxToolCalls: 1, maxUsage: 10 });
    assert.equal(result.exhausted, undefined);
    assert.equal(result.stopReason, 'end_turn');
  });
}

test('v2: maxUsage ends a turn once reported usage crosses it', async () => {
  const { result } = await run(2, async (t) => {
    for (const used of [100, 900, 1500]) {
      await t.sendUpdate({ sessionUpdate: 'usage_update', used, size: 200000 });
      await sleep(5);
    }
    await untilAborted(t.signal);
  }, { maxUsage: 1000 });
  assert.deepEqual(result.exhausted, { limit: 'usage', max: 1000, value: 1500 });
});

test('client-wide limits apply to every turn', async () => {
  const { result } = await run(1, async (t) => untilAborted(t.signal), {}, { maxDurationMs: 40 });
  assert.equal(result.exhausted?.limit, 'duration');
});

test('an agent that ignores the cancel is ended here after the grace period, still marked exhausted', async () => {
  const { result } = await run(1, () => new Promise(() => {}), { maxDurationMs: 40 });
  assert.equal(result.exhausted?.limit, 'duration');
  assert.equal(result.forced, true);
});
