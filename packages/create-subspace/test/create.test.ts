import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { main } from 'create-subspace';

const repo = resolve(import.meta.dirname, '../../..');
async function create(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => void (out += t), err: (t) => void (err += t) });
  return { code, out, err };
}

test('each template writes a project; linked to a checkout, dependencies point at its packages', async () => {
  for (const template of ['script', 'agent', 'claude-agent']) {
    const dir = join(await mkdtemp(join(tmpdir(), 'create-subspace-')), `my-${template}`);
    const made = await create(dir, '--template', template, '--subspace', repo);
    assert.equal(made.code, 0, made.err);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, `my-${template}`);
    assert.match(pkg.dependencies['@deft-subspace/acp'], /^link:.*packages\/acp$/);
    assert.equal(!!pkg.dependencies['@deft-subspace/claude'], template === 'claude-agent');
    const main = template === 'script' ? 'src/index.ts' : 'src/agent.ts';
    assert.equal(pkg.scripts.start, `node ${main}`);
    const source = await readFile(join(dir, main), 'utf8');
    assert.match(source, template === 'script' ? /start\('claude'/ : template === 'agent' ? /serveStdio\(/ : /modelAgent\(/);
    assert.doesNotMatch(source, /__NAME__/);
  }
});

test('refuses a non-empty folder, an unknown template, a missing folder, and a bad checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-subspace-'));
  await writeFile(join(dir, 'x'), 'x');
  assert.equal((await create(dir)).code, 1);
  assert.equal((await create(join(dir, 'new'), '--template', 'nope')).code, 2);
  assert.equal((await create()).code, 2);
  assert.match((await create(join(dir, 'other'), '--subspace', dir)).err, /does not look like a Subspace checkout/);
  // Without a checkout: the published version, and a note that it is not published yet.
  const plain = await create(join(dir, 'plain'));
  assert.match(plain.out, /not on npm yet/);
  assert.equal(JSON.parse(await readFile(join(dir, 'plain', 'package.json'), 'utf8')).dependencies['@deft-subspace/acp'], '0.0.0-experiment');
});
