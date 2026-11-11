/**
 * A turn: one prompt and everything the agent does about it.
 *
 *   const turn = session.prompt('Fix the failing test');
 *   for await (const event of turn) render(event);
 *   const { stopReason, text } = await turn.done;
 *
 * - `done` settles only after the last event has been delivered, on v1 and v2.
 * - Iterate as many times as you like; each iterator starts from the first event.
 * - Each message, thought and user message is followed by a `*_end` event
 *   once something else arrives or the turn ends.
 * - `cancel()` tells the agent, answers its open permission questions with
 *   `cancelled`, and ends the turn if the agent does not confirm in time.
 * - `history` (a prompt option) bounds what the turn keeps for a long turn;
 *   see `TurnHistory`.
 */
import { dispatch, TextTracker, type TurnHandlers } from './handlers.ts';
import type { ToolCall, TurnEvent, TurnResult } from './model.ts';

/**
 * What a turn keeps of its events, for `history` and for iterating it again:
 * `'all'` (the default) keeps every event; a number keeps the last that many;
 * `'none'` keeps none. An event is only dropped once every iterator running
 * at the time (and the turn's handlers) has had it, so a running reader never
 * misses one; an iterator started later begins at the oldest event kept. An
 * iterator you stop calling `next()` on without ending it (`break`,
 * `return()`) holds events back until it is garbage collected.
 * `text`, `toolCalls` and `done` are not affected.
 */
export type TurnHistory = 'all' | 'none' | number;

/** @internal What the turn knows so far, for `text` and `toolCalls`. */
export interface TurnView {
  text(): string;
  toolCalls(): ToolCall[];
}

type TextEvent = Extract<TurnEvent, { type: 'message' | 'thought' | 'user_message' }>;
const isText = (event: TurnEvent): event is TextEvent => event.type === 'message' || event.type === 'thought' || event.type === 'user_message';
/** What ends an open message: other text, or content. Usage, state, title and other notices do not. */
const ends = (event: TurnEvent) => isText(event) || event.type === 'tool_call' || event.type === 'plan' || event.type === 'permission' || event.type === 'terminal';

export class Turn implements AsyncIterable<TurnEvent> {
  readonly id: string;
  readonly done: Promise<TurnResult>;

  /** Events kept, from `head` on; `dropped` events came before them. */
  private events: TurnEvent[] = [];
  private head = 0;
  private dropped = 0;
  /** How many events to keep; undefined keeps all. */
  private readonly keep?: number;
  /**
   * Where each running iterator is (an absolute event index). Held weakly: an
   * iterator dropped while suspended at a yield never runs its `finally`, so
   * its cursor goes when the iterator is collected instead of pinning history.
   */
  private readonly cursors = new Set<WeakRef<{ index: number }>>();
  private readonly waiters = new Set<() => void>();
  private finished?: { ok: true; result: TurnResult } | { ok: false; error: unknown };
  private resolveDone!: (result: TurnResult) => void;
  private rejectDone!: (error: unknown) => void;
  private readonly onCancel: () => Promise<void>;
  private readonly view?: TurnView;
  private cancelling?: Promise<void>;
  /** Runs the turn's handlers; `done` waits for it. */
  private observer?: Promise<void>;
  /** The handlers will not run again (they finished, or one failed). */
  private observerEnded = false;
  private handlerFailed?: { error: unknown };
  /** Events the observer has finished dispatching. */
  private dispatched = 0;
  private readonly progress = new Set<() => void>();
  /** The message being streamed, as its latest event. */
  private open?: TextEvent;

  /** @internal */
  constructor(id: string, onCancel: () => Promise<void>, view?: TurnView, history: TurnHistory = 'all') {
    this.id = id;
    this.onCancel = onCancel;
    this.view = view;
    if (history === 'none') this.keep = 0;
    else if (typeof history === 'number') {
      if (!Number.isInteger(history) || history < 0) throw new RangeError(`history must be 'all', 'none' or a whole number >= 0, not ${history}`);
      this.keep = history;
    }
    this.done = new Promise<TurnResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // Iterating without awaiting `done` must not raise an unhandled rejection.
    this.done.catch(() => {});
  }

  get isDone(): boolean {
    return this.finished !== undefined;
  }

  /** Events so far (the ones kept, with the `history` option). */
  get history(): readonly TurnEvent[] {
    return this.head ? this.events.slice(this.head) : this.events;
  }

  /** How many events the turn has had, kept or not. */
  private get total(): number {
    return this.dropped + this.events.length - this.head;
  }

  /** Agent message text so far (the whole turn's, once done). */
  get text(): string {
    return this.finished?.ok ? this.finished.result.text : (this.view?.text() ?? '');
  }

  /** Tool calls so far, each with every update merged in. */
  get toolCalls(): ToolCall[] {
    return this.finished?.ok ? this.finished.result.toolCalls : (this.view?.toolCalls() ?? []);
  }

  /** Ask the agent to stop. Resolves once the request is sent; await `done` for the end. */
  cancel(): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.cancelling ??= this.onCancel();
    return this.cancelling;
  }

  get cancelRequested(): boolean {
    return this.cancelling !== undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
    const cursor = { index: this.dropped };
    const ref = new WeakRef(cursor);
    this.cursors.add(ref);
    try {
      for (;;) {
        while (cursor.index < this.total) {
          const event = this.events[this.head + cursor.index - this.dropped]!;
          cursor.index++;
          yield event;
        }
        if (this.finished) {
          if (!this.finished.ok) throw this.finished.error;
          return;
        }
        // Caught up: what this reader held back can go.
        this.trim();
        await new Promise<void>((resolve) => this.waiters.add(resolve));
      }
    } finally {
      this.cursors.delete(ref);
      this.trim();
    }
  }

  /** @internal */
  push(...events: TurnEvent[]): void {
    if (this.finished || events.length === 0) return;
    for (const event of events) {
      if (this.open && ends(event) && !(isText(event) && event.type === this.open.type && event.messageId === this.open.messageId)) this.close(true);
      if (isText(event)) this.open = event;
      this.events.push(event);
    }
    this.trim();
    this.wake();
  }

  /** Drop events past `history` that every running iterator has had. */
  private trim(): void {
    if (this.keep === undefined) return;
    let until = this.total - this.keep;
    for (const ref of this.cursors) {
      const cursor = ref.deref();
      if (cursor) until = Math.min(until, cursor.index);
      else this.cursors.delete(ref);
    }
    if (until <= this.dropped) return;
    for (let i = this.head; i < this.head + until - this.dropped; i++) this.events[i] = undefined as unknown as TurnEvent;
    this.head += until - this.dropped;
    this.dropped = until;
    // A new array once most of it is dropped, so dropping stays cheap.
    if (this.head > 64 && this.head * 2 > this.events.length) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  /** End the open message, if any. */
  private close(complete: boolean): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    this.events.push({ type: `${open.type}_end`, messageId: open.messageId, text: open.text, complete });
  }

  /** @internal */
  finish(result: TurnResult): void {
    if (this.finished) return;
    this.close(result.stopReason === 'end_turn' && !result.cancelled);
    this.trim();
    this.finished = { ok: true, result };
    this.wake();
    this.settle(() => this.resolveDone(result));
  }

  /** @internal */
  fail(error: unknown): void {
    if (this.finished) return;
    this.close(false);
    this.trim();
    this.finished = { ok: false, error };
    this.wake();
    this.settle(() => this.rejectDone(error));
  }

  /**
   * @internal Run `handlers` for every event, in order, one at a time. `done`
   * settles after the last one ran; a handler that throws cancels the turn,
   * and `done` rejects with its error.
   */
  observe(handlers: TurnHandlers): void {
    if (this.observer) return;
    this.observer = (async () => {
      try {
        const text = new TextTracker();
        for await (const event of this) {
          await dispatch(event, handlers, text);
          this.dispatched++;
          for (const notify of [...this.progress]) notify();
        }
      } catch (error) {
        // The turn's own failure ends the loop too; only a handler's error is kept.
        if (this.finished?.ok !== false || this.finished.error !== error) {
          this.handlerFailed = { error };
          void this.cancel();
        }
      } finally {
        // Nothing waits for handlers that will not run again.
        this.observerEnded = true;
        for (const notify of [...this.progress]) notify();
      }
    })();
  }

  /**
   * @internal Wait until the handlers have run for every event so far (at most
   * `maxMs`), so that a question to the user comes after what the agent said
   * before asking it.
   */
  async caughtUp(maxMs = 1000): Promise<void> {
    if (!this.observer || this.observerEnded || this.finished) return;
    const target = this.total;
    if (this.dispatched >= target) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.progress.delete(check);
        resolve();
      };
      const check = () => {
        if (this.dispatched >= target || this.finished || this.observerEnded) done();
      };
      const timer = setTimeout(done, maxMs);
      this.progress.add(check);
    });
  }

  private settle(complete: () => void): void {
    if (!this.observer) return complete();
    void this.observer.then(() => (this.handlerFailed ? this.rejectDone(this.handlerFailed.error) : complete()));
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
