/**
 * A turn: one prompt and everything the agent does about it.
 *
 *   const turn = session.prompt('Fix the failing test');
 *   for await (const event of turn) render(event);
 *   const { stopReason, text } = await turn.done;
 *
 * - `done` settles only after the last event has been delivered, on v1 and v2.
 * - Iterate as many times as you like; each iterator starts from the first event.
 * - `cancel()` tells the agent, answers its open permission questions with
 *   `cancelled`, and ends the turn if the agent does not confirm in time.
 */
import type { ToolCall, TurnEvent, TurnResult } from './model.ts';

/** @internal What the turn knows so far, for `text` and `toolCalls`. */
export interface TurnView {
  text(): string;
  toolCalls(): ToolCall[];
}

export class Turn implements AsyncIterable<TurnEvent> {
  readonly id: string;
  readonly done: Promise<TurnResult>;

  private readonly events: TurnEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private finished?: { ok: true; result: TurnResult } | { ok: false; error: unknown };
  private resolveDone!: (result: TurnResult) => void;
  private rejectDone!: (error: unknown) => void;
  private readonly onCancel: () => Promise<void>;
  private readonly view?: TurnView;
  private cancelling?: Promise<void>;

  /** @internal */
  constructor(id: string, onCancel: () => Promise<void>, view?: TurnView) {
    this.id = id;
    this.onCancel = onCancel;
    this.view = view;
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

  /** Events so far. */
  get history(): readonly TurnEvent[] {
    return this.events;
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
    let index = 0;
    for (;;) {
      while (index < this.events.length) yield this.events[index++]!;
      if (this.finished) {
        if (!this.finished.ok) throw this.finished.error;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** @internal */
  push(...events: TurnEvent[]): void {
    if (this.finished || events.length === 0) return;
    this.events.push(...events);
    this.wake();
  }

  /** @internal */
  finish(result: TurnResult): void {
    if (this.finished) return;
    this.finished = { ok: true, result };
    this.wake();
    this.resolveDone(result);
  }

  /** @internal */
  fail(error: unknown): void {
    if (this.finished) return;
    this.finished = { ok: false, error };
    this.wake();
    this.rejectDone(error);
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
