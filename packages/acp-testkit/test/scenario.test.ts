/** The scenario runner: expectations, workspaces, permissions, snapshots, bundles, reports and waivers. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyWaivers, formatReport } from '@deft-subspace/acp-testkit';
import { defineScenario, formatJUnit, formatScenarios, loadScenarios, runScenario, type Scenario } from '@deft-subspace/acp-testkit/node';

const here = fileURLToPath(new URL('.', import.meta.url));
const agent = { command: process.execPath, args: ['--conditions=subspace-source', join(here, 'fixtures/writer-agent.ts')] };

test('a passing scenario: workspace copied from a fixture, files, tool calls, permissions and text checked', async () => {
  const report = await runScenario(
    defineScenario({
      name: 'writes a file',
      agent,
      workspace: { from: 'fixtures/greeting' },
      permissions: 'allow',
      turns: [
        { prompt: 'hi', expect: { end: 'completed', text: { contains: 'Hello', notContains: 'Wrote' }, toolCalls: { max: 0 } } },
        {
          prompt: 'write hello.txt hi there',
          expect: {
            text: { matches: '^Wrote hello\\.txt' },
            toolCalls: { min: 1, titles: ['Write hello'], kinds: ['edit'], allCompleted: true },
            permissions: { min: 1, titles: ['Write hello.txt'] },
            files: { 'hello.txt': { equals: 'hi there' }, 'existing.txt': { contains: 'seed' }, 'nope.txt': { exists: false } },
          },
        },
      ],
    }),
    { baseDir: here }
  );
  assert.equal(report.pass, true, formatScenarios([report]));
  assert.equal(report.bundle, undefined);
  assert.equal(report.turns[1]!.permissions.length, 1);
});

test('a failing scenario lists what failed and leaves a bundle (trace, report, files); refusals keep files unwritten', async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'scenario-artifacts-'));
  const report = await runScenario(
    { name: 'refused write', agent, permissions: 'reject', turns: [{ prompt: 'write a.txt x', expect: { files: { 'a.txt': { exists: true } }, toolCalls: { allCompleted: true }, end: 'completed' } }] },
    { artifacts }
  );
  assert.equal(report.pass, false);
  assert.deepEqual(report.turns[0]!.failures, ['tool call "Write a.txt" ended failed', 'a.txt does not exist']);
  const bundle = report.bundle!;
  assert.match(await readFile(join(bundle, 'trace.jsonl'), 'utf8'), /session\/request_permission/);
  assert.equal(JSON.parse(await readFile(join(bundle, 'report.json'), 'utf8')).name, 'refused write');
  // A scenario whose agent cannot start is a failure with the reason, not a throw.
  const missing = await runScenario({ name: 'no agent', agent: { command: '/no/such/agent' }, turns: [{ prompt: 'hi' }] }, { artifacts });
  assert.equal(missing.pass, false);
  assert.match(missing.error ?? '', /no\/such\/agent/);
});

test('a scenario with no turns fails: it would check nothing', async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'scenario-artifacts-'));
  const report = await runScenario({ name: 'empty', agent, turns: [] }, { artifacts });
  assert.equal(report.pass, false);
  assert.match(report.error ?? '', /no turns/);
});

test('snapshots: written once, matched after, a change differs until accepted with updateSnapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scenario-snapshots-'));
  const scenario = (prompt: string): Scenario => ({ name: 'greets', agent, snapshot: 'greets.snapshot.json', turns: [{ prompt }] });
  assert.equal((await runScenario(scenario('hi'), { baseDir: dir, requireSnapshots: false })).snapshot, 'written');
  assert.equal((await runScenario(scenario('hi'), { baseDir: dir })).snapshot, 'matched');
  const changed = await runScenario(scenario('hello'), { baseDir: dir, artifacts: dir });
  assert.equal(changed.snapshot, 'differed');
  assert.equal(changed.pass, false);
  assert.match(changed.turns[0]!.failures[0]!, /differs from the snapshot/);
  assert.equal((await runScenario(scenario('hello'), { baseDir: dir, updateSnapshots: true })).snapshot, 'written');
  assert.equal((await runScenario(scenario('hello'), { baseDir: dir })).snapshot, 'matched');
});

test('snapshots: a differing turn fails in every report, and so does a different number of turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scenario-snapshot-reports-'));
  const scenario = (...prompts: string[]): Scenario => ({ name: 'greets', agent, snapshot: 'greets.snapshot.json', turns: prompts.map((prompt) => ({ prompt })) });
  assert.equal((await runScenario(scenario('hi', 'hi'), { baseDir: dir, requireSnapshots: false })).snapshot, 'written');
  const changed = await runScenario(scenario('hello', 'hi'), { baseDir: dir, artifacts: dir });
  assert.deepEqual(changed.turns.map((t) => t.pass), [false, true]);
  assert.match(formatScenarios([changed]), /no {2}1\./);
  assert.match(formatJUnit([changed]), /failures="1"/);
  const shorter = await runScenario(scenario('hi'), { baseDir: dir, artifacts: dir });
  assert.equal(shorter.pass, false);
  assert.deepEqual(shorter.turns.map((t) => t.pass), [true]);
  assert.match(formatScenarios([shorter]), /snapshot: 1 turns, the snapshot has 2/);
  const junit = formatJUnit([shorter]);
  assert.match(junit, /failures="1"/);
  assert.match(junit, /name="snapshot"><failure message="1 turns, the snapshot has 2/);
});

test("a named agent is looked up in the scenario's project, not the temporary workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scenario-catalog-'));
  const toml = (s: string) => JSON.stringify(s);
  await writeFile(
    join(dir, 'subspace.toml'),
    `[agents.local-writer]\ncommand = ${toml(agent.command)}\nargs = [${agent.args.map(toml).join(', ')}]\n`
  );
  const report = await runScenario({ name: 'local', agent: 'local-writer' as never, turns: [{ prompt: 'hi' }] }, { baseDir: dir, artifacts: dir });
  assert.equal(report.error, undefined);
  assert.equal(report.pass, true);
});

test('loadScenarios reads JSON files; text and JUnit reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scenario-files-'));
  const file = join(dir, 'suite.json');
  await writeFile(file, JSON.stringify({ scenarios: [{ name: 'one', agent, turns: [{ prompt: 'hi', expect: { text: { contains: 'Nope' } } }] }] }));
  const [scenario] = await loadScenarios(file);
  const report = await runScenario(scenario!, { artifacts: dir });
  const text = formatScenarios([report]);
  assert.match(text, /FAIL  one/);
  assert.match(text, /- text does not contain "Nope"/);
  assert.match(text, /1 of 1 scenarios failed/);
  const junit = formatJUnit([report]);
  assert.match(junit, /<testsuite name="one" tests="1" failures="1"/);
  assert.match(junit, /<failure message="text does not contain &quot;Nope&quot;">/);
  await writeFile(join(dir, 'bad.json'), '{"nothing": true}');
  await assert.rejects(loadScenarios(join(dir, 'bad.json')), /not a scenario file/);
});

test('waivers turn a known failure into WAIVE; a waiver for a passing check is dropped', () => {
  const report = applyWaivers(
    [
      { id: 'session.unknown', title: 'unknown session', pass: false, detail: 'error -32602' },
      { id: 'prompt.ends', title: 'a prompt ends', pass: true, detail: '' },
    ],
    { 'session.unknown': 'answers -32602', 'prompt.ends': 'never needed' }
  );
  assert.equal(report[0]!.pass, true);
  assert.equal(report[0]!.waived, 'answers -32602');
  assert.equal(report[1]!.waived, undefined);
  assert.match(formatReport(report), /^WAIVE session\.unknown .*\[waived: answers -32602\]/m);
});

test('./ agent paths are relative to the scenario file; sameAs compares two workspace files', async () => {
  const report = await runScenario(
    {
      name: 'relative agent',
      agent: { command: process.execPath, args: ['--conditions=subspace-source', './fixtures/writer-agent.ts'] },
      workspace: { from: 'fixtures/greeting' },
      permissions: 'allow',
      turns: [
        { prompt: 'write a.txt same words' },
        { prompt: 'write b.txt same words', expect: { files: { 'b.txt': { sameAs: 'a.txt' } } } },
        { prompt: 'write c.txt other words', expect: { files: { 'c.txt': { sameAs: 'a.txt' } } } },
      ],
    },
    { baseDir: here, artifacts: await mkdtemp(join(tmpdir(), 'scenario-same-')) }
  );
  assert.equal(report.turns[1]!.pass, true, formatScenarios([report]));
  assert.deepEqual(report.turns[2]!.failures, ['c.txt differs from a.txt']);
});

test('snapshots: an unreadable snapshot fails and is kept; in CI mode a missing one fails instead of being written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scenario-snapshot-strict-'));
  const scenario: Scenario = { name: 'greets', agent, snapshot: 'greets.snapshot.json', turns: [{ prompt: 'hi' }] };
  await writeFile(join(dir, 'greets.snapshot.json'), '[{"end": "completed", <<<<<<< merge conflict');
  const broken = await runScenario(scenario, { baseDir: dir, artifacts: dir });
  assert.equal(broken.pass, false);
  assert.equal(broken.snapshot, 'unreadable');
  assert.match(await readFile(join(dir, 'greets.snapshot.json'), 'utf8'), /merge conflict/);
  assert.match(formatScenarios([broken]), /snapshot: .*greets\.snapshot\.json/);
  // updateSnapshots still replaces it.
  assert.equal((await runScenario(scenario, { baseDir: dir, updateSnapshots: true })).snapshot, 'written');

  const missing = await runScenario({ ...scenario, snapshot: 'new.snapshot.json' }, { baseDir: dir, artifacts: dir, requireSnapshots: true });
  assert.equal(missing.pass, false);
  assert.equal(missing.snapshot, 'missing');
  assert.equal(existsSync(join(dir, 'new.snapshot.json')), false);
  assert.match(formatJUnit([missing]), /name="snapshot"><failure/);
  // The CI environment variable turns it on by default.
  const saved = process.env.CI;
  process.env.CI = 'true';
  try {
    assert.equal((await runScenario({ ...scenario, snapshot: 'other.snapshot.json' }, { baseDir: dir, artifacts: dir })).snapshot, 'missing');
  } finally {
    if (saved === undefined) delete process.env.CI;
    else process.env.CI = saved;
  }
});

test('a passing scenario removes its workspace and trace; bundles are unique and stay inside the artifacts folder', async () => {
  const passed = await runScenario({ name: 'quiet', agent, turns: [{ prompt: 'hi' }] });
  assert.equal(passed.pass, true);
  assert.equal(existsSync(passed.workspace), false);
  assert.equal(existsSync(dirname(passed.trace)), false);
  const kept = await runScenario({ name: 'kept', agent, turns: [{ prompt: 'hi' }] }, { keep: true });
  assert.equal(existsSync(kept.workspace), true);

  const artifacts = await mkdtemp(join(tmpdir(), 'scenario-bundles-'));
  const failing = (name: string): Scenario => ({ name, agent, turns: [{ prompt: 'hi', expect: { text: { contains: 'Nope' } } }] });
  const a = await runScenario(failing('..'), { artifacts });
  const b = await runScenario(failing('..'), { artifacts });
  assert.equal(dirname(a.bundle!), artifacts);
  assert.notEqual(a.bundle, b.bundle);
  assert.equal((await readdir(artifacts)).length, 2);
  assert.ok((await stat(join(a.bundle!, 'report.json'))).isFile());
  assert.doesNotMatch(basename(a.bundle!), /^\./);
  // A failed run keeps its workspace for the bundle.
  assert.equal(existsSync(a.workspace), true);
});

test('JUnit drops characters XML cannot carry', () => {
  const outcome = { end: 'completed' as const, stopReason: 'end_turn', text: '', toolCalls: [] };
  const turn = { prompt: 'a\u0001b', pass: false, failures: ['bad \u001b[31mred\u0000'], outcome, updates: 0, permissions: [], durationMs: 1 };
  const junit = formatJUnit([{ name: 'ctl', pass: false, turns: [turn], workspace: '', trace: '', durationMs: 1 }]);
  assert.doesNotMatch(junit, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  assert.match(junit, /name="1\. ab"/);
});

test('loadScenarios imports a module by file URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scenario module #1 '));
  await writeFile(join(dir, 'suite.mjs'), `export default { name: 'm', agent: 'claude', turns: [{ prompt: 'hi' }] };`);
  const [scenario] = await loadScenarios(join(dir, 'suite.mjs'));
  assert.equal(scenario!.name, 'm');
});
