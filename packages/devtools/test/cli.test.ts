import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { channelPair, formatTrace, traceTap, type TraceRecord } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type ProtocolVersion } from '@deft-subspace/acp';
import { analyzeTrace } from '@deft-subspace/devtools';
import { main } from '../src/cli.ts';

/** Record a real client/agent conversation: a permission, a tool call, a cancel. */
async function record(protocol: ProtocolVersion): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];
  const [clientEnd, agentEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'rec',
    protocols: [protocol],
    async prompt(turn) {
      await turn.say('Hello ');
      await turn.say('there.');
      const call = await turn.toolCall({ title: 'ls', kind: 'execute' });
      const ok = await turn.requestPermission({ title: 'Run ls?', toolCallId: call.id });
      if (!ok.allowed) return 'end_turn';
      await call.update({ status: 'in_progress' });
      while (!turn.signal.aborted && turn.text === 'wait') await new Promise((r) => setTimeout(r, 5));
      if (turn.signal.aborted) return 'cancelled';
      await call.complete();
      return 'end_turn';
    },
  });
  const tap = traceTap((r) => records.push(r), { peer: 'client', label: `rec v${protocol}` });
  const client = await AcpClient.connect(clientEnd, { protocol, permissions: 'allow', tap });
  const session = await client.newSession({ cwd: '/tmp' });
  await session.prompt('go').done;
  const second = session.prompt('wait');
  setTimeout(() => void second.cancel(), 30);
  await second.done;
  await client.close();
  return records;
}

for (const protocol of [1, 2] as const) {
  test(`a real v${protocol} conversation analyzes cleanly`, async () => {
    const a = analyzeTrace(await record(protocol));
    assert.equal(a.protocol, protocol);
    assert.deepEqual(a.diagnostics.filter((d) => d.level !== 'info'), []);
    assert.deepEqual(a.turns.map((t) => [t.prompt, t.status, t.toolCalls.length, t.permissions.length]), [
      ['go', 'ended', 1, 1],
      ['wait', 'cancelled', 1, 1],
    ]);
    assert.equal(a.turns[0]!.text, 'Hello there.');
    assert.deepEqual(a.toolCalls.map((c) => c.history.map((h) => h.status)), [['pending', 'in_progress', 'completed'], ['pending', 'in_progress', 'failed']]);
    assert.deepEqual(a.permissions.map((p) => p.result), ['allowed', 'allowed']);
    assert.equal(a.cancels[0]!.kind, 'session');
    assert.ok(a.cancels[0]!.confirmedAfter! >= 0);
    assert.ok(a.requests.every((r) => r.outcome === 'result'));
  });
}

test('the CLI writes the HTML and prints its path, or prints a summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devtools-'));
  try {
    const input = join(dir, 'run.trace.jsonl');
    await writeFile(input, formatTrace(await record(2)));
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };

    assert.equal(await main([input], io), 0);
    assert.equal(out.join(''), `${join(dir, 'run.trace.html')}\n`);
    assert.match(await readFile(join(dir, 'run.trace.html'), 'utf8'), /^<!doctype html>[\s\S]*rec v2/);

    out.length = 0;
    assert.equal(await main([input, '-o', join(dir, 'x.html')], io), 0);
    assert.equal(out.join(''), `${join(dir, 'x.html')}\n`);

    out.length = 0;
    assert.equal(await main(['--summary', input], io), 0);
    assert.match(out.join(''), /rec v2: rec 0\.0\.0, protocol v2[\s\S]*2 turns[\s\S]*"wait"\s+cancelled/);

    assert.equal(await main([], io), 2);
    assert.equal(await main([input, '--bogus'], io), 2);
    assert.equal(await main([join(dir, 'missing.jsonl')], io), 1);
    assert.match(err.join(''), /Usage[\s\S]*Unknown option --bogus[\s\S]*Cannot read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
