/** text(), stream(), json(), file() and image(), and signal / timeoutMs on prompts. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { channelPair } from '@deft-subspace/kernel';
import { connectSession, findJson, JsonAnswerError, serveAgent, type AgentTurn } from '@deft-subspace/acp';
import { file } from '@deft-subspace/acp/node';

/** An agent whose reply to each prompt comes from `reply` (given the turn). */
function agentReplying(reply: (turn: AgentTurn, n: number) => Promise<void> | void, capabilities: Record<string, unknown> = {}) {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  let n = 0;
  serveAgent(agentEnd, { name: 'replier', capabilities, prompt: async (turn) => void (await reply(turn, n++)) });
  return clientEnd;
}

test('text() and stream(); stopping a stream early cancels the turn', async () => {
  let cancelled = false;
  const s = await connectSession(
    agentReplying(async (turn) => {
      await turn.say('One.');
      await turn.tool('step', () => 'x');
      await turn.say('Two.');
      if (turn.text === 'long') {
        for (let i = 0; i < 100 && !turn.signal.aborted; i++) {
          await turn.say(` ${i}`);
          await new Promise((r) => setTimeout(r, 5));
        }
        cancelled = turn.signal.aborted;
      }
    }),
    { cwd: '/w', permissions: 'reject' }
  );
  assert.equal(await s.text('hi'), 'One.\n\nTwo.');
  let streamed = '';
  for await (const chunk of s.stream('hi')) streamed += chunk;
  assert.equal(streamed, 'One.\n\nTwo.');
  for await (const chunk of s.stream('long')) if (chunk.includes('3')) break;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cancelled, true);
  await s.close();
});

test('json(): finds JSON in a fence, checks it with a Standard Schema, asks again once when it does not fit', async () => {
  const prompts: string[] = [];
  const s = await connectSession(
    agentReplying(async (turn, n) => {
      prompts.push(turn.text);
      if (n === 0) await turn.say('Here you go:\n```json\n{"files": ["a.ts", "b.ts"]}\n```');
      else if (n === 1) await turn.say('{"files": "a.ts"}'); // wrong shape
      else if (n === 2) await turn.say('Sorry: {"files": ["a.ts"], "note": "fixed {braces} in \\"strings\\""} done');
      else await turn.say('no json here');
    }),
    { cwd: '/w', permissions: 'reject' }
  );
  const schema = z.object({ files: z.array(z.string()) });
  assert.deepEqual(await s.json('Which files?', { schema, shape: { files: ['path'] } }), { files: ['a.ts', 'b.ts'] });
  assert.match(prompts[0]!, /Reply with only the JSON value/);
  assert.match(prompts[0]!, /"files"/);
  const fixed = await s.json('Again', { schema });
  assert.deepEqual(fixed, { files: ['a.ts'] });
  assert.match(prompts[2]!, /That answer was not right: files: /);
  await assert.rejects(s.json('No', { retries: 0 }), (e: unknown) => e instanceof JsonAnswerError && /no JSON value/.test(e.message));
  assert.deepEqual(findJson('Answer: [1, 2] and more'), [1, 2]);
  await s.close();
});

test('prompt signal and timeoutMs cancel the turn', async () => {
  const s = await connectSession(
    agentReplying(async (turn) => {
      while (!turn.signal.aborted) await new Promise((r) => setTimeout(r, 5));
    }),
    { cwd: '/w', permissions: 'reject' }
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  assert.equal((await s.run('wait', { signal: controller.signal })).stopReason, 'cancelled');
  const timed = await s.run('wait', { timeoutMs: 20 });
  assert.equal(timed.stopReason, 'cancelled');
  assert.equal(timed.exhausted?.limit, 'duration');
  await s.close();
});

test('file(): embedded where the agent takes it, text where it does not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subspace-file-'));
  const path = join(dir, 'notes.md');
  await writeFile(path, '# Notes\nhi');
  for (const embedded of [true, false]) {
    let received: unknown;
    const s = await connectSession(
      agentReplying((turn) => void (received = turn.prompt), { promptCapabilities: { embeddedContext: embedded } }),
      { cwd: dir, permissions: 'reject', protocol: 1 }
    );
    await s.run(['Summarize', file(path)]);
    assert.deepEqual((received as Array<Record<string, unknown>>)[0], { type: 'text', text: 'Summarize' }); // a string in the list is a text block
    const block = (received as Array<Record<string, unknown>>)[1]!;
    if (embedded) assert.deepEqual(block, { type: 'resource', resource: { uri: `file://${path}`, mimeType: 'text/markdown', text: '# Notes\nhi' } });
    else assert.deepEqual(block, { type: 'text', text: `${path}:\n\n\`\`\`\n# Notes\nhi\n\`\`\`` });
    await s.close();
  }
});
