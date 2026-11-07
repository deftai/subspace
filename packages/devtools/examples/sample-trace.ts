/**
 * Record a realistic ACP trace in-process and open it in the viewer.
 *
 *   node --conditions=source packages/devtools/examples/sample-trace.ts
 *
 * An agent and a client (both @deft-subspace/acp) talk over a channel pair,
 * once on protocol v1 and once on v2, with streaming, a plan, tool calls,
 * permissions (allowed, rejected, and cut off by a cancel), a cancelled
 * turn and two error answers. The client's traffic is recorded with
 * traceTap. Writes, under packages/devtools/samples/ (gitignored):
 *
 *   sample-v1.trace.jsonl  sample-v1.html
 *   sample-v2.trace.jsonl  sample-v2.html
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelPair, formatTrace, traceTap, type Channel, type TraceRecord } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type PermissionHandler, type ProtocolVersion } from '@deft-subspace/acp';
import { analyzeTrace, formatSummary, renderTraceHtml } from '@deft-subspace/devtools';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const words = (text: string) => text.split(/(?<= )/);

function startAgent(channel: Channel<unknown>, protocol: ProtocolVersion) {
  serveAgent(channel, {
    name: 'sample-agent',
    version: '0.3.1',
    protocols: [protocol],
    async prompt(turn) {
      if (turn.text.startsWith('Fix')) {
        for (const w of words('The user wants the failing test fixed. First read the test, then run the suite to see the failure.')) {
          await turn.think(w);
          await sleep(1);
        }
        await turn.plan([
          { content: 'Read the failing test', status: 'in_progress' },
          { content: 'Run the test suite' },
          { content: 'Fix the bug and re-run' },
        ]);
        const read = await turn.toolCall({ title: 'Read test/math.test.ts', kind: 'read', locations: [{ path: 'test/math.test.ts' }] });
        await sleep(8);
        await read.complete({ content: [{ type: 'content', content: { type: 'text', text: "assert.equal(add(0.1, 0.2), 0.3) // fails: 0.30000000000000004" } }] });
        for (const w of words('The test compares floats with `equal`. I will run the suite to confirm before changing anything.\n')) {
          await turn.say(w);
          await sleep(1);
        }
        const run = await turn.toolCall({ title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } });
        const ok = await turn.requestPermission({ title: 'Run `npm test`?', toolCallId: run.id });
        if (!ok.allowed) {
          await run.fail();
          return 'end_turn';
        }
        await run.update({ status: 'in_progress' });
        for (let i = 1; i <= 4; i++) {
          await sleep(12);
          await run.update({ content: [{ type: 'content', content: { type: 'text', text: `${i * 7} tests passed, 1 failed` } }] });
        }
        await run.fail({ rawOutput: { exitCode: 1 } });
        const edit = await turn.toolCall({
          title: 'Edit test/math.test.ts',
          kind: 'edit',
          content: [{ type: 'diff', path: 'test/math.test.ts', oldText: 'assert.equal(add(0.1, 0.2), 0.3)', newText: 'assert.ok(Math.abs(add(0.1, 0.2) - 0.3) < 1e-9)' }],
        });
        const write = await turn.requestPermission({ title: 'Edit test/math.test.ts?', toolCallId: edit.id });
        if (write.allowed) await edit.complete();
        else await edit.fail();
        for (const w of words('I changed the assertion to compare within a tolerance. ')) {
          await turn.say(w);
          await sleep(1);
        }
        await turn.say('All 29 tests pass now.');
        return 'end_turn';
      }

      if (turn.text.startsWith('Delete')) {
        await turn.say('That removes the build output.');
        const rm = await turn.toolCall({ title: 'rm -rf dist', kind: 'delete', rawInput: { command: 'rm -rf dist' } });
        const answer = await turn.requestPermission({ title: 'Delete dist/?', toolCallId: rm.id });
        if (!answer.allowed) {
          await rm.fail();
          await turn.say(' OK, I left it alone.');
          return 'end_turn';
        }
        await rm.complete();
        return 'end_turn';
      }

      if (turn.text.startsWith('Rewrite')) {
        // The client cancels while this question is open: the agent's request is cancelled too.
        await turn.say('This touches every file.');
        const big = await turn.toolCall({ title: 'Rewrite 214 files', kind: 'edit' });
        await turn.requestPermission({ title: 'Rewrite 214 files?', toolCallId: big.id });
        return turn.signal.aborted ? 'cancelled' : 'end_turn';
      }

      // Anything else: count slowly until cancelled.
      const count = await turn.toolCall({ title: 'count', kind: 'other', status: 'in_progress' });
      for (let i = 1; i <= 1000; i++) {
        if (turn.signal.aborted) return 'cancelled';
        await turn.say(`${i} `);
        await sleep(2);
      }
      await count.complete();
      return 'end_turn';
    },
  });
}

/** The "user": allows tests and edits, refuses deletes, and never answers the rewrite. */
const user: PermissionHandler = async (request, signal) => {
  // v1 requests carry only the tool call, so look at its title too.
  const about = `${request.title} ${request.toolCall?.title ?? ''}`;
  await sleep(/Edit/.test(about) ? 40 : 15);
  if (/Delete|rm -rf/.test(about)) return 'reject';
  if (/Rewrite/.test(about)) {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return 'cancelled';
  }
  return 'allow';
};

async function record(protocol: ProtocolVersion): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];
  const tap = traceTap((r) => records.push(r), { peer: 'client', label: `Sample session (ACP v${protocol})`, meta: { example: 'sample-trace.ts' } });
  const [clientEnd, agentEnd] = channelPair<unknown>();
  startAgent(agentEnd, protocol);
  const client = await AcpClient.connect(clientEnd, { name: 'sample-client', version: '1.0.0', protocol, permissions: user, tap });
  const session = await client.newSession({ cwd: '/home/dev/calc' });

  await session.prompt('Fix the failing math test').done;
  tap.note('The user asks for a delete, which will be refused');
  await session.prompt('Delete the build directory').done;

  const rewrite = session.prompt('Rewrite the project in Rust');
  setTimeout(() => void rewrite.cancel(), 60);
  await rewrite.done;

  const counting = session.prompt('Count to 1000');
  setTimeout(() => void counting.cancel(), 120);
  await counting.done;

  // Two errors: a session that does not exist, and a method the agent does not have.
  await client.peer.request('session/prompt', { sessionId: 'no-such-session', prompt: [{ type: 'text', text: 'Hello?' }] }).catch(() => {});
  await client.peer.request('session/set_model', { sessionId: session.id, modelId: 'fast' }).catch(() => {});
  await client.close();
  return records;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'samples');
await mkdir(outDir, { recursive: true });
for (const protocol of [1, 2] as const) {
  const records = await record(protocol);
  const base = join(outDir, `sample-v${protocol}`);
  await writeFile(`${base}.trace.jsonl`, formatTrace(records));
  await writeFile(`${base}.html`, renderTraceHtml(records));
  process.stdout.write(`\n${formatSummary(analyzeTrace(records))}${base}.html\n`);
}
