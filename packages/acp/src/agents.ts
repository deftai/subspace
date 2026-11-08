/**
 * Known agents: how to start them, and what they do that Subspace works around.
 *
 * An agent comes from layers, each later one overriding the earlier field by field:
 *
 *   1. the ACP agent registry (launch details and versions; see registry.ts),
 *   2. Subspace's built-in curation (BUILTIN_AGENTS: short names, login and
 *      install hints, and quirks),
 *   3. files (`~/.config/subspace/agents.toml`, then `./subspace.toml`; see
 *      `loadCatalog()` in ./node).
 *
 * A quirk records something an agent does that it should not, or that a
 * client has to know: what it is (`summary`), which conformance checks it
 * explains (`waives`, used by `subspace check`), and the fix: text (`fix`:
 * what Subspace does about it), settings that are used (`apply`: a mode,
 * arguments, environment), or both. So every non-default setting says why.
 *
 *   [agents.claude.quirks.starts-in-auto-mode]
 *   summary = "Starts in auto mode, where it writes and runs without asking"
 *   apply = { mode = "default" }
 */
import { REGISTRY_SNAPSHOT } from './registry-snapshot.ts';
import { registryTarget, type Registry, type RegistryAgent } from './registry.ts';

export interface Quirk {
  summary: string;
  /** Conformance check ids this quirk explains; `subspace check` waives them. */
  waives?: string[];
  /** What Subspace (or this agent's settings) does about it. */
  fix?: string;
  /** Settings used because of it: a session mode, arguments appended, environment added. */
  apply?: { mode?: string | false; args?: string[]; env?: Record<string, string> };
  /** Where or when it was seen (an agent version, a date). */
  seen?: string;
  /** Where it is reported upstream (an issue URL). */
  upstream?: string;
  /** false: ignore it (its settings are not used and its checks not waived). */
  enabled?: boolean;
}

/** An agent as a layer gives it: every field optional, so a file can change just one. */
export interface AgentDefinition {
  name?: string;
  description?: string;
  /** Take launch details (command, arguments, version) from this ACP registry entry. */
  registry?: string;
  command?: string;
  /** Replaces the arguments (the registry's, or an earlier layer's). */
  args?: string[];
  /** Added after the arguments. */
  extraArgs?: string[];
  env?: Record<string, string>;
  /** The session mode to switch to; false keeps the agent's own. */
  mode?: string | false;
  install?: string;
  login?: string;
  /** Other names it answers to. */
  aliases?: string[];
  quirks?: Record<string, Partial<Quirk>>;
  /** false: hide it (a later layer can turn it back on). */
  enabled?: boolean;
  /** How to start it when the registry has no entry for it (offline cache, a renamed id). */
  fallback?: { command: string; args?: string[] };
}

export interface CatalogLayer {
  /** Where it came from: "built-in", a file path. */
  source: string;
  agents: Record<string, AgentDefinition>;
}

export interface AgentCatalog {
  registry: Registry;
  /** Where the registry came from: "snapshot (date)" or a cache file. */
  registrySource: string;
  /** Lowest first: later layers override earlier ones. */
  layers: CatalogLayer[];
  /**
   * Registry binaries installed by `subspace agents install` (`installAgent`):
   * `<id>@<version>` -> the folder they were unpacked into. Used by absolute
   * path; PATH is not touched.
   */
  binaries?: Record<string, string>;
}

/** An agent ready to start. */
export interface ResolvedAgent {
  id: string;
  name: string;
  description: string;
  /** From the registry, when it came from there. */
  version?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  mode?: string;
  install?: string;
  login?: string;
  registry?: string;
  /** How it is launched: a package runner (npx, uvx), a registry binary, or a plain command. */
  launch: 'npx' | 'uvx' | 'binary' | 'command';
  aliases: string[];
  /** Enabled quirks, by id. */
  quirks: Record<string, Quirk>;
  /** Check id: reason, from the enabled quirks. */
  waivers: Record<string, string>;
  /** The layers that defined it, lowest first: "registry", "built-in", file paths. */
  sources: string[];
}

/**
 * Subspace's curation of the agents it knows best. Launch details come from
 * the registry where it has them; quirks come from the testkit's recorded
 * corpus (packages/acp-testkit/corpus).
 */
export const BUILTIN_AGENTS = {
  claude: {
    registry: 'claude-acp',
    aliases: ['claude-code'],
    fallback: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
    description: 'Claude Code through its ACP adapter',
    install: 'Install Node.js (for npx); the adapter downloads on first start',
    login: 'Log in to Claude Code first: run `claude` and sign in, or set ANTHROPIC_API_KEY',
    quirks: {
      'starts-in-auto-mode': {
        summary: 'Starts in auto mode, where it writes files and runs commands without asking',
        apply: { mode: 'default' },
        fix: 'Sessions switch to its ask-first mode, so permission answers are consulted',
        seen: 'claude-agent-acp 0.101.0',
      },
      'refused-turn-ends-normally': {
        summary: 'A refused write ends the turn end_turn, with the tool call failed',
        fix: 'turnEnd() reports completed; result.refused counts the refusal',
        seen: 'claude-agent-acp 0.101.0',
      },
      'account-in-auth-status': {
        summary: 'Sends the signed-in account (email, organization, plan) in _auth/status_update',
        fix: 'The testkit recorder redacts it from traces',
        seen: 'claude-agent-acp 0.101.0',
      },
    },
  },
  codex: {
    registry: 'codex-acp',
    fallback: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
    install: 'Install Node.js (for npx); the adapter downloads on first start',
    login: 'Log in to Codex first: run `codex login`, or set OPENAI_API_KEY',
    quirks: {
      'starts-in-agent-mode': {
        summary: 'Starts in agent mode, where it runs commands without asking',
        apply: { mode: 'read-only' },
        fix: 'Sessions switch to read-only mode, where it asks first (and still acts once allowed)',
        seen: 'codex-acp 2.5.0',
      },
      'refused-turn-ends-cancelled': {
        summary: 'A refused write ends the turn with stop reason cancelled, though nobody cancelled, and leaves the tool call pending',
        fix: 'turnEnd() reports refused (result.refused counts it)',
        seen: 'codex-acp 2.5.0, 2026-11',
        upstream: 'https://github.com/agentclientprotocol/codex-acp/issues/556',
      },
      'reject-option-named-cancel': {
        summary: 'Its reject option is named cancel (kind reject_once)',
        fix: 'Permission answers pick options by kind, not name',
        seen: 'codex-acp 2.5.0',
      },
      'account-in-auth-status': {
        summary: 'Sends the signed-in account in _auth/status_update',
        fix: 'The testkit recorder redacts it from traces',
        seen: 'codex-acp 2.5.0',
      },
    },
  },
  grok: {
    registry: 'grok-build',
    command: 'grok',
    args: ['--permission-mode', 'default', 'agent', 'stdio'],
    install: 'Install Grok Build (the `grok` command; also `npx @xai-official/grok`)',
    login: 'Log in to Grok Build first: run `grok` and sign in',
    quirks: {
      'follows-always-approve': {
        summary: 'Follows an always-approve permission_mode in ~/.grok/config.toml, so it never asks',
        fix: 'Started with --permission-mode default (in its arguments), so it asks first',
      },
      'unknown-session-32602': {
        summary: 'Answers a prompt for an unknown session with -32602 Invalid params, not -32002',
        waives: ['session.unknown'],
        seen: 'Grok Build, 2026-11',
      },
      'refused-turn-ends-cancelled': {
        summary: 'A refused write ends the turn with stop reason cancelled, though nobody cancelled',
        fix: 'turnEnd() reports refused (result.refused counts it)',
        seen: 'Grok Build 1.0.77, 2026-11',
      },
      'vendor-notifications': {
        summary: 'Sends many _x.ai/* extension notifications around session/new and each turn',
        fix: 'The client ignores extension notifications it has no handler for',
        seen: 'Grok Build 1.0.77, 2026-11',
      },
    },
  },
  gemini: {
    registry: 'gemini',
    fallback: { command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
    install: 'Install Node.js (for npx), or the Gemini CLI (npm install -g @google/gemini-cli)',
    login: 'Log in to the Gemini CLI first: run `gemini` and sign in, or set GEMINI_API_KEY',
  },
  opencode: {
    registry: 'opencode',
    fallback: { command: 'opencode', args: ['acp'] },
    install: 'Install OpenCode (the `opencode` command)',
    login: 'Log in to OpenCode first: run `opencode auth login`',
  },
} satisfies Record<string, AgentDefinition>;

export type BuiltinAgentName = keyof typeof BUILTIN_AGENTS;

/** A catalog of the built-in layer and the bundled registry snapshot (no files). */
export function builtinCatalog(registry: Registry = REGISTRY_SNAPSHOT, registrySource = 'snapshot'): AgentCatalog {
  return { registry, registrySource, layers: [{ source: 'built-in', agents: BUILTIN_AGENTS as Record<string, AgentDefinition> }] };
}

function mergeQuirks(into: Record<string, Partial<Quirk>>, from: Record<string, Partial<Quirk>> | undefined): void {
  for (const [id, quirk] of Object.entries(from ?? {})) into[id] = { ...(into[id] ?? {}), ...quirk };
}

/** The name a lookup means: a defined name, an alias, or a registry id. */
function canonical(catalog: AgentCatalog, name: string): string | undefined {
  for (const layer of [...catalog.layers].reverse()) if (layer.agents[name]) return name;
  for (const layer of [...catalog.layers].reverse()) {
    for (const [key, definition] of Object.entries(layer.agents)) if (definition.aliases?.includes(name)) return key;
  }
  if (catalog.registry.agents.some((a) => a.id === name)) return name;
  return undefined;
}

function registryLaunch(
  entry: RegistryAgent,
  platform: string,
  arch: string,
  binaries: Record<string, string> = {}
): Pick<ResolvedAgent, 'command' | 'args' | 'env' | 'launch'> & { install?: string; installable?: boolean; installed?: boolean } {
  const d = entry.distribution;
  if (d.npx) return { command: 'npx', args: ['-y', d.npx.package, ...(d.npx.args ?? [])], env: d.npx.env ?? {}, launch: 'npx' };
  if (d.uvx) return { command: 'uvx', args: [d.uvx.package, ...(d.uvx.args ?? [])], env: d.uvx.env ?? {}, launch: 'uvx' };
  const own = d.binary?.[registryTarget(platform, arch)];
  const target = own ?? Object.values(d.binary ?? {})[0];
  // Installed by `subspace agents install`: run it from there.
  const dir = binaries[`${entry.id}@${entry.version}`];
  if (target && dir) {
    const command = `${dir.replace(/[\\/]+$/, '')}/${target.cmd.replace(/^\.\//, '')}`;
    const install = `It was installed by \`subspace agents install ${entry.id}\` into ${dir}; run that again if it is missing`;
    return { command, args: target.args ?? [], env: target.env ?? {}, launch: 'binary', install, installed: true };
  }
  // Otherwise it is expected on PATH under its command's name.
  const command = (target?.cmd ?? entry.id).split(/[\\/]/).pop()!;
  // Only this machine's download can be installed.
  const install = !own
    ? undefined
    : own.sha256
      ? `Run \`subspace agents install ${entry.id}\`, or install ${entry.name} so \`${command}\` is on PATH (download: ${own.archive})`
      : `Install ${entry.name} so \`${command}\` is on PATH (download: ${own.archive}; the registry lists no checksum for it, so Subspace does not install it)`;
  return { command, args: target?.args ?? [], env: target?.env ?? {}, launch: 'binary', ...(install ? { install, installable: !!own?.sha256 } : {}) };
}

/** Resolve a name (a defined name, an alias, or a registry id). Undefined when unknown. */
export function resolveAgent(
  catalog: AgentCatalog,
  name: string,
  host: { platform: string; arch: string } = { platform: (globalThis as { process?: { platform?: string } }).process?.platform ?? 'linux', arch: (globalThis as { process?: { arch?: string } }).process?.arch ?? 'x64' }
): ResolvedAgent | undefined {
  const id = canonical(catalog, name);
  if (!id) return undefined;
  const merged: AgentDefinition = {};
  const quirks: Record<string, Partial<Quirk>> = {};
  const sources: string[] = [];
  const extraArgs: string[] = [];
  const env: Record<string, string> = {};
  const aliases = new Set<string>();
  /** An install hint from the user's own files (not the built-in one). */
  let ownInstall: string | undefined;
  for (const layer of catalog.layers) {
    const definition = layer.agents[id];
    if (!definition) continue;
    sources.push(layer.source);
    if (layer.source !== 'built-in' && definition.install !== undefined) ownInstall = definition.install;
    const { quirks: q, extraArgs: extra, env: e, aliases: a, ...fields } = definition;
    // A layer that sets args starts the extra arguments over.
    if (fields.args) extraArgs.length = 0;
    Object.assign(merged, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    mergeQuirks(quirks, q);
    extraArgs.push(...(extra ?? []));
    Object.assign(env, e ?? {});
    for (const alias of a ?? []) aliases.add(alias);
  }
  if (merged.enabled === false) return undefined;
  const entry = catalog.registry.agents.find((a) => a.id === (merged.registry ?? id));
  if (entry) sources.unshift('registry');
  const launch = entry
    ? registryLaunch(entry, host.platform, host.arch, catalog.binaries)
    : merged.fallback
      ? { command: merged.fallback.command, args: merged.fallback.args ?? [], env: {}, launch: (merged.fallback.command === 'npx' || merged.fallback.command === 'uvx' ? merged.fallback.command : 'command') as ResolvedAgent['launch'] }
      : undefined;
  const command = merged.command ?? launch?.command;
  if (!command) return undefined;
  const enabled = Object.fromEntries(
    Object.entries(quirks).filter(([, q]) => q.enabled !== false && typeof q.summary === 'string') as Array<[string, Quirk]>
  );
  // Quirk settings first; the agent's own fields (from any layer) win over them.
  let mode: string | false | undefined;
  const quirkArgs: string[] = [];
  const quirkEnv: Record<string, string> = {};
  for (const quirk of Object.values(enabled)) {
    if (quirk.apply?.mode !== undefined) mode = quirk.apply.mode;
    quirkArgs.push(...(quirk.apply?.args ?? []));
    Object.assign(quirkEnv, quirk.apply?.env ?? {});
  }
  if (merged.mode !== undefined) mode = merged.mode;
  // A command of its own means the registry's arguments are not its arguments.
  const baseArgs = merged.args ?? (merged.command && merged.command !== launch?.command ? [] : (launch?.args ?? []));
  const waivers: Record<string, string> = {};
  for (const quirk of Object.values(enabled)) for (const check of quirk.waives ?? []) waivers[check] = quirk.summary;
  // Your own hint wins. A command of your own makes the registry's hint beside the point.
  // Otherwise the registry knows better than the built-in hint when the binary is
  // installed, or Subspace can install it; the built-in hint covers the rest.
  const ownCommand = merged.command !== undefined && merged.command !== launch?.command;
  const known = launch as { install?: string; installed?: boolean; installable?: boolean } | undefined;
  const install = ownInstall ?? (ownCommand ? merged.install : known?.installed || known?.installable ? known.install : (merged.install ?? known?.install));
  return {
    id,
    name: merged.name ?? entry?.name ?? id,
    description: merged.description ?? entry?.description ?? '',
    ...(entry?.version ? { version: entry.version } : {}),
    command,
    args: [...baseArgs, ...quirkArgs, ...extraArgs],
    env: { ...(merged.command && merged.command !== launch?.command ? {} : (launch?.env ?? {})), ...quirkEnv, ...env },
    ...(mode ? { mode } : {}),
    ...(install ? { install } : {}),
    ...(merged.login ? { login: merged.login } : {}),
    ...(entry ? { registry: entry.id } : {}),
    launch: merged.command && merged.command !== launch?.command ? 'command' : (launch?.launch ?? 'command'),
    aliases: [...aliases],
    quirks: enabled,
    waivers,
    sources,
  };
}

/** Every agent the layers define (in order), then the registry's other agents. */
export function listAgents(catalog: AgentCatalog): ResolvedAgent[] {
  const names = new Set<string>();
  for (const layer of catalog.layers) for (const name of Object.keys(layer.agents)) names.add(name);
  const defined = [...names].map((n) => resolveAgent(catalog, n)).filter((a): a is ResolvedAgent => !!a);
  const claimed = new Set(defined.flatMap((a) => [a.id, ...(a.registry ? [a.registry] : [])]));
  const others = catalog.registry.agents.filter((a) => !claimed.has(a.id)).map((a) => resolveAgent(catalog, a.id)).filter((a): a is ResolvedAgent => !!a);
  return [...defined, ...others];
}
