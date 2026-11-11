/**
 * The agent side of v2 background work (the "Background work" RFD): which
 * tool calls and terminals a session runs in the background, which the client
 * may cancel, and the `background` list on state snapshots.
 *
 * - A cancellable item advertises `capabilities: { cancel: {} }` and gets its
 *   own AbortSignal, fired by the client's `tool_call/cancel` or
 *   `terminal/cancel`, by `session/close`, and (until it is detached) by the
 *   turn's cancel.
 * - `detach()` moves an item to the background: it outlives the turn,
 *   `session/cancel` no longer stops it, and from then on every state update
 *   for the session carries the `background` list. Finishing it (a final
 *   status, or an exit) removes it, after its final update.
 */
import { RpcError } from '@deft-subspace/kernel';
import type { BackgroundItem } from './model.ts';

export interface Work {
  readonly kind: 'tool_call' | 'terminal';
  readonly id: string;
  readonly controller: AbortController;
  readonly cancellable: boolean;
  listed: boolean;
  final: boolean;
}

type State = 'running' | 'requires_action' | 'idle';

export class SessionWork {
  /** True once anything was detached: every state update must then carry the list. */
  reports = false;
  state: State = 'idle';
  private readonly items = new Map<string, Work>();
  /** Removes an item's listener on its turn's signal. */
  private readonly unfollow = new Map<Work, () => void>();
  private readonly send: (update: Record<string, unknown>) => Promise<void>;

  constructor(send: (update: Record<string, unknown>) => Promise<void>) {
    this.send = send;
  }

  add(kind: Work['kind'], id: string, cancellable: boolean, turnSignal?: AbortSignal): Work {
    const work: Work = { kind, id, controller: new AbortController(), cancellable, listed: false, final: false };
    this.items.set(`${kind}:${id}`, work);
    // Foreground work stops with its turn; detached work does not.
    if (turnSignal) {
      const onAbort = () => {
        if (!work.listed && !work.final) work.controller.abort(turnSignal.reason);
      };
      turnSignal.addEventListener('abort', onAbort, { once: true });
      this.unfollow.set(work, () => turnSignal.removeEventListener('abort', onAbort));
    }
    return work;
  }

  get(kind: Work['kind'], id: string): Work | undefined {
    return this.items.get(`${kind}:${id}`);
  }

  /** The `background` field for a state update: present once the session reports background work. */
  fields(): { background?: BackgroundItem[] } {
    return this.reports ? { background: this.list() } : {};
  }

  list(): BackgroundItem[] {
    return [...this.items.values()]
      .filter((w) => w.listed && !w.final)
      .map((w) => (w.kind === 'terminal' ? { type: 'terminal', terminalId: w.id } : { type: 'tool_call', toolCallId: w.id }));
  }

  /** Move an item to the background and send a snapshot that lists it (announce it first). */
  async detach(work: Work): Promise<void> {
    if (work.final || work.listed) return;
    work.listed = true;
    this.reports = true;
    await this.snapshot();
  }

  /** The item reached a final status (sent already): drop it from the list with a new snapshot. */
  async finish(work: Work): Promise<void> {
    if (work.final) return;
    work.final = true;
    this.items.delete(`${work.kind}:${work.id}`);
    this.unfollow.get(work)?.();
    this.unfollow.delete(work);
    if (work.listed) await this.snapshot();
  }

  /** The client's tool_call/cancel or terminal/cancel. -32602 for unknown, finished or uncancellable items. */
  cancel(kind: Work['kind'], id: string): void {
    const work = this.get(kind, id);
    if (!work || work.final) throw RpcError.invalidParams(`No running ${kind === 'terminal' ? 'terminal' : 'tool call'} ${id}`);
    if (!work.cancellable) throw RpcError.invalidParams(`${kind === 'terminal' ? 'Terminal' : 'Tool call'} ${id} cannot be cancelled`);
    work.controller.abort(new Error('cancelled by the client'));
  }

  /** session/close, or the connection gone: stop everything. */
  closeAll(reason: Error = new Error('session closed')): void {
    for (const work of this.items.values()) work.controller.abort(reason);
  }

  snapshot(): Promise<void> {
    return this.send({ sessionUpdate: 'state_update', state: this.state, ...this.fields() });
  }
}

/** Bytes or text as RFC 4648 base64, in any runtime. */
export function base64(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
