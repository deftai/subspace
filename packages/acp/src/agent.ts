/**
 * The agent side of ACP, written once for v1 and v2.
 *
 *   serveAgent(channel, {
 *     name: 'echo',
 *     async prompt(turn) {
 *       await turn.say(`You said: ${turn.text}`);
 *       return 'end_turn';
 *     },
 *   });
 *
 * - The client's `session/cancel` aborts `turn.signal`; return when it fires.
 *   The turn then ends `cancelled`, and tool calls still open are marked failed.
 * - Unknown sessions get -32002 (never a silently created session).
 * - v1 and v2 differ on the wire (tool call create vs upsert, prompt answer vs
 *   idle state); the handler does not see that.
 */
import {
  cancelRequest,
  RpcError,
  RpcPeer,
  type Channel,
  type RequestHandler,
  type RequestOptions,
  type RpcPeerOptions,
} from '@deft-subspace/kernel';
import { CapabilityError, clientSupport, type ClientSupport } from './capabilities.ts';
import {
  callExtension,
  registerExtensions,
  type ExtensionHandler,
  type ExtensionNotification,
  type ExtensionRequest,
} from './extensions.ts';
import { base64, SessionWork } from './background.ts';
import { McpCaller, type McpServerClient } from './mcp-caller.ts';
import { parseMcpServers, type McpServer } from './mcp.ts';
import type { ContentBlock, PermissionOption, ProtocolVersion, StopReason, ToolCallContent, ToolCallStatus } from './model.ts';

export interface ToolCallInit {
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: unknown[];
  rawInput?: unknown;
  /** v2: let the client cancel this tool call alone (`tool_call/cancel`); watch `handle.signal`. */
  cancellable?: boolean;
}

export interface ToolCallHandle {
  readonly id: string;
  /**
   * Fires when this tool call should stop: the turn is cancelled (unless it
   * was detached), the client cancels it (if cancellable), or the session closes.
   */
  readonly signal: AbortSignal;
  update(fields: Partial<Omit<ToolCallInit, 'cancellable'>> & { rawOutput?: unknown }): Promise<void>;
  complete(fields?: { content?: ToolCallContent[]; rawOutput?: unknown }): Promise<void>;
  fail(fields?: { content?: ToolCallContent[]; rawOutput?: unknown }): Promise<void>;
  /** End it `cancelled` (e.g. after `signal` fired). */
  cancelled(fields?: { content?: ToolCallContent[]; rawOutput?: unknown }): Promise<void>;
  /**
   * v2: keep it running in the background after the turn: listed on state
   * updates, not stopped by `session/cancel`. Finish it with complete, fail or
   * cancelled as usual. v1 has no background work: it is only no longer failed with the turn.
   */
  detach(): Promise<void>;
}

/**
 * Thrown by `turn.tool()` when the user refused a tool that asked first.
 * A prompt handler that lets it escape ends the turn `end_turn`: the agent
 * stopped because it was not allowed, which is not an error.
 */
export class PermissionDenied extends Error {
  readonly title: string;

  constructor(title: string) {
    super(`Not allowed: ${title}`);
    this.name = 'PermissionDenied';
    this.title = title;
  }
}

/** v2: a terminal the agent runs and shows the client (display only). */
export interface TerminalDisplay {
  readonly id: string;
  /** Fires when the client cancels it (if cancellable), the turn is cancelled (unless detached), or the session closes. */
  readonly signal: AbortSignal;
  /** Append output (bytes, or text as UTF-8). */
  write(data: string | Uint8Array): Promise<void>;
  /** Replace all output so far. */
  replace(data: string | Uint8Array): Promise<void>;
  /** The process exited. */
  exit(status?: { exitCode?: number; signal?: string }): Promise<void>;
  /** Keep it running in the background after the turn (listed until it exits). */
  detach(): Promise<void>;
}

/** Fields of a tool call update, in ACP's wire names (`toolCallId`, `rawInput`, ...). */
export type ToolCallFields = { toolCallId: string } & Record<string, unknown>;

export interface AgentTurn {
  readonly sessionId: string;
  readonly protocol: ProtocolVersion;
  /** What the client said it can do in initialize (v1 `clientCapabilities`, v2 `capabilities`). */
  readonly clientCapabilities: Record<string, unknown>;
  /** The same, as one shape for v1 and v2. */
  readonly clientSupports: ClientSupport;
  /** The session's MCP servers, typed (from session/new, load or resume). */
  readonly mcpServers: readonly McpServer[];
  /**
   * A server the client serves over this connection (`acp` in `mcpServers`),
   * by name: `listTools()`, `callTool()`, `request()`. Calls are cancelled
   * with the turn. Throws if the session has no `acp` server of that name.
   */
  mcp(name: string): McpServerClient;
  /** Read a file through the client (v1 `fs/read_text_file`). Throws a `CapabilityError` if it offers none. */
  readFile(path: string, options?: { line?: number; limit?: number }): Promise<string>;
  /** Write a file through the client (v1 `fs/write_text_file`). Throws a `CapabilityError` if it offers none. */
  writeFile(path: string, content: string): Promise<void>;
  /** Tell the client a URL-mode elicitation finished (`elicitation/complete`). */
  completeElicitation(elicitationId: string): Promise<void>;
  /** Call one of the client's vendor extension requests. Aborted with the turn. */
  call<Params, Result>(extension: ExtensionRequest<Params, Result>, params: Params): Promise<Result>;
  /** Send one of the client's vendor extension notifications. */
  notify<Params>(extension: ExtensionNotification<Params>, params: Params): Promise<void>;
  readonly prompt: ContentBlock[];
  /** The prompt's text blocks, joined. */
  readonly text: string;
  /** Aborted when the client cancels the turn or the connection closes. */
  readonly signal: AbortSignal;
  say(text: string): Promise<void>;
  think(text: string): Promise<void>;
  toolCall(init: ToolCallInit & { id?: string }): Promise<ToolCallHandle>;
  /**
   * Run a tool as one step: show the tool call, ask first if `ask` is set
   * (`true`, or the question to ask), run `run`, and complete it with what
   * `run` returns (a string becomes text content) or fail it if `run` throws.
   * A refusal throws `PermissionDenied`; let it escape to end the turn.
   *
   *   const files = await turn.tool({ title: 'List files', kind: 'read' }, () => readdir(cwd));
   *   await turn.tool({ title: 'Delete build/', kind: 'delete', ask: true }, () => rm('build', { recursive: true }));
   */
  tool<T>(init: string | (ToolCallInit & { id?: string; ask?: boolean | string }), run: (call: ToolCallHandle) => T | Promise<T>): Promise<T>;
  plan(entries: Array<{ content: string; priority?: string; status?: string }>): Promise<void>;
  /**
   * Send a tool call update you already have in ACP shape (e.g. from a model
   * pipeline). `create` marks the first one: v1 sends it as `tool_call`; v2
   * always upserts with `tool_call_update`.
   */
  toolCallUpdate(fields: ToolCallFields, options?: { create?: boolean }): Promise<void>;
  /** Send any `session/update` as given. You are responsible for it suiting `protocol`. */
  sendUpdate(update: Record<string, unknown> & { sessionUpdate: string }): Promise<void>;
  /** Call the client (e.g. `fs/read_text_file`, `terminal/create`). Aborted with the turn unless you pass a signal. */
  request<Result = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<Result>;
  /** Echo or record the user's own message as an update (`user_message_chunk`). */
  userMessage(text: string): Promise<void>;
  /**
   * Run a command in the client's terminal (v1 clients that advertise `terminal`).
   * Throws if the client offers none. Release the handle when done.
   */
  terminal(command: string, options?: { args?: string[]; cwd?: string; env?: Record<string, string>; outputByteLimit?: number }): Promise<TerminalHandle>;
  /**
   * Ask the user through the client (`elicitation/create`). Throws if the client
   * offers no elicitation. A cancelled turn answers `cancel`.
   */
  elicit(request: {
    message: string;
    requestedSchema?: unknown;
    url?: string;
    toolCallId?: string;
  }): Promise<
    | { action: 'accept'; content?: Record<string, unknown>; elicitationId?: string }
    | { action: 'decline'; elicitationId?: string }
    | { action: 'cancel'; elicitationId?: string }
  >;
  /**
   * v2: show the client a terminal this agent runs (`terminal_update`,
   * `terminal_output_chunk`). Refer to it from a tool call with content
   * `{ type: 'terminal', terminalId: display.id }`. Throws on v1.
   */
  showTerminal(init: {
    command?: string;
    cwd?: string;
    size?: { cols: number; rows: number };
    /** Let the client stop it (`terminal/cancel`); watch `display.signal`. */
    cancellable?: boolean;
    id?: string;
  }): Promise<TerminalDisplay>;
  /** Ask the user. `allowed` is false for rejections and when the turn was cancelled. */
  requestPermission(request: {
    title: string;
    toolCallId?: string;
    options?: PermissionOption[];
  }): Promise<{ outcome: 'selected'; optionId: string; allowed: boolean } | { outcome: 'cancelled'; allowed: false }>;
}

export interface TerminalHandle {
  readonly id: string;
  output(): Promise<{ output: string; truncated: boolean; exitStatus?: { exitCode?: number | null; signal?: string | null } | null }>;
  waitForExit(): Promise<{ exitCode?: number | null; signal?: string | null }>;
  kill(): Promise<void>;
  release(): Promise<void>;
}

/** What `loadSession` uses to replay history: updates only, no questions to the client. */
export type ReplayWriter = Pick<AgentTurn, 'say' | 'think' | 'userMessage' | 'toolCall' | 'toolCallUpdate' | 'plan' | 'sendUpdate'>;

export interface AgentOptions {
  name: string;
  version?: string;
  /** Protocol versions to accept. Default [1, 2]. */
  protocols?: ProtocolVersion[];
  /** Extra fields for initialize's capabilities (v1 `agentCapabilities`, v2 `capabilities`). */
  capabilities?: Record<string, unknown>;
  /**
   * MCP server transports to advertise. `acp` (servers the client serves over
   * this connection) is handled here: use `turn.mcp(name)`. For the others the
   * agent connects itself. v1 always takes stdio. Default: none (v1: stdio).
   */
  mcpTransports?: Array<'stdio' | 'http' | 'sse' | 'acp'>;
  newSession?(request: {
    cwd: string;
    /** As sent. */
    mcpServers: unknown[];
    /** The same, typed; entries of unknown transports left out. */
    servers: McpServer[];
    /** session/new's params as sent. */
    params: Record<string, unknown>;
  }): Promise<{ sessionId?: string } | void> | { sessionId?: string } | void;
  prompt(turn: AgentTurn): Promise<StopReason | void> | StopReason | void;
  /** More request handlers, e.g. vendor `_name/method` extensions. Registered before the first message. */
  methods?: Record<string, RequestHandler<any>>;
  /**
   * Reopen an existing session: v1 `session/load` (with `replay`) and
   * `session/resume` (without), v2 `session/resume` (with `replay` when the
   * client asks for it). Replay history through `replay` before returning; the
   * client is answered after. Throw `RpcError.notFound(...)` for an unknown id.
   * Providing it advertises loading and resuming.
   */
  loadSession?(request: {
    sessionId: string;
    cwd: string;
    mcpServers: unknown[];
    servers: McpServer[];
    params: Record<string, unknown>;
    replay?: ReplayWriter;
  }): Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  /** Called when the client closes a session (`session/close`), after its turn is cancelled. */
  closeSession?(sessionId: string): Promise<void> | void;
  /** Queue a prompt that arrives while a turn is running, instead of refusing it. Default false. */
  queuePrompts?: boolean;
  /** Handlers for the client's calls to your vendor extension methods (see `extensionRequest`, `handle`). */
  extensions?: ExtensionHandler[];
  peer?: Omit<RpcPeerOptions, 'cancelOutbound' | 'cancelInbound'>;
}

const randomUUID = (): string => globalThis.crypto.randomUUID();
const isFinal = (status: unknown) => status === 'completed' || status === 'failed' || status === 'cancelled';

const DEFAULT_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

interface AgentSession {
  id: string;
  controller?: AbortController;
  /** Prompts waiting for the running one (with `queuePrompts`). */
  waiting: Set<AbortController>;
  /** Settles when the last queued turn ends. */
  tail: Promise<void>;
  servers: McpServer[];
  /** Background and cancellable work (v2). */
  work: SessionWork;
}

/** initialize's MCP capability, in each protocol's spelling. */
function mcpCapabilities(protocol: ProtocolVersion, transports: AgentOptions['mcpTransports'] = []): Record<string, unknown> {
  if (protocol === 2) return Object.fromEntries(transports.filter((t) => t !== 'sse').map((t) => [t, {}]));
  return Object.fromEntries(transports.filter((t) => t !== 'stdio').map((t) => [t, true]));
}

export function serveAgent(channel: Channel<unknown>, options: AgentOptions): RpcPeer {
  const accepted = options.protocols ?? [1, 2];
  const sessions = new Map<string, AgentSession>();
  let protocol: ProtocolVersion = 1;
  let clientCapabilities: Record<string, unknown> = {};

  const peer = new RpcPeer(channel, {
    name: options.name,
    ...options.peer,
    ...cancelRequest,
  });
  const mcpCaller = new McpCaller(peer, { name: options.name, version: options.version ?? '0.0.0' });
  const newSession = (id: string, servers: McpServer[] = []): AgentSession => ({
    id,
    waiting: new Set(),
    tail: Promise.resolve(),
    servers,
    work: new SessionWork((update) => peer.notify('session/update', { sessionId: id, update })),
  });

  peer.onRequest('initialize', (params: { protocolVersion?: unknown; capabilities?: unknown; clientCapabilities?: unknown }) => {
    const asked = Number(params?.protocolVersion);
    const best = Math.max(...accepted) as ProtocolVersion;
    protocol = (accepted.includes(asked as ProtocolVersion) ? asked : best) as ProtocolVersion;
    const caps = protocol === 2 ? params?.capabilities : params?.clientCapabilities;
    clientCapabilities = caps && typeof caps === 'object' ? (caps as Record<string, unknown>) : {};
    const info = { name: options.name, version: options.version ?? '0.0.0' };
    const mcp = mcpCapabilities(protocol, options.mcpTransports);
    const extra = options.capabilities ?? {};
    if (protocol === 2) {
      const session = { ...((extra.session as Record<string, unknown> | undefined) ?? {}) };
      if (Object.keys(mcp).length) session.mcp = { ...mcp, ...((session.mcp as Record<string, unknown> | undefined) ?? {}) };
      return { protocolVersion: 2, info, capabilities: { ...extra, ...(Object.keys(session).length ? { session } : {}) }, authMethods: [] };
    }
    return {
      protocolVersion: 1,
      agentInfo: info,
      agentCapabilities: {
        loadSession: !!options.loadSession,
        sessionCapabilities: { close: {}, ...(options.loadSession ? { resume: {} } : {}) },
        ...(Object.keys(mcp).length ? { mcpCapabilities: mcp } : {}),
        ...extra,
      },
      authMethods: [],
    };
  });

  for (const [method, handler] of Object.entries(options.methods ?? {})) peer.onRequest(method, handler);
  registerExtensions(peer, options.extensions);

  peer.onRequest('session/new', async (params: { cwd?: string; mcpServers?: unknown[] } & Record<string, unknown>) => {
    if (typeof params?.cwd !== 'string') throw RpcError.invalidParams('cwd is required');
    const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    const { servers } = parseMcpServers(mcpServers);
    const created = await options.newSession?.({ cwd: params.cwd, mcpServers, servers, params });
    const id = (created && created.sessionId) || randomUUID();
    sessions.set(id, newSession(id, servers));
    return { sessionId: id };
  });

  if (options.loadSession) {
    const load = options.loadSession;
    const open = async (params: Record<string, unknown>, replay: boolean) => {
      if (typeof params?.sessionId !== 'string') throw RpcError.invalidParams('sessionId is required');
      if (typeof params.cwd !== 'string') throw RpcError.invalidParams('cwd is required');
      const id = params.sessionId;
      const writer = replay
        ? new TurnWriter(peer, id, protocol, [], new AbortController().signal, clientCapabilities, [], mcpCaller, undefined).api
        : undefined;
      const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
      const { servers } = parseMcpServers(mcpServers);
      const result = await load({
        sessionId: id,
        cwd: params.cwd,
        mcpServers,
        servers,
        params,
        ...(writer ? { replay: writer } : {}),
      });
      const existing = sessions.get(id);
      if (existing) existing.servers = servers;
      else sessions.set(id, newSession(id, servers));
      return result ?? {};
    };
    peer.onRequest<Record<string, unknown>>('session/load', (params) => open(params, true));
    peer.onRequest<Record<string, unknown>>('session/resume', (params) =>
      open(params, protocol === 2 && !!params?.replayFrom)
    );
  }

  peer.onRequest('session/close', async (params: { sessionId?: string }) => {
    const session = params?.sessionId ? sessions.get(params.sessionId) : undefined;
    if (!session) throw RpcError.notFound(`Unknown session ${String(params?.sessionId)}`, { sessionId: params?.sessionId });
    session.controller?.abort(new Error('session closed'));
    for (const waiting of session.waiting) waiting.abort(new Error('session closed'));
    // Closing stops background work too.
    session.work.closeAll();
    sessions.delete(session.id);
    await options.closeSession?.(session.id);
    return {};
  });

  // v2: stop one cancellable tool call or terminal (background work, or a step of the turn).
  for (const [method, kind, key] of [
    ['tool_call/cancel', 'tool_call', 'toolCallId'],
    ['terminal/cancel', 'terminal', 'terminalId'],
  ] as const) {
    peer.onRequest(method, (params: Record<string, unknown>) => {
      const session = typeof params?.sessionId === 'string' ? sessions.get(params.sessionId) : undefined;
      if (!session) throw RpcError.notFound(`Unknown session ${String(params?.sessionId)}`, { sessionId: params?.sessionId });
      if (typeof params[key] !== 'string') throw RpcError.invalidParams(`${key} is required`);
      session.work.cancel(kind, params[key] as string);
      return {};
    });
  }

  peer.onNotification('session/cancel', (params: { sessionId?: string }) => {
    const session = params?.sessionId ? sessions.get(params.sessionId) : undefined;
    session?.controller?.abort(new Error('cancelled by the client'));
    // Queued prompts are cancelled too: the client asked for the session to stop.
    for (const waiting of session?.waiting ?? []) waiting.abort(new Error('cancelled by the client'));
  });

  peer.onRequest('session/prompt', async (params: { sessionId?: string; prompt?: ContentBlock[] }, context) => {
    const session = params?.sessionId ? sessions.get(params.sessionId) : undefined;
    if (!session) throw RpcError.notFound(`Unknown session ${String(params?.sessionId)}`, { sessionId: params?.sessionId });
    const busy = !!session.controller || session.waiting.size > 0;
    if (busy && !options.queuePrompts) throw RpcError.invalidParams(`Session ${session.id} already has a turn running`);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, peer.signal]);
    const turn = new TurnWriter(peer, session.id, protocol, params.prompt ?? [], signal, clientCapabilities, session.servers, mcpCaller, session.work);
    // Wait for the turn ahead (if any), in order.
    const ahead = session.tail;
    let release!: () => void;
    session.tail = new Promise<void>((resolve) => (release = resolve));
    session.waiting.add(controller);

    const run = async (onStart?: () => Promise<void>): Promise<StopReason> => {
      await ahead;
      session.waiting.delete(controller);
      if (signal.aborted) {
        release();
        return 'cancelled';
      }
      session.controller = controller;
      await onStart?.();
      let stop: StopReason;
      try {
        stop = (await options.prompt(turn.api)) ?? 'end_turn';
      } catch (error) {
        if (signal.aborted) {
          stop = 'cancelled';
        } else if (error instanceof PermissionDenied) {
          // The agent stopped because the user said no: a normal end.
          stop = 'end_turn';
        } else {
          if (protocol === 1) throw error;
          await turn.idle('error', { message: error instanceof Error ? error.message : String(error) });
          return 'error';
        }
      } finally {
        session.controller = undefined;
        release();
      }
      if (signal.aborted) {
        stop = 'cancelled';
        await turn.failOpenToolCalls();
      }
      return stop;
    };

    if (protocol === 1) return { stopReason: await run() };

    // v2: answer at once with the user message id, then run; the end is an idle state update.
    const userMessageId = randomUUID();
    setTimeout(() => {
      void (async () => {
        const stop = await run(() => turn.state('running'));
        if (stop !== 'error') await turn.idle(stop);
      })().catch(() => {});
    }, 0);
    void context;
    return { messageId: userMessageId };
  });

  peer.start();
  return peer;
}

class TurnWriter {
  readonly api: AgentTurn;
  private segment = 0;
  private lastWasText = false;
  private readonly open = new Set<string>();
  private readonly peer: RpcPeer;
  private readonly sessionId: string;
  private readonly protocol: ProtocolVersion;
  private readonly turnId = randomUUID().slice(0, 8);
  private readonly work: SessionWork | undefined;
  private readonly signal: AbortSignal;

  constructor(
    peer: RpcPeer,
    sessionId: string,
    protocol: ProtocolVersion,
    prompt: ContentBlock[],
    signal: AbortSignal,
    clientCapabilities: Record<string, unknown>,
    servers: McpServer[],
    mcpCaller: McpCaller,
    work: SessionWork | undefined
  ) {
    this.peer = peer;
    this.sessionId = sessionId;
    this.protocol = protocol;
    this.work = work;
    this.signal = signal;
    const text = prompt
      .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
    const supports = clientSupport(protocol, clientCapabilities);
    this.api = {
      sessionId,
      protocol,
      clientCapabilities,
      clientSupports: supports,
      mcpServers: servers,
      mcp: (name) => {
        const server = servers.find((s): s is McpServer & { type: 'acp' } => s.type === 'acp' && s.name === name);
        if (!server) {
          const offered = servers.filter((s) => s.type === 'acp').map((s) => s.name);
          throw new Error(`The session has no acp MCP server "${name}" (acp servers: ${offered.join(', ') || 'none'})`);
        }
        return mcpCaller.server(server, { signal });
      },
      prompt,
      text,
      signal,
      say: (t) => this.chunk('agent_message_chunk', t),
      think: (t) => this.chunk('agent_thought_chunk', t),
      toolCall: (init) => this.toolCall(init),
      tool: (init, run) => this.tool(init, run),
      showTerminal: (init) => this.showTerminal(init),
      plan: (entries) =>
        this.update(
          protocol === 2
            ? { sessionUpdate: 'plan_update', plan: { type: 'items', entries: entries.map(planEntry) } }
            : { sessionUpdate: 'plan', entries: entries.map(planEntry) }
        ),
      requestPermission: (request) => this.permission(request, signal),
      toolCallUpdate: async (fields, options) => {
        this.lastWasText = false;
        const { toolCallId } = fields;
        if (options?.create) this.open.add(toolCallId);
        if (isFinal(fields.status)) this.open.delete(toolCallId);
        await this.update({
          ...fields,
          sessionUpdate: options?.create && protocol === 1 ? 'tool_call' : 'tool_call_update',
        });
      },
      sendUpdate: (update) => this.update(update),
      request: (method, params, options) => peer.request(method, params, { signal, ...options }),
      userMessage: (text) =>
        this.update({ sessionUpdate: 'user_message_chunk', messageId: `${this.turnId}-u`, content: { type: 'text', text } }),
      readFile: async (path, options) => {
        if (!supports.readTextFile) throw new CapabilityError('fs/read_text_file', 'client');
        const result = await peer.request<{ content: string }>(
          'fs/read_text_file',
          { sessionId, path, ...(options?.line !== undefined ? { line: options.line } : {}), ...(options?.limit !== undefined ? { limit: options.limit } : {}) },
          { signal }
        );
        return result.content;
      },
      writeFile: async (path, content) => {
        if (!supports.writeTextFile) throw new CapabilityError('fs/write_text_file', 'client');
        await peer.request('fs/write_text_file', { sessionId, path, content }, { signal });
      },
      completeElicitation: (elicitationId) => peer.notify('elicitation/complete', { sessionId, elicitationId }),
      call: (extension, params) => callExtension(peer, extension, params, { signal }),
      notify: (extension, params) => peer.notify(extension.method, params),
      terminal: async (command, options) => {
        if (!supports.terminal) throw new CapabilityError('terminals', 'client');
        const created = await peer.request<{ terminalId: string }>(
          'terminal/create',
          {
            sessionId,
            command,
            args: options?.args ?? [],
            env: Object.entries(options?.env ?? {}).map(([name, value]) => ({ name, value })),
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            ...(options?.outputByteLimit ? { outputByteLimit: options.outputByteLimit } : {}),
          },
          { signal }
        );
        const ref = { sessionId, terminalId: created.terminalId };
        return {
          id: created.terminalId,
          output: () => peer.request('terminal/output', ref, { signal }),
          waitForExit: () => peer.request('terminal/wait_for_exit', ref, { signal }),
          kill: async () => void (await peer.request('terminal/kill', ref)),
          release: async () => void (await peer.request('terminal/release', ref)),
        };
      },
      elicit: async (request) => {
        const mode = request.url ? 'url' : 'form';
        if (!supports.elicitation[mode]) throw new CapabilityError(`${mode} elicitation`, 'client');
        const elicitationId = mode === 'url' ? randomUUID() : undefined;
        const params = {
          sessionId,
          mode,
          message: request.message,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
          ...(mode === 'form'
            ? { requestedSchema: request.requestedSchema ?? { type: 'object', properties: {} } }
            : { url: request.url, elicitationId }),
        };
        const id = elicitationId ? { elicitationId } : {};
        try {
          const answer = await peer.request<{ action?: string; content?: Record<string, unknown> }>('elicitation/create', params, { signal });
          if (answer?.action === 'accept') return { action: 'accept', ...(answer.content ? { content: answer.content } : {}), ...id };
          if (answer?.action === 'decline') return { action: 'decline', ...id };
        } catch {
          // Aborted with the turn, or an error answer.
        }
        return { action: 'cancel', ...id };
      },
    };
  }

  update(update: Record<string, unknown>): Promise<void> {
    return this.peer.notify('session/update', { sessionId: this.sessionId, update });
  }

  state(state: 'running' | 'requires_action'): Promise<void> {
    if (this.work) this.work.state = state;
    return this.update({ sessionUpdate: 'state_update', state, ...this.work?.fields() });
  }

  idle(stopReason: StopReason, error?: unknown): Promise<void> {
    if (this.work) this.work.state = 'idle';
    return this.update({ sessionUpdate: 'state_update', state: 'idle', stopReason, ...(error ? { error } : {}), ...this.work?.fields() });
  }

  async failOpenToolCalls(): Promise<void> {
    for (const id of [...this.open]) await this.toolUpdate(id, { status: 'failed' });
  }

  private chunk(kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string): Promise<void> {
    if (!this.lastWasText) this.segment++;
    this.lastWasText = true;
    return this.update({
      sessionUpdate: kind,
      messageId: `${this.turnId}-${kind === 'agent_message_chunk' ? 'm' : 't'}${this.segment}`,
      content: { type: 'text', text },
    });
  }

  private async toolCall(init: ToolCallInit & { id?: string }): Promise<ToolCallHandle> {
    this.lastWasText = false;
    const id = init.id ?? `call-${randomUUID().slice(0, 8)}`;
    const cancellable = !!init.cancellable && this.protocol === 2 && !!this.work;
    const fields = {
      title: init.title,
      kind: init.kind ?? 'other',
      status: init.status ?? 'pending',
      content: init.content ?? [],
      locations: init.locations ?? [],
      ...(init.rawInput !== undefined ? { rawInput: init.rawInput } : {}),
      ...(cancellable ? { capabilities: { cancel: {} } } : {}),
    };
    this.open.add(id);
    const work = this.work?.add('tool_call', id, cancellable, this.signal);
    // v1 creates with tool_call; v2 has only the upsert.
    await this.update({ sessionUpdate: this.protocol === 1 ? 'tool_call' : 'tool_call_update', toolCallId: id, ...fields });
    return {
      id,
      signal: work?.controller.signal ?? this.signal,
      update: (f) => this.toolUpdate(id, f),
      complete: (f) => this.toolUpdate(id, { ...f, status: 'completed' }),
      fail: (f) => this.toolUpdate(id, { ...f, status: 'failed' }),
      cancelled: (f) => this.toolUpdate(id, { ...f, status: 'cancelled' }),
      detach: async () => {
        // No longer the turn's: not failed when it is cancelled.
        this.open.delete(id);
        if (work && this.protocol === 2) await this.work!.detach(work);
      },
    };
  }

  private async tool<T>(
    init: string | (ToolCallInit & { id?: string; ask?: boolean | string }),
    run: (call: ToolCallHandle) => T | Promise<T>
  ): Promise<T> {
    const { ask, ...fields } = typeof init === 'string' ? { title: init, ask: undefined } : init;
    const text = (t: string): ToolCallContent[] => [{ type: 'content', content: { type: 'text', text: t } } as ToolCallContent];
    const call = await this.toolCall({ ...fields, status: ask ? 'pending' : 'in_progress' });
    if (ask) {
      const answer = await this.permission({ title: typeof ask === 'string' ? ask : fields.title, toolCallId: call.id }, this.signal);
      if (!answer.allowed) {
        await call.fail({ content: text(answer.outcome === 'cancelled' ? 'Cancelled' : 'Not allowed') });
        throw new PermissionDenied(fields.title);
      }
      await call.update({ status: 'in_progress' });
    }
    try {
      const result = await run(call);
      await call.complete(typeof result === 'string' ? { content: text(result) } : result === undefined ? {} : { rawOutput: result });
      return result;
    } catch (error) {
      // v1 has no cancelled status.
      if (call.signal.aborted && this.protocol === 2) await call.cancelled();
      else await call.fail({ content: text(error instanceof Error ? error.message : String(error)) });
      throw error;
    }
  }

  private async toolUpdate(id: string, fields: Record<string, unknown>): Promise<void> {
    this.lastWasText = false;
    const final = isFinal(fields.status);
    if (final) this.open.delete(id);
    const work = this.work?.get('tool_call', id);
    // A finished tool call stops advertising cancel.
    await this.update({ sessionUpdate: 'tool_call_update', toolCallId: id, ...fields, ...(final && work?.cancellable ? { capabilities: null } : {}) });
    if (final && work) await this.work!.finish(work);
  }

  private async showTerminal(init: Parameters<AgentTurn['showTerminal']>[0]): Promise<TerminalDisplay> {
    if (this.protocol !== 2 || !this.work) throw new CapabilityError('agent terminals (protocol v2)', 'client');
    const id = init.id ?? `term-${randomUUID().slice(0, 8)}`;
    const work = this.work.add('terminal', id, !!init.cancellable, this.signal);
    const terminal = (fields: Record<string, unknown>) => this.update({ sessionUpdate: 'terminal_update', terminalId: id, ...fields });
    await terminal({
      ...(init.command !== undefined ? { command: init.command } : {}),
      ...(init.cwd !== undefined ? { cwd: init.cwd } : {}),
      ...(init.size ? { size: init.size } : {}),
      ...(init.cancellable ? { capabilities: { cancel: {} } } : {}),
    });
    return {
      id,
      signal: work.controller.signal,
      write: (data) => this.update({ sessionUpdate: 'terminal_output_chunk', terminalId: id, data: base64(data) }),
      replace: (data) => terminal({ output: { data: base64(data) } }),
      exit: async (status = {}) => {
        await terminal({ exitStatus: status, ...(init.cancellable ? { capabilities: null } : {}) });
        await this.work!.finish(work);
      },
      detach: () => this.work!.detach(work),
    };
  }

  private async permission(
    request: { title: string; toolCallId?: string; options?: PermissionOption[] },
    signal: AbortSignal
  ): Promise<{ outcome: 'selected'; optionId: string; allowed: boolean } | { outcome: 'cancelled'; allowed: false }> {
    const options = request.options ?? DEFAULT_OPTIONS;
    // An existing tool call is referred to by id only, so its own title stays.
    const toolCall = request.toolCallId
      ? { toolCallId: request.toolCallId }
      : { toolCallId: `permission-${randomUUID().slice(0, 8)}`, title: request.title };
    const params =
      this.protocol === 2
        ? { sessionId: this.sessionId, title: request.title, subject: { type: 'tool_call', toolCall }, options }
        : { sessionId: this.sessionId, toolCall, options };
    try {
      const result = (await this.peer.request('session/request_permission', params, { signal })) as {
        outcome?: { outcome?: string; optionId?: string };
      };
      const outcome = result?.outcome;
      if (outcome?.outcome === 'selected' && typeof outcome.optionId === 'string') {
        const option = options.find((o) => o.optionId === outcome.optionId);
        return { outcome: 'selected', optionId: outcome.optionId, allowed: !!option && option.kind.startsWith('allow') };
      }
    } catch {
      // Aborted, closed, or an error answer: treated as not allowed.
    }
    return { outcome: 'cancelled', allowed: false };
  }
}

function planEntry(entry: { content: string; priority?: string; status?: string }) {
  return { content: entry.content, priority: entry.priority ?? 'medium', status: entry.status ?? 'pending' };
}
