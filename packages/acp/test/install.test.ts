/** Installing registry binaries: checked downloads, unpacked under the cache, used by absolute path. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveAgent, type RegistryAgent } from '@deft-subspace/acp';
import { installAgent, installedBinaries, InstallError, loadCatalog } from '@deft-subspace/acp/node';

const host = { platform: 'darwin', arch: 'arm64' };
const target = 'darwin-aarch64';

/** A folder with an archive built from `files` (path -> content; '->x' makes a symlink to x). */
function archive(kind: 'tar.gz' | 'zip', files: Record<string, string>): { path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), 'subspace-install-'));
  const src = join(dir, 'src');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(src, name, '..'), { recursive: true });
    if (content.startsWith('->')) symlinkSync(content.slice(2), join(src, name));
    else {
      writeFileSync(join(src, name), content);
      chmodSync(join(src, name), 0o755);
    }
  }
  const path = join(dir, `agent.${kind}`);
  if (kind === 'zip') execFileSync('zip', ['-qry', path, '.'], { cwd: src });
  else execFileSync('tar', ['-czf', path, '-C', src, '.']);
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

/** A fetch that serves one file for any URL, and counts calls. */
function serving(path: string) {
  const calls: string[] = [];
  const fake = (async (url: URL | string) => {
    calls.push(String(url));
    return new Response(readFileSync(path));
  }) as typeof fetch;
  return { fetch: fake, calls };
}

function entry(binary: Record<string, unknown>, id = 'tool'): RegistryAgent {
  return { id, name: 'Tool', version: '1.2.3', description: '', distribution: { binary: { [target]: { archive: 'https://example.com/tool.tar.gz', cmd: './bin/tool', ...binary } as never } } };
}

const cache = () => ({ XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), 'subspace-cache-')), XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'subspace-config-')) });

test('install: a checksummed tar.gz is unpacked under the cache, then reused; the catalog runs it by absolute path', async () => {
  const env = cache();
  const a = archive('tar.gz', { 'bin/tool': '#!/bin/sh\necho hi\n' });
  const { fetch, calls } = serving(a.path);
  const agent = entry({ sha256: a.sha256 });
  const first = await installAgent(agent, { env, ...host, fetch });
  assert.equal(first.reused, false);
  assert.equal(first.command, join(env.XDG_CACHE_HOME, 'subspace', 'bin', 'tool', '1.2.3', 'bin', 'tool'));
  assert.equal(execFileSync(first.command, { encoding: 'utf8' }), 'hi\n');
  const again = await installAgent(agent, { env, ...host, fetch });
  assert.equal(again.reused, true);
  assert.equal(calls.length, 1, 'downloaded once');

  assert.deepEqual(installedBinaries(env), { 'tool@1.2.3': first.dir });
  const catalog = loadCatalog({ env, builtinOnly: true });
  catalog.registry = { version: '1', agents: [agent] };
  catalog.binaries = installedBinaries(env);
  const resolved = resolveAgent(catalog, 'tool', host)!;
  assert.equal(resolved.command, first.command);
  assert.match(resolved.install!, /installed by `subspace agents install tool`/);
});

test('install: a zip works too', async () => {
  const env = cache();
  const a = archive('zip', { 'bin/tool': '#!/bin/sh\necho zipped\n' });
  const installed = await installAgent(entry({ archive: 'https://example.com/tool.zip', sha256: a.sha256 }), { env, ...host, fetch: serving(a.path).fetch });
  assert.equal(execFileSync(installed.command, { encoding: 'utf8' }), 'zipped\n');
});

test('install refuses: no checksum, a wrong checksum, plain http, a command outside the folder, a symlink out of it', async () => {
  const env = cache();
  const a = archive('tar.gz', { 'bin/tool': 'x', 'bin/link': '->/etc/hosts' });
  const { fetch, calls } = serving(a.path);
  const refused = async (binary: Record<string, unknown>, message: RegExp) => {
    await assert.rejects(installAgent(entry(binary), { env, ...host, fetch }), (e: Error) => e instanceof InstallError && message.test(e.message));
  };
  await refused({}, /lists no sha256/);
  assert.equal(calls.length, 0, 'nothing downloaded without a checksum');
  await refused({ sha256: '0'.repeat(64) }, /sha256 is [0-9a-f]{64}, the registry says 0{64}; not installed/);
  await refused({ sha256: a.sha256, archive: 'http://example.com/tool.tar.gz' }, /not https/);
  await refused({ sha256: a.sha256, cmd: '../../escape' }, /outside its folder/);
  await refused({ sha256: a.sha256, cmd: './bin/link' }, /points outside its folder/);
  await refused({ sha256: a.sha256, cmd: './bin/missing' }, /has no \.\/bin\/missing/);
  // Nothing was left installed, and no temporary files remain.
  assert.deepEqual(installedBinaries(env), {});
  assert.deepEqual(execFileSync('ls', ['-A', join(env.XDG_CACHE_HOME, 'subspace', 'bin', 'tool')], { encoding: 'utf8' }), '');
});

test('without an install, a checksummed binary suggests `subspace agents install`; one without a checksum says why not', () => {
  const catalog = loadCatalog({ env: cache(), builtinOnly: true });
  catalog.registry = { version: '1', agents: [entry({ sha256: 'a'.repeat(64) }), entry({}, 'plain')] };
  assert.match(resolveAgent(catalog, 'tool', host)!.install!, /^Run `subspace agents install tool`/);
  assert.equal(resolveAgent(catalog, 'tool', host)!.command, 'tool');
  assert.match(resolveAgent(catalog, 'plain', host)!.install!, /lists no checksum for it, so Subspace does not install it/);
});

test('install hints: the registry\'s beats a built-in one when Subspace can install or has installed it; your own beats both', async () => {
  const env = cache();
  const opencode = (binary: Record<string, unknown>, platform = target): RegistryAgent => ({
    id: 'opencode',
    name: 'OpenCode',
    version: '1.0.0',
    description: '',
    distribution: { binary: { [platform]: { archive: 'https://example.com/opencode.tar.gz', cmd: './opencode', ...binary } as never } },
  });
  const hint = (agent: RegistryAgent, extra: Partial<Parameters<typeof resolveAgent>[0]> = {}) => {
    const catalog = { ...loadCatalog({ env, builtinOnly: true }), ...extra };
    catalog.registry = { version: '1', agents: [agent] };
    return resolveAgent(catalog, 'opencode', host)!;
  };
  // Installable: say so, before the built-in "Install OpenCode".
  assert.match(hint(opencode({ sha256: 'a'.repeat(64) })).install!, /^Run `subspace agents install opencode`, or install OpenCode/);
  // No checksum, or no download for this machine: the built-in hint.
  assert.match(hint(opencode({})).install!, /^Install OpenCode \(the `opencode` command\)/);
  assert.match(hint(opencode({ sha256: 'a'.repeat(64) }, 'linux-x86_64')).install!, /^Install OpenCode \(the `opencode` command\)/);
  // Installed: run from the cache, and the hint says how it got there.
  const a = archive('tar.gz', { opencode: '#!/bin/sh\n' });
  const agent = opencode({ sha256: a.sha256 });
  const installed = await installAgent(agent, { env, ...host, fetch: serving(a.path).fetch });
  const resolved = hint(agent, { binaries: installedBinaries(env) });
  assert.equal(resolved.command, installed.command);
  assert.match(resolved.install!, /^It was installed by `subspace agents install opencode` into .*; run that again if it is missing$/);
  // Trailing separators on the folder are trimmed, in linear time (the old regex was quadratic on a long run of them).
  const withDirs = (f: (dir: string) => string) => Object.fromEntries(Object.entries(installedBinaries(env)).map(([key, dir]) => [key, f(dir)]));
  assert.equal(hint(agent, { binaries: withDirs((dir) => `${dir}//`) }).command, installed.command);
  const trimStarted = Date.now();
  hint(agent, { binaries: withDirs((dir) => `${dir}${'/'.repeat(100_000)}x`) });
  assert.ok(Date.now() - trimStarted < 1000);
  // Your own agents file: its hint wins; your own command drops the registry's hint.
  const mine = { source: '/home/me/subspace.toml', agents: { opencode: { install: 'Ask IT for OpenCode' } } };
  const layers = (layer: object) => ({ layers: [...loadCatalog({ env, builtinOnly: true }).layers, layer] as never });
  assert.equal(hint(agent, { binaries: installedBinaries(env), ...layers(mine) }).install, 'Ask IT for OpenCode');
  const ownCommand = hint(opencode({ sha256: 'a'.repeat(64) }), layers({ source: '/home/me/subspace.toml', agents: { opencode: { command: '/opt/opencode' } } }));
  assert.equal(ownCommand.command, '/opt/opencode');
  assert.match(ownCommand.install!, /^Install OpenCode \(the `opencode` command\)/);
});
