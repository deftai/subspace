/**
 * The quick way in (Node): start a known agent with sensible defaults, run
 * turns with handler options, and serve an agent on stdio.
 *
 *   const agent = await start('claude', { onPermission: (r) => (r.toolCall?.kind === 'read' ? 'allow' : 'reject') });
 *   try {
 *     await agent.run('Summarize README.md', { onMessage: (delta) => process.stdout.write(delta) });
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
import { ErrorCode, ndjson, RpcError, type RpcPeer } from '@deft-subspace/kernel';
import { serveAgent, type AgentOptions } from './agent.ts';
import type { ElicitationHandler, PromptOptions, Session, SessionMcpServers } from './client.ts';
import { mergeHandlers, type TurnHandlers } from './handlers.ts';
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
}

/** Known agents. Adapters run through `npx`, so the first start may download them. */
export const AGENT_PRESETS = {
  claude: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    mode: 'default',
    description: 'Claude Code through its ACP adapter, in ask-first mode',
  },
  codex: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    mode: 'read-only',
    description: 'OpenAI Codex through its ACP adapter, in read-only mode (it still acts once you allow it)',
  },
  grok: {
    command: 'grok',
    args: ['--permission-mode', 'default', 'agent', 'stdio'],
    description: 'Grok Build, asking before tools',
  },
  gemini: { command: 'gemini', args: ['--experimental-acp'], description: 'Gemini CLI' },
  opencode: { command: 'opencode', args: ['acp'], description: 'OpenCode' },
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
}

export interface StartedAgent {
  readonly client: ConnectedAgent['client'];
  readonly process: ConnectedAgent['process'];
  /** The session opened by `start()`. */
  readonly session: Session;
  /** Why the preset's mode was not applied, if it was not. */
  readonly modeWarning?: string;
  /** Run one turn in the session and resolve with its result (after its handlers ran). */
  run(prompt: string | ContentBlock | ContentBlock[], options?: PromptOptions): Promise<TurnResult>;
  /** Start a turn in the session; iterate it, or pass handlers. */
  prompt(prompt: string | ContentBlock | ContentBlock[], options?: PromptOptions): Turn;
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
  if (!options.permissions && !handlers?.onPermission) {
    throw new TypeError(
      "start() needs an answer for the agent's permission questions: pass onPermission: (request) => 'allow' or 'reject', " +
        "or permissions: 'reject' to refuse everything ('allow' to allow everything)."
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const { extraArgs, mode: modeOption, session: sessionOptions, handleSignals, files, ...rest } = options;
  // Advertise form questions so a turn's onQuestion can answer them; decline otherwise.
  const decline: ElicitationHandler = () => ({ action: 'decline' });
  const connected = await connectAgent(preset.command, {
    ...rest,
    args: [...preset.args, ...(extraArgs ?? [])],
    cwd,
    ...(files === false ? {} : files ? { files } : { workspace: cwd }),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(handlers ? { handlers } : {}),
    elicitation: options.elicitation ?? decline,
    elicitationModes: options.elicitationModes ?? ['form'],
  });
  const mode = modeOption === false ? undefined : (modeOption ?? preset.mode);
  let modeWarning: string | undefined;

  const open = async (extra: StartOptions['session'] = sessionOptions): Promise<Session> => {
    const params = { cwd, ...(extra?.mcpServers ? { mcpServers: extra.mcpServers } : {}), ...(extra?.additionalDirectories ? { additionalDirectories: extra.additionalDirectories } : {}) };
    let session: Session;
    try {
      session = await connected.client.newSession(params);
    } catch (error) {
      // Not logged in, and only one way to log in that the agent handles itself: use it, once.
      const methods = connected.client.authMethods.filter((m) => m.type === 'agent');
      if (!(RpcError.is(error) && error.code === ErrorCode.AuthRequired && methods.length === 1)) throw error;
      await connected.client.authenticate(methods[0]!.id);
      session = await connected.client.newSession(params);
    }
    if (mode) {
      if (session.modes?.available.some((m) => m.id === mode)) await session.setMode(mode);
      else modeWarning = `The agent offers no mode "${mode}" (offered: ${session.modes?.available.map((m) => m.id).join(', ') || 'none'}); it runs in its own.`;
    }
    return session;
  };

  let session: Session;
  try {
    session = await open();
  } catch (error) {
    await connected.close();
    throw error;
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
    })());
  if (handleSignals ?? true) process.once('SIGINT', onSignal);

  const started: StartedAgent = {
    client: connected.client,
    process: connected.process,
    session,
    get modeWarning() {
      return modeWarning;
    },
    run: (prompt, promptOptions) => session.prompt(prompt, promptOptions).done,
    prompt: (prompt, promptOptions) => session.prompt(prompt, promptOptions),
    newSession: (extra) => open(extra),
    close,
    [Symbol.asyncDispose]: close,
  };
  return started;
}

/** Start an agent, run one prompt, close it, and resolve with the turn's result. */
export async function run(
  agent: Parameters<typeof start>[0],
  prompt: string | ContentBlock | ContentBlock[],
  options: StartOptions & Pick<PromptOptions, 'limits'>
): Promise<TurnResult> {
  const { limits, ...startOptions } = options;
  const started = await start(agent, startOptions);
  try {
    return await started.run(prompt, limits ? { limits } : {});
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
