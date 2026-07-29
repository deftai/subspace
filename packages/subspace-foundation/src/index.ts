/** Protocol-agnostic kernel sketches — phase-1 local prototype. */

export type CloseReason = { error?: unknown };

export interface ByteTransport {
  readonly kind: string;
  open(): Promise<void>;
  close(reason?: CloseReason): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
  readonly readable: AsyncIterable<Uint8Array>;
  readonly closed: Promise<CloseReason | undefined>;
}

export interface Framer<TFrame = Uint8Array> {
  push(chunk: Uint8Array): TFrame[];
  reset?(): void;
  encode(frame: TFrame): Uint8Array;
}

export interface Codec<TMessage, TFrame = Uint8Array> {
  decode(frame: TFrame): TMessage;
  encode(message: TMessage): TFrame;
}

export interface MessageTransport<TMessage> {
  readonly kind: string;
  open(): Promise<void>;
  close(reason?: CloseReason): Promise<void>;
  send(message: TMessage): Promise<void>;
  readonly readable: AsyncIterable<TMessage>;
  readonly closed: Promise<CloseReason | undefined>;
}

export interface Connection<TMessage> {
  readonly id: string;
  send(message: TMessage): Promise<void>;
  readonly messages: AsyncIterable<TMessage>;
  close(reason?: CloseReason): Promise<void>;
  readonly closed: Promise<CloseReason | undefined>;
}

/** NDJSON / line framer — stateful cumulation. */
export function defineNdjsonFramer(): Framer<Uint8Array> {
  let buffer = new Uint8Array(0);
  const te = new TextEncoder();
  const td = new TextDecoder();

  return {
    push(chunk: Uint8Array): Uint8Array[] {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      const text = td.decode(merged);
      const lines = text.split("\n");
      const incomplete = lines.pop() ?? "";
      buffer = te.encode(incomplete);
      return lines
        .filter((line) => line.length > 0)
        .map((line) => te.encode(line));
    },
    reset() {
      buffer = new Uint8Array(0);
    },
    encode(frame: Uint8Array): Uint8Array {
      const nl = te.encode("\n");
      const out = new Uint8Array(frame.length + nl.length);
      out.set(frame);
      out.set(nl, frame.length);
      return out;
    },
  };
}

type QueueItem<T> =
  | { ok: true; value: T }
  | { ok: false; done: true }
  | { ok: false; error: unknown };

/** In-process message duplex pair (structured objects, no bytes). */
export function defineMessagePair<TMessage>(): {
  a: MessageTransport<TMessage>;
  b: MessageTransport<TMessage>;
} {
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

  async function* readable(
    queue: QueueItem<TMessage>[],
    waitBox: { current?: (item: QueueItem<TMessage>) => void },
  ): AsyncIterable<TMessage> {
    for (;;) {
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
      async close(reason?: CloseReason) {
        if (getClosed() !== undefined) return;
        setClosed(reason ?? {});
        push(recvQueue, recvWait, { ok: false, done: true });
        peerClose();
        resolveClosed(reason ?? {});
      },
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
      if (closedB === undefined) {
        closedB = {};
        push(ab, abWaitBox, { ok: false, done: true });
        resolveClosedB({});
      }
    },
  );

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
