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

test('linked to a checkout: pnpm instructions, and npm is told it cannot install link: dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-subspace-'));
  let out = '';
  let err = '';
  const io = (agent: string) => ({ out: (t: string) => void (out += t), err: (t: string) => void (err += t), env: { npm_config_user_agent: agent } });
  assert.equal(await main([join(dir, 'a'), '--subspace', repo], io('pnpm/10.0.0 node/v22')), 0);
  assert.match(out, /pnpm install/);
  assert.doesNotMatch(out, /^ {2}npm install/m);
  assert.equal(err, '');
  out = '';
  assert.equal(await main([join(dir, 'b'), '--subspace', repo], io('npm/10.9.0 node/v22')), 0);
  assert.match(out, /pnpm install/);
  assert.match(err, /npm cannot install/);
  // A folder name with a space is quoted in the cd line.
  out = '';
  assert.equal(await main([join(dir, 'd e')], io('npm/10.9.0 node/v22')), 0);
  assert.match(out, /cd '.*d e'/);
});

test('rejects unknown flags, missing values, and a target that is a file; odd names still make a valid package name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-subspace-'));
  const typo = await create('--templat', 'agent', join(dir, 'proj'));
  assert.equal(typo.code, 2);
  assert.match(typo.err, /--templat\b/);
  assert.match(typo.err, /--template/);
  const missing = await create(join(dir, 'proj2'), '-t');
  assert.equal(missing.code, 2);
  assert.match(missing.err, /needs a value/);
  assert.doesNotMatch(missing.err, /undefined/);
  await writeFile(join(dir, 'file'), 'x');
  const file = await create(join(dir, 'file'));
  assert.equal(file.code, 1);
  assert.match(file.err, /not a folder/);
  assert.equal((await create(join(dir, '日本'))).code, 0);
  const name = JSON.parse(await readFile(join(dir, '日本', 'package.json'), 'utf8')).name;
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal((await create(join(dir, 'eq'), '--template=agent')).code, 0);
  assert.equal(JSON.parse(await readFile(join(dir, 'eq', 'package.json'), 'utf8')).scripts.start, 'node src/agent.ts');
});

test('the claude-agent template confines its file tools to the working folder', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'create-subspace-')), 'ca');
  assert.equal((await create(dir, '--template', 'claude-agent')).code, 0);
  const source = await readFile(join(dir, 'src', 'agent.ts'), 'utf8');
  assert.match(source, /inside\(path\)/);
  assert.doesNotMatch(source, /readFile\(path,/);
});
