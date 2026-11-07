import { ndjson, type Channel } from '@deft-subspace/kernel';
import { rechunk } from '@deft-subspace/kernel/testing';

/**
 * Two byte ends joined as NDJSON, like stdio. `fault` (default: byte by byte)
 * re-chunks both directions, so framing is exercised on every test.
 */
export function byteLink(fault: () => TransformStream<Uint8Array, Uint8Array> = () => rechunk(1)) {
  const aToB = new TransformStream<Uint8Array, Uint8Array>();
  const bToA = new TransformStream<Uint8Array, Uint8Array>();
  const a: Channel<Uint8Array> = { readable: bToA.readable.pipeThrough(fault()), writable: aToB.writable };
  const b: Channel<Uint8Array> = { readable: aToB.readable.pipeThrough(fault()), writable: bToA.writable };
  let client: ReturnType<typeof ndjson> | undefined;
  let agent: ReturnType<typeof ndjson> | undefined;
  // Lazy: a test may hand `b` to the official SDK instead.
  return {
    a,
    b,
    get client() {
      return (client ??= ndjson(a));
    },
    get agent() {
      return (agent ??= ndjson(b));
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
