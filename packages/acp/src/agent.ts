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
import type { ContentBlock, PermissionOption, ProtocolVersion, StopReason, ToolCallContent, ToolCallStatus } from './model.ts';

export interface ToolCallInit {
  title: string;
  kind?: string;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: unknown[];
  rawInput?: unknown;
}

export interface ToolCallHandle {
  readonly id: string;
  update(fields: Partial<ToolCallInit> & { rawOutput?: unknown }): Promise<void>;
  complete(fields?: { content?: ToolCallContent[]; rawOutput?: unknown }): Promise<void>;
  fail(fields?: { content?: ToolCallContent[]; rawOutput?: unknown }): Promise<void>;
}

/** Fields of a tool call update, in ACP's wire names (`toolCallId`, `rawInput`, ...). */
export type ToolCallFields = { toolCallId: string } & Record<string, unknown>;

export interface AgentTurn {
  readonly sessionId: string;
  readonly protocol: ProtocolVersion;
  /** What the client said it can do in initialize (v1 `clientCapabilities`, v2 `capabilities`). */
  readonly clientCapabilities: Record<string, unknown>;
  readonly prompt: ContentBlock[];
  /** The prompt's text blocks, joined. */
  readonly text: string;
  /** Aborted when the client cancels the turn or the connection closes. */
  readonly signal: AbortSignal;
  say(text: string): Promise<void>;
  think(text: string): Promise<void>;
  toolCall(init: ToolCallInit & { id?: string }): Promise<ToolCallHandle>;
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
  }): Promise<{ action: 'accept'; content?: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' }>;
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
  newSession?(request: {
    cwd: string;
    mcpServers: unknown[];
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
    params: Record<string, unknown>;
    replay?: ReplayWriter;
  }): Promise<void | Record<string, unknown>> | void | Record<string, unknown>;
  /** Called when the client closes a session (`session/close`), after its turn is cancelled. */
  closeSession?(sessionId: string): Promise<void> | void;
  peer?: Omit<RpcPeerOptions, 'cancelOutbound' | 'cancelInbound'>;
}

const randomUUID = (): string => globalThis.crypto.randomUUID();

const DEFAULT_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

interface AgentSession {
  id: string;
  controller?: AbortController;
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

  peer.onRequest('initialize', (params: { protocolVersion?: unknown; capabilities?: unknown; clientCapabilities?: unknown }) => {
    const asked = Number(params?.protocolVersion);
    const best = Math.max(...accepted) as ProtocolVersion;
    protocol = (accepted.includes(asked as ProtocolVersion) ? asked : best) as ProtocolVersion;
    const caps = protocol === 2 ? params?.capabilities : params?.clientCapabilities;
    clientCapabilities = caps && typeof caps === 'object' ? (caps as Record<string, unknown>) : {};
    const info = { name: options.name, version: options.version ?? '0.0.0' };
    return protocol === 2
      ? { protocolVersion: 2, info, capabilities: { ...options.capabilities }, authMethods: [] }
      : {
          protocolVersion: 1,
          agentInfo: info,
          agentCapabilities: {
            loadSession: !!options.loadSession,
            sessionCapabilities: { close: {}, ...(options.loadSession ? { resume: {} } : {}) },
            ...options.capabilities,
          },
          authMethods: [],
        };
  });

  for (const [method, handler] of Object.entries(options.methods ?? {})) peer.onRequest(method, handler);

  peer.onRequest('session/new', async (params: { cwd?: string; mcpServers?: unknown[] } & Record<string, unknown>) => {
    if (typeof params?.cwd !== 'string') throw RpcError.invalidParams('cwd is required');
    const created = await options.newSession?.({ cwd: params.cwd, mcpServers: params.mcpServers ?? [], params });
    const id = (created && created.sessionId) || randomUUID();
    sessions.set(id, { id });
    return { sessionId: id };
  });

  if (options.loadSession) {
    const load = options.loadSession;
    const open = async (params: Record<string, unknown>, replay: boolean) => {
      if (typeof params?.sessionId !== 'string') throw RpcError.invalidParams('sessionId is required');
      if (typeof params.cwd !== 'string') throw RpcError.invalidParams('cwd is required');
      const id = params.sessionId;
      const writer = replay
        ? new TurnWriter(peer, id, protocol, [], new AbortController().signal, clientCapabilities).api
        : undefined;
      const result = await load({
        sessionId: id,
        cwd: params.cwd,
        mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
        params,
        ...(writer ? { replay: writer } : {}),
      });
      if (!sessions.has(id)) sessions.set(id, { id });
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
    sessions.delete(session.id);
    await options.closeSession?.(session.id);
    return {};
  });

  peer.onNotification('session/cancel', (params: { sessionId?: string }) => {
    const session = params?.sessionId ? sessions.get(params.sessionId) : undefined;
    session?.controller?.abort(new Error('cancelled by the client'));
  });

  peer.onRequest('session/prompt', async (params: { sessionId?: string; prompt?: ContentBlock[] }, context) => {
    const session = params?.sessionId ? sessions.get(params.sessionId) : undefined;
    if (!session) throw RpcError.notFound(`Unknown session ${String(params?.sessionId)}`, { sessionId: params?.sessionId });
    if (session.controller) throw RpcError.invalidParams(`Session ${session.id} already has a turn running`);
    const controller = new AbortController();
    session.controller = controller;
    const signal = AbortSignal.any([controller.signal, peer.signal]);
    const turn = new TurnWriter(peer, session.id, protocol, params.prompt ?? [], signal, clientCapabilities);

    const run = async (): Promise<StopReason> => {
      let stop: StopReason;
      try {
        stop = (await options.prompt(turn.api)) ?? 'end_turn';
      } catch (error) {
        if (!signal.aborted) {
          if (protocol === 1) throw error;
          await turn.idle('error', { message: error instanceof Error ? error.message : String(error) });
          return 'error';
        }
        stop = 'cancelled';
      } finally {
        session.controller = undefined;
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
        await turn.state('running');
        const stop = await run();
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

  constructor(
    peer: RpcPeer,
    sessionId: string,
    protocol: ProtocolVersion,
    prompt: ContentBlock[],
    signal: AbortSignal,
    clientCapabilities: Record<string, unknown>
  ) {
    this.peer = peer;
    this.sessionId = sessionId;
    this.protocol = protocol;
    const text = prompt
      .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
    this.api = {
      sessionId,
      protocol,
      clientCapabilities,
      prompt,
      text,
      signal,
      say: (t) => this.chunk('agent_message_chunk', t),
      think: (t) => this.chunk('agent_thought_chunk', t),
      toolCall: (init) => this.toolCall(init),
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
        if (fields.status === 'completed' || fields.status === 'failed') this.open.delete(toolCallId);
        await this.update({
          ...fields,
          sessionUpdate: options?.create && protocol === 1 ? 'tool_call' : 'tool_call_update',
        });
      },
      sendUpdate: (update) => this.update(update),
      request: (method, params, options) => peer.request(method, params, { signal, ...options }),
      userMessage: (text) =>
        this.update({ sessionUpdate: 'user_message_chunk', messageId: `${this.turnId}-u`, content: { type: 'text', text } }),
      terminal: async (command, options) => {
        if (protocol !== 1 || clientCapabilities.terminal !== true) throw new Error('The client offers no terminal');
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
        const caps = clientCapabilities.elicitation as { form?: unknown; url?: unknown } | undefined;
        const mode = request.url ? 'url' : 'form';
        if (!caps || caps[mode] == null) throw new Error(`The client offers no ${mode} elicitation`);
        const params = {
          sessionId,
          mode,
          message: request.message,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
          ...(mode === 'form'
            ? { requestedSchema: request.requestedSchema ?? { type: 'object', properties: {} } }
            : { url: request.url, elicitationId: randomUUID() }),
        };
        try {
          const answer = await peer.request<{ action?: string; content?: Record<string, unknown> }>('elicitation/create', params, { signal });
          if (answer?.action === 'accept') return { action: 'accept', ...(answer.content ? { content: answer.content } : {}) };
          if (answer?.action === 'decline') return { action: 'decline' };
        } catch {
          // Aborted with the turn, or an error answer.
        }
        return { action: 'cancel' };
      },
    };
  }

  update(update: Record<string, unknown>): Promise<void> {
    return this.peer.notify('session/update', { sessionId: this.sessionId, update });
  }

  state(state: 'running' | 'requires_action'): Promise<void> {
    return this.update({ sessionUpdate: 'state_update', state });
  }

  idle(stopReason: StopReason, error?: unknown): Promise<void> {
    return this.update({ sessionUpdate: 'state_update', state: 'idle', stopReason, ...(error ? { error } : {}) });
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
    const fields = { title: init.title, kind: init.kind ?? 'other', status: init.status ?? 'pending', content: init.content ?? [], locations: init.locations ?? [], ...(init.rawInput !== undefined ? { rawInput: init.rawInput } : {}) };
    this.open.add(id);
    // v1 creates with tool_call; v2 has only the upsert.
    await this.update({ sessionUpdate: this.protocol === 1 ? 'tool_call' : 'tool_call_update', toolCallId: id, ...fields });
    return {
      id,
      update: (f) => this.toolUpdate(id, f),
      complete: (f) => this.toolUpdate(id, { ...f, status: 'completed' }),
      fail: (f) => this.toolUpdate(id, { ...f, status: 'failed' }),
    };
  }

  private toolUpdate(id: string, fields: Record<string, unknown>): Promise<void> {
    this.lastWasText = false;
    if (fields.status === 'completed' || fields.status === 'failed') this.open.delete(id);
    return this.update({ sessionUpdate: 'tool_call_update', toolCallId: id, ...fields });
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
