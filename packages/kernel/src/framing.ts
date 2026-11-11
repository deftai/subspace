import { pipeChannel, type Channel } from './channel.ts';

/** Something on the wire that was skipped instead of delivered. */
export interface FramingDiagnostic {
  kind: 'invalid-json' | 'too-large';
  /** Size of the skipped line in UTF-16 code units (close to bytes for ASCII). */
  size: number;
  /** The start of the skipped line, for logs. At most 200 characters. */
  preview: string;
  error?: unknown;
}

export interface NdjsonOptions {
  /**
   * Longest line accepted, in UTF-16 code units. Longer lines are skipped and
   * reported, so a runaway peer cannot exhaust memory. Default 32 MiB.
   */
  maxLineLength?: number;
  /** Called for each skipped line. Agents often print banners or logs on stdout. */
  onDiagnostic?: (diagnostic: FramingDiagnostic) => void;
}

const DEFAULT_MAX_LINE = 32 * 1024 * 1024;

/**
 * Split bytes into JSON values, one per line.
 *
 * - UTF-8 is decoded as a stream, so a character split across chunks survives.
 * - Each byte is looked at a bounded number of times, so long lines cost O(n).
 * - Lines that are not JSON are skipped and reported, not fatal.
 * - CRLF line endings and blank lines are accepted.
 */
export function ndjsonDecoder(options: NdjsonOptions = {}): TransformStream<Uint8Array, unknown> {
  const maxLine = options.maxLineLength ?? DEFAULT_MAX_LINE;
  const decoder = new TextDecoder('utf-8');
  let pieces: string[] = [];
  let pendingLength = 0;
  let skipping = false; // inside an over-long line; drop until the next newline

  const report = (diagnostic: FramingDiagnostic) => {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // A broken diagnostics hook must not break the stream.
    }
  };

  const emitLine = (line: string, controller: TransformStreamDefaultController<unknown>) => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.trim() === '') return;
    try {
      controller.enqueue(JSON.parse(text));
    } catch (error) {
      report({ kind: 'invalid-json', size: text.length, preview: text.slice(0, 200), error });
    }
  };

  const take = (text: string, controller: TransformStreamDefaultController<unknown>) => {
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;
      const tail = text.slice(start, newline);
      if (skipping) {
        skipping = false;
      } else if (pendingLength + tail.length > maxLine) {
        report({ kind: 'too-large', size: pendingLength + tail.length, preview: (pieces[0] ?? tail).slice(0, 200) });
      } else {
        emitLine(pieces.length ? pieces.join('') + tail : tail, controller);
      }
      pieces = [];
      pendingLength = 0;
      start = newline + 1;
    }
    const rest = text.slice(start);
    if (rest && !skipping) {
      if (pendingLength + rest.length > maxLine) {
        report({ kind: 'too-large', size: pendingLength + rest.length, preview: (pieces[0] ?? rest).slice(0, 200) });
        pieces = [];
        pendingLength = 0;
        skipping = true;
      } else {
        pieces.push(rest);
        pendingLength += rest.length;
      }
    }
  };

  return new TransformStream<Uint8Array, unknown>({
    transform(chunk, controller) {
      take(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      take(decoder.decode(), controller);
      // A final line without a newline still counts.
      if (!skipping && pieces.length) emitLine(pieces.join(''), controller);
    },
  });
}

/** A value that has no JSON form (a cycle, a BigInt, `undefined`). */
export class EncodeError extends Error {
  constructor(cause: unknown) {
    super(`Value cannot be encoded as JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'EncodeError';
  }
}

// Objects the encoder could not write, and why. A stream cannot fail one
// write without failing for good, so the writer asks here afterwards.
const encodeFailures = new WeakMap<object, EncodeError>();

/** The EncodeError for a value an encoder just skipped, if it did. Clears it. */
export function takeEncodeFailure(value: unknown): EncodeError | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const failure = encodeFailures.get(value);
  if (failure) encodeFailures.delete(value);
  return failure;
}

/**
 * Write JSON values as lines of UTF-8. A value that cannot be serialized
 * (a cycle, a BigInt, `undefined`) is dropped and reported; it never breaks
 * the stream. An RpcPeer writing through `ndjson()` fails that one write.
 */
export function ndjsonEncoder(options: { onError?: (error: unknown, value: unknown) => void } = {}): TransformStream<unknown, Uint8Array> {
  const encoder = new TextEncoder();
  const fail = (cause: unknown, value: unknown) => {
    const error = new EncodeError(cause);
    if (typeof value === 'object' && value !== null) encodeFailures.set(value, error);
    try {
      options.onError?.(cause, value);
    } catch {
      // A broken error hook must not break the stream.
    }
  };
  return new TransformStream<unknown, Uint8Array>({
    transform(value, controller) {
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        fail(error, value);
        return;
      }
      // undefined, functions and symbols have no JSON form.
      if (text === undefined) {
        fail(new TypeError(`${typeof value} is not JSON`), value);
        return;
      }
      controller.enqueue(encoder.encode(`${text}\n`));
    },
  });
}

/** A byte channel (stdio, a socket) as a channel of JSON values. */
export function ndjson(bytes: Channel<Uint8Array>, options: NdjsonOptions = {}): Channel<unknown> {
  return pipeChannel(bytes, { read: ndjsonDecoder(options), write: ndjsonEncoder() });
}
