/**
 * Test helpers: a clock you move by hand, and faults you can put on a byte
 * stream (tiny chunks, merged chunks) to prove framing does not care how bytes
 * arrive.
 */
import type { Clock } from './clock.ts';

export interface ManualClock extends Clock {
  /** Move time forward, running every timer that comes due, in order. */
  advance(ms: number): void;
  readonly pendingTimers: number;
}

export function manualClock(start = 0): ManualClock {
  let now = start;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: now + Math.max(0, ms), callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let dueHandle: number | undefined;
        let dueAt = Infinity;
        for (const [handle, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueHandle = handle;
          }
        }
        if (dueHandle === undefined) break;
        const timer = timers.get(dueHandle)!;
        timers.delete(dueHandle);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

/** Re-chunk bytes into pieces of `size` bytes (1 = byte by byte). */
export function rechunk(size: number): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      for (let i = 0; i < chunk.length; i += size) controller.enqueue(chunk.slice(i, i + size));
    },
  });
}

/** Hold bytes and release them merged, every `count` chunks (and at the end). */
export function merge(count: number): TransformStream<Uint8Array, Uint8Array> {
  let held: Uint8Array[] = [];
  const release = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!held.length) return;
    const total = held.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of held) {
      out.set(c, offset);
      offset += c.length;
    }
    held = [];
    controller.enqueue(out);
  };
  return new TransformStream({
    transform(chunk, controller) {
      held.push(chunk);
      if (held.length >= count) release(controller);
    },
    flush: release,
  });
}

/** Resolve on the next macrotask, after pending stream work has run. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
