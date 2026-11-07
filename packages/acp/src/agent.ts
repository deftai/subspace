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
import { RpcError, RpcPeer, type Channel, type RpcPeerOptions } from '@deft-subspace/kernel';
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

export interface AgentTurn {
  readonly sessionId: string;
  readonly protocol: ProtocolVersion;
  readonly prompt: ContentBlock[];
  /** The prompt's text blocks, joined. */
  readonly text: string;
  /** Aborted when the client cancels the turn or the connection closes. */
  readonly signal: AbortSignal;
  say(text: string): Promise<void>;
  think(text: string): Promise<void>;
  toolCall(init: ToolCallInit & { id?: string }): Promise<ToolCallHandle>;
  plan(entries: Array<{ content: string; priority?: string; status?: string }>): Promise<void>;
  /** Ask the user. `allowed` is false for rejections and when the turn was cancelled. */
  requestPermission(request: {
    title: string;
    toolCallId?: string;
    options?: PermissionOption[];
  }): Promise<{ outcome: 'selected'; optionId: string; allowed: boolean } | { outcome: 'cancelled'; allowed: false }>;
}

export interface AgentOptions {
  name: string;
  version?: string;
  /** Protocol versions to accept. Default [1, 2]. */
  protocols?: ProtocolVersion[];
  newSession?(request: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId?: string } | void> | { sessionId?: string } | void;
  prompt(turn: AgentTurn): Promise<StopReason | void> | StopReason | void;
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

  const peer = new RpcPeer(channel, {
    name: options.name,
    ...options.peer,
    cancelOutbound: { method: '$/cancel_request', params: (requestId) => ({ requestId }) },
    cancelInbound: { method: '$/cancel_request', id: (p: { requestId?: string | number }) => p?.requestId },
  });

  peer.onRequest('initialize', (params: { protocolVersion?: unknown }) => {
    const asked = Number(params?.protocolVersion);
    const best = Math.max(...accepted) as ProtocolVersion;
    protocol = (accepted.includes(asked as ProtocolVersion) ? asked : best) as ProtocolVersion;
    const info = { name: options.name, version: options.version ?? '0.0.0' };
    return protocol === 2
      ? { protocolVersion: 2, info, capabilities: {}, authMethods: [] }
      : { protocolVersion: 1, agentInfo: info, agentCapabilities: { loadSession: false }, authMethods: [] };
  });

  peer.onRequest('session/new', async (params: { cwd?: string; mcpServers?: unknown[] }) => {
    if (typeof params?.cwd !== 'string') throw RpcError.invalidParams('cwd is required');
    const created = await options.newSession?.({ cwd: params.cwd, mcpServers: params.mcpServers ?? [] });
    const id = (created && created.sessionId) || randomUUID();
    sessions.set(id, { id });
    return { sessionId: id };
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
    const turn = new TurnWriter(peer, session.id, protocol, params.prompt ?? [], signal);

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

  constructor(peer: RpcPeer, sessionId: string, protocol: ProtocolVersion, prompt: ContentBlock[], signal: AbortSignal) {
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
    const toolCall = { toolCallId: request.toolCallId ?? `permission-${randomUUID().slice(0, 8)}`, title: request.title };
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
