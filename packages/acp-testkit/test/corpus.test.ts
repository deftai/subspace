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
  mode?: string;
  cancelAfterMs?: number;
  protocol: 1 | 2;
  expected: NormalizedTurn;
}

/** Replay one corpus trace the way it was recorded: same mode, prompt and policy, cancel after the first message if it was. */
async function replayCorpus(file: string) {
  const records = await loadTrace(join(dir, file));
  const meta = (records[0] as TraceHeader).meta as unknown as Meta;
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const replay = replayAgent(agentEnd, records);
  const client = await AcpClient.connect(clientEnd, { permissions: meta.permissions });
  const session = await client.newSession({ cwd: '/workspace' });
  if (meta.mode) await session.setMode(meta.mode);
  const turn = session.prompt(meta.prompt);
  for await (const event of turn) {
    if (event.type === 'message' && meta.cancelAfterMs !== undefined) void turn.cancel();
  }
  const result = normalizeTurn(await turn.done);
  await replay.done;
  await client.close();
  return { meta, result, protocol: client.protocol };
}

test('the corpus has the Grok, Claude and Codex traces', () => {
  for (const agent of ['grok', 'claude', 'codex'])
    for (const name of [`${agent}-plain`, `${agent}-write-rejected`, `${agent}-cancel`]) assert.ok(files.includes(`${name}.trace.jsonl`), name);
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

test('quirk: Codex, too, ends a turn whose write was rejected with stopReason "cancelled", and leaves the tool call pending', async () => {
  const { result } = await replayCorpus('codex-write-rejected.trace.jsonl');
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.cancelled, false, 'not cancelled from this side');
  assert.deepEqual(result.toolCalls.map((c) => [c.kind, c.status]), [['edit', 'pending']]);
});

test('Claude ends a turn whose write was rejected normally, with the tool call failed', async () => {
  const { result, protocol } = await replayCorpus('claude-write-rejected.trace.jsonl');
  assert.equal(protocol, 2);
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.toolCalls.map((c) => [c.kind, c.status]), [['edit', 'failed']]);
});

for (const agent of ['claude', 'codex']) {
  test(`${agent} confirms a cancel mid-stream; the turn is not forced`, async () => {
    const { result } = await replayCorpus(`${agent}-cancel.trace.jsonl`);
    assert.deepEqual([result.stopReason, result.cancelled, result.forced], ['cancelled', true, false]);
  });
}

// The catalog's quirks (packages/acp/src/agents.ts), as the corpus shows them.

/** Every JSON-RPC message in a corpus trace. */
async function messages(file: string): Promise<Array<Record<string, any>>> {
  const records = await loadTrace(join(dir, file));
  return records.flatMap((r: any) => (r.kind === 'message' ? [r.msg] : []));
}

/** The mode a session starts in: the session/new result's mode option. */
async function startingMode(file: string): Promise<string | undefined> {
  for (const msg of await messages(file)) {
    const options = msg.result?.configOptions as Array<Record<string, any>> | undefined;
    const mode = options?.find((o) => o.category === 'mode' || o.id === 'mode');
    if (mode) return mode.currentValue;
  }
  return undefined;
}

test('quirk starts-in-auto-mode: Claude starts a session in auto mode', async () => {
  assert.equal(await startingMode('claude-plain.trace.jsonl'), 'auto');
});

test('quirk starts-in-agent-mode: Codex starts a session in agent mode', async () => {
  assert.equal(await startingMode('codex-plain.trace.jsonl'), 'agent');
});

test('quirk reject-option-named-cancel: Codex offers its reject option as "cancel" (kind reject_once)', async () => {
  const ask = (await messages('codex-write-rejected.trace.jsonl')).find((m) => m.method === 'session/request_permission');
  const reject = ask?.params.options.find((o: any) => o.kind === 'reject_once');
  assert.equal(reject?.optionId, 'cancel');
});

test('quirk account-in-auth-status: the account in _auth/status_update is redacted in the corpus', async () => {
  for (const agent of ['claude', 'codex']) {
    const updates = (await messages(`${agent}-plain.trace.jsonl`)).filter((m) => m.method === '_auth/status_update');
    assert.ok(updates.length, `${agent} sends _auth/status_update`);
    for (const u of updates) for (const value of Object.values(u.params.authStatus.account ?? {})) assert.equal(value, '<redacted>');
  }
});

test('quirk vendor-notifications: Grok sends _x.ai/* notifications, and the replay ignores them', async () => {
  const vendor = (await messages('grok-plain.trace.jsonl')).filter((m) => m.method?.startsWith('_x.ai/') && m.id === undefined);
  assert.ok(vendor.length >= 10, `${vendor.length} _x.ai notifications`);
  const { result } = await replayCorpus('grok-plain.trace.jsonl');
  assert.equal(result.stopReason, 'end_turn');
});
