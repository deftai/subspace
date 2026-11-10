/**
 * Traces: every JSON-RPC message on a connection, with time and direction,
 * as JSON Lines. One format for recording (testkit), replay, and the trace
 * viewer (devtools).
 *
 *   const records: TraceRecord[] = [];
 *   const peer = new RpcPeer(channel, { tap: traceTap((r) => records.push(r), { peer: 'client' }) });
 *   ...
 *   await writeFile('session.trace.jsonl', formatTrace(records));
 *
 * Line 1 is a header. Then one record per message (and optional notes).
 * `t` is milliseconds since the header's `started`.
 */
import { systemClock, type Clock } from './clock.ts';

export const TRACE_VERSION = 1;

export interface TraceHeader {
  v: typeof TRACE_VERSION;
  kind: 'header';
  /** ISO time the trace started. */
  started: string;
  /** Which side recorded it, e.g. 'client'. */
  peer: string;
  label?: string;
  meta?: Record<string, unknown>;
}

export interface TraceMessage {
  v: typeof TRACE_VERSION;
  kind: 'message';
  t: number;
  /** As seen by the recording peer: `in` was received, `out` was sent. */
  dir: 'in' | 'out';
  msg: unknown;
}

export interface TraceNote {
  v: typeof TRACE_VERSION;
  kind: 'note';
  t: number;
  text: string;
  data?: unknown;
}

export type TraceRecord = TraceHeader | TraceMessage | TraceNote;

export interface TraceTapOptions {
  peer: string;
  label?: string;
  meta?: Record<string, unknown>;
  clock?: Clock;
  /** Change or drop (return undefined) a message before it is recorded, e.g. to remove secrets. */
  redact?: (message: unknown, dir: 'in' | 'out') => unknown;
}

export interface TraceTap {
  (direction: 'in' | 'out', message: unknown): void;
  /** Add a note at the current time. */
  note(text: string, data?: unknown): void;
}

/** An `RpcPeerOptions.tap` that records a trace. The header is written at once. */
export function traceTap(write: (record: TraceRecord) => void, options: TraceTapOptions): TraceTap {
  const clock = options.clock ?? systemClock;
  const start = clock.now();
  write({
    v: TRACE_VERSION,
    kind: 'header',
    started: new Date(start).toISOString(),
    peer: options.peer,
    ...(options.label ? { label: options.label } : {}),
    ...(options.meta ? { meta: options.meta } : {}),
  });
  const tap = ((direction: 'in' | 'out', message: unknown) => {
    const msg = options.redact ? options.redact(message, direction) : message;
    if (msg === undefined) return;
    // Copy, so later mutation of the message does not change the record.
    write({ v: TRACE_VERSION, kind: 'message', t: clock.now() - start, dir: direction, msg: structuredClone(msg) });
  }) as TraceTap;
  tap.note = (text, data) =>
    write({ v: TRACE_VERSION, kind: 'note', t: clock.now() - start, text, ...(data === undefined ? {} : { data }) });
  return tap;
}

/** Records as JSON Lines. */
export function formatTrace(records: readonly TraceRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/** Parse JSON Lines. Throws on a malformed line, naming it; skips blank lines. */
export function parseTrace(text: string): TraceRecord[] {
  const records: TraceRecord[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Trace line ${index + 1} is not JSON`, { cause: error });
    }
    const r = record as Partial<TraceRecord>;
    if (r?.v !== TRACE_VERSION || (r.kind !== 'header' && r.kind !== 'message' && r.kind !== 'note')) {
      throw new Error(`Trace line ${index + 1} is not a version ${TRACE_VERSION} trace record`);
    }
    records.push(r as TraceRecord);
  });
  if (records[0]?.kind !== 'header') throw new Error('A trace starts with a header record');
  return records;
}
