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
  LocalError,
  RpcError,
  RpcPeer,
  type Channel,
  type PeerDiagnostic,
  type RpcPeerOptions,
} from '@deft-subspace/kernel';
import type { ContentBlock, PermissionRequest, ProtocolVersion, ToolCall, TurnEvent, v1, v2 } from './model.ts';
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
  /** Sees every JSON-RPC message, both directions. */
  tap?: RpcPeerOptions['tap'];
  onDiagnostic?: (diagnostic: PeerDiagnostic) => void;
}

export interface AgentInfo {
  name?: string;
  title?: string;
  version?: string;
}

const CANCEL_REQUEST = '$/cancel_request';

export class AcpClient {
  readonly peer: RpcPeer;
  readonly protocol: ProtocolVersion;
  readonly agent: AgentInfo;
  /** The agent's capabilities as it sent them (v1 `agentCapabilities` or v2 `capabilities`). */
  readonly capabilities: Record<string, unknown>;

  private readonly options: ClientOptions;
  private readonly sessions = new Map<string, Session>();
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
      cancelOutbound: { method: CANCEL_REQUEST, params: (requestId) => ({ requestId }) },
      cancelInbound: { method: CANCEL_REQUEST, id: (p: { requestId?: string | number }) => p?.requestId },
      tap: options.tap,
      onDiagnostic: options.onDiagnostic,
    });
    // Handlers are registered before the first message can arrive.
    let client: AcpClient | undefined;
    peer.onNotification('session/update', (params: { sessionId?: string; update?: unknown }) => {
      client?.routeUpdate(params);
    });
    peer.onRequest('session/request_permission', (params, context) => {
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
  get cancelGraceMs(): number {
    return this.options.timeouts?.cancelGraceMs ?? 10_000;
  }

  private routeUpdate(params: { sessionId?: string; update?: unknown }): void {
    const session = typeof params?.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
    session?.receive(params.update);
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
}

export class Session {
  readonly id: string;
  readonly client: AcpClient;
  /** What session/new returned. */
  readonly created: Record<string, unknown>;

  private active?: ActiveTurn;
  private readonly listeners = new Set<(event: TurnEvent) => void>();

  /** @internal */
  constructor(client: AcpClient, id: string, created: Record<string, unknown>) {
    this.client = client;
    this.id = id;
    this.created = created;
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  /** Updates that arrive between turns (available commands, config options, ...). */
  onIdleUpdate(listener: (event: TurnEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(input: string | ContentBlock | ContentBlock[]): Turn {
    if (this.active) throw new Error(`Session ${this.id} already has a turn running`);
    const blocks: ContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : Array.isArray(input) ? input : [input];
    const id = this.client.nextTurnId(this.id);
    const active: ActiveTurn = {
      turn: new Turn(id, () => this.cancel()),
      projection: new TurnProjection(id),
      promptAnswered: false,
      cancelController: new AbortController(),
    };
    this.active = active;

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

  /** @internal */
  connectionClosed(error: LocalError): void {
    if (this.active) this.failTurn(this.active, error);
  }

  /** @internal */
  receive(update: unknown): void {
    const active = this.active;
    if (!active) {
      const { events } = new TurnProjection(`${this.id}#idle`).apply(update);
      for (const event of events) for (const listener of this.listeners) listener(event);
      return;
    }
    const { events, state } = active.projection.apply(update);
    active.turn.push(...events);
    if (state?.state === 'idle') {
      active.idle = { stopReason: state.stopReason ?? 'end_turn', error: state.error };
      // v2: the turn ends at idle. The prompt answer normally came first.
      if (this.client.protocol === 2 && active.promptAnswered) this.end(active, active.idle.stopReason, active.idle.error);
    }
  }

  /** @internal */
  async permission(params: Record<string, unknown>, signal: AbortSignal, policy: PermissionPolicy): Promise<v1.RequestPermissionResponse> {
    const active = this.active;
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
    const cancelled = active.cancelController.signal.aborted;
    active.turn.finish({
      stopReason,
      text: active.projection.text,
      toolCalls: [...active.projection.toolCalls.values()].map((c) => ({ ...c })),
      cancelled,
      ...(forced ? { forced: true } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  private failTurn(active: ActiveTurn, error: unknown): void {
    if (this.active !== active) return;
    this.active = undefined;
    active.turn.fail(error);
  }
}
