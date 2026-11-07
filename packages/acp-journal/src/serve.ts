/**
 * Serve journaled sessions over ACP (protocol v1), one call per connection:
 *
 *   const registry = new SessionRegistry({ open, exists, closeJournal });
 *   serveJournal(channel, registry, { name: 'ideal' });
 *
 * - `session/new` and `session/load` attach this connection to a session's
 *   journal. New: live from head+1. Load: every event from the start, then a
 *   `_<ns>/cursor` notification, then live; the load is answered after the cursor.
 * - `session/prompt` answers after every event the turn appended has been sent.
 * - Requests carrying `_meta[ns].requestId` are admitted once (see admission.ts).
 * - Extension requests: `_<ns>/rewind {sessionId, toSeq}`,
 *   `_<ns>/allow` and `_<ns>/deny {sessionId, permissionId}`.
 * - A connection that closes detaches; its sessions keep running in the registry.
 */
import { cancelRequest, RpcError, RpcPeer, type Channel, type RpcPeerOptions } from '@deft-subspace/kernel';
import type { ContentBlock, PermissionOption } from '@deft-subspace/acp';
import { fingerprint, requestIdOf, withoutMeta } from './admission.ts';
import { PermissionBroker, type Gate, type GateAction } from './broker.ts';
import type { CoalesceDiagnostic } from './coalesce.ts';
import { JournalProjector } from './projector.ts';
import type { SessionRegistry } from './registry.ts';
import type { ToolDescriber } from './tools.ts';
import type { JournaledSession, JournalEvent, Notification, Vocabulary } from './types.ts';

export interface ServeOptions {
  name: string;
  version?: string;
  /** `_meta` key and extension prefix. Default `journal`. */
  namespace?: string;
  /** Default `ask`. `auto-allow` allows every live gate: trusted local workspaces only. */
  permissions?: 'ask' | 'auto-allow';
  /** The options a permission question offers. Default allow once / reject once. */
  permissionOptions?: PermissionOption[];
  /** Advertised after session/new and session/load. */
  commands?: Array<{ name: string; description: string; input?: { hint: string } }>;
  vocabulary?: Vocabulary;
  describeTool?: ToolDescriber;
  rawEvents?: boolean;
  peer?: Omit<RpcPeerOptions, 'cancelOutbound' | 'cancelInbound'>;
  onError?(error: unknown): void;
  onDiagnostic?(diagnostic: CoalesceDiagnostic & { sessionId: string; seq: number }): void;
}

const DEFAULT_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One connection's view of one session: its projector, send order, and how far it has got. */
class Attachment {
  readonly projector: JournalProjector;
  readonly session: JournaledSession;
  unsubscribe: () => void = () => {};
  /** Highest seq delivered by the subscription. */
  seen = 0;
  readonly turns = new Set<AbortController>();
  private queue: Promise<void> = Promise.resolve();
  private waiters: Array<{ seq: number; resolve: () => void }> = [];
  private readonly onError: (error: unknown) => void;

  constructor(session: JournaledSession, projector: JournalProjector, onError: (error: unknown) => void) {
    this.session = session;
    this.projector = projector;
    this.onError = onError;
  }

  /** Run in send order. Failures are reported, and do not stop later sends. */
  enqueue(work: () => unknown): void {
    this.queue = this.queue.then(work).then(
      () => undefined,
      (error) => this.onError(error)
    );
  }

  delivered(seq: number): void {
    this.seen = Math.max(this.seen, seq);
    const ready = this.waiters.filter((w) => w.seq <= this.seen);
    this.waiters = this.waiters.filter((w) => w.seq > this.seen);
    for (const w of ready) w.resolve();
  }

  /** Resolve once events up to `seq` are delivered and everything queued so far is sent. */
  async drain(seq: number): Promise<void> {
    if (this.seen < seq) await new Promise<void>((resolve) => this.waiters.push({ seq, resolve }));
    await this.queue;
  }

  abortTurns(): void {
    for (const controller of this.turns) controller.abort(new Error('cancelled by the client'));
    this.turns.clear();
  }

  detach(): void {
    this.unsubscribe();
    this.abortTurns();
    for (const w of this.waiters) w.resolve();
    this.waiters = [];
  }
}

export function serveJournal(channel: Channel<unknown>, registry: SessionRegistry, options: ServeOptions): RpcPeer {
  const ns = options.namespace ?? 'journal';
  const permissionOptions = options.permissionOptions ?? DEFAULT_OPTIONS;
  const attachments = new Map<string, Attachment>();
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Reporting is an observer too.
    }
  };

  const peer = new RpcPeer(channel, { name: options.name, ...options.peer, ...cancelRequest });

  const broker = new PermissionBroker({
    mode: options.permissions ?? 'ask',
    onError: report,
    ask: (gate) => ask(gate),
    settle: (gate, action) => settle(gate, action),
  });

  async function ask(gate: Gate): Promise<GateAction> {
    const known = gate.toolCallId !== undefined && attachments.get(gate.sessionId)?.projector.openToolCalls.includes(gate.toolCallId);
    // A known tool call is referred to by id only, so the client keeps its title.
    const toolCall = {
      toolCallId: gate.toolCallId ?? `permission-${gate.permissionId}`,
      ...(known ? {} : { title: gate.title ?? 'Permission requested' }),
      _meta: { [ns]: { permissionId: gate.permissionId, seq: gate.seq } },
    };
    const result = await peer.request(
      'session/request_permission',
      { sessionId: gate.sessionId, toolCall, options: permissionOptions },
      { signal: gate.signal }
    );
    const outcome = isRecord(result) && isRecord(result.outcome) ? result.outcome : {};
    if (outcome.outcome === 'cancelled') return 'cancel';
    const option = permissionOptions.find((o) => o.optionId === outcome.optionId);
    return outcome.outcome === 'selected' && option && option.kind.startsWith('allow') ? 'allow' : 'deny';
  }

  async function settle(gate: Gate, action: GateAction): Promise<unknown> {
    const session = await registry.get(gate.sessionId);
    return registry.admissions.admit(gate.sessionId, `${ns}-permission:${gate.seq}`, action, () => {
      if (action === 'cancel') return cancel(gate.sessionId);
      return action === 'allow' ? session.allow(gate.permissionId) : session.deny(gate.permissionId);
    });
  }

  async function cancel(sessionId: string): Promise<void> {
    broker.invalidate(sessionId);
    attachments.get(sessionId)?.abortTurns();
    if (registry.has(sessionId)) await (await registry.get(sessionId)).cancel();
  }

  function send(attachment: Attachment, notifications: Notification[]): void {
    for (const n of notifications) attachment.enqueue(() => peer.notify(n.method, n.params));
  }

  /** Attach to a session's journal. Replay: from seq 1, ending in a cursor; otherwise live from head+1. */
  async function attach(session: JournaledSession, replay: boolean): Promise<Attachment> {
    const id = session.sessionId;
    attachments.get(id)?.detach();
    const projector = new JournalProjector({
      sessionId: id,
      namespace: ns,
      vocabulary: options.vocabulary,
      describeTool: options.describeTool,
      rawEvents: options.rawEvents,
      onDiagnostic: (d) => options.onDiagnostic?.({ ...d, sessionId: id }),
    });
    const attachment = new Attachment(session, projector, report);
    attachments.set(id, attachment);
    if (options.commands?.length) {
      send(attachment, [
        {
          method: 'session/update',
          params: { sessionId: id, update: { sessionUpdate: 'available_commands_update', availableCommands: options.commands } },
        },
      ]);
    }
    const head = await session.head();
    // Live from head+1: everything up to head counts as already delivered.
    if (!replay) attachment.delivered(head);
    let cursorSent = !replay;
    const sendCursor = () => {
      cursorSent = true;
      send(attachment, [projector.cursor(head)]);
    };
    if (!cursorSent && head === 0) sendCursor();
    const onEvent = (event: JournalEvent) => {
      try {
        if (attachments.get(id) !== attachment) return;
        const live = event.seq > head;
        if (live && !cursorSent) sendCursor();
        const { fact, notifications } = projector.project(event, { replay: !live });
        send(attachment, notifications);
        if (fact) attachment.enqueue(() => broker.observe(id, event.seq, fact, live));
        if (!cursorSent && event.seq >= head) sendCursor();
        attachment.delivered(event.seq);
      } catch (error) {
        report(error);
      }
    };
    attachment.unsubscribe = session.subscribe(replay ? 1 : head + 1, onEvent);
    if (replay) await attachment.drain(head);
    return attachment;
  }

  function attached(sessionId: unknown): Attachment {
    const attachment = typeof sessionId === 'string' ? attachments.get(sessionId) : undefined;
    if (!attachment || !registry.has(attachment.session.sessionId)) {
      throw RpcError.notFound(`Unknown session ${String(sessionId)} on this connection; create or load it first`, { sessionId });
    }
    return attachment;
  }

  /** Admit a move once per receipt, then wait until its events have been sent here. */
  async function move(attachment: Attachment, method: string, params: unknown, work: () => Promise<unknown>): Promise<unknown> {
    const id = attachment.session.sessionId;
    const result = await registry.admissions.admit(id, requestIdOf(params, ns), fingerprint([method, withoutMeta(params)]), work);
    await attachment.drain(await attachment.session.head());
    return result;
  }

  peer.onRequest('initialize', () => ({
    protocolVersion: 1,
    agentInfo: { name: options.name, version: options.version ?? '0.0.0' },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      sessionCapabilities: { close: {} },
    },
    authMethods: [],
  }));

  peer.onRequest('session/new', async (params: Record<string, unknown>) => {
    if (typeof params?.cwd !== 'string') throw RpcError.invalidParams('cwd is required');
    const meta = isRecord(params._meta) && isRecord(params._meta[ns]) ? { ...params._meta[ns] } : {};
    delete meta.requestId;
    const cwd = params.cwd;
    const sessionId = await registry.admissions.admit(
      'session/new',
      requestIdOf(params, ns),
      fingerprint(withoutMeta(params)),
      async () => (await registry.create({ cwd, options: meta })).sessionId
    );
    if (!attachments.has(sessionId)) await attach(await registry.get(sessionId), false);
    return { sessionId };
  });

  peer.onRequest('session/load', async (params: Record<string, unknown>) => {
    if (typeof params?.sessionId !== 'string' || !params.sessionId) throw RpcError.invalidParams('sessionId is required');
    const session = await registry.load(params.sessionId, typeof params.cwd === 'string' ? params.cwd : undefined);
    await attach(session, true);
    return {};
  });

  peer.onRequest('session/prompt', async (params: Record<string, unknown>) => {
    const attachment = attached(params?.sessionId);
    const prompt = Array.isArray(params.prompt) ? (params.prompt as ContentBlock[]) : [];
    const text = prompt
      .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
    return move(attachment, 'session/prompt', params, async () => {
      const controller = new AbortController();
      attachment.turns.add(controller);
      try {
        const { stopReason } = await attachment.session.prompt({ text, prompt, signal: controller.signal });
        return { stopReason };
      } finally {
        attachment.turns.delete(controller);
      }
    });
  });

  peer.onNotification('session/cancel', (params: { sessionId?: unknown }) => {
    if (typeof params?.sessionId === 'string') void cancel(params.sessionId).catch(report);
  });

  peer.onRequest('session/close', async (params: Record<string, unknown>) => {
    const attachment = attached(params?.sessionId);
    const id = attachment.session.sessionId;
    broker.invalidate(id);
    attachment.detach();
    send(attachment, attachment.projector.interrupt('session.closed'));
    await attachment.drain(0);
    attachments.delete(id);
    await registry.close(id);
    return {};
  });

  peer.onRequest(`_${ns}/rewind`, async (params: Record<string, unknown>) => {
    const attachment = attached(params?.sessionId);
    const toSeq = params.toSeq;
    if (typeof toSeq !== 'number' || !Number.isSafeInteger(toSeq) || toSeq < 0) {
      throw RpcError.invalidParams('toSeq must be a non-negative integer');
    }
    const session = attachment.session;
    if (!session.rewind) throw RpcError.methodNotFound(`_${ns}/rewind`);
    const rewind = session.rewind.bind(session);
    broker.invalidate(session.sessionId);
    await move(attachment, `_${ns}/rewind`, params, () => rewind(toSeq));
    return { headSeq: attachment.projector.head };
  });

  for (const action of ['allow', 'deny'] as const) {
    peer.onRequest(`_${ns}/${action}`, async (params: Record<string, unknown>) => {
      const attachment = attached(params?.sessionId);
      const permissionId = params.permissionId;
      if (typeof permissionId !== 'string' || !permissionId) throw RpcError.invalidParams('permissionId is required');
      await move(attachment, `_${ns}/${action}`, params, () => attachment.session[action](permissionId));
      return {};
    });
  }

  void peer.closed.then(() => {
    broker.dispose();
    for (const attachment of attachments.values()) attachment.detach();
    attachments.clear();
  });

  peer.start();
  return peer;
}
