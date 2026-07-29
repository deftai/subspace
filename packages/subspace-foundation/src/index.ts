/**
 * Protocol-agnostic kernel sketches for subspace phase-1 local prototypes.
 *
 * Owns: byte/message transport contracts, NDJSON framing, in-process message
 * duplex pairs, and a thin Connection wrapper over MessageTransport.
 * Does not own: ACP/JSON-RPC shapes, process/stdio wiring, or product agents.
 */

/** Optional close metadata; error present means abnormal teardown. */
export type CloseReason = { error?: unknown };

/**
 * Raw byte duplex: open/close lifecycle plus write + readable chunks.
 * Implementations own the physical channel; callers own framing/codec.
 */
export interface ByteTransport {
  readonly kind: string;
  open(): Promise<void>;
  close(reason?: CloseReason): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
  readonly readable: AsyncIterable<Uint8Array>;
  readonly closed: Promise<CloseReason | undefined>;
}

/**
 * Stateful frame boundary layer over byte chunks.
 * push may yield zero or more complete frames; incomplete tail stays buffered.
 */
export interface Framer<TFrame = Uint8Array> {
  push(chunk: Uint8Array): TFrame[];
  reset?(): void;
  encode(frame: TFrame): Uint8Array;
}

/**
 * Symmetric encode/decode between domain messages and frames.
 * Stateless relative to the channel; does not own buffering.
 */
export interface Codec<TMessage, TFrame = Uint8Array> {
  decode(frame: TFrame): TMessage;
  encode(message: TMessage): TFrame;
}

/**
 * Message-level duplex (structured values, not raw bytes).
 * Same lifecycle shape as ByteTransport; send replaces write.
 */
export interface MessageTransport<TMessage> {
  readonly kind: string;
  open(): Promise<void>;
  close(reason?: CloseReason): Promise<void>;
  send(message: TMessage): Promise<void>;
  readonly readable: AsyncIterable<TMessage>;
  readonly closed: Promise<CloseReason | undefined>;
}

/**
 * Named handle over a MessageTransport for session-style callers.
 * Does not open the underlay; assumes transport is already usable.
 */
export interface Connection<TMessage> {
  readonly id: string;
  send(message: TMessage): Promise<void>;
  readonly messages: AsyncIterable<TMessage>;
  close(reason?: CloseReason): Promise<void>;
  readonly closed: Promise<CloseReason | undefined>;
}

/**
 * NDJSON / line framer — cumulative buffer so partial chunks do not drop data.
 * Incomplete trailing line is re-encoded into buffer until a newline arrives.
 */
export function defineNdjsonFramer(): Framer<Uint8Array> {
  let buffer = new Uint8Array(0);
  const te = new TextEncoder();
  const td = new TextDecoder();

  return {
    /**
     * Merge chunk into buffer; emit complete non-empty lines as frames.
     * Invariant: buffer always holds only the incomplete trailing fragment.
     */
    push(chunk: Uint8Array): Uint8Array[] {
      // Grow buffer by concatenation — Uint8Array has no efficient append.
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      const text = td.decode(merged);
      const lines = text.split("\n");
      // pop leaves the partial last segment (possibly empty) for next push.
      const incomplete = lines.pop() ?? "";
      buffer = te.encode(incomplete);
      return lines
        .filter((line) => line.length > 0)
        .map((line) => te.encode(line));
    },
    /** Drop any partial line so a new stream does not inherit stale bytes. */
    reset() {
      buffer = new Uint8Array(0);
    },
    /** Wire format: one frame per line, always terminated with \\n. */
    encode(frame: Uint8Array): Uint8Array {
      const nl = te.encode("\n");
      const out = new Uint8Array(frame.length + nl.length);
      out.set(frame);
      out.set(nl, frame.length);
      return out;
    },
  };
}

/** Queue cell: value, clean end, or error — drives async readable handoff. */
type QueueItem<T> =
  | { ok: true; value: T }
  | { ok: false; done: true }
  | { ok: false; error: unknown };

/**
 * In-process structured duplex pair (no bytes, no JSON).
 * a.send lands on b.readable and vice versa; closing one end also ends the peer.
 */
export function defineMessagePair<TMessage>(): {
  a: MessageTransport<TMessage>;
  b: MessageTransport<TMessage>;
} {
  // Directional queues + single waiter each: either buffer or deliver live.
  const ab: QueueItem<TMessage>[] = [];
  const ba: QueueItem<TMessage>[] = [];
  let abWait: ((item: QueueItem<TMessage>) => void) | undefined;
  let baWait: ((item: QueueItem<TMessage>) => void) | undefined;
  let closedA: CloseReason | undefined;
  let closedB: CloseReason | undefined;
  let resolveClosedA!: (r: CloseReason | undefined) => void;
  let resolveClosedB!: (r: CloseReason | undefined) => void;
  const closedAPromise = new Promise<CloseReason | undefined>((r) => {
    resolveClosedA = r;
  });
  const closedBPromise = new Promise<CloseReason | undefined>((r) => {
    resolveClosedB = r;
  });

  /**
   * Deliver immediately if a reader is parked; otherwise enqueue.
   * Wait box is cleared so only one consumer is woken per item.
   */
  function push(
    queue: QueueItem<TMessage>[],
    wait: { current?: (item: QueueItem<TMessage>) => void },
    item: QueueItem<TMessage>,
  ) {
    if (wait.current) {
      const w = wait.current;
      wait.current = undefined;
      w(item);
    } else {
      queue.push(item);
    }
  }

  const abWaitBox: { current?: (item: QueueItem<TMessage>) => void } = {};
  const baWaitBox: { current?: (item: QueueItem<TMessage>) => void } = {};

  /**
   * Async iterator: drain queue or park until push supplies the next item.
   * Terminal items end the generator (error throws, done returns).
   */
  async function* readable(
    queue: QueueItem<TMessage>[],
    waitBox: { current?: (item: QueueItem<TMessage>) => void },
  ): AsyncIterable<TMessage> {
    for (;;) {
      // Prefer buffered items so back-to-back sends stay ordered without races.
      const item =
        queue.shift() ??
        (await new Promise<QueueItem<TMessage>>((resolve) => {
          waitBox.current = resolve;
        }));
      if (!item.ok) {
        if ("error" in item) throw item.error;
        return;
      }
      yield item.value;
    }
  }

  /**
   * Build one MessageTransport endpoint wired to the given send/recv queues.
   * peerClose runs when this side closes so the counterpart stops reading.
   */
  function makeSide(
    kind: string,
    sendQueue: QueueItem<TMessage>[],
    sendWait: { current?: (item: QueueItem<TMessage>) => void },
    recvQueue: QueueItem<TMessage>[],
    recvWait: { current?: (item: QueueItem<TMessage>) => void },
    getClosed: () => CloseReason | undefined,
    setClosed: (r: CloseReason | undefined) => void,
    resolveClosed: (r: CloseReason | undefined) => void,
    closedPromise: Promise<CloseReason | undefined>,
    peerClose: () => void,
  ): MessageTransport<TMessage> {
    return {
      kind,
      async open() {},
      /**
       * Idempotent close: end local readable, notify peer, settle closed.
       * First closer wins; subsequent calls no-op.
       */
      async close(reason?: CloseReason) {
        if (getClosed() !== undefined) return;
        setClosed(reason ?? {});
        // Stop our readers; peerClose stops the other direction.
        push(recvQueue, recvWait, { ok: false, done: true });
        peerClose();
        resolveClosed(reason ?? {});
      },
      /** Reject after close so callers do not silently drop outbound traffic. */
      async send(message: TMessage) {
        if (getClosed() !== undefined) {
          throw new Error("MessageTransport closed");
        }
        push(sendQueue, sendWait, { ok: true, value: message });
      },
      get readable() {
        return readable(recvQueue, recvWait);
      },
      get closed() {
        return closedPromise;
      },
    };
  }

  let aRef: MessageTransport<TMessage>;
  let bRef: MessageTransport<TMessage>;

  // a → ab → b.readable; peerClose on a ends b if still open.
  aRef = makeSide(
    "memory-message-a",
    ab,
    abWaitBox,
    ba,
    baWaitBox,
    () => closedA,
    (r) => {
      closedA = r;
    },
    resolveClosedA,
    closedAPromise,
    () => {
      // Half-close peer only once so closed promises settle a single time.
      if (closedB === undefined) {
        closedB = {};
        push(ab, abWaitBox, { ok: false, done: true });
        resolveClosedB({});
      }
    },
  );

  // b → ba → a.readable; peerClose on b ends a if still open.
  bRef = makeSide(
    "memory-message-b",
    ba,
    baWaitBox,
    ab,
    abWaitBox,
    () => closedB,
    (r) => {
      closedB = r;
    },
    resolveClosedB,
    closedBPromise,
    () => {
      if (closedA === undefined) {
        closedA = {};
        push(ba, baWaitBox, { ok: false, done: true });
        resolveClosedA({});
      }
    },
  );

  return { a: aRef, b: bRef };
}

/**
 * Wrap a MessageTransport as a Connection with a stable session id.
 * Pure adapter — does not open/close beyond forwarding.
 */
export function openMessageConnection<TMessage>(
  transport: MessageTransport<TMessage>,
  id = crypto.randomUUID(),
): Connection<TMessage> {
  return {
    id,
    send: (m) => transport.send(m),
    messages: transport.readable,
    close: (r) => transport.close(r),
    closed: transport.closed,
  };
}
