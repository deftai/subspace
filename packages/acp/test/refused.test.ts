/**
 * Refused permissions: TurnResult.refused counts them, and turnEnd tells an
 * agent that stops "cancelled" after a refusal (Grok, Codex) from a cancel.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpClient, serveAgent, turnEnd, type AgentOptions, type ClientOptions, type ProtocolVersion } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

async function pair(protocol: ProtocolVersion, agent: AgentOptions['prompt'], client: ClientOptions) {
  const link = byteLink();
  serveAgent(link.agent, { name: 'refuser', protocols: [protocol], prompt: agent });
  const c = await AcpClient.connect(link.client, client);
  return c.newSession({ cwd: '/w' });
}

/** Asks once; stops "cancelled" if refused (like Grok and Codex), else ends normally. */
const asksOnce: AgentOptions['prompt'] = async (turn) => {
  const call = await turn.toolCall({ title: 'Write hello.txt', kind: 'edit' });
  const answer = await turn.requestPermission({ title: 'Write hello.txt', toolCallId: call.id });
  return answer.allowed ? 'end_turn' : 'cancelled';
};

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: a refused request stopped "cancelled" is turnEnd "refused"; an allowed one is "completed"`, async () => {
    const rejected = await (await pair(protocol, asksOnce, { permissions: 'reject' })).prompt('write').done;
    assert.deepEqual([rejected.stopReason, rejected.cancelled, rejected.refused, turnEnd(rejected)], ['cancelled', false, 1, 'refused']);

    const answeredCancelled = await (await pair(protocol, asksOnce, { permissions: () => 'cancelled' })).prompt('write').done;
    assert.deepEqual([answeredCancelled.refused, turnEnd(answeredCancelled)], [1, 'refused']);

    const allowed = await (await pair(protocol, asksOnce, { permissions: 'allow' })).prompt('write').done;
    assert.deepEqual([allowed.stopReason, allowed.refused, turnEnd(allowed)], ['end_turn', undefined, 'completed']);
  });

  test(`v${protocol}: a request answered cancelled because of a cancel is not counted; the turn is "cancelled"`, async () => {
    let session!: Awaited<ReturnType<typeof pair>>;
    session = await pair(protocol, asksOnce, {
      permissions: async (_request, signal) => {
        void turn.cancel();
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        return 'allow';
      },
    });
    const turn = session.prompt('write');
    const result = await turn.done;
    assert.deepEqual([result.stopReason, result.cancelled, result.refused, turnEnd(result)], ['cancelled', true, undefined, 'cancelled']);
  });
}

test('turnEnd: limits, errors, and other stops', () => {
  const base = { text: '', toolCalls: [], cancelled: false };
  assert.equal(turnEnd({ ...base, stopReason: 'cancelled', cancelled: true, exhausted: { limit: 'toolCalls', max: 1, value: 2 } }), 'limit');
  assert.equal(turnEnd({ ...base, stopReason: 'error', error: {} }), 'error');
  assert.equal(turnEnd({ ...base, stopReason: 'cancelled' }), 'cancelled', 'the agent cancelled unprompted, nothing refused');
  assert.equal(turnEnd({ ...base, stopReason: 'end_turn', refused: 1 }), 'completed', 'Claude: refused, but ended normally');
  assert.equal(turnEnd({ ...base, stopReason: 'max_tokens' }), 'completed');
});
