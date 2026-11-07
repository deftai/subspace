/**
 * An in-memory journal and a small Ideal-shaped session over it. Event names
 * and payloads follow Ideal's; the "agent" is a script driven by prompt text:
 *
 *   stream <words...>   deltas, then the full message
 *   tool <name> <arg>   tool request + permission gate; allow runs it, deny fails it
 *   /allow <id>  /deny <id>  /rewind <seq>   slash moves; an illegal one journals session.rejected
 */
import { ndjson, type Channel } from '@deft-subspace/kernel';
import { rechunk } from '@deft-subspace/kernel/testing';
import { SessionRegistry, type JournaledSession, type JournalEvent } from '@deft-subspace/acp-journal';

export class MemoryJournal {
  readonly events: JournalEvent[] = [];
  private readonly listeners = new Set<{ sessionId: string; fromSeq: number; fn: (e: JournalEvent) => void }>();

  append(sessionId: string, type: string, payload: unknown = {}): JournalEvent {
    const event = { seq: this.events.length + 1, type, sessionId, payload: JSON.parse(JSON.stringify(payload)) };
    this.events.push(event);
    for (const l of [...this.listeners]) if (l.sessionId === sessionId && event.seq >= l.fromSeq) l.fn(event);
    return event;
  }

  read(sessionId: string): JournalEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  subscribe(sessionId: string, fromSeq: number, fn: (e: JournalEvent) => void): () => void {
    for (const e of this.read(sessionId)) if (e.seq >= fromSeq) fn(e);
    const entry = { sessionId, fromSeq, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  types(sessionId: string): string[] {
    return this.read(sessionId).map((e) => e.type);
  }
}

interface Gate {
  id: string;
  resolve: (decision: 'allow' | 'deny' | 'cancelled') => void;
}

export class FakeSession implements JournaledSession {
  readonly sessionId: string;
  readonly journal: MemoryJournal;
  closed = 0;
  prompts = 0;
  private gate?: Gate;
  private running = 0;
  private nextTool = 0;

  constructor(journal: MemoryJournal, sessionId: string) {
    this.journal = journal;
    this.sessionId = sessionId;
  }

  head(): number {
    return this.journal.read(this.sessionId).at(-1)?.seq ?? 0;
  }

  subscribe(fromSeq: number, listener: (event: JournalEvent) => void): () => void {
    return this.journal.subscribe(this.sessionId, fromSeq, listener);
  }

  busy(): boolean {
    return this.running > 0;
  }

  private append(type: string, payload?: unknown) {
    return this.journal.append(this.sessionId, type, payload);
  }

  async prompt({ text }: { text: string; signal: AbortSignal }) {
    const slash = /^\/(\w+)\s*(.*)$/.exec(text);
    if (slash) {
      const [, name, args] = slash as unknown as [string, string, string];
      if (name === 'allow') await this.allow(args);
      else if (name === 'deny') await this.deny(args);
      else if (name === 'rewind') await this.rewind(Number(args));
      return { stopReason: 'end_turn' as const };
    }
    this.prompts++;
    this.running++;
    try {
      this.append('session.prompt', { text });
      const [verb, ...rest] = text.split(' ');
      const messageId = `a-${this.head()}`;
      if (verb === 'stream') {
        for (const word of rest) this.append('session.message.delta', { messageId, role: 'assistant', text: `${word} ` });
        this.append('session.message', { messageId, role: 'assistant', text: rest.map((w) => `${w} `).join('') });
      } else if (verb === 'tool') {
        const id = `t${++this.nextTool}`;
        const [name = 'read', arg = ''] = rest;
        this.append('session.tool_request', { id, name, input: name === 'exec' ? { command: arg } : { path: arg } });
        const permissionId = `p${this.nextTool}`;
        const decision = await new Promise<'allow' | 'deny' | 'cancelled'>((resolve) => {
          this.gate = { id: permissionId, resolve };
          this.append('session.permission_request', { id: permissionId, toolCallId: id, title: `${name} ${arg}` });
        });
        if (decision === 'cancelled') return { stopReason: 'cancelled' as const };
        this.append('session.tool_result', decision === 'allow' ? { id, output: `ran ${arg}` } : { id, output: 'denied', isError: true });
        this.append('session.message', { messageId, role: 'assistant', text: decision === 'allow' ? 'Done.' : 'Not allowed.' });
      } else {
        this.append('session.message', { messageId, role: 'assistant', text: `Echo: ${text}` });
      }
      this.append('session.turn_complete', { stopReason: 'end_turn' });
      return { stopReason: 'end_turn' as const };
    } finally {
      this.running--;
    }
  }

  private answer(permissionId: string, decision: 'allow' | 'deny'): void {
    const gate = this.gate;
    if (!gate || gate.id !== permissionId) {
      this.append('session.rejected', { event: decision, reason: `no open permission ${permissionId}` });
      return;
    }
    this.gate = undefined;
    this.append('session.permission_response', { id: permissionId, decision });
    gate.resolve(decision);
  }

  async allow(permissionId: string) {
    this.answer(permissionId, 'allow');
  }

  async deny(permissionId: string) {
    this.answer(permissionId, 'deny');
  }

  cancel() {
    if (!this.running) return { cancelled: false };
    this.append('session.cancelled', { reason: 'client' });
    const gate = this.gate;
    this.gate = undefined;
    gate?.resolve('cancelled');
    return { cancelled: true };
  }

  async rewind(toSeq: number) {
    const gate = this.gate;
    this.gate = undefined;
    this.append('session.rewind', { toSeq });
    gate?.resolve('cancelled');
  }

  close() {
    this.closed++;
  }
}

/** A journal, its sessions, and a registry over them. */
export function world(extra: { closeJournal?: () => void } = {}) {
  const journal = new MemoryJournal();
  const sessions = new Map<string, FakeSession>();
  let opened = 0;
  const registry = new SessionRegistry({
    open({ sessionId, cwd }) {
      opened++;
      const id = sessionId ?? `s${opened}`;
      const session = new FakeSession(journal, id);
      sessions.set(id, session);
      if (!sessionId) journal.append(id, 'session.opened', { cwd });
      return session;
    },
    exists: (id) => journal.read(id).length > 0,
    closeJournal: extra.closeJournal,
  });
  return { journal, sessions, registry, opened: () => opened };
}

/** Two NDJSON ends joined byte by byte, like stdio. */
export function link(): { client: Channel<unknown>; agent: Channel<unknown> } {
  const aToB = new TransformStream<Uint8Array, Uint8Array>();
  const bToA = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: ndjson({ readable: bToA.readable.pipeThrough(rechunk(1)), writable: aToB.writable }),
    agent: ndjson({ readable: aToB.readable.pipeThrough(rechunk(1)), writable: bToA.writable }),
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(2);
  }
}
