/**
 * The ACP agent registry (the "ACP Agent Registry" RFD): manifests of ACP
 * agents and how to run them, published at REGISTRY_URL. Subspace bundles a
 * snapshot (registry-snapshot.ts) and can fetch the latest into a cache
 * (`subspace agents --refresh`).
 */

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export interface RegistryLaunch {
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RegistryBinary {
  archive: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  license?: string;
  distribution: {
    npx?: RegistryLaunch;
    uvx?: RegistryLaunch;
    /** Keyed by target: darwin-aarch64, darwin-x86_64, linux-aarch64, linux-x86_64, windows-aarch64, windows-x86_64. */
    binary?: Record<string, RegistryBinary>;
  };
}

export interface Registry {
  version: string;
  agents: RegistryAgent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.map(String) : undefined);
const env = (value: unknown): Record<string, string> | undefined =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])) : undefined;

function launch(value: unknown): RegistryLaunch | undefined {
  if (!isRecord(value) || typeof value.package !== 'string') return undefined;
  const args = strings(value.args);
  const vars = env(value.env);
  return { package: value.package, ...(args?.length ? { args } : {}), ...(vars && Object.keys(vars).length ? { env: vars } : {}) };
}

/** Keep the fields Subspace uses, and drop entries that do not parse. */
export function trimRegistry(raw: unknown): Registry {
  const source = isRecord(raw) ? raw : {};
  const agents: RegistryAgent[] = [];
  for (const entry of Array.isArray(source.agents) ? source.agents : []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !isRecord(entry.distribution)) continue;
    const d = entry.distribution;
    const binary: Record<string, RegistryBinary> = {};
    for (const [target, b] of Object.entries(isRecord(d.binary) ? d.binary : {})) {
      if (!isRecord(b) || typeof b.cmd !== 'string' || typeof b.archive !== 'string') continue;
      const args = strings(b.args);
      const vars = env(b.env);
      binary[target] = { archive: b.archive, cmd: b.cmd, ...(args?.length ? { args } : {}), ...(vars && Object.keys(vars).length ? { env: vars } : {}) };
    }
    const npx = launch(d.npx);
    const uvx = launch(d.uvx);
    if (!npx && !uvx && !Object.keys(binary).length) continue;
    agents.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      version: String(entry.version ?? ''),
      description: String(entry.description ?? ''),
      ...(typeof entry.repository === 'string' ? { repository: entry.repository } : {}),
      ...(typeof entry.website === 'string' ? { website: entry.website } : {}),
      ...(typeof entry.license === 'string' ? { license: entry.license } : {}),
      distribution: { ...(npx ? { npx } : {}), ...(uvx ? { uvx } : {}), ...(Object.keys(binary).length ? { binary } : {}) },
    });
  }
  return { version: String(source.version ?? ''), agents };
}

/** This machine's registry target, e.g. darwin-aarch64. */
export function registryTarget(platform: string, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  return `${os}-${cpu}`;
}
