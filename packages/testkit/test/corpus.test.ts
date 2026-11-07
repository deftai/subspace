/**
 * The quirks corpus: real agents' traces (corpus/*.trace.jsonl), replayed to
 * our AcpClient. Each must give the TurnResult it gave live (kept in the
 * trace header's meta.expected). Record more with scripts/record.ts.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { channelPair, type TraceHeader } from '@deft-subspace/kernel';
import { AcpClient, type PermissionPolicy } from '@deft-subspace/acp';
import { normalizeTurn, replayAgent, type NormalizedTurn } from '@deft-subspace/acp-testkit';
import { loadTrace } from '@deft-subspace/acp-testkit/node';

const dir = join(import.meta.dirname, '..', 'corpus');
const files = readdirSync(dir).filter((f) => f.endsWith('.trace.jsonl')).sort();

interface Meta {
  prompt: string;
  permissions: PermissionPolicy;
  cancelAfterMs?: number;
  protocol: 1 | 2;
  expected: NormalizedTurn;
}

/** Replay one corpus trace the way it was recorded: same prompt and policy, cancel after the first message if it was. */
async function replayCorpus(file: string) {
  const records = await loadTrace(join(dir, file));
  const meta = (records[0] as TraceHeader).meta as unknown as Meta;
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const replay = replayAgent(agentEnd, records);
  const client = await AcpClient.connect(clientEnd, { permissions: meta.permissions });
  const session = await client.newSession({ cwd: '/workspace' });
  const turn = session.prompt(meta.prompt);
  for await (const event of turn) {
    if (event.type === 'message' && meta.cancelAfterMs !== undefined) void turn.cancel();
  }
  const result = normalizeTurn(await turn.done);
  await replay.done;
  await client.close();
  return { meta, result, protocol: client.protocol };
}

test('the corpus has the Grok traces', () => {
  for (const name of ['grok-plain', 'grok-write-rejected', 'grok-cancel']) assert.ok(files.includes(`${name}.trace.jsonl`), name);
});

for (const file of files) {
  test(`corpus ${file}: replay gives the recorded TurnResult`, async () => {
    const { meta, result, protocol } = await replayCorpus(file);
    assert.equal(protocol, meta.protocol);
    assert.deepEqual(result, meta.expected);
  });
}

test('quirk: Grok ends a turn whose write was rejected with stopReason "cancelled", though nobody cancelled', async () => {
  const { result } = await replayCorpus('grok-write-rejected.trace.jsonl');
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.cancelled, false, 'not cancelled from this side');
  assert.deepEqual(result.toolCalls.map((c) => [c.kind, c.status]), [['edit', 'failed']]);
});

test('Grok confirms a cancel mid-stream; the turn is not forced', async () => {
  const { result } = await replayCorpus('grok-cancel.trace.jsonl');
  assert.deepEqual([result.stopReason, result.cancelled, result.forced], ['cancelled', true, false]);
  assert.match(result.text, /^1\n2\n3/);
});

test('Grok plain turn: v1, end_turn, the exact text', async () => {
  const { result, protocol } = await replayCorpus('grok-plain.trace.jsonl');
  assert.equal(protocol, 1);
  assert.deepEqual([result.stopReason, result.text], ['end_turn', 'SUBSPACE_OK']);
});
