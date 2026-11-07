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
 * - Presets for known agents (claude, codex, grok, gemini, opencode), each
 *   started in the mode where it asks before acting, so your permission
 *   answers are actually consulted. `{ mode }` overrides, `mode: false` keeps
 *   the agent's own.
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
import type { ElicitationHandler, PromptOptions, Session, SessionMcpServers } from './client.ts';
import { mergeHandlers, type TurnHandlers } from './handlers.ts';
import { conveniences, type SessionConveniences } from './conveniences.ts';
import { openSession, requirePermissionAnswer } from './open.ts';
import type { ContentBlock, TurnResult } from './model.ts';
import type { PermissionPolicy } from './permissions.ts';
import { connectAgent, type ConnectAgentOptions, type ConnectedAgent } from './node.ts';
import type { Turn } from './turn.ts';

export interface AgentPreset {
  command: string;
  args: string[];
  /** The mode to switch each session to (the agent's ask-first mode). */
  mode?: string;
  description: string;
  /** How to install it, for the error when it is missing. */
  install?: string;
  /** How to log in, for the error when it needs a login. */
  login?: string;
}

/** Known agents. Adapters run through `npx`, so the first start may download them. */
export const AGENT_PRESETS = {
  claude: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    mode: 'default',
    description: 'Claude Code through its ACP adapter, in ask-first mode',
    install: 'Install Node.js (for npx); the adapter downloads on first start',
    login: 'Log in to Claude Code first: run `claude` and sign in, or set ANTHROPIC_API_KEY',
  },
  codex: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    mode: 'read-only',
    description: 'OpenAI Codex through its ACP adapter, in read-only mode (it still acts once you allow it)',
    install: 'Install Node.js (for npx); the adapter downloads on first start',
    login: 'Log in to Codex first: run `codex login`, or set OPENAI_API_KEY',
  },
  grok: {
    command: 'grok',
    args: ['--permission-mode', 'default', 'agent', 'stdio'],
    description: 'Grok Build, asking before tools',
    install: 'Install Grok Build (the `grok` command)',
    login: 'Log in to Grok Build first: run `grok` and sign in',
  },
  gemini: {
    command: 'gemini',
    args: ['--experimental-acp'],
    description: 'Gemini CLI',
    install: 'Install the Gemini CLI (npm install -g @google/gemini-cli)',
    login: 'Log in to the Gemini CLI first: run `gemini` and sign in, or set GEMINI_API_KEY',
  },
  opencode: {
    command: 'opencode',
    args: ['acp'],
    description: 'OpenCode',
    install: 'Install OpenCode (the `opencode` command)',
    login: 'Log in to OpenCode first: run `opencode auth login`',
  },
} as const satisfies Record<string, AgentPreset>;

export type AgentName = keyof typeof AGENT_PRESETS;

export interface StartOptions extends Omit<ConnectAgentOptions, 'cwd' | 'workspace' | 'permissions' | 'handlers' | 'args' | 'files'>, TurnHandlers {
  /** The agent's folder, the workspace its file requests stay in, and the session's cwd. Default `process.cwd()`. */
  cwd?: string;
  /** Serve the agent's file requests from `cwd` (v1). Default true. */
  files?: ConnectAgentOptions['files'] | false;
  /** Arguments added after the preset's. */
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
  /** Why the preset's mode was not applied, if it was not. */
  readonly modeWarning?: string;
  /** Another session with the same agent (switched to the same mode). */
  newSession(options?: StartOptions['session']): Promise<Session>;
  /** Cancel what is running, close the session and the connection, and stop the agent. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Start a known agent (or `{ command, args }`) and open a session. */
export async function start(agent: AgentName | (Omit<AgentPreset, 'description'> & { description?: string }), options: StartOptions): Promise<StartedAgent> {
  const preset: Omit<AgentPreset, 'description'> = typeof agent === 'string' ? AGENT_PRESETS[agent] : agent;
  if (!preset) throw new TypeError(`Unknown agent "${String(agent)}". Known: ${Object.keys(AGENT_PRESETS).join(', ')}, or pass { command, args }.`);
  const handlers = mergeHandlers(options.handlers, options);
  requirePermissionAnswer(options, 'start()');
  const cwd = options.cwd ?? process.cwd();
  const { extraArgs, mode: modeOption, session: sessionOptions, handleSignals, files, trace, quiet, ...rest } = options;
  // A label for messages and traces: the preset's name, or the program (and the script it runs).
  const script = preset.args.find((a) => !a.startsWith('-'));
  const name = typeof agent === 'string' ? agent : [basename(preset.command), ...(script ? [basename(script)] : [])].join(' ');
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
function explain(error: unknown, preset: Partial<AgentPreset>, name: string): unknown {
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
  prompt: string | ContentBlock | ContentBlock[],
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
