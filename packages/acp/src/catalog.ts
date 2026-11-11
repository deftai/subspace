/**
 * Agent files and the registry cache (Node).
 *
 * Layers, lowest first: the ACP registry (the bundled snapshot, or a newer
 * cached copy from `refreshRegistry()`), the built-in agents, then
 *   - $XDG_CONFIG_HOME/subspace/agents.toml (default ~/.config/subspace/agents.toml),
 *   - the nearest subspace.toml, from cwd up, if its folder is trusted,
 *   - each file in $SUBSPACE_AGENTS (path-separated) and `files`.
 *
 *   [agents.claude]                # change one field of a built-in agent
 *   extra_args = ["--verbose"]
 *
 *   [agents.mine]                  # a new agent
 *   command = "node"
 *   args = ["/path/to/agent.js"]
 *   mode = "ask"
 *
 *   [agents.mine.quirks.slow-start]
 *   summary = "Takes 20 s to answer initialize"
 *   fix = "Nothing to do; just wait"
 *
 * A project's subspace.toml can choose the commands agents run, so it is only
 * read when your own agents.toml trusts its folder (that folder only, not the
 * ones below it; ~/ and symlinks are resolved):
 *
 *   [trust]
 *   folders = ["~/work/my-project"]
 *
 * An untrusted one is skipped with a warning (see `onWarning`).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { builtinCatalog, type AgentCatalog, type AgentDefinition, type CatalogLayer, type Quirk } from './agents.ts';
import { installedBinaries, installedBinariesAsync } from './install.ts';
import { REGISTRY_URL, trimRegistry, type Registry } from './registry.ts';
import { REGISTRY_SNAPSHOT, REGISTRY_SNAPSHOT_DATE } from './registry-snapshot.ts';

export class AgentFileError extends Error {
  override name = 'AgentFileError';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** TOML keys in snake_case or camelCase. */
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function check(source: string, path: string, value: unknown, want: 'string' | 'strings' | 'env' | 'mode' | 'boolean'): unknown {
  const fail = (what: string) => {
    throw new AgentFileError(`${source}: ${path} should be ${what}, not ${JSON.stringify(value)}`);
  };
  switch (want) {
    case 'string':
      if (typeof value !== 'string') fail('a string');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail('true or false');
      return value;
    case 'mode':
      if (typeof value !== 'string' && value !== false) fail('a mode name, or false to keep the agent\'s own');
      return value;
    case 'strings':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) fail('a list of strings');
      return value;
    case 'env':
      if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) fail('a table of strings (KEY = "value")');
      return value;
  }
}

const AGENT_FIELDS: Record<string, 'string' | 'strings' | 'env' | 'mode' | 'boolean'> = {
  name: 'string',
  description: 'string',
  registry: 'string',
  command: 'string',
  args: 'strings',
  extraArgs: 'strings',
  env: 'env',
  mode: 'mode',
  install: 'string',
  login: 'string',
  aliases: 'strings',
  enabled: 'boolean',
};
const QUIRK_FIELDS: Record<string, 'string' | 'strings' | 'boolean'> = { summary: 'string', waives: 'strings', fix: 'string', seen: 'string', upstream: 'string', enabled: 'boolean' };
const APPLY_FIELDS: Record<string, 'strings' | 'env' | 'mode'> = { mode: 'mode', args: 'strings', env: 'env' };

function unknownKey(source: string, path: string, key: string, known: string[]): never {
  throw new AgentFileError(`${source}: ${path}.${key} is not a known field (known: ${known.join(', ')})`);
}

/** Parse and check an agents file's text (TOML with an [agents] table). Other top-level tables are ignored. */
export function parseAgentFile(text: string, source: string): CatalogLayer {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new AgentFileError(`${source}: ${(error as Error).message}`);
  }
  return parseAgentTable(raw.agents, source);
}

/**
 * Check an already-parsed agents table (name: definition), such as one
 * nested in another tool's config. `at` names it in errors (default "agents").
 */
export function parseAgentTable(table: unknown, source: string, at = 'agents'): CatalogLayer {
  const agents: Record<string, AgentDefinition> = {};
  if (table === undefined) return { source, agents };
  if (!isRecord(table)) throw new AgentFileError(`${source}: ${at} should be a table ([${at}.<name>])`);
  for (const [name, value] of Object.entries(table)) {
    const path = `${at}.${name}`;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new AgentFileError(`${source}: ${path}: names are letters, digits, ., _ and -`);
    if (!isRecord(value)) throw new AgentFileError(`${source}: ${path} should be a table`);
    const definition: Record<string, unknown> = {};
    for (const [rawKey, field] of Object.entries(value)) {
      const key = camel(rawKey);
      if (key === 'quirks') {
        if (!isRecord(field)) throw new AgentFileError(`${source}: ${path}.quirks should be a table ([${path}.quirks.<id>])`);
        const quirks: Record<string, Partial<Quirk>> = {};
        for (const [id, q] of Object.entries(field)) {
          const qpath = `${path}.quirks.${id}`;
          if (!isRecord(q)) throw new AgentFileError(`${source}: ${qpath} should be a table`);
          const quirk: Record<string, unknown> = {};
          for (const [rawQKey, qv] of Object.entries(q)) {
            const qkey = camel(rawQKey);
            if (qkey === 'apply') {
              if (!isRecord(qv)) throw new AgentFileError(`${source}: ${qpath}.apply should be a table`);
              const apply: Record<string, unknown> = {};
              for (const [ak, av] of Object.entries(qv)) {
                const want = APPLY_FIELDS[camel(ak)];
                if (!want) unknownKey(source, `${qpath}.apply`, ak, Object.keys(APPLY_FIELDS));
                apply[camel(ak)] = check(source, `${qpath}.apply.${ak}`, av, want);
              }
              quirk.apply = apply;
            } else {
              const want = QUIRK_FIELDS[qkey];
              if (!want) unknownKey(source, qpath, rawQKey, [...Object.keys(QUIRK_FIELDS), 'apply']);
              quirk[qkey] = check(source, `${qpath}.${rawQKey}`, qv, want);
            }
          }
          quirks[id] = quirk as Partial<Quirk>;
        }
        definition.quirks = quirks;
        continue;
      }
      const want = AGENT_FIELDS[key];
      if (!want) unknownKey(source, path, rawKey, [...Object.keys(AGENT_FIELDS).map((k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)), 'quirks']);
      definition[key] = check(source, `${path}.${rawKey}`, field, want);
    }
    agents[name] = definition as AgentDefinition;
  }
  return { source, agents };
}

export interface CatalogOptions {
  /** Where to look for subspace.toml (and up). Default `process.cwd()`. */
  cwd?: string;
  /** More agent files, after the others. */
  files?: string[];
  /** Skip ~/.config/subspace/agents.toml, subspace.toml and $SUBSPACE_AGENTS (built-ins and registry only). */
  builtinOnly?: boolean;
  /** Environment to read ($XDG_CONFIG_HOME, $XDG_CACHE_HOME, $SUBSPACE_AGENTS). Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Read the nearest subspace.toml even if its folder is not in your agents.toml's [trust] folders. */
  trustProject?: boolean;
  /** Told about a subspace.toml skipped because its folder is not trusted. Default: once per file, on stderr. */
  onWarning?: (message: string) => void;
}

/** An agents file loadCatalog() may read. `trusted` is false for a subspace.toml whose folder is not trusted: it is skipped. */
export interface AgentFile {
  path: string;
  exists: boolean;
  trusted: boolean;
}

/** The files loadCatalog() reads, in order, whether each exists, and whether it is trusted. */
export function agentFiles(options: CatalogOptions = {}): AgentFile[] {
  const { first, folders, last } = agentFilePlaces(options);
  const files: AgentFile[] = [{ path: first, exists: existsSync(first), trusted: true }];
  const found = folders.find((candidate) => existsSync(candidate));
  if (found) {
    let text: string | undefined;
    try {
      text = files[0]!.exists ? readFileSync(first, 'utf8') : undefined;
    } catch {
      // Unreadable: nothing is trusted.
    }
    const trusted = options.trustProject || last.includes(found) || isTrusted(found, trustedFolders(text, first, false), (p) => realpathSync.native(p));
    files.push({ path: found, exists: true, trusted });
  }
  for (const path of last) files.push({ path, exists: existsSync(path), trusted: true });
  return files;
}

const fileExists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** `agentFiles()` without blocking the event loop. */
export async function agentFilesAsync(options: CatalogOptions = {}): Promise<AgentFile[]> {
  const { first, folders, last } = agentFilePlaces(options);
  const files: AgentFile[] = [{ path: first, exists: await fileExists(first), trusted: true }];
  for (const candidate of folders) {
    if (await fileExists(candidate)) {
      const text = files[0]!.exists ? await readFile(first, 'utf8').catch(() => undefined) : undefined;
      let trusted = options.trustProject || last.includes(candidate);
      if (!trusted) {
        const folders = trustedFolders(text, first, false);
        const real = new Map<string, string>();
        for (const p of [dirname(candidate), ...folders]) real.set(p, await realpath(p).catch(() => p));
        trusted = isTrusted(candidate, folders, (p) => real.get(p) ?? p);
      }
      files.push({ path: candidate, exists: true, trusted });
      break;
    }
  }
  for (const path of last) files.push({ path, exists: await fileExists(path), trusted: true });
  return files;
}

/** Where agent files may be: the user's file, each folder's subspace.toml from cwd up (the first that exists counts), then the rest. */
function agentFilePlaces(options: CatalogOptions): { first: string; folders: string[]; last: string[] } {
  const env = options.env ?? process.env;
  const folders: string[] = [];
  for (let dir = resolve(options.cwd ?? process.cwd()); ; dir = dirname(dir)) {
    folders.push(join(dir, 'subspace.toml'));
    if (dirname(dir) === dir) break;
  }
  const last = [...(env.SUBSPACE_AGENTS ?? '').split(delimiter).filter(Boolean), ...(options.files ?? [])].map((file) => resolve(file));
  return { first: join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'subspace', 'agents.toml'), folders, last };
}

/**
 * The trusted folders in the user's agents.toml text ([trust] folders), with
 * ~/ expanded. With `strict`, a bad [trust] table is an AgentFileError;
 * without, it trusts nothing (loadCatalog reports the error when it reads the file).
 */
function trustedFolders(text: string | undefined, source: string, strict: boolean): string[] {
  if (text === undefined) return [];
  try {
    let raw: Record<string, unknown>;
    try {
      raw = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      throw new AgentFileError(`${source}: ${(error as Error).message}`);
    }
    const trust = raw.trust;
    if (trust === undefined) return [];
    if (!isRecord(trust)) throw new AgentFileError(`${source}: trust should be a table ([trust])`);
    for (const key of Object.keys(trust)) if (key !== 'folders') unknownKey(source, 'trust', key, ['folders']);
    const folders = trust.folders === undefined ? [] : (check(source, 'trust.folders', trust.folders, 'strings') as string[]);
    return folders.map((folder) => {
      if (folder === '~' || folder.startsWith('~/')) return resolve(homedir(), folder.slice(2));
      if (!isAbsolute(folder)) throw new AgentFileError(`${source}: trust.folders should hold absolute paths or ~/ paths, not ${JSON.stringify(folder)}`);
      return resolve(folder);
    });
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

/** Whether a subspace.toml's folder is one of `folders` (that folder itself, after resolving symlinks). */
function isTrusted(file: string, folders: string[], real: (path: string) => string): boolean {
  const canonical = (path: string) => {
    let out: string;
    try {
      out = real(path);
    } catch {
      out = path;
    }
    return process.platform === 'win32' ? out.toLowerCase() : out;
  };
  const folder = canonical(dirname(file));
  return folders.some((f) => canonical(f) === folder);
}

/** The warning for a skipped subspace.toml: where it is and how to trust it. */
function untrustedWarning(file: string, userFile: string): string {
  return (
    `subspace: skipped ${file}: its folder is not trusted, and a subspace.toml can choose the commands agents run.\n` +
    `To trust this folder (only this one, not the folders below it), add it to [trust] folders in ${userFile}:\n\n` +
    `  [trust]\n  folders = [${JSON.stringify(dirname(file))}]\n`
  );
}

const warned = new Set<string>();
function warnOnce(message: string, path: string): void {
  if (warned.has(path)) return;
  warned.add(path);
  process.stderr.write(message);
}

export function registryCachePath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'subspace', 'registry.json');
}

/** The registry to use: the cached copy if it is newer than the bundled snapshot. */
export function loadRegistry(env: Record<string, string | undefined> = process.env): { registry: Registry; source: string } {
  const cache = registryCachePath(env);
  let text: string | undefined;
  try {
    text = readFileSync(cache, 'utf8');
  } catch {
    // No cache: the snapshot.
  }
  return registryFrom(cache, text);
}

/** `loadRegistry()` without blocking the event loop. */
export async function loadRegistryAsync(env: Record<string, string | undefined> = process.env): Promise<{ registry: Registry; source: string }> {
  const cache = registryCachePath(env);
  return registryFrom(cache, await readFile(cache, 'utf8').catch(() => undefined));
}

function registryFrom(cache: string, text: string | undefined): { registry: Registry; source: string } {
  try {
    const cached = text === undefined ? undefined : (JSON.parse(text) as { fetchedAt?: string; registry?: unknown });
    if (cached?.fetchedAt && cached.fetchedAt.slice(0, 10) >= REGISTRY_SNAPSHOT_DATE) {
      return { registry: trimRegistry(cached.registry), source: `${cache} (${cached.fetchedAt.slice(0, 10)})` };
    }
  } catch {
    // Unreadable: the snapshot.
  }
  return { registry: REGISTRY_SNAPSHOT, source: `bundled snapshot (${REGISTRY_SNAPSHOT_DATE})` };
}

/** Fetch the latest ACP registry into the cache. */
export async function refreshRegistry(options: { url?: string; env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): Promise<{ agents: number; path: string }> {
  const url = options.url ?? REGISTRY_URL;
  const response = await (options.fetch ?? fetch)(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const registry = trimRegistry(await response.json());
  if (!registry.agents.length) throw new Error(`${url}: no agents in the registry; keeping the old one`);
  const path = registryCachePath(options.env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ fetchedAt: new Date().toISOString(), url, registry }, null, 2)}\n`);
  return { agents: registry.agents.length, path };
}

/** The agent catalog: registry, built-ins, then agent files. Throws AgentFileError for a bad file. */
export function loadCatalog(options: CatalogOptions = {}): AgentCatalog {
  const { registry, source } = loadRegistry(options.env);
  const catalog = builtinCatalog(registry, source);
  catalog.binaries = installedBinaries(options.env);
  if (options.builtinOnly) return catalog;
  const files = agentFiles(options);
  for (const file of files) {
    if (!includeFile(file, files[0]!.path, options)) continue;
    const text = readFileSync(file.path, 'utf8');
    if (file === files[0]) trustedFolders(text, file.path, true);
    catalog.layers.push(parseAgentFile(text, file.path));
  }
  return catalog;
}

/** `loadCatalog()` without blocking the event loop (agent files and the registry cache are read asynchronously). */
export async function loadCatalogAsync(options: CatalogOptions = {}): Promise<AgentCatalog> {
  const { registry, source } = await loadRegistryAsync(options.env);
  const catalog = builtinCatalog(registry, source);
  catalog.binaries = await installedBinariesAsync(options.env);
  if (options.builtinOnly) return catalog;
  const files = await agentFilesAsync(options);
  for (const file of files) {
    if (!includeFile(file, files[0]!.path, options)) continue;
    const text = await readFile(file.path, 'utf8');
    if (file === files[0]) trustedFolders(text, file.path, true);
    catalog.layers.push(parseAgentFile(text, file.path));
  }
  return catalog;
}

/** Whether loadCatalog reads a file: it exists (a missing --agents-file is an error) and is trusted (else a warning). */
function includeFile(file: AgentFile, userFile: string, options: CatalogOptions): boolean {
  if (!file.exists) {
    if ((options.files ?? []).map((f) => resolve(f)).includes(file.path)) throw new AgentFileError(`${file.path}: no such file`);
    return false;
  }
  if (!file.trusted) {
    const message = untrustedWarning(file.path, userFile);
    if (options.onWarning) options.onWarning(message);
    else warnOnce(message, file.path);
    return false;
  }
  return true;
}
