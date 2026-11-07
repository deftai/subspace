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
  assert.equal(resolved.install, undefined);
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
