/**
 * Recording: keep a connection's traffic as a kernel trace (JSON Lines).
 *
 *   const rec = recorder({ peer: 'client', label: 'plain turn' });
 *   const client = await AcpClient.connect(channel, { tap: rec.tap });
 *   ...
 *   await writeFile('plain.trace.jsonl', rec.text());
 *
 * For a channel without an RpcPeer (an official-SDK peer, a proxy), wrap the
 * channel instead: `tapChannel(channel, rec.tap)`.
 */
import { formatTrace, traceTap, type Channel, type TraceRecord, type TraceTap, type TraceTapOptions } from '@deft-subspace/kernel';

export interface Recorder {
  /** Header first, then one record per message or note, as they happen. */
  readonly records: TraceRecord[];
  /** Pass as `tap` to an RpcPeer or AcpClient, or to `tapChannel`. */
  readonly tap: TraceTap;
  /** Add a note at the current time. */
  note(text: string, data?: unknown): void;
  /** The trace as JSON Lines. */
  text(): string;
}

export function recorder(options: TraceTapOptions): Recorder {
  const records: TraceRecord[] = [];
  const tap = traceTap((record) => records.push(record), options);
  return { records, tap, note: (text, data) => tap.note(text, data), text: () => formatTrace(records) };
}

/**
 * A channel that reports every message to `tap`: what is read is `in`, what
 * is written is `out`, as seen by whoever holds the returned channel.
 */
export function tapChannel<T>(channel: Channel<T>, tap: (direction: 'in' | 'out', message: T) => void): Channel<T> {
  const observe = (direction: 'in' | 'out') =>
    new TransformStream<T, T>({
      transform(message, controller) {
        try {
          tap(direction, message);
        } catch {
          // Taps observe; they never change the traffic.
        }
        controller.enqueue(message);
      },
    });
  const out = observe('out');
  void out.readable.pipeTo(channel.writable).catch(() => {});
  return { readable: channel.readable.pipeThrough(observe('in')), writable: out.writable };
}

/**
 * A `redact` function for `recorder()`: replaces every occurrence of each
 * string (or pattern) in every string of a message, e.g. a temp directory or
 * a home path, so traces can be committed.
 */
export function replaceStrings(pairs: ReadonlyArray<readonly [string | RegExp, string]>): (message: unknown) => unknown {
  const fix = (text: string) =>
    pairs.reduce(
      (acc, [from, to]) => (typeof from === 'string' ? (from ? acc.split(from).join(to) : acc) : acc.replace(from, to)),
      text
    );
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return fix(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk;
}

/** A `redact` function that replaces the value of every property with one of these names, at any depth. */
export function redactKeys(keys: readonly string[], replacement: unknown = '[redacted]'): (message: unknown) => unknown {
  const names = new Set(keys);
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, names.has(k) ? replacement : walk(v)]));
    }
    return value;
  };
  return walk;
}

/** The message records of a trace, flipped to the other side's view if needed. */
export function messagesOf(records: readonly TraceRecord[], as?: string): Array<{ t: number; dir: 'in' | 'out'; msg: unknown }> {
  const header = records[0]?.kind === 'header' ? records[0] : undefined;
  const flip = as !== undefined && header !== undefined && header.peer !== as;
  return records
    .filter((r) => r.kind === 'message')
    .map((r) => ({ t: r.t, dir: flip ? (r.dir === 'in' ? 'out' : 'in') : r.dir, msg: r.msg }));
}
