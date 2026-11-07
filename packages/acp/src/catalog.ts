/**
 * Agent files and the registry cache (Node).
 *
 * Layers, lowest first: the ACP registry (the bundled snapshot, or a newer
 * cached copy from `refreshRegistry()`), the built-in agents, then
 *   - $XDG_CONFIG_HOME/subspace/agents.toml (default ~/.config/subspace/agents.toml),
 *   - the nearest subspace.toml, from cwd up,
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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { builtinCatalog, type AgentCatalog, type AgentDefinition, type CatalogLayer, type Quirk } from './agents.ts';
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
const QUIRK_FIELDS: Record<string, 'string' | 'strings' | 'boolean'> = { summary: 'string', waives: 'strings', fix: 'string', seen: 'string', enabled: 'boolean' };
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
  const agents: Record<string, AgentDefinition> = {};
  if (raw.agents === undefined) return { source, agents };
  if (!isRecord(raw.agents)) throw new AgentFileError(`${source}: agents should be a table ([agents.<name>])`);
  for (const [name, value] of Object.entries(raw.agents)) {
    const path = `agents.${name}`;
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
}

/** The files loadCatalog() reads, in order, and whether each exists. */
export function agentFiles(options: CatalogOptions = {}): Array<{ path: string; exists: boolean }> {
  const env = options.env ?? process.env;
  const paths: string[] = [];
  paths.push(join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'subspace', 'agents.toml'));
  for (let dir = resolve(options.cwd ?? process.cwd()); ; dir = dirname(dir)) {
    const candidate = join(dir, 'subspace.toml');
    if (existsSync(candidate)) {
      paths.push(candidate);
      break;
    }
    if (dirname(dir) === dir) break;
  }
  for (const file of (env.SUBSPACE_AGENTS ?? '').split(delimiter).filter(Boolean)) paths.push(resolve(file));
  for (const file of options.files ?? []) paths.push(resolve(file));
  return paths.map((path) => ({ path, exists: existsSync(path) }));
}

export function registryCachePath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'subspace', 'registry.json');
}

/** The registry to use: the cached copy if it is newer than the bundled snapshot. */
export function loadRegistry(env: Record<string, string | undefined> = process.env): { registry: Registry; source: string } {
  const cache = registryCachePath(env);
  try {
    const cached = JSON.parse(readFileSync(cache, 'utf8')) as { fetchedAt?: string; registry?: unknown };
    if (cached.fetchedAt && cached.fetchedAt.slice(0, 10) >= REGISTRY_SNAPSHOT_DATE) {
      return { registry: trimRegistry(cached.registry), source: `${cache} (${cached.fetchedAt.slice(0, 10)})` };
    }
  } catch {
    // No cache, or unreadable: the snapshot.
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
  if (options.builtinOnly) return catalog;
  for (const { path, exists } of agentFiles(options)) {
    if (!exists) {
      if ((options.files ?? []).map((f) => resolve(f)).includes(path)) throw new AgentFileError(`${path}: no such file`);
      continue;
    }
    catalog.layers.push(parseAgentFile(readFileSync(path, 'utf8'), path));
  }
  return catalog;
}
