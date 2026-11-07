/**
 * Install registry binaries (Node only): `subspace agents install <name>`.
 *
 * Safe enough, not more: only on request, never when an agent starts; only
 * archives the registry lists a SHA-256 for, checked while downloading; the
 * archive is unpacked into a fresh folder under the cache and the command must
 * stay inside it. The checksum comes from the same registry as the URL, so it
 * catches a changed or broken download, not a compromised registry.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { registryTarget, type RegistryAgent } from './registry.ts';

const run = promisify(execFile);
const MARKER = '.subspace-install.json';

export class InstallError extends Error {
  override name = 'InstallError';
}

export interface InstallOptions {
  /** Environment to read ($XDG_CACHE_HOME). Default `process.env`. */
  env?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  /** Refuse downloads larger than this. Default 2 GB. */
  maxBytes?: number;
}

export interface Installed {
  id: string;
  version: string;
  /** The folder it was unpacked into. */
  dir: string;
  /** The command, by absolute path. */
  command: string;
  sha256: string;
  /** Already installed with the same checksum: nothing was downloaded. */
  reused: boolean;
}

/** Where installed binaries live: `<cache>/subspace/bin/<id>/<version>`. */
export function binariesPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'subspace', 'bin');
}

/** Installed binaries, `<id>@<version>` -> folder (for `AgentCatalog.binaries`). */
export function installedBinaries(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const root = binariesPath(env);
  const found: Record<string, string> = {};
  if (!existsSync(root)) return found;
  for (const id of readdirSync(root)) {
    if (id.startsWith('.')) continue;
    let versions: string[];
    try {
      versions = readdirSync(join(root, id));
    } catch {
      continue;
    }
    for (const version of versions) {
      const dir = join(root, id, version);
      if (!version.startsWith('.') && existsSync(join(dir, MARKER))) found[`${id}@${version}`] = dir;
    }
  }
  return found;
}

/** A path segment from registry data: no separators, no dot names. */
function segment(value: string, what: string): string {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new InstallError(`the registry's ${what} ${JSON.stringify(value)} is not usable as a folder name`);
  return value;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Download, check and unpack `entry`'s binary for this machine. */
export async function installAgent(entry: RegistryAgent, options: InstallOptions = {}): Promise<Installed> {
  const target = registryTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  const binary = entry.distribution.binary?.[target];
  if (!binary) {
    const has = Object.keys(entry.distribution.binary ?? {});
    throw new InstallError(has.length ? `${entry.id} has no binary for ${target} (it has ${has.join(', ')})` : `${entry.id} is not distributed as a binary`);
  }
  if (!binary.sha256) throw new InstallError(`the registry lists no sha256 for ${entry.id} on ${target}, so Subspace does not install it; install it yourself (${binary.archive})`);
  const url = new URL(binary.archive);
  if (url.protocol !== 'https:') throw new InstallError(`${entry.id}: refusing a download that is not https (${binary.archive})`);

  const root = join(binariesPath(options.env), segment(entry.id, 'id'));
  const dir = join(root, segment(entry.version || 'unversioned', 'version'));
  const command = resolve(dir, binary.cmd);
  if (!inside(dir, command)) throw new InstallError(`${entry.id}: the command ${JSON.stringify(binary.cmd)} is outside its folder`);
  if (existsSync(join(dir, MARKER))) {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { sha256?: string };
    if (marker.sha256 === binary.sha256 && existsSync(command)) return { id: entry.id, version: entry.version, dir, command, sha256: binary.sha256, reused: true };
  }

  await mkdir(root, { recursive: true });
  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const download = join(root, `.download-${tag}`);
  const unpack = join(root, `.unpack-${tag}`);
  try {
    const sha256 = await fetchTo(url, download, options.fetch ?? fetch, options.maxBytes ?? 2 * 1024 ** 3);
    if (sha256 !== binary.sha256) throw new InstallError(`${entry.id}: the download's sha256 is ${sha256}, the registry says ${binary.sha256}; not installed`);

    await mkdir(unpack);
    const name = url.pathname.toLowerCase();
    if (/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar)$/.test(name)) await run('tar', ['-xf', download, '-C', unpack]);
    else if (name.endsWith('.zip')) {
      // bsdtar (macOS, Windows) reads zip files; GNU tar does not.
      if (process.platform === 'linux') await run('unzip', ['-q', download, '-d', unpack]);
      else await run('tar', ['-xf', download, '-C', unpack]);
    } else await copyFile(download, join(unpack, basename(binary.cmd)));

    // The command must exist and stay inside the folder, symlinks included.
    const unpacked = resolve(unpack, binary.cmd);
    if (!existsSync(unpacked)) throw new InstallError(`${entry.id}: the archive has no ${binary.cmd}`);
    const real = await realpath(unpacked);
    if (!inside(await realpath(unpack), real)) throw new InstallError(`${entry.id}: ${binary.cmd} points outside its folder`);
    if (!(await stat(real)).isFile()) throw new InstallError(`${entry.id}: ${binary.cmd} is not a file`);
    if (process.platform !== 'win32') await chmod(real, 0o755);

    await writeFile(join(unpack, MARKER), `${JSON.stringify({ id: entry.id, version: entry.version, target, archive: binary.archive, sha256, installed: new Date().toISOString() }, null, 2)}\n`);
    await rm(dir, { recursive: true, force: true });
    await rename(unpack, dir);
    return { id: entry.id, version: entry.version, dir, command, sha256, reused: false };
  } finally {
    await rm(download, { force: true });
    await rm(unpack, { recursive: true, force: true });
  }
}

/** Stream `url` into `path`, hashing as it goes; the hex SHA-256. */
async function fetchTo(url: URL, path: string, fetchImpl: typeof fetch, maxBytes: number): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new InstallError(`download failed: ${response.status} ${response.statusText} (${url})`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new InstallError(`download is ${length} bytes, over the ${maxBytes} limit (${url})`);
  const hash = createHash('sha256');
  const out = createWriteStream(path);
  let bytes = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new InstallError(`download is over the ${maxBytes} byte limit (${url})`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
  } finally {
    await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
  }
  return hash.digest('hex');
}
