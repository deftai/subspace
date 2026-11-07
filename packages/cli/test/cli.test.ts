/** The subspace command, driven through main() against a small agent. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, parse } from '@deft-subspace/cli';

const agent = ['--', process.execPath, '--conditions=source', fileURLToPath(new URL('./fixtures/tidy-agent.ts', import.meta.url))];

async function cli(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => void (out += t), err: (t) => void (err += t) });
  return { code, out, err };
}

test('parse: command, positional, valued and boolean flags, and the agent after --', () => {
  assert.deepEqual(parse(['run', 'claude', 'fix', 'it', '--mode', 'plan', '--yes']), {
    command: 'run',
    positional: ['claude', 'fix', 'it'],
    flags: { mode: 'plan', yes: true },
    lists: {},
  });
  assert.deepEqual(parse(['run', '--prompt', 'a', '--prompt', 'b', '--env', 'X=1']).lists, { prompt: ['a', 'b'], env: ['X=1'] });
  assert.deepEqual(parse(['run', 'hi', '--', 'node', 'a.js', '--x']).custom, { command: 'node', args: ['a.js', '--x'] });
});

test('run: renders the turn; --yes allows, --read-only and the default (no terminal) refuse the delete', async () => {
  const allowed = await cli('run', 'tidy up', '--yes', '--quiet', ...agent);
  assert.equal(allowed.code, 0, allowed.err);
  assert.equal(allowed.out, 'Found 2 logs.\n\n? Delete 2 log files allowed\n\nDeleted them.\n');

  const readOnly = await cli('run', 'tidy up', '--read-only', '--quiet', ...agent);
  assert.match(readOnly.out, /\? Delete 2 log files refused/);
  assert.doesNotMatch(readOnly.out, /Deleted them/);

  // Default: reads allowed without asking; the rest asked in the terminal, and with none, refused.
  const asked = await cli('run', 'tidy up', ...agent);
  assert.match(asked.out, /• List files/);
  assert.match(asked.out, /✓ List files/);
  assert.match(asked.out, /\? Delete 2 log files refused/);
});

test('run --json prints the result; --trace then trace --summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subspace-cli-'));
  const trace = join(dir, 'run.jsonl');
  const json = await cli('run', 'tidy up', '--yes', '--json', '--trace', trace, ...agent);
  assert.equal(json.code, 0, json.err);
  const result = JSON.parse(json.out);
  assert.equal(result.end, 'completed');
  assert.equal(result.text, 'Found 2 logs.\n\nDeleted them.');
  const summary = await cli('trace', trace, '--summary');
  assert.equal(summary.code, 0, summary.err);
  assert.match(summary.out, /1 turns/);
  assert.match(summary.out, /"tidy up"  end_turn/);
});

test('check runs the conformance checks; agents lists presets; usage errors exit 2', async () => {
  const check = await cli('check', '--only', 'initialize.version,session.new,session.unknown', ...agent);
  assert.equal(check.code, 0, check.out + check.err);
  assert.match(check.out, /PASS\s+initialize\.version/);

  const agents = await cli('agents');
  for (const name of ['claude', 'codex', 'grok', 'gemini', 'opencode']) assert.match(agents.out, new RegExp(` ${name} `));

  assert.equal((await cli('run')).code, 2);
  assert.match((await cli('run', 'nobody', 'hi')).err, /Unknown agent "nobody"/);
  assert.equal((await cli('frobnicate')).code, 2);
  assert.equal((await cli()).code, 2);
});

test('test runs scenario files: text report, JUnit, exit code', async () => {
  const { mkdtemp: mk, writeFile: wf, readFile: rf } = await import('node:fs/promises');
  const dir = await mk(join(tmpdir(), 'subspace-cli-test-'));
  const [, command, ...args] = agent;
  await wf(
    join(dir, 'tidy.scenario.json'),
    JSON.stringify({
      scenarios: [
        { name: 'tidy allowed', agent: { command, args }, permissions: 'allow', turns: [{ prompt: 'tidy', expect: { text: { contains: 'Deleted them' }, toolCalls: { min: 2, allCompleted: true } } }] },
        { name: 'tidy refused', agent: { command, args }, permissions: 'read-only', turns: [{ prompt: 'tidy', expect: { text: { contains: 'Deleted them' } } }] },
      ],
    })
  );
  const junit = join(dir, 'junit.xml');
  const run = await cli('test', join(dir, 'tidy.scenario.json'), '--junit', junit, '--artifacts', join(dir, 'artifacts'));
  assert.equal(run.code, 1);
  assert.match(run.out, /PASS  tidy allowed/);
  assert.match(run.out, /FAIL  tidy refused/);
  assert.match(run.out, /1 of 2 scenarios failed/);
  assert.match(await rf(junit, 'utf8'), /<testsuite name="tidy refused" tests="1" failures="1"/);
});

test('run: several prompts in one session, inline expectations (exit 4), --raw, --env', async () => {
  const { mkdtemp: mk, writeFile: wf } = await import('node:fs/promises');
  const dir = await mk(join(tmpdir(), 'subspace-cli-run-'));
  const prompts = join(dir, 'prompts.txt');
  await wf(prompts, '# a comment\nenv GREETING\n\ntidy up\n');

  const json = await cli('run', '--prompts-file', prompts, '--env', 'GREETING=hello', '--yes', '--json', ...agent);
  assert.equal(json.code, 0, json.err);
  const turns = JSON.parse(json.out);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'GREETING=hello');
  assert.equal(turns[1].end, 'completed');

  const ok = await cli('run', 'tidy up', '--yes', '--quiet', '--expect-contains', 'Deleted them', '--expect-end', 'completed', ...agent);
  assert.equal(ok.code, 0, ok.err);
  const no = await cli('run', '--prompt', 'tidy up', '--prompt', 'env X', '--read-only', '--quiet', '--expect-contains', 'Deleted them', '--expect-not-contains', 'logs', ...agent);
  assert.equal(no.code, 4);
  assert.match(no.err, /expectation failed: the text does not contain "Deleted them"/);
  assert.match(no.err, /expectation failed: the text contains "logs"/);

  const raw = await cli('run', 'env X', '--raw', '--quiet', ...agent);
  assert.match(raw.err, /^-> \{"jsonrpc":"2.0","id":0,"method":"initialize"/m);
  assert.match(raw.err, /^<- \{"jsonrpc":"2.0","method":"session\/update"/m);
  assert.equal((await cli('run', 'x', '--env', 'NOEQUALS', ...agent)).code, 2);
});
