/**
 * Faults to put on a channel, to see how a peer copes with a bad wire.
 *
 *   const flaky = faultChannel(link.client, { read: [delay(5), closeWhen(isUpdate('agent_message_chunk'))] });
 *
 * Message transforms (`delay`, `disconnectAfter`, `closeWhen`) work on any
 * stream, counting chunks; on a byte stream a chunk is not a message. Byte
 * transforms (`rechunk`, `merge`, `coalesce`, `injectLines`) go below
 * `ndjson()`. The kernel's `merge(n)` holds chunks until it has `n`, so it
 * stalls a conversation; use `coalesce(ms)` there.
 */
import type { Channel } from '@deft-subspace/kernel';

export { merge, rechunk } from '@deft-subspace/kernel/testing';

/** Apply transforms, in order, to what is read from and written to a channel. */
export function faultChannel<T>(
  channel: Channel<T>,
  faults: { read?: Array<TransformStream<T, T>>; write?: Array<TransformStream<T, T>> }
): Channel<T> {
  const readable = (faults.read ?? []).reduce((stream, t) => stream.pipeThrough(t), channel.readable);
  const writes = faults.write ?? [];
  if (!writes.length) return { readable, writable: channel.writable };
  const tail = writes.slice(1).reduce((stream, t) => stream.pipeThrough(t), writes[0]!.readable);
  void tail.pipeTo(channel.writable).catch(() => {});
  return { readable, writable: writes[0]!.writable };
}

/** Merge the chunks that arrive within `ms` of the first into one. */
export function coalesce(ms: number): TransformStream<Uint8Array, Uint8Array> {
  let held: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!held.length) return;
    const out = new Uint8Array(held.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of held) {
      out.set(c, offset);
      offset += c.length;
    }
    held = [];
    try {
      controller.enqueue(out);
    } catch {
      // The stream was closed meanwhile.
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      held.push(chunk);
      timer ??= setTimeout(() => release(controller), ms);
    },
    flush: release,
  });
}

/** Hold each chunk for `ms` (or `ms(chunk)`) before passing it on. Order is kept. */
export function delay<T>(ms: number | ((chunk: T) => number)): TransformStream<T, T> {
  return new TransformStream<T, T>({
    async transform(chunk, controller) {
      const wait = typeof ms === 'function' ? ms(chunk) : ms;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      controller.enqueue(chunk);
    },
  });
}

/** Pass `count` chunks, then end the stream as a dropped connection would. */
export function disconnectAfter<T>(count: number): TransformStream<T, T> {
  let passed = 0;
  return new TransformStream<T, T>({
    start(controller) {
      if (count <= 0) controller.terminate();
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (++passed >= count) controller.terminate();
    },
  });
}

/**
 * End the stream at the first chunk that matches, e.g. mid-turn.
 * `including: true` (default) passes the matching chunk first.
 */
export function closeWhen<T>(matches: (chunk: T) => boolean, options: { including?: boolean } = {}): TransformStream<T, T> {
  const including = options.including ?? true;
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      if (!matches(chunk)) {
        controller.enqueue(chunk);
        return;
      }
      if (including) controller.enqueue(chunk);
      controller.terminate();
    },
  });
}

/** Matches a `session/update` message of the given kind (any kind if omitted). */
export function isUpdate(kind?: string): (message: unknown) => boolean {
  return (message) => {
    const m = message as { method?: unknown; params?: { update?: { sessionUpdate?: unknown } } } | null;
    return m?.method === 'session/update' && (kind === undefined || m.params?.update?.sessionUpdate === kind);
  };
}

/**
 * Put lines that are not JSON (banners, logs) into a byte stream: before the
 * first chunk, and after every `every`-th newline. A good reader skips them.
 */
export function injectLines(
  lines: readonly string[] = ['Welcome to the agent!', 'warning: not JSON'],
  options: { every?: number } = {}
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const noise = encoder.encode(lines.map((l) => `${l}\n`).join(''));
  const every = options.every ?? 1;
  // 0 would never inject (n % 0 is NaN): say so instead.
  if (!Number.isInteger(every) || every < 1) throw new RangeError(`injectLines: every must be a whole number of at least 1, not ${every}`);
  let started = false;
  let newlines = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!started) {
        started = true;
        controller.enqueue(noise);
      }
      let from = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x0a) continue;
        if (++newlines % every !== 0) continue;
        controller.enqueue(chunk.slice(from, i + 1));
        controller.enqueue(noise);
        from = i + 1;
      }
      if (from < chunk.length) controller.enqueue(chunk.slice(from));
    },
  });
}
