/**
 * Journaled permission gates, put to the ACP client.
 *
 * The session journals `permission_request`; the broker asks the client and
 * hands the answer back as `allow`, `deny` or `cancel`. It is routing state,
 * not a second permission machine: the session still decides legality.
 *
 * - One gate per session. A newer request replaces the open one.
 * - Only live requests are asked. A replayed request is history, not a
 *   reason to prompt again.
 * - Fails closed: an error, a malformed answer or an unknown option is `deny`.
 *   The client answering `cancelled` cancels the session's turn.
 * - The gate closes when the journal records an answer from anywhere else (a
 *   slash command, another client), or a cancel, close or rewind. The open
 *   client request is withdrawn, and a late answer to it is ignored.
 */
import type { Fact } from './types.ts';

export type GateAction = 'allow' | 'deny' | 'cancel';

export interface Gate {
  sessionId: string;
  permissionId: string;
  /** The journal seq of the request. Unique per gate; use it as a receipt key. */
  seq: number;
  toolCallId?: string;
  title?: string;
  /** Fires when the gate closes before an answer is used. */
  signal: AbortSignal;
}

export interface BrokerOptions {
  /** `ask` puts each gate to `ask()`; `auto-allow` allows every live gate (trusted local use only). */
  mode?: 'ask' | 'auto-allow';
  /** Ask the client. Resolve with what it chose; reject on errors (that is a deny). */
  ask(gate: Gate): Promise<GateAction>;
  /** Apply an answer to the session. */
  settle(gate: Gate, action: GateAction): Promise<unknown>;
  onError?(error: unknown): void;
}

interface Open {
  gate: Gate;
  controller: AbortController;
}

export class PermissionBroker {
  private readonly open = new Map<string, Open>();
  private readonly options: BrokerOptions;

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  /** The open gate's permission id for a session, if any. */
  pending(sessionId: string): string | undefined {
    return this.open.get(sessionId)?.gate.permissionId;
  }

  /** Feed one projected fact. Returns at once; asking runs in the background. */
  observe(sessionId: string, seq: number, fact: Fact | undefined, live: boolean): void {
    if (!fact) return;
    if (fact.kind === 'permission_response') {
      if (this.open.get(sessionId)?.gate.permissionId === fact.id) this.invalidate(sessionId);
      return;
    }
    if (fact.kind === 'interrupt') {
      this.invalidate(sessionId);
      return;
    }
    if (fact.kind !== 'permission_request' || !live) return;
    this.invalidate(sessionId);
    const controller = new AbortController();
    const gate: Gate = {
      sessionId,
      permissionId: fact.id,
      seq,
      ...(fact.toolCallId ? { toolCallId: fact.toolCallId } : {}),
      ...(fact.title ? { title: fact.title } : {}),
      signal: controller.signal,
    };
    const entry: Open = { gate, controller };
    this.open.set(sessionId, entry);
    void this.run(entry);
  }

  /** Close a session's gate now, e.g. as a cancel arrives and before the journal records it. */
  invalidate(sessionId: string): void {
    const entry = this.open.get(sessionId);
    if (!entry) return;
    this.open.delete(sessionId);
    entry.controller.abort(new Error('permission gate closed'));
  }

  dispose(): void {
    for (const id of [...this.open.keys()]) this.invalidate(id);
  }

  private async run(entry: Open): Promise<void> {
    // Never decide inside the journal's append callback.
    await Promise.resolve();
    let action: GateAction = 'deny';
    if (this.options.mode === 'auto-allow') action = 'allow';
    else {
      try {
        const answer = await this.options.ask(entry.gate);
        action = answer === 'allow' || answer === 'cancel' ? answer : 'deny';
      } catch (error) {
        if (!entry.gate.signal.aborted) this.report(error);
      }
    }
    if (this.open.get(entry.gate.sessionId) !== entry) return; // closed meanwhile: the answer is stale
    this.open.delete(entry.gate.sessionId);
    try {
      await this.options.settle(entry.gate, action);
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Reporting must not stop the gate from settling.
    }
  }
}
