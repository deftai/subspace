/**
 * Opening a ready session, for any channel: `connectSession()` is `start()`
 * for a connection you already have (a socket, an in-process agent).
 *
 *   const { session, run, close } = await connectSession(channel, {
 *     cwd: '/work',
 *     onPermission: (request) => (request.toolCall?.kind === 'read' ? 'allow' : 'reject'),
 *     onMessage: (delta, { separator }) => process.stdout.write(separator + delta),
 *   });
 *   await run('What does this repo do?');
 *   await close();
 */
import type { Channel } from '@deft-subspace/kernel';
import { ErrorCode, RpcError } from '@deft-subspace/kernel';
import { AcpClient, type ClientOptions, type PromptOptions, type Session, type SessionMcpServers } from './client.ts';
import { mergeHandlers, type TurnHandlers } from './handlers.ts';
import type { ContentBlock, TurnResult } from './model.ts';
import type { Turn } from './turn.ts';

export interface SessionSetup {
  cwd: string;
  mcpServers?: SessionMcpServers;
  additionalDirectories?: string[];
  /** Switch the session to this mode, if the agent offers it. */
  mode?: string;
}

/**
 * Open a session: on "needs a login", if the agent offers exactly one method
 * it handles itself, log in with it once and try again; then switch to `mode`
 * when offered. A mode the agent does not offer is a warning, not a failure.
 */
export async function openSession(client: AcpClient, setup: SessionSetup): Promise<{ session: Session; modeWarning?: string }> {
  const params = {
    cwd: setup.cwd,
    ...(setup.mcpServers ? { mcpServers: setup.mcpServers } : {}),
    ...(setup.additionalDirectories ? { additionalDirectories: setup.additionalDirectories } : {}),
  };
  let session: Session;
  try {
    session = await client.newSession(params);
  } catch (error) {
    const methods = client.authMethods.filter((m) => m.type === 'agent');
    if (!(RpcError.is(error) && error.code === ErrorCode.AuthRequired && methods.length === 1)) throw error;
    await client.authenticate(methods[0]!.id);
    session = await client.newSession(params);
  }
  if (!setup.mode) return { session };
  if (session.modes?.available.some((m) => m.id === setup.mode)) {
    await session.setMode(setup.mode);
    return { session };
  }
  const offered = session.modes?.available.map((m) => m.id).join(', ') || 'none';
  return { session, modeWarning: `The agent offers no mode "${setup.mode}" (offered: ${offered}); it runs in its own.` };
}

/** Throws unless the options say how to answer permission questions. */
export function requirePermissionAnswer(options: Pick<ClientOptions, 'permissions' | 'handlers'> & TurnHandlers, caller: string): void {
  if (options.permissions || mergeHandlers(options.handlers, options)?.onPermission) return;
  throw new TypeError(
    `${caller} needs an answer for the agent's permission questions: pass onPermission: (request) => 'allow' or 'reject', ` +
      "or permissions: 'reject' to refuse everything ('allow' to allow everything)."
  );
}

export interface ConnectSessionOptions extends ClientOptions, Partial<SessionSetup> {}

export interface ConnectedSession {
  readonly client: AcpClient;
  readonly session: Session;
  readonly modeWarning?: string;
  /** Run one turn and resolve with its result (after its handlers ran). */
  run(prompt: string | ContentBlock | ContentBlock[], options?: PromptOptions): Promise<TurnResult>;
  prompt(prompt: string | ContentBlock | ContentBlock[], options?: PromptOptions): Turn;
  /** Close the session and the connection. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Connect over a channel and open a session, ready for turns. Handler options
 * are defaults for every turn. Like `start()`, it needs a permission answer.
 * `cwd` defaults to `process.cwd()` where there is one.
 */
export async function connectSession(channel: Channel<unknown>, options: ConnectSessionOptions): Promise<ConnectedSession> {
  requirePermissionAnswer(options, 'connectSession()');
  const { cwd, mcpServers, additionalDirectories, mode, ...clientOptions } = options;
  const folder = cwd ?? (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
  if (!folder) throw new TypeError('connectSession() needs a cwd here (there is no process.cwd())');
  const client = await AcpClient.connect(channel, clientOptions);
  let opened: Awaited<ReturnType<typeof openSession>>;
  try {
    opened = await openSession(client, {
      cwd: folder,
      ...(mcpServers ? { mcpServers } : {}),
      ...(additionalDirectories ? { additionalDirectories } : {}),
      ...(mode ? { mode } : {}),
    });
  } catch (error) {
    await client.close();
    throw error;
  }
  const { session } = opened;
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      await session.close().catch(() => {});
      await client.close();
    })());
  return {
    client,
    session,
    ...(opened.modeWarning ? { modeWarning: opened.modeWarning } : {}),
    run: (prompt, promptOptions) => session.prompt(prompt, promptOptions).done,
    prompt: (prompt, promptOptions) => session.prompt(prompt, promptOptions),
    close,
    [Symbol.asyncDispose]: close,
  };
}
