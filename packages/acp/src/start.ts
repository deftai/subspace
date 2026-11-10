/**
 * The quick way in (Node): start a known agent with sensible defaults, run
 * turns with handler options, and serve an agent on stdio.
 *
 *   const agent = await start('claude', { onPermission: (r) => (r.toolCall?.kind === 'read' ? 'allow' : 'reject') });
 *   try {
 *     await agent.run('Summarize README.md', { onMessage: (delta, { separator }) => process.stdout.write(separator + delta) });
 *   } finally {
 *     await agent.close();
 *   }
 *
 *   const { text } = await run('codex', 'What does this repo do?', { permissions: 'reject' });
 *
 * What `start()` does for you:
 * - Known agents by name: the built-ins (claude, codex, grok, gemini,
 *   opencode), any ACP registry id, and agents files (agents.toml,
 *   subspace.toml; see catalog.ts). Each starts in the mode where it asks
 *   before acting, so your permission answers are actually consulted (a
 *   quirk records why). `{ mode }` overrides, `mode: false` keeps the agent's own.
 * - One folder: `cwd` (default `process.cwd()`) is the agent's working
 *   directory, the workspace its file requests are confined to, and the session's cwd.
 * - A session, opened and ready (`agent.session`, `agent.run()`).
 * - Login: if opening the session fails because the agent needs a login and
 *   it offers exactly one method it handles itself, that method is used once.
 * - Ctrl-C (SIGINT) cancels the running turn and stops the agent before exiting.
 * - Questions from the agent (form elicitation) are advertised and go to the
 *   turn's `onQuestion`, or are declined.
 *
 * It requires a permission answer (`onPermission` or `permissions`): agents
 * ask before writing and running, and a silent refusal surprises everyone.
 */
import { Readable, Writable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import { ErrorCode, ndjson, RpcError, traceTap, type RpcPeer } from '@deft-subspace/kernel';
import { serveAgent, type AgentOptions } from './agent.ts';
import type { ElicitationHandler, PromptInput, PromptOptions, Session, SessionMcpServers } from './client.ts';
import { mergeHandlers, type TurnHandlers } from './handlers.ts';
import { conveniences, type SessionConveniences } from './conveniences.ts';
import { openSession, requirePermissionAnswer } from './open.ts';
import type { ContentBlock, TurnResult } from './model.ts';
import type { PermissionPolicy } from './permissions.ts';
import { connectAgent, type ConnectAgentOptions, type ConnectedAgent } from './node.ts';
import type { Turn } from './turn.ts';
import { listAgents, resolveAgent, type AgentCatalog, type BuiltinAgentName, type ResolvedAgent } from './agents.ts';
import { loadCatalog } from './catalog.ts';

/** An agent given by its command (not by name). */
export interface AgentCommand {
  command: string;
  args?: readonly string[];
  /** The mode to switch each session to (its ask-first mode). */
  mode?: string;
  env?: Record<string, string>;
  description?: string;
  /** How to install it, for the error when it is missing. */
  install?: string;
  /** How to log in, for the error when it needs a login. */
  login?: string;
}

/** A known agent's name (built in, from an agents file, or an ACP registry id). */
export type AgentName = BuiltinAgentName | (string & {});

export interface StartOptions extends Omit<ConnectAgentOptions, 'cwd' | 'workspace' | 'permissions' | 'handlers' | 'args' | 'files'>, TurnHandlers {
  /** The agent's folder, the workspace its file requests stay in, and the session's cwd. Default `process.cwd()`. */
  cwd?: string;
  /** Serve the agent's file requests from `cwd` (v1). Default true. */
  files?: ConnectAgentOptions['files'] | false;
  /** Where names are looked up. Default: loadCatalog({ cwd }) (built-ins, the ACP registry, agents files). */
  catalog?: AgentCatalog;
  /** Arguments added after the agent's. */
  extraArgs?: string[];
  /** The session mode to switch to. Default: the preset's ask-first mode. `false`: the agent's own. */
  mode?: string | false;
  /** A fixed answer to every permission question; or use `onPermission`. One of the two is required. */
  permissions?: PermissionPolicy;
  /** Handlers for every turn (flat handler options on these options do the same). */
  handlers?: TurnHandlers;
  /** MCP servers and extra directories for the session. */
  session?: { mcpServers?: SessionMcpServers; additionalDirectories?: string[] };
  /** Cancel and stop the agent on Ctrl-C (SIGINT) before exiting. Default true. */
  handleSignals?: boolean;
  /** Record the whole connection to this file (a trace; view it with `deft-subspace-trace`). */
  trace?: string;
  /** No notices on stderr (such as "the first start downloads the adapter"). */
  quiet?: boolean;
}

export interface StartedAgent extends SessionConveniences {
  readonly client: ConnectedAgent['client'];
  readonly process: ConnectedAgent['process'];
  /** The session opened by `start()`. */
  readonly session: Session;
  /** The agent as resolved from the catalog (when started by name): its command, quirks, sources. */
  readonly agent?: ResolvedAgent;
  /** Why the agent's mode was not applied, if it was not. */
  readonly modeWarning?: string;
  /** Another session with the same agent (switched to the same mode). */
  newSession(options?: StartOptions['session']): Promise<Session>;
  /** Cancel what is running, close the session and the connection, and stop the agent. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Look up a name in a catalog; an error that lists the known names if it is not there. */
export function agentByName(name: string, catalog: AgentCatalog): ResolvedAgent {
  const found = resolveAgent(catalog, name);
  if (found) return found;
  const known = listAgents(catalog)
    .filter((a) => !a.sources.every((s) => s === 'registry'))
    .map((a) => a.id);
  throw new TypeError(`Unknown agent "${name}". Known: ${known.join(', ')} (and the ACP registry's; \`subspace agents --all\`), or pass { command, args }.`);
}

/** Start a known agent (by name) or `{ command, args }`, and open a session. */
export async function start(agent: AgentName | AgentCommand, options: StartOptions): Promise<StartedAgent> {
  const resolved = typeof agent === 'string' ? agentByName(agent, options.catalog ?? loadCatalog({ cwd: options.cwd ?? process.cwd() })) : undefined;
  const preset: AgentCommand & { args: readonly string[] } = resolved ?? { ...agent as AgentCommand, args: (agent as AgentCommand).args ?? [] };
  const handlers = mergeHandlers(options.handlers, options);
  requirePermissionAnswer(options, 'start()');
  const cwd = options.cwd ?? process.cwd();
  const { extraArgs, mode: modeOption, session: sessionOptions, handleSignals, files, trace, quiet, catalog: _catalog, ...rest } = options;
  // The agent's environment on top of ours; the caller's on top of that.
  const env = preset.env && Object.keys(preset.env).length ? { ...(process.env as Record<string, string>), ...preset.env, ...(rest.env ?? {}) } : rest.env;
  // A label for messages and traces: the preset's name, or the program (and the script it runs).
  const script = preset.args.find((a) => !a.startsWith('-'));
  const name = resolved ? resolved.id : [basename(preset.command), ...(script ? [basename(script)] : [])].join(' ');
  const recording = trace ? traceFile(trace, name, cwd) : undefined;
  const tap = recording
    ? (direction: 'in' | 'out', message: unknown) => {
        recording.tap(direction, message);
        rest.tap?.(direction, message);
      }
    : rest.tap;
  // npx may download the adapter first; say so if it takes a while.
  const slow =
    !quiet && preset.command === 'npx' ? setTimeout(() => process.stderr.write(`Starting ${name}: the first start downloads its ACP adapter...\n`), 4000) : undefined;
  (slow as { unref?: () => void } | undefined)?.unref?.();
  // Advertise form questions so a turn's onQuestion can answer them; decline otherwise.
  const decline: ElicitationHandler = () => ({ action: 'decline' });
  let connected: ConnectedAgent;
  try {
    connected = await connectAgent(preset.command, {
      ...rest,
      ...(tap ? { tap } : {}),
      ...(env ? { env } : {}),
      args: [...preset.args, ...(extraArgs ?? [])],
      cwd,
      ...(files === false ? {} : files ? { files } : { workspace: cwd }),
      ...(options.permissions ? { permissions: options.permissions } : {}),
      ...(handlers ? { handlers } : {}),
      elicitation: options.elicitation ?? decline,
      elicitationModes: options.elicitationModes ?? ['form'],
    });
  } catch (error) {
    await recording?.close();
    throw explain(error, preset, name);
  } finally {
    clearTimeout(slow);
  }
  const mode = modeOption === false ? undefined : (modeOption ?? preset.mode);
  let modeWarning: string | undefined;

  const open = async (extra: StartOptions['session'] = sessionOptions): Promise<Session> => {
    const opened = await openSession(connected.client, {
      cwd,
      ...(extra?.mcpServers ? { mcpServers: extra.mcpServers } : {}),
      ...(extra?.additionalDirectories ? { additionalDirectories: extra.additionalDirectories } : {}),
      ...(mode ? { mode } : {}),
    });
    if (opened.modeWarning) modeWarning = opened.modeWarning;
    return opened.session;
  };

  let session: Session;
  try {
    session = await open();
  } catch (error) {
    await connected.close();
    await recording?.close();
    throw explain(error, preset, name);
  }

  let closed: Promise<void> | undefined;
  const onSignal = () => {
    void close().finally(() => process.exit(130));
  };
  const close = () =>
    (closed ??= (async () => {
      process.off('SIGINT', onSignal);
      await session.close().catch(() => {});
      await connected.close();
      await recording?.close();
    })());
  if (handleSignals ?? true) process.once('SIGINT', onSignal);

  const started: StartedAgent = {
    client: connected.client,
    process: connected.process,
    session,
    ...(resolved ? { agent: resolved } : {}),
    get modeWarning() {
      return modeWarning;
    },
    ...conveniences(session),
    newSession: (extra) => open(extra),
    close,
    [Symbol.asyncDispose]: close,
  };
  return started;
}

/** Errors with a next step: a missing program says how to install it, a needed login how to log in. */
function explain(error: unknown, preset: Pick<AgentCommand, 'install' | 'login'>, name: string): unknown {
  if (!(error instanceof Error)) return error;
  if (error.name === 'SpawnError' && preset.install) error.message += `\n${name}: ${preset.install}.`;
  else if (RpcError.is(error) && error.code === ErrorCode.AuthRequired) {
    error.message = `${name} needs a login. ${preset.login ?? 'Log in to it first, then try again.'}\n(${error.message})`;
  }
  return error;
}

/** A trace written to `path` as it happens (JSON Lines, the kernel's trace format). */
function traceFile(path: string, label: string, cwd: string) {
  const stream = createWriteStream(path);
  const tap = traceTap((record) => stream.write(`${JSON.stringify(record)}\n`), { peer: 'client', label, meta: { agent: label, cwd } });
  return {
    tap,
    close: () => new Promise<void>((resolve) => stream.end(resolve)),
  };
}

/** Start an agent, run one prompt, close it, and resolve with the turn's result. */
export async function run(
  agent: Parameters<typeof start>[0],
  prompt: PromptInput,
  options: StartOptions & Pick<PromptOptions, 'limits' | 'timeoutMs' | 'signal'>
): Promise<TurnResult> {
  const { limits, timeoutMs, signal, ...startOptions } = options;
  const started = await start(agent, startOptions);
  try {
    return await started.run(prompt, { ...(limits ? { limits } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(signal ? { signal } : {}) });
  } finally {
    await started.close();
  }
}

/**
 * Serve an agent on this process's stdin and stdout, for any ACP client.
 * `console.log` and friends write to stderr from then on, so a stray log
 * line cannot corrupt the protocol stream (`redirectConsole: false` to keep them).
 */
export function serveStdio(options: AgentOptions & { redirectConsole?: boolean }): RpcPeer {
  const { redirectConsole, ...agentOptions } = options;
  if (redirectConsole ?? true) {
    for (const level of ['log', 'info', 'debug'] as const) console[level] = console.error.bind(console);
  }
  return serveAgent(
    ndjson({
      readable: Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
      writable: Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    }),
    agentOptions
  );
}
