/**
 * The app-owned side: which sessions are open, and the receipts that make
 * retries safe. One registry can serve many connections; a connection that
 * goes away does not cancel or close anything here.
 */
import { RpcError } from '@deft-subspace/kernel';
import { Admissions } from './admission.ts';
import type { JournaledSession } from './types.ts';

export interface OpenInput {
  /** Set for a load; absent for a new session. */
  sessionId?: string;
  cwd?: string;
  /** The client's `_meta[ns]` on session/new, minus the request id. */
  options?: Record<string, unknown>;
}

export interface RegistryOptions {
  /** Open a new session, or reopen a stored one from its journal. */
  open(input: OpenInput): Promise<JournaledSession> | JournaledSession;
  /** True if the journal has this session. A load of anything else is -32002. */
  exists(sessionId: string): Promise<boolean> | boolean;
  /** Runs last in `dispose()`, after every session has closed. Close the journal here. */
  closeJournal?(): Promise<void> | void;
}

export class SessionRegistry {
  readonly admissions: Admissions;
  private readonly options: RegistryOptions;
  private readonly sessions = new Map<string, Promise<JournaledSession>>();
  private readonly closing = new Map<string, Promise<void>>();
  private disposal?: Promise<void>;

  constructor(options: RegistryOptions & { receiptsPerScope?: number }) {
    this.options = options;
    this.admissions = new Admissions({ limit: options.receiptsPerScope });
  }

  async create(input: Omit<OpenInput, 'sessionId'>): Promise<JournaledSession> {
    this.assertLive();
    const session = await this.options.open(input);
    this.sessions.set(session.sessionId, Promise.resolve(session));
    return session;
  }

  /** The open session, or the stored one reopened. Unknown ids are -32002. */
  async load(sessionId: string, cwd?: string): Promise<JournaledSession> {
    this.assertLive();
    await this.closing.get(sessionId);
    const open = this.sessions.get(sessionId);
    if (open) return open;
    if (!(await this.options.exists(sessionId))) throw RpcError.notFound(`Unknown session ${sessionId}`, { sessionId });
    let opening = this.sessions.get(sessionId);
    if (!opening) {
      opening = Promise.resolve(this.options.open({ sessionId, cwd }));
      this.sessions.set(sessionId, opening);
      opening.catch(() => {
        if (this.sessions.get(sessionId) === opening) this.sessions.delete(sessionId);
      });
    }
    return opening;
  }

  /** An open session. Unknown, closing and closed ids are -32002. */
  async get(sessionId: unknown): Promise<JournaledSession> {
    this.assertLive();
    const opening = typeof sessionId === 'string' && !this.closing.has(sessionId) ? this.sessions.get(sessionId) : undefined;
    if (!opening) throw RpcError.notFound(`Unknown session ${String(sessionId)}`, { sessionId });
    return opening;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId) && !this.closing.has(sessionId);
  }

  /**
   * Cancel if busy, then close. Idempotent; a later load reopens it from the
   * journal. Receipts are kept, so a retry after a reopen still runs nothing.
   */
  close(sessionId: string): Promise<void> {
    const previous = this.closing.get(sessionId);
    if (previous) return previous;
    const opening = this.sessions.get(sessionId);
    if (!opening) return Promise.reject(RpcError.notFound(`Unknown session ${sessionId}`, { sessionId }));
    const closing = opening
      .then(async (session) => {
        try {
          if (session.busy?.()) await session.cancel();
        } finally {
          await session.close();
        }
      })
      .finally(() => {
        this.sessions.delete(sessionId);
        this.closing.delete(sessionId);
      });
    this.closing.set(sessionId, closing);
    return closing;
  }

  /** Close every session, then the journal. New work is refused from the first call. */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
      try {
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map((f) => f.reason), 'Closing sessions failed');
      } finally {
        await this.options.closeJournal?.();
      }
    })();
    return this.disposal;
  }

  private assertLive(): void {
    if (this.disposal) throw RpcError.internal('The session registry is shut down');
  }
}
