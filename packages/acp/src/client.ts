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
  ContentBlock,
  Exhaustion,
  PermissionRequest,
  ProtocolVersion,
  ToolCall,
  TurnEvent,
  TurnLimits,
  v1,
  v2,
} from './model.ts';
import { modesFrom, modesFromConfig, type SessionModes } from './modes.ts';
import { decide, type PermissionPolicy } from './permissions.ts';
import { TurnProjection } from './projection.ts';
import { Turn } from './turn.ts';

/** File access an agent may ask for (v1 `fs/*`). See `workspaceFiles()` in `@deft-subspace/acp/node`. */
export interface FileHandlers {
  readTextFile(request: { path: string; line?: number | null; limit?: number | null }): Promise<string>;
  writeTextFile(request: { path: string; content: string }): Promise<void>;
}

export interface ClientOptions {
  name?: string;
  version?: string;
  /** `'auto'` asks for v2 and accepts v1. Default `'auto'`. */
  protocol?: 'auto' | ProtocolVersion;
  /** How to answer permission questions. Default `'reject'`: nothing is allowed unless you say so. */
  permissions?: PermissionPolicy;
  /** Serve the agent's file requests (v1). Without this, the client advertises no file access. */
  files?: FileHandlers;
  timeouts?: {
    /** initialize. Default 60 s (agents often install on first run). */
    initializeMs?: number;
    /** session/new. Default 60 s. */
    sessionMs?: number;
    /** How long a cancelled turn may take to confirm before it is ended here. Default 10 s. */
    cancelGraceMs?: number;
  };
  /** Limits for every turn, unless a prompt sets its own. Default: none. */
  limits?: TurnLimits;
  /** Sees every JSON-RPC message, both directions. */
  tap?: RpcPeerOptions['tap'];
  onDiagnostic?: (diagnostic: PeerDiagnostic) => void;
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

  private readonly options: ClientOptions;
  private readonly sessions = new Map<string, Session>();
  /** Updates for a session id not registered yet: agents often send them right after session/new. */
  private readonly early = new Map<string, unknown[]>();
  private turnCounter = 0;

  private constructor(peer: RpcPeer, protocol: ProtocolVersion, init: Record<string, unknown>, options: ClientOptions) {
    this.peer = peer;
    this.protocol = protocol;
    this.options = options;
    const info = (init.info ?? init.agentInfo ?? {}) as AgentInfo;
    this.agent = { name: info.name, title: info.title, version: info.version };
    this.capabilities = (init.capabilities ?? init.agentCapabilities ?? {}) as Record<string, unknown>;
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
    peer.start();

    const wanted = options.protocol ?? 'auto';
    const name = options.name ?? 'deft-subspace';
    const version = options.version ?? '0.0.0';
    const v1Capabilities: v1.ClientCapabilities = {
      fs: { readTextFile: !!options.files, writeTextFile: !!options.files },
      terminal: false,
    };
    // One request both generations understand: v2 fields plus their v1 names.
    const params: Record<string, unknown> =
      wanted === 1
        ? { protocolVersion: 1, clientInfo: { name, version }, clientCapabilities: v1Capabilities }
        : {
            protocolVersion: 2,
            info: { name, version },
            capabilities: {} satisfies v2.ClientCapabilities,
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
    client = new AcpClient(peer, negotiated as ProtocolVersion, init, options);
    return client;
  }

  async newSession(request: { cwd: string; mcpServers?: unknown[]; additionalDirectories?: string[] }): Promise<Session> {
    const result = (await this.peer.request(
      'session/new',
      { cwd: request.cwd, mcpServers: request.mcpServers ?? [], ...(request.additionalDirectories ? { additionalDirectories: request.additionalDirectories } : {}) },
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

  /** Close the connection. Running turns fail with a `closed` LocalError. */
  async close(): Promise<void> {
    await this.peer.close();
  }

  /** @internal */
  nextTurnId(sessionId: string): string {
    return `${sessionId}#${++this.turnCounter}`;
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
    return session.permission(params, signal, this.options.permissions ?? 'reject');
  }
}

interface ActiveTurn {
  turn: Turn;
  projection: TurnProjection;
  promptAnswered: boolean;
  idle?: { stopReason: string; error?: unknown };
  cancelController: AbortController;
  limits: TurnLimits;
  toolCalls: number;
  exhausted?: Exhaustion;
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
  /** What session/new returned. */
  readonly created: Record<string, unknown>;

  private active?: ActiveTurn;
  private readonly listeners = new Set<(event: TurnEvent, raw: unknown) => void>();
  /** Recent updates between turns, replayed to listeners added later. */
  private readonly idleHistory: Array<{ event: TurnEvent; raw: unknown }> = [];
  private currentModes?: SessionModes;

  /** @internal */
  constructor(client: AcpClient, id: string, created: Record<string, unknown>) {
    this.client = client;
    this.id = id;
    this.created = created;
    this.currentModes = modesFrom(created);
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

  /** Start a turn. `limits` replace the client's default limits for this turn. */
  prompt(input: string | ContentBlock | ContentBlock[], options: { limits?: TurnLimits } = {}): Turn {
    if (this.active) throw new Error(`Session ${this.id} already has a turn running`);
    const blocks: ContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : Array.isArray(input) ? input : [input];
    const id = this.client.nextTurnId(this.id);
    const projection = new TurnProjection(id);
    const active: ActiveTurn = {
      turn: new Turn(id, () => this.cancel(), {
        text: () => projection.text,
        toolCalls: () => [...projection.toolCalls.values()].map((c) => ({ ...c })),
      }),
      projection,
      promptAnswered: false,
      cancelController: new AbortController(),
      limits: options.limits ?? this.client.defaultLimits ?? {},
      toolCalls: 0,
      timers: [],
    };
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
    return active.turn;
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
      active.turn.push(...active.projection.failOpenToolCalls());
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
    if (this.active) this.failTurn(this.active, error);
  }

  /** @internal */
  receive(update: unknown): void {
    this.trackModes(update);
    const active = this.active;
    if (!active) {
      const { events } = new TurnProjection(`${this.id}#idle`).apply(update);
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

  private trackModes(update: unknown): void {
    if (typeof update !== 'object' || update === null) return;
    const u = update as Record<string, unknown>;
    if (u.sessionUpdate === 'current_mode_update' && this.currentModes && typeof u.currentModeId === 'string') {
      this.currentModes.current = u.currentModeId;
    } else if (u.sessionUpdate === 'config_option_update') {
      const modes = modesFromConfig(u.configOptions);
      if (modes) this.currentModes = modes;
    }
  }

  /** @internal */
  async permission(params: Record<string, unknown>, signal: AbortSignal, policy: PermissionPolicy): Promise<v1.RequestPermissionResponse> {
    const active = this.active;
    // No turn is running, or it is being cancelled: nobody asked for this. Fail closed.
    if (!active || active.cancelController.signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const projection = active?.projection ?? new TurnProjection(`${this.id}#idle`);
    const request = this.permissionRequest(params, projection);
    const combined = active ? AbortSignal.any([signal, active.cancelController.signal]) : signal;
    const outcome = await decide(policy, request, combined);
    active?.turn.push({ type: 'permission', request, outcome });
    if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
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
    this.stopTimers(active);
    const cancelled = active.cancelController.signal.aborted;
    active.turn.finish({
      stopReason,
      text: active.projection.text,
      toolCalls: [...active.projection.toolCalls.values()].map((c) => ({ ...c })),
      cancelled,
      ...(forced ? { forced: true } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(active.exhausted ? { exhausted: active.exhausted } : {}),
    });
  }

  private failTurn(active: ActiveTurn, error: unknown): void {
    if (this.active !== active) return;
    this.active = undefined;
    this.stopTimers(active);
    active.turn.fail(error);
  }
}
