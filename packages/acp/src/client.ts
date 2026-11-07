/**
 * The host side of ACP: connect to an agent, open sessions, run turns.
 *
 *   const client = await AcpClient.connect(channel, { name: 'my-app' });
 *   const session = await client.newSession({ cwd });
 *   const turn = session.prompt('hello');
 *   for await (const event of turn) ...
 *
 * The client asks for protocol v2 and accepts v1; the app sees the same model
 * either way (`client.protocol` says which one is in use).
 */
import { validateElicitation } from './elicitation.ts';
import { mergeHandlers, observes, type TurnHandlers } from './handlers.ts';
import {
  cancelRequest,
  LocalError,
  RpcError,
  RpcPeer,
  type Channel,
  type PeerDiagnostic,
  type RpcPeerOptions,
} from '@deft-subspace/kernel';
import type {
  BackgroundItem,
  ContentBlock,
  Exhaustion,
  PermissionRequest,
  ProtocolVersion,
  ToolCall,
  TurnEvent,
  TurnLimits,
  TurnResult,
  v1,
  v2,
} from './model.ts';
import { authMethodNames, authMethodsFrom, canLogout, type AuthMethod } from './auth.ts';
import { agentSupport, CapabilityError, type AgentSupport } from './capabilities.ts';
import { configOptionsFrom, configParams, type ConfigOption, type SelectConfigOption } from './config.ts';
import {
  callExtension,
  registerExtensions,
  type ExtensionHandler,
  type ExtensionNotification,
  type ExtensionRequest,
} from './extensions.ts';
import { modesFrom, modesFromConfig, type SessionModes } from './modes.ts';
import { decide, type PermissionPolicy } from './permissions.ts';
import { backgroundOf, TurnProjection } from './projection.ts';
import { McpProvider, mcpServersParam, type McpRegistration, type McpServer, type ServeMcpOptions } from './mcp.ts';
import { Terminals } from './terminals.ts';
import { Turn } from './turn.ts';

/** File access an agent may ask for (v1 `fs/*`). See `workspaceFiles()` in `@deft-subspace/acp/node`. */
export interface FileHandlers {
  readTextFile(request: { path: string; line?: number | null; limit?: number | null }): Promise<string>;
  writeTextFile(request: { path: string; content: string }): Promise<void>;
}

/**
 * Terminals an agent may run (v1 `terminal/*`). See `workspaceTerminals()` in
 * `@deft-subspace/acp/node`. v2 removed client terminals, so these are only
 * offered to v1 agents.
 */
export interface TerminalHandlers {
  create(request: v1.CreateTerminalRequest): Promise<{ terminalId: string }>;
  output(request: { sessionId: string; terminalId: string }): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
  }>;
  waitForExit(request: { sessionId: string; terminalId: string }): Promise<{ exitCode?: number | null; signal?: string | null }>;
  kill(request: { sessionId: string; terminalId: string }): Promise<void>;
  release(request: { sessionId: string; terminalId: string }): Promise<void>;
}

/** What an agent asks the user for (`elicitation/create`): a form, or a URL to visit. */
export interface ElicitationRequest {
  sessionId?: string;
  toolCallId?: string;
  mode: 'form' | 'url' | (string & {});
  message: string;
  /** `form`: the JSON Schema of the answer. */
  requestedSchema?: unknown;
  /** `url`: where to send the user, and the id the agent completes it by. */
  url?: string;
  elicitationId?: string;
  raw: unknown;
}

export type ElicitationResponse =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

/**
 * Answer an elicitation. Anything that goes wrong becomes `decline`, and so
 * does a form answer that does not fit `requestedSchema` (check it first with
 * `validateElicitation` to ask the user again instead).
 */
export type ElicitationHandler = (
  request: ElicitationRequest,
  signal: AbortSignal
) => ElicitationResponse | Promise<ElicitationResponse>;

/**
 * Connection options. Handler options (`onMessage`, `onToolCall`,
 * `onPermission`, `onQuestion`, ...) may be given flat here, as defaults for
 * every turn, or under `handlers`.
 */
export interface ClientOptions extends TurnHandlers {
  name?: string;
  version?: string;
  /** `'auto'` asks for v2 and accepts v1. Default `'auto'`. */
  protocol?: 'auto' | ProtocolVersion;
  /** How to answer permission questions. Default `'reject'`: nothing is allowed unless you say so. */
  permissions?: PermissionPolicy;
  /** Serve the agent's file requests (v1). Without this, the client advertises no file access. */
  files?: FileHandlers;
  /** Run the agent's terminal commands (v1). Without this, the client advertises no terminal. */
  terminals?: TerminalHandlers;
  /** Answer the agent's questions to the user (`elicitation/create`). Without this, none are advertised. */
  elicitation?: ElicitationHandler;
  /** Which elicitation modes to advertise with `elicitation`. Default both. Requests in other modes are declined. */
  elicitationModes?: Array<'form' | 'url'>;
  /**
   * The app can run the agent again in a terminal for the user to log in
   * (`terminal` login methods, with their `args` and `env`). Default false:
   * agents then list only methods they handle themselves.
   */
  terminalAuth?: boolean;
  timeouts?: {
    /** initialize. Default 60 s (agents often install on first run). */
    initializeMs?: number;
    /** session/new. Default 60 s. */
    sessionMs?: number;
    /** How long a cancelled turn may take to confirm before it is ended here. Default 10 s. */
    cancelGraceMs?: number;
    /** authenticate / auth/login. Default 5 min (the user may be logging in in a browser). */
    authMs?: number;
  };
  /** Limits for every turn, unless a prompt sets its own. Default: none. */
  limits?: TurnLimits;
  /** Handlers for every turn (see `TurnHandlers`); a prompt's own replace them one by one. */
  handlers?: TurnHandlers;
  /** Queue a prompt sent while a turn is running, instead of throwing. Per prompt: `{ queue }`. Default false. */
  queuePrompts?: boolean;
  /** Handlers for the agent's vendor extension methods (see `extensionRequest`, `handle`). */
  extensions?: ExtensionHandler[];
  /** The agent finished a URL-mode elicitation (`elicitation/complete`). */
  onElicitationComplete?: (notification: { elicitationId: string; sessionId?: string }) => void;
  /** Sees every JSON-RPC message, both directions. */
  tap?: RpcPeerOptions['tap'];
  onDiagnostic?: (diagnostic: PeerDiagnostic) => void;
}

/** Which existing session to open, and where. */
/** Options for one prompt: limits, queueing, and handlers for this turn. */
export type PromptOptions = {
  limits?: TurnLimits;
  queue?: boolean;
  /** Cancel the turn when this fires. */
  signal?: AbortSignal;
  /** Cancel the turn after this long (the same as `limits.maxDurationMs`). */
  timeoutMs?: number;
} & TurnHandlers;

/** MCP servers for a session: declarations, or registrations from `client.serveMcp()`. */
export type SessionMcpServers = ReadonlyArray<McpServer | McpRegistration>;

export interface SessionLocator {
  sessionId: string;
  cwd: string;
  mcpServers?: SessionMcpServers;
  additionalDirectories?: string[];
}

export interface AgentInfo {
  name?: string;
  title?: string;
  version?: string;
}

export class AcpClient {
  readonly peer: RpcPeer;
  readonly protocol: ProtocolVersion;
  readonly agent: AgentInfo;
  /** The agent's capabilities as it sent them (v1 `agentCapabilities` or v2 `capabilities`). */
  readonly capabilities: Record<string, unknown>;
  /** What the agent can do, the same shape for v1 and v2. */
  readonly supports: AgentSupport;
  /** How the agent lets you log in (`initialize`'s `authMethods`). Empty if it needs no login. */
  readonly authMethods: readonly AuthMethod[];

  private readonly options: ClientOptions;
  private readonly mcp: McpProvider;
  private readonly sessions = new Map<string, Session>();
  /** Updates for a session id not registered yet: agents often send them right after session/new. */
  private readonly early = new Map<string, unknown[]>();
  private turnCounter = 0;

  private constructor(peer: RpcPeer, protocol: ProtocolVersion, init: Record<string, unknown>, options: ClientOptions, mcp: McpProvider) {
    this.peer = peer;
    this.mcp = mcp;
    this.protocol = protocol;
    this.options = options;
    const info = (init.info ?? init.agentInfo ?? {}) as AgentInfo;
    this.agent = { name: info.name, title: info.title, version: info.version };
    this.capabilities = (init.capabilities ?? init.agentCapabilities ?? {}) as Record<string, unknown>;
    this.supports = agentSupport(protocol, this.capabilities);
    this.authMethods = authMethodsFrom(init);
    // In v2 a running turn has no request in flight, so the connection closing
    // must end it explicitly.
    void peer.closed.then((info) => {
      const error = new LocalError(
        'closed',
        info.reason === 'remote-ended' ? 'The agent closed the connection' : 'The connection to the agent closed',
        { cause: info.error }
      );
      for (const session of this.sessions.values()) session.connectionClosed(error);
    });
  }

  /** Connect over a channel of JSON-RPC messages (use `ndjson()` for bytes). */
  static async connect(channel: Channel<unknown>, options: ClientOptions = {}): Promise<AcpClient> {
    // Flat handler options and `handlers` are one set of defaults for every turn.
    const handlers = mergeHandlers(options.handlers, options);
    options = { ...options, ...(handlers ? { handlers } : {}) };
    // An onQuestion is no use unless the agent is told it may ask: advertise forms (others declined).
    if (handlers?.onQuestion && !options.elicitation) {
      options = { ...options, elicitation: () => ({ action: 'decline' }), elicitationModes: options.elicitationModes ?? ['form'] };
    }
    const peer = new RpcPeer(channel, {
      name: options.name ?? 'acp-client',
      ...cancelRequest,
      tap: options.tap,
      onDiagnostic: options.onDiagnostic,
    });
    // Handlers are registered before the first message can arrive.
    let client: AcpClient | undefined;
    peer.onNotification('session/update', (params: { sessionId?: string; update?: unknown }) => {
      client?.routeUpdate(params);
    });
    peer.onRequest<Record<string, unknown>>('session/request_permission', (params, context) => {
      if (!client) throw RpcError.internal('Not initialized');
      return client.handlePermission(params, context.signal);
    });
    if (options.files) {
      const files = options.files;
      peer.onRequest('fs/read_text_file', async (p: v1.ReadTextFileRequest) => ({ content: await files.readTextFile(p) }));
      peer.onRequest('fs/write_text_file', async (p: v1.WriteTextFileRequest) => {
        await files.writeTextFile(p);
        return {};
      });
    }
    if (options.terminals) {
      const t = options.terminals;
      peer.onRequest('terminal/create', (p: v1.CreateTerminalRequest) => t.create(p));
      peer.onRequest('terminal/output', (p: { sessionId: string; terminalId: string }) => t.output(p));
      peer.onRequest('terminal/wait_for_exit', (p: { sessionId: string; terminalId: string }) => t.waitForExit(p));
      peer.onRequest('terminal/kill', async (p: { sessionId: string; terminalId: string }) => {
        await t.kill(p);
        return {};
      });
      peer.onRequest('terminal/release', async (p: { sessionId: string; terminalId: string }) => {
        await t.release(p);
        return {};
      });
    }
    registerExtensions(peer, options.extensions);
    if (options.onElicitationComplete) {
      const done = options.onElicitationComplete;
      peer.onNotification<{ elicitationId?: unknown; sessionId?: unknown }>('elicitation/complete', (p) => {
        if (typeof p?.elicitationId !== 'string') return;
        done({ elicitationId: p.elicitationId, ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}) });
      });
    }
    if (options.elicitation) {
      const handler = options.elicitation;
      peer.onRequest<Record<string, unknown>>('elicitation/create', async (p, context) => {
        const request: ElicitationRequest = {
          mode: String(p?.mode ?? ''),
          message: String(p?.message ?? ''),
          raw: p,
          ...(typeof p?.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(typeof p?.toolCallId === 'string' ? { toolCallId: p.toolCallId } : {}),
          ...(p?.requestedSchema !== undefined ? { requestedSchema: p.requestedSchema } : {}),
          ...(typeof p?.url === 'string' ? { url: p.url } : {}),
          ...(typeof p?.elicitationId === 'string' ? { elicitationId: p.elicitationId } : {}),
        };
        if (!(options.elicitationModes ?? ['form', 'url']).includes(request.mode as 'form')) return { action: 'decline' };
        try {
          // The running turn's onQuestion, if it has one, else the client's.
          const perTurn = request.sessionId ? client?.questionHandlerFor(request.sessionId) : undefined;
          const answer = await (perTurn ?? handler)(request, context.signal);
          if (answer?.action === 'accept') {
            // A form answer must fit the form; one that does not is not sent.
            if (request.mode === 'form' && validateElicitation(request.requestedSchema, answer.content).length) return { action: 'decline' };
            return { action: 'accept', ...(answer.content ? { content: answer.content } : {}) };
          }
          if (answer?.action === 'cancel') return { action: 'cancel' };
        } catch {
          // Fail closed.
        }
        return { action: 'decline' };
      });
    }
    // Always answers mcp/message: unknown servers get -33001.
    const mcp = new McpProvider(peer);
    peer.start();

    const wanted = options.protocol ?? 'auto';
    const name = options.name ?? 'deft-subspace';
    const version = options.version ?? '0.0.0';
    const modes = options.elicitationModes ?? ['form', 'url'];
    const elicitation = options.elicitation && modes.length ? Object.fromEntries(modes.map((m) => [m, {}])) : undefined;
    const v1Capabilities: v1.ClientCapabilities = {
      fs: { readTextFile: !!options.files, writeTextFile: !!options.files },
      terminal: !!options.terminals,
      ...(options.terminalAuth ? { auth: { terminal: true } } : {}),
      ...(elicitation ? { elicitation } : {}),
    };
    const v2Capabilities: v2.ClientCapabilities = {
      ...(options.terminalAuth ? { auth: { terminal: {} } } : {}),
      ...(elicitation ? { elicitation } : {}),
    };
    // One request both generations understand: v2 fields plus their v1 names.
    const params: Record<string, unknown> =
      wanted === 1
        ? { protocolVersion: 1, clientInfo: { name, version }, clientCapabilities: v1Capabilities }
        : {
            protocolVersion: 2,
            info: { name, version },
            capabilities: v2Capabilities,
            clientInfo: { name, version },
            clientCapabilities: v1Capabilities,
          };
    const init = (await peer.request('initialize', params, {
      timeoutMs: options.timeouts?.initializeMs ?? 60_000,
    })) as Record<string, unknown>;
    const negotiated = Number(init?.protocolVersion);
    if (negotiated !== 1 && negotiated !== 2) {
      await peer.close();
      throw new Error(`Agent answered with protocol version ${String(init?.protocolVersion)}; this client speaks 1 and 2`);
    }
    if (wanted !== 'auto' && negotiated !== wanted) {
      await peer.close();
      throw new Error(`Asked for protocol v${wanted}, agent chose v${negotiated}`);
    }
    client = new AcpClient(peer, negotiated as ProtocolVersion, init, options, mcp);
    return client;
  }

  async newSession(request: { cwd: string; mcpServers?: SessionMcpServers; additionalDirectories?: string[] }): Promise<Session> {
    const result = (await this.peer.request(
      'session/new',
      { cwd: request.cwd, mcpServers: this.mcpServers(request.mcpServers), ...(request.additionalDirectories ? { additionalDirectories: request.additionalDirectories } : {}) },
      { timeoutMs: this.options.timeouts?.sessionMs ?? 60_000 }
    )) as { sessionId?: unknown } & Record<string, unknown>;
    if (typeof result?.sessionId !== 'string' || !result.sessionId) {
      throw new LocalError('invalid-response', 'session/new returned no sessionId', { method: 'session/new' });
    }
    const session = new Session(this, result.sessionId, result);
    this.sessions.set(session.id, session);
    const early = this.early.get(session.id);
    this.early.delete(session.id);
    for (const update of early ?? []) session.receive(update);
    return session;
  }

  /**
   * Open an existing session and replay its history: v1 `session/load`, v2
   * `session/resume` from the start. The replayed updates come back as events,
   * in order; the session then behaves like a new one.
   */
  async loadSession(request: SessionLocator): Promise<{ session: Session; replayed: TurnEvent[] }> {
    if (!this.supports.loadSession) throw new CapabilityError('session/load', 'agent');
    const session = this.register(request.sessionId);
    const replayed: TurnEvent[] = [];
    const stop = session.onIdleUpdate((event) => replayed.push(event));
    try {
      const result = await this.peer.request(
        this.protocol === 1 ? 'session/load' : 'session/resume',
        this.locator(request, this.protocol === 2 ? { replayFrom: { type: 'start' } } : {}),
        { timeoutMs: this.options.timeouts?.sessionMs ?? 60_000 }
      );
      session.absorb(result);
      return { session, replayed };
    } catch (error) {
      this.sessions.delete(request.sessionId);
      throw error;
    } finally {
      stop();
    }
  }

  /** Reopen an existing session without replaying its history (`session/resume`). */
  async resumeSession(request: SessionLocator): Promise<Session> {
    if (!this.supports.resumeSession) throw new CapabilityError('session/resume', 'agent');
    const session = this.register(request.sessionId);
    try {
      session.absorb(
        await this.peer.request('session/resume', this.locator(request), { timeoutMs: this.options.timeouts?.sessionMs ?? 60_000 })
      );
      return session;
    } catch (error) {
      this.sessions.delete(request.sessionId);
      throw error;
    }
  }

  /** The agent's sessions (`session/list`), one page at a time. */
  async listSessions(request: { cwd?: string; cursor?: string } = {}): Promise<{
    sessions: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>;
    nextCursor?: string;
  }> {
    if (!this.supports.listSessions) throw new CapabilityError('session/list', 'agent');
    const result = (await this.peer.request('session/list', request)) as { sessions?: unknown; nextCursor?: unknown };
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    return {
      sessions: sessions as Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>,
      ...(typeof result?.nextCursor === 'string' ? { nextCursor: result.nextCursor } : {}),
    };
  }

  /**
   * Log in with one of the agent's `authMethods` (v1 `authenticate`, v2
   * `auth/login`). For an `agent` method the agent does the work, which can
   * mean waiting for the user in a browser. Throws for a method it did not list.
   */
  async authenticate(methodId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    if (!this.authMethods.some((m) => m.id === methodId)) {
      throw new Error(`The agent offers no login method "${methodId}" (offered: ${this.authMethods.map((m) => m.id).join(', ') || 'none'})`);
    }
    await this.peer.request(authMethodNames(this.protocol).login, { methodId }, {
      timeoutMs: options.timeoutMs ?? this.options.timeouts?.authMs ?? 300_000,
      signal: options.signal,
    });
  }

  /** Log out (v1 `logout`, if the agent offers it; v2 `auth/logout`). */
  async logout(options: { timeoutMs?: number } = {}): Promise<void> {
    if (!canLogout(this.protocol, this.capabilities, [...this.authMethods])) throw new CapabilityError('logout', 'agent');
    await this.peer.request(authMethodNames(this.protocol).logout, {}, { timeoutMs: options.timeoutMs ?? 30_000 });
  }

  /** Whether `logout()` can be called. */
  get canLogout(): boolean {
    return canLogout(this.protocol, this.capabilities, [...this.authMethods]);
  }

  /**
   * Delete a session from the agent's history (`session/delete`). An open
   * session with that id is closed here first (a running turn is cancelled).
   */
  async deleteSession(sessionId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.supports.deleteSession) throw new CapabilityError('session/delete', 'agent');
    const open = this.sessions.get(sessionId);
    if (open) await open.shutDown();
    await this.peer.request('session/delete', { sessionId }, { timeoutMs: options.timeoutMs ?? 30_000 });
  }

  /**
   * Serve an MCP server to the agent over this connection (MCP-over-ACP).
   * Put the registration in a session's `mcpServers`; the agent must
   * advertise the `acp` MCP transport (`client.supports.mcp.acp`). The server
   * serves requests as soon as this returns; `dispose()` stops it.
   */
  serveMcp(options: ServeMcpOptions): McpRegistration {
    return this.mcp.serve(options);
  }

  private mcpServers(servers: SessionMcpServers | undefined): unknown[] {
    return mcpServersParam(this.protocol, this.supports, servers ?? []);
  }

  /** Call one of the agent's vendor extension requests. */
  call<Params, Result>(extension: ExtensionRequest<Params, Result>, params: Params, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Result> {
    return callExtension(this.peer, extension, params, options);
  }

  /** Send one of the agent's vendor extension notifications. */
  notify<Params>(extension: ExtensionNotification<Params>, params: Params): Promise<void> {
    return this.peer.notify(extension.method, params);
  }

  /** @internal */
  get queuePrompts(): boolean {
    return this.options.queuePrompts ?? false;
  }

  /** @internal */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private register(sessionId: string): Session {
    if (this.sessions.has(sessionId)) throw new Error(`Session ${sessionId} is already open on this connection`);
    const session = new Session(this, sessionId, {});
    this.sessions.set(sessionId, session);
    const early = this.early.get(sessionId);
    this.early.delete(sessionId);
    for (const update of early ?? []) session.receive(update);
    return session;
  }

  private locator(request: SessionLocator, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: request.sessionId,
      cwd: request.cwd,
      mcpServers: this.mcpServers(request.mcpServers),
      ...(request.additionalDirectories ? { additionalDirectories: request.additionalDirectories } : {}),
      ...extra,
    };
  }

  /** Close the connection. Running turns fail with a `closed` LocalError. */
  async close(): Promise<void> {
    await this.peer.close();
  }

  /** @internal */
  nextTurnId(sessionId: string): string {
    return `${sessionId}#${++this.turnCounter}`;
  }

  /** @internal */
  /** @internal */
  get defaultHandlers(): TurnHandlers | undefined {
    return this.options.handlers;
  }

  /** @internal The running turn's question handler in a session, if any. */
  questionHandlerFor(sessionId: string): ElicitationHandler | undefined {
    return this.sessions.get(sessionId)?.questionHandler;
  }

  /** @internal */
  get defaultLimits(): TurnLimits | undefined {
    return this.options.limits;
  }

  /** @internal */
  get cancelGraceMs(): number {
    return this.options.timeouts?.cancelGraceMs ?? 10_000;
  }

  private routeUpdate(params: { sessionId?: string; update?: unknown }): void {
    if (typeof params?.sessionId !== 'string') return;
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.receive(params.update);
      return;
    }
    // Keep a few, for a session/new still being answered; drop the rest.
    const held = this.early.get(params.sessionId) ?? [];
    if (held.length < 100) held.push(params.update);
    this.early.set(params.sessionId, held);
    if (this.early.size > 16) this.early.delete(this.early.keys().next().value as string);
  }

  private async handlePermission(params: Record<string, unknown>, signal: AbortSignal): Promise<v1.RequestPermissionResponse> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const session = this.sessions.get(sessionId);
    if (!session) throw RpcError.notFound(`Unknown session ${sessionId}`);
    return session.permission(params, signal, this.options.handlers?.onPermission ?? this.options.permissions ?? 'reject');
  }
}

interface ActiveTurn {
  turn: Turn;
  projection: TurnProjection;
  /** This turn's own answers (prompt handlers), over the client's. */
  permissions?: PermissionPolicy;
  question?: ElicitationHandler;
  promptAnswered: boolean;
  idle?: { stopReason: string; error?: unknown };
  cancelController: AbortController;
  limits: TurnLimits;
  toolCalls: number;
  exhausted?: Exhaustion;
  /** Permission requests refused while the turn was not being cancelled. */
  refused: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const unrefTimer = (handle: ReturnType<typeof setTimeout>) => {
  (handle as { unref?: () => void }).unref?.();
  return handle;
};

export class Session {
  readonly id: string;
  readonly client: AcpClient;
  /** What session/new (or load, or resume) returned. */
  created: Record<string, unknown>;
  /** Title and update time, from the agent's `session_info_update`. */
  readonly info: { title?: string; updatedAt?: string } = {};
  /**
   * Terminals the agent runs and shows (v2 `terminal_update`,
   * `terminal_output_chunk`), by id. Kept across turns: one may outlive the
   * turn that started it, and its updates may come before the tool call that
   * shows it.
   */
  readonly terminals = new Terminals();

  private active?: ActiveTurn;
  /** Prompts waiting for the running turn to end (with `queue`). */
  private readonly queued: Array<{ active: ActiveTurn; blocks: ContentBlock[] }> = [];
  private readonly listeners = new Set<(event: TurnEvent, raw: unknown) => void>();
  /** Recent updates between turns, replayed to listeners added later. */
  private readonly idleHistory: Array<{ event: TurnEvent; raw: unknown }> = [];
  private currentModes?: SessionModes;
  private currentConfig: ConfigOption[] = [];
  /** Tool calls of earlier turns (and between turns), kept so later updates to background work patch them. */
  private readonly idleProjection: TurnProjection;
  private currentBackground?: BackgroundItem[];

  /** @internal */
  constructor(client: AcpClient, id: string, created: Record<string, unknown>) {
    this.client = client;
    this.id = id;
    this.created = created;
    this.currentModes = modesFrom(created);
    this.currentConfig = configOptionsFrom(created.configOptions) ?? [];
    this.idleProjection = new TurnProjection(`${id}#idle`, this.terminals);
  }

  /**
   * v2: the work the agent says runs in the background (terminals, tool calls,
   * subagents), from its latest state update. Undefined when it does not
   * report it, which means unknown, not "nothing".
   */
  get background(): readonly BackgroundItem[] | undefined {
    return this.currentBackground;
  }

  /** Tool calls of earlier turns, and of work between turns, by id (background work lives here). */
  get toolCalls(): ReadonlyMap<string, Readonly<ToolCall>> {
    return this.idleProjection.toolCalls;
  }

  /**
   * v2: stop one tool call (`tool_call/cancel`), without cancelling the turn.
   * Only for a tool call that advertises it (`cancellable`). Resolves when the
   * agent has accepted; it confirms with a final status on the tool call.
   */
  async cancelToolCall(toolCallId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const call = this.active?.projection.toolCalls.get(toolCallId) ?? this.idleProjection.toolCalls.get(toolCallId);
    if (this.client.protocol !== 2 || !call?.cancellable) throw new CapabilityError(`cancelling tool call ${toolCallId}`, 'agent');
    await this.client.peer.request('tool_call/cancel', { sessionId: this.id, toolCallId }, { timeoutMs: options.timeoutMs ?? 30_000 });
  }

  /**
   * v2: stop the process behind one of the agent's terminals (`terminal/cancel`).
   * Only for a terminal that advertises it. The agent confirms with its exit status;
   * the output stays.
   */
  async cancelTerminal(terminalId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.client.protocol !== 2 || !this.terminals.get(terminalId)?.cancellable) {
      throw new CapabilityError(`cancelling terminal ${terminalId}`, 'agent');
    }
    await this.client.peer.request('terminal/cancel', { sessionId: this.id, terminalId }, { timeoutMs: options.timeoutMs ?? 30_000 });
  }

  /** Whether a tool call is background work: listed, or showing a listed terminal. */
  private isBackground(call: Pick<ToolCall, 'id' | 'content'>): boolean {
    const list = this.currentBackground ?? [];
    if (list.some((item) => item.type === 'tool_call' && item.toolCallId === call.id)) return true;
    const terminals = new Set(list.flatMap((item) => (item.type === 'terminal' ? [item.terminalId] : [])));
    return call.content.some((c) => c.type === 'terminal' && terminals.has((c as { terminalId?: string }).terminalId as string));
  }

  /** @internal Take in a load or resume answer (modes, config options). */
  absorb(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    this.created = result as Record<string, unknown>;
    this.currentModes = modesFrom(this.created) ?? this.currentModes;
    this.currentConfig = configOptionsFrom(this.created.configOptions) ?? this.currentConfig;
  }

  /**
   * End this session: cancel a running turn, then `session/close` if the agent
   * supports it (v1 says so in `sessionCapabilities.close`; v2 agents are
   * asked). The session is forgotten here either way.
   */
  async close(): Promise<void> {
    await this.shutDown();
    try {
      if (this.client.supports.closeSession) {
        await this.client.peer.request('session/close', { sessionId: this.id }, { timeoutMs: 10_000 });
      }
    } catch {
      // Not supported, or the agent is gone: the session is closed here regardless.
    } finally {
      this.client.forget(this.id);
    }
  }

  /** @internal Stop queued and running turns and forget the session here, without telling the agent. */
  async shutDown(): Promise<void> {
    for (const queued of this.queued.splice(0)) queued.active.turn.finish(this.notSent());
    if (this.active) {
      const turn = this.active.turn;
      await this.cancel();
      await turn.done.catch(() => {});
    }
    this.client.forget(this.id);
  }

  /** The modes the agent offers and the current one, whichever way it offers them. Absent if none. */
  get modes(): Readonly<SessionModes> | undefined {
    return this.currentModes;
  }

  /**
   * Switch mode, through `session/set_mode` or `session/set_config_option`
   * as the agent requires. Throws if the agent offers no such mode.
   */
  async setMode(modeId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const modes = this.currentModes;
    if (!modes) throw new Error(`The agent offers no session modes`);
    if (!modes.available.some((m) => m.id === modeId)) {
      throw new Error(`The agent offers no mode "${modeId}" (available: ${modes.available.map((m) => m.id).join(', ') || 'none'})`);
    }
    if (modes.via === 'modes') {
      await this.client.peer.request('session/set_mode', { sessionId: this.id, modeId }, options);
      modes.current = modeId;
      return;
    }
    const params =
      this.client.protocol === 2
        ? { sessionId: this.id, configId: modes.configId, type: 'id', value: modeId }
        : { sessionId: this.id, configId: modes.configId, value: modeId };
    const result = (await this.client.peer.request('session/set_config_option', params, options)) as Record<string, unknown> | null;
    this.currentModes = (result && modesFromConfig(result.configOptions)) ?? { ...modes, current: modeId };
    this.currentConfig = configOptionsFrom(result?.configOptions) ?? this.withValue(modes.configId!, modeId);
  }

  /**
   * The agent's config options for this session (model, reasoning effort,
   * mode, on/off switches), kept current from its answers and
   * `config_option_update`s. Empty if it offers none.
   */
  get configOptions(): readonly ConfigOption[] {
    return this.currentConfig;
  }

  /** One config option, by id. */
  configOption(id: string): ConfigOption | undefined {
    return this.currentConfig.find((o) => o.id === id);
  }

  /**
   * Set a config option (`session/set_config_option`): a choice's value for a
   * select option, true or false for an on/off one. Throws, without asking
   * the agent, for an option or value it did not offer.
   */
  async setConfigOption(id: string, value: string | boolean, options: { timeoutMs?: number } = {}): Promise<void> {
    const option = this.configOption(id);
    if (!option) {
      throw new Error(`The agent offers no config option "${id}" (offered: ${this.currentConfig.map((o) => o.id).join(', ') || 'none'})`);
    }
    const built = configParams(this.client.protocol, this.id, option, value);
    if ('problem' in built) throw new Error(built.problem);
    const result = (await this.client.peer.request('session/set_config_option', built.params, options)) as Record<string, unknown> | null;
    this.currentConfig = configOptionsFrom(result?.configOptions) ?? this.withValue(id, value);
    this.currentModes = modesFromConfig(result?.configOptions) ?? this.currentModes;
    if (this.currentModes?.via === 'config' && this.currentModes.configId === id && typeof value === 'string') this.currentModes.current = value;
  }

  /** The model option (category `model`, a select), if the agent offers one. */
  get model(): SelectConfigOption | undefined {
    return this.currentConfig.find((o): o is SelectConfigOption => o.category === 'model' && o.type === 'select');
  }

  /** Choose a model: sets the option with category `model`. */
  async setModel(value: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const model = this.model;
    if (!model) throw new Error('The agent offers no model choice');
    await this.setConfigOption(model.id, value, options);
  }

  private withValue(id: string, value: unknown): ConfigOption[] {
    return this.currentConfig.map((o) => (o.id === id ? ({ ...o, currentValue: value } as ConfigOption) : o));
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  /**
   * Updates that arrive between turns (available commands, config options, ...),
   * with the raw update. The last 50 are replayed to a new listener, so nothing
   * sent right after session/new is missed.
   */
  onIdleUpdate(listener: (event: TurnEvent, raw: unknown) => void): () => void {
    for (const { event, raw } of this.idleHistory) listener(event, raw);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start a turn. `limits` replace the client's default limits for this turn.
   * While a turn is running this throws, unless `queue` (or the client's
   * `queuePrompts`) is set: then the turn starts when the running one ends.
   * Content the agent cannot take (an image it did not offer to accept, for
   * example) throws a `CapabilityError`.
   */
  /**
   * Send a prompt. Iterate the turn for its events, or pass handlers
   * (`onMessage`, `onToolCall`, `onPermission`, ...; see `TurnHandlers`):
   * `turn.done` then settles after they ran.
   */
  prompt(input: string | ContentBlock | ContentBlock[], options: PromptOptions = {}): Turn {
    const given: ContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : Array.isArray(input) ? input : [input];
    const blocks = this.fitContent(given);
    if (this.active && !(options.queue ?? this.client.queuePrompts)) {
      throw new Error(`Session ${this.id} already has a turn running (pass { queue: true } to queue it)`);
    }
    const id = this.client.nextTurnId(this.id);
    const projection = new TurnProjection(id, this.terminals);
    const active = {
      projection,
      promptAnswered: false,
      cancelController: new AbortController(),
      limits: {
        ...(options.limits ?? this.client.defaultLimits ?? {}),
        ...(options.timeoutMs !== undefined ? { maxDurationMs: options.timeoutMs } : {}),
      },
      toolCalls: 0,
      refused: 0,
      timers: [],
    } as unknown as ActiveTurn;
    active.turn = new Turn(id, () => this.cancelTurn(active), {
      text: () => projection.text,
      toolCalls: () => [...projection.toolCalls.values()].map((c) => ({ ...c })),
    });
    const handlers = mergeHandlers(this.client.defaultHandlers, options);
    if (handlers?.onPermission) active.permissions = handlers.onPermission;
    if (handlers?.onQuestion) active.question = handlers.onQuestion;
    if (observes(handlers)) active.turn.observe(handlers!);
    if (options.signal) {
      // Aborting the signal cancels the turn (or, if it is queued, means it is never sent).
      const signal = options.signal;
      const onAbort = () => void active.turn.cancel();
      if (signal.aborted) queueMicrotask(onAbort);
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        void active.turn.done.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
      }
    }
    if (this.active) this.queued.push({ active, blocks });
    else this.begin(active, blocks);
    return active.turn;
  }

  /** @internal The running turn's onQuestion. */
  get questionHandler(): ElicitationHandler | undefined {
    return this.active?.question;
  }

  /** Prompts waiting to start. */
  get queuedCount(): number {
    return this.queued.length;
  }

  /**
   * The prompt as the agent can take it: an embedded text file it cannot take
   * becomes text (its path, then its contents); images, audio and binary
   * files it cannot take throw a CapabilityError.
   */
  private fitContent(blocks: ContentBlock[]): ContentBlock[] {
    const can = this.client.supports.prompt;
    return blocks.map((block) => {
      if (block.type === 'image' && !can.image) throw new CapabilityError('image prompts', 'agent');
      if (block.type === 'audio' && !can.audio) throw new CapabilityError('audio prompts', 'agent');
      if (block.type === 'resource' && !can.embeddedContext) {
        const resource = (block as { resource?: { uri?: string; text?: string } }).resource;
        if (typeof resource?.text !== 'string') throw new CapabilityError('embedded resources in prompts', 'agent');
        const name = resource.uri?.replace(/^file:\/\//, '') ?? 'file';
        return { type: 'text', text: `${name}:\n\n\`\`\`\n${resource.text}\n\`\`\`` } as ContentBlock;
      }
      return block;
    });
  }

  private begin(active: ActiveTurn, blocks: ContentBlock[]): void {
    this.active = active;
    const { maxDurationMs } = active.limits;
    if (maxDurationMs !== undefined) {
      active.timers.push(
        unrefTimer(setTimeout(() => this.exhaust(active, { limit: 'duration', max: maxDurationMs, value: maxDurationMs }), maxDurationMs))
      );
    }
    this.restartIdle(active);

    this.client.peer.request('session/prompt', { sessionId: this.id, prompt: blocks }).then(
      (result) => {
        active.promptAnswered = true;
        if (this.client.protocol === 1) {
          const stopReason = String((result as v1.PromptResponse | undefined)?.stopReason ?? 'end_turn');
          this.end(active, stopReason);
        } else if (active.idle) {
          this.end(active, active.idle.stopReason, active.idle.error);
        }
      },
      (error) => this.failTurn(active, error)
    );
  }

  /** The next queued prompt, once nothing is running. */
  private startNext(): void {
    if (this.active) return;
    const next = this.queued.shift();
    if (next) this.begin(next.active, next.blocks);
  }

  /** The result of a queued turn cancelled before it reached the agent. */
  private notSent(): TurnResult {
    return { stopReason: 'cancelled', text: '', toolCalls: [], cancelled: true };
  }

  private cancelTurn(active: ActiveTurn): Promise<void> {
    const index = this.queued.findIndex((q) => q.active === active);
    if (index >= 0) {
      this.queued.splice(index, 1);
      active.turn.finish(this.notSent());
      return Promise.resolve();
    }
    return this.active === active ? this.cancel() : Promise.resolve();
  }

  /** Cancel the running turn, if any. */
  async cancel(): Promise<void> {
    const active = this.active;
    if (!active || active.cancelController.signal.aborted) return;
    // Open permission questions are answered `cancelled`, as the spec requires.
    active.cancelController.abort();
    await this.client.peer.notify('session/cancel', { sessionId: this.id }).catch(() => {});
    const handle = setTimeout(() => {
      if (this.active !== active) return;
      // Background work is not the turn's: session/cancel does not stop it.
      active.turn.push(...active.projection.failOpenToolCalls((call) => this.isBackground(call)));
      this.end(active, 'cancelled', undefined, true);
    }, this.client.cancelGraceMs);
    (handle as { unref?: () => void }).unref?.();
    void active.turn.done.finally(() => clearTimeout(handle)).catch(() => {});
  }

  /** A limit was reached: record it once, tell the turn, cancel. */
  private exhaust(active: ActiveTurn, exhaustion: Exhaustion): void {
    if (this.active !== active || active.exhausted) return;
    active.exhausted = exhaustion;
    active.turn.push({ type: 'exhausted', ...exhaustion });
    void this.cancel();
  }

  private restartIdle(active: ActiveTurn): void {
    const { idleMs } = active.limits;
    if (idleMs === undefined || active.exhausted) return;
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = unrefTimer(
      setTimeout(() => this.exhaust(active, { limit: 'idle', max: idleMs, value: idleMs }), idleMs)
    );
  }

  private stopTimers(active: ActiveTurn): void {
    for (const handle of active.timers) clearTimeout(handle);
    if (active.idleTimer) clearTimeout(active.idleTimer);
  }

  /** @internal */
  connectionClosed(error: LocalError): void {
    for (const queued of this.queued.splice(0)) queued.active.turn.fail(error);
    if (this.active) this.failTurn(this.active, error);
  }

  /** @internal */
  receive(update: unknown): void {
    this.trackModes(update);
    const active = this.active;
    // Updates to tool calls of earlier turns (background work) are not this turn's.
    if (!active || this.ofEarlierTurn(update)) {
      const { events } = this.idleProjection.apply(update);
      for (const event of events) {
        this.idleHistory.push({ event, raw: update });
        if (this.idleHistory.length > 50) this.idleHistory.shift();
        for (const listener of this.listeners) listener(event, update);
      }
      return;
    }
    const { events, state } = active.projection.apply(update);
    active.turn.push(...events);
    this.restartIdle(active);
    this.checkLimits(active, events);
    if (state?.state === 'idle') {
      active.idle = { stopReason: state.stopReason ?? 'end_turn', error: state.error };
      // v2: the turn ends at idle. The prompt answer normally came first.
      if (this.client.protocol === 2 && active.promptAnswered) this.end(active, active.idle.stopReason, active.idle.error);
    }
  }

  private checkLimits(active: ActiveTurn, events: TurnEvent[]): void {
    const { maxToolCalls, maxUsage } = active.limits;
    for (const event of events) {
      if (event.type === 'tool_call' && event.created) {
        active.toolCalls++;
        if (maxToolCalls !== undefined && active.toolCalls > maxToolCalls) {
          this.exhaust(active, { limit: 'toolCalls', max: maxToolCalls, value: active.toolCalls });
        }
      } else if (event.type === 'usage' && maxUsage !== undefined && event.used > maxUsage) {
        this.exhaust(active, { limit: 'usage', max: maxUsage, value: event.used });
      }
    }
  }

  private ofEarlierTurn(update: unknown): boolean {
    const u = update as { sessionUpdate?: unknown; toolCallId?: unknown } | null;
    if (!u || typeof u.toolCallId !== 'string') return false;
    if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update' && u.sessionUpdate !== 'tool_call_content_chunk') return false;
    return this.idleProjection.toolCalls.has(u.toolCallId) && !this.active?.projection.toolCalls.has(u.toolCallId);
  }

  private trackModes(update: unknown): void {
    if (typeof update !== 'object' || update === null) return;
    const u = update as Record<string, unknown>;
    // Every state snapshot replaces the background list; one without it makes it unknown.
    if (u.sessionUpdate === 'state_update') this.currentBackground = backgroundOf(u);
    if (u.sessionUpdate === 'session_info_update') {
      if (typeof u.title === 'string') this.info.title = u.title;
      if (typeof u.updatedAt === 'string') this.info.updatedAt = u.updatedAt;
    }
    if (u.sessionUpdate === 'current_mode_update' && this.currentModes && typeof u.currentModeId === 'string') {
      this.currentModes.current = u.currentModeId;
    } else if (u.sessionUpdate === 'config_option_update') {
      const modes = modesFromConfig(u.configOptions);
      if (modes) this.currentModes = modes;
      const config = configOptionsFrom(u.configOptions);
      if (config) this.currentConfig = config;
    }
  }

  /** @internal */
  async permission(params: Record<string, unknown>, signal: AbortSignal, policy: PermissionPolicy): Promise<v1.RequestPermissionResponse> {
    const active = this.active;
    // A question about listed background work stands on its own: not tied to a turn or its cancel.
    if (this.aboutBackground(params)) {
      const request = this.permissionRequest(params, this.idleProjection);
      const outcome = await decide(policy, request, signal);
      for (const listener of this.listeners) listener({ type: 'permission', request, outcome }, params);
      if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
    }
    // No turn is running, or it is being cancelled: nobody asked for this. Fail closed.
    if (!active || active.cancelController.signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const projection = active.projection;
    const request = this.permissionRequest(params, projection);
    const combined = active ? AbortSignal.any([signal, active.cancelController.signal]) : signal;
    const outcome = await decide(active.permissions ?? policy, request, combined);
    if ((outcome.outcome === 'cancelled' || !outcome.allowed) && !active.cancelController.signal.aborted) active.refused++;
    active?.turn.push({ type: 'permission', request, outcome });
    if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
  }

  /** v2: a permission question whose subject is listed background work (by tool call or terminal). */
  private aboutBackground(params: Record<string, unknown>): boolean {
    const list = this.currentBackground;
    if (this.client.protocol !== 2 || !list?.length) return false;
    const subject = params.subject as Record<string, unknown> | undefined;
    const toolCallId = (subject?.toolCall as { toolCallId?: unknown } | undefined)?.toolCallId ?? subject?.toolCallId;
    const terminalId = subject?.terminalId;
    return list.some(
      (item) =>
        (item.type === 'tool_call' && item.toolCallId === toolCallId) || (item.type === 'terminal' && item.terminalId === terminalId)
    );
  }

  private permissionRequest(params: Record<string, unknown>, projection: TurnProjection): PermissionRequest {
    const options = Array.isArray(params.options) ? (params.options as PermissionRequest['options']) : [];
    let toolCall: ToolCall | undefined;
    let command: PermissionRequest['command'];
    // v1: params.toolCall. v2: params.subject = { type: 'tool_call', toolCall } | { type: 'command', ... }.
    const subject = params.subject as Record<string, unknown> | undefined;
    const rawToolCall = (params.toolCall ?? (subject?.type === 'tool_call' ? subject.toolCall : undefined)) as
      | Record<string, unknown>
      | undefined;
    if (rawToolCall) toolCall = projection.mergeToolCall(rawToolCall);
    if (subject?.type === 'command') command = { command: String(subject.command), cwd: String(subject.cwd) };
    const title =
      typeof params.title === 'string' ? params.title : toolCall?.title || command?.command || 'Permission requested';
    return {
      sessionId: this.id,
      title,
      toolCall: toolCall ? { ...toolCall } : undefined,
      command,
      options,
      protocol: this.client.protocol,
      raw: params,
    };
  }

  private end(active: ActiveTurn, stopReason: string, error?: unknown, forced?: boolean): void {
    if (this.active !== active) return;
    this.active = undefined;
    // Later updates to this turn's tool calls (background work) patch them here.
    for (const [id, call] of active.projection.toolCalls) this.idleProjection.toolCalls.set(id, call);
    this.stopTimers(active);
    queueMicrotask(() => this.startNext());
    const cancelled = active.cancelController.signal.aborted;
    active.turn.finish({
      stopReason,
      text: active.projection.text,
      toolCalls: [...active.projection.toolCalls.values()].map((c) => ({ ...c })),
      cancelled,
      ...(forced ? { forced: true } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(active.exhausted ? { exhausted: active.exhausted } : {}),
      ...(active.refused ? { refused: active.refused } : {}),
    });
  }

  private failTurn(active: ActiveTurn, error: unknown): void {
    if (this.active !== active) return;
    this.active = undefined;
    this.stopTimers(active);
    queueMicrotask(() => this.startNext());
    active.turn.fail(error);
  }
}
