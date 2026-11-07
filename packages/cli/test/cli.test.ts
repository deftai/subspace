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
  });
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
