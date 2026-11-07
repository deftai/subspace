/**
 * A channel is a duplex of Web Streams: read what the other side sent, write
 * what you send. Bytes on the edges (stdio, sockets), structured messages in
 * process. Web Streams run unchanged on Node, Bun, Deno and browsers.
 */
export interface Channel<T> {
  readonly readable: ReadableStream<T>;
  readonly writable: WritableStream<T>;
}

/**
 * Two connected channels in one process: what `a` writes, `b` reads, and the
 * other way round. No bytes, no JSON. Use it to run a client and an agent
 * together in tests or in one app.
 */
export function channelPair<T>(): [a: Channel<T>, b: Channel<T>] {
  const aToB = new TransformStream<T, T>();
  const bToA = new TransformStream<T, T>();
  return [
    { readable: bToA.readable, writable: aToB.writable },
    { readable: aToB.readable, writable: bToA.writable },
  ];
}

/** Apply a transform to each direction of a channel. */
export function pipeChannel<A, B>(
  channel: Channel<A>,
  transforms: { read: TransformStream<A, B>; write: TransformStream<B, A> }
): Channel<B> {
  void transforms.write.readable.pipeTo(channel.writable).catch(() => {});
  return {
    readable: channel.readable.pipeThrough(transforms.read),
    writable: transforms.write.writable,
  };
}
