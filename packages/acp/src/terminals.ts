/**
 * Terminals the agent runs and shows (v2 `terminal_update`,
 * `terminal_output_chunk`). Display only: the client cannot control them. A
 * tool call refers to one with content `{ type: 'terminal', terminalId }`;
 * look it up with `session.terminals.get(terminalId)`. Updates and the tool
 * call may arrive in either order, and a terminal can outlive its turn, so
 * the session keeps them.
 *
 *   for await (const event of turn) {
 *     if (event.type === 'terminal') render(event.terminal.id, event.appended ?? event.terminal.output);
 *   }
 *
 * Output is bytes (it may split a UTF-8 character or an escape sequence);
 * `terminalText()` decodes it for a plain transcript.
 */
import { defineLazy } from './lazy.ts';

export interface TerminalExit {
  exitCode?: number;
  signal?: string;
}

export interface TerminalState {
  id: string;
  command?: string;
  /** Absolute. */
  cwd?: string;
  /** The size the command runs with, in character cells. */
  size?: { cols: number; rows: number };
  /**
   * Every byte the agent wants shown, so far (the last million by default).
   * An event's snapshot joins it from the stored chunks the first time it is
   * read, so it costs nothing until you look; after that it is the
   * snapshot's own array.
   */
  output: Uint8Array;
  /** Present once the command has exited. */
  exitStatus?: TerminalExit;
  /** The agent lets the client stop it (`session.cancelTerminal()`). */
  cancellable?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** RFC 4648 base64 to bytes, in any runtime. Undecodable data gives no bytes. */
function bytes(data: unknown): Uint8Array {
  if (typeof data !== 'string') return new Uint8Array();
  try {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

/** Where a terminal's output was at one moment: a view of the log's segments, never a copy. */
interface Span {
  segments: Uint8Array[];
  /** Bytes written into each segment; frozen for every segment but the last. */
  fills: number[];
  /** First live byte: segment index and offset in it. */
  start: number;
  startOffset: number;
  /** One past the last live segment, and the bytes used of `segments[end - 1]`. */
  end: number;
  endFill: number;
  length: number;
}

/** Segment size: small writes share one segment, so a chunk is not an object of its own. */
const SEGMENT = 64 * 1024;

/**
 * Output as a list of append-only segments. Appending copies only the new
 * bytes; a snapshot is a span over the segments; bytes are joined only when
 * read. Bytes a span covers are never written again: appends go past its end,
 * and dropping old output (the cap) or a replacement starts new arrays.
 */
class OutputLog {
  private segments: Uint8Array[] = [];
  private fills: number[] = [];
  private start = 0;
  private startOffset = 0;
  private length = 0;
  private current?: Span;
  /** The output last read through now(), and its bytes. */
  private cache?: { span: Span; bytes: Uint8Array };
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.length;
  }

  /** @internal How many segment arrays and bytes this log holds (for tests). */
  get stats(): { segments: number; capacity: number } {
    let capacity = 0;
    for (let i = this.start; i < this.segments.length; i++) capacity += this.segments[i]!.length;
    return { segments: this.segments.length - this.start, capacity };
  }

  append(data: Uint8Array): void {
    if (data.length === 0) return;
    let source = data;
    // Past the cap, only the last maxBytes can survive.
    if (source.length > this.maxBytes) source = source.subarray(source.length - this.maxBytes);
    const last = this.segments.length - 1;
    let written = 0;
    if (last >= this.start) {
      const room = this.segments[last]!.length - this.fills[last]!;
      written = Math.min(room, source.length);
      if (written) {
        this.segments[last]!.set(source.subarray(0, written), this.fills[last]!);
        this.fills[last]! += written;
      }
    }
    if (written < source.length) {
      const rest = source.subarray(written);
      // Segments grow with the output, up to SEGMENT, so a short output stays small.
      const segment = new Uint8Array(Math.max(rest.length, Math.min(SEGMENT, Math.max(1024, this.length))));
      segment.set(rest);
      this.segments.push(segment);
      this.fills.push(rest.length);
    }
    this.length += source.length;
    this.current = undefined;
    this.drop();
  }

  /** Replace everything kept so far. */
  reset(data: Uint8Array): void {
    this.segments = [];
    this.fills = [];
    this.start = 0;
    this.startOffset = 0;
    this.length = 0;
    this.current = undefined;
    this.append(data);
  }

  /** The output as it is now. Spans stay valid however the log changes later. */
  span(): Span {
    this.current ??= {
      segments: this.segments,
      fills: this.fills,
      start: this.start,
      startOffset: this.startOffset,
      end: this.segments.length,
      endFill: this.segments.length ? this.fills[this.segments.length - 1]! : 0,
      length: this.length,
    };
    return this.current;
  }

  /** The output as it is now: the same array until the output changes. */
  now(): Uint8Array {
    const span = this.span();
    if (this.cache?.span !== span) this.cache = { span, bytes: this.bytes(span) };
    return this.cache.bytes;
  }

  /** A new array of the bytes a span covers. */
  bytes(span: Span): Uint8Array {
    const out = new Uint8Array(span.length);
    let at = 0;
    for (let i = span.start; i < span.end; i++) {
      const from = i === span.start ? span.startOffset : 0;
      const to = i === span.end - 1 ? span.endFill : span.fills[i]!;
      out.set(span.segments[i]!.subarray(from, to), at);
      at += to - from;
    }
    return out;
  }

  /** Drop output from the front past the cap. */
  private drop(): void {
    let excess = this.length - this.maxBytes;
    if (excess <= 0) return;
    this.length -= excess;
    while (excess > 0) {
      const available = this.fills[this.start]! - this.startOffset;
      if (available <= excess) {
        excess -= available;
        this.start++;
        this.startOffset = 0;
      } else {
        this.startOffset += excess;
        excess = 0;
      }
    }
    // New arrays once most entries are dropped: spans keep the old ones.
    if (this.start > 32 && this.start * 2 > this.segments.length) {
      this.segments = this.segments.slice(this.start);
      this.fills = this.fills.slice(this.start);
      this.start = 0;
    }
  }
}

/** The output as text, for a transcript (invalid UTF-8 becomes U+FFFD; escape sequences are kept). */
export function terminalText(terminal: Pick<TerminalState, 'output'>): string {
  return new TextDecoder().decode(terminal.output);
}

/**
 * A live terminal's `output`: the log as it is now. Assigning replaces what is
 * kept, as a `terminal_update` with output does.
 */
function defineLiveOutput(target: object, log: OutputLog): void {
  Object.defineProperty(target, 'output', {
    get: () => log.now(),
    set: (value: unknown) => log.reset(value instanceof Uint8Array ? value : new Uint8Array()),
    enumerable: true,
    configurable: true,
  });
}

export class Terminals {
  private readonly byId = new Map<string, TerminalState>();
  private readonly logs = new Map<string, OutputLog>();
  /** Bytes kept per terminal; older output is dropped from the front past this. */
  private readonly maxBytes: number;

  constructor(maxBytes = 1_000_000) {
    this.maxBytes = maxBytes;
  }

  get(id: string): Readonly<TerminalState> | undefined {
    return this.byId.get(id);
  }

  get all(): ReadonlyArray<Readonly<TerminalState>> {
    return [...this.byId.values()];
  }

  /**
   * The terminal as it is now, unchanged by later updates. Its `output` is
   * joined the first time it is read: a snapshot nobody reads copies nothing.
   */
  snapshot(id: string): Readonly<TerminalState> | undefined {
    const terminal = this.byId.get(id);
    const log = this.logs.get(id);
    if (!terminal || !log) return undefined;
    const snapshot = {} as TerminalState;
    for (const key of Object.keys(terminal) as Array<keyof TerminalState>) {
      if (key !== 'output') (snapshot as unknown as Record<string, unknown>)[key] = terminal[key];
      else {
        // Copied the first time it is read; then the snapshot's own array.
        const span = log.span();
        defineLazy(snapshot, 'output', () => log.bytes(span));
      }
    }
    return snapshot;
  }

  /** @internal How the output of a terminal is stored (for tests). */
  storage(id: string): { bytes: number; segments: number; capacity: number } | undefined {
    const log = this.logs.get(id);
    return log ? { bytes: log.size, ...log.stats } : undefined;
  }

  /**
   * Apply a `terminal_update` or `terminal_output_chunk`. Returns the terminal
   * after it and, for a chunk, the bytes appended; undefined if the update was
   * not a terminal update or had no `terminalId`.
   */
  apply(update: Record<string, unknown>): { terminal: TerminalState; appended?: Uint8Array; replaced: boolean } | undefined {
    if (typeof update.terminalId !== 'string' || !update.terminalId) return undefined;
    const id = update.terminalId;
    let terminal = this.byId.get(id);
    let log = this.logs.get(id);
    if (!terminal || !log) {
      const created = new OutputLog(this.maxBytes);
      log = created;
      terminal = { id } as TerminalState;
      defineLiveOutput(terminal, created);
      this.byId.set(id, terminal);
      this.logs.set(id, log);
    }
    if (update.sessionUpdate === 'terminal_output_chunk') {
      const appended = bytes(update.data);
      log.append(appended);
      return { terminal, appended, replaced: false };
    }
    // terminal_update: an omitted field is unchanged, null clears it, a value replaces it.
    if ('command' in update) terminal.command = typeof update.command === 'string' ? update.command : undefined;
    if ('cwd' in update) terminal.cwd = typeof update.cwd === 'string' ? update.cwd : undefined;
    if ('size' in update) {
      const size = update.size;
      terminal.size = isRecord(size) && typeof size.cols === 'number' && typeof size.rows === 'number' ? { cols: size.cols, rows: size.rows } : undefined;
    }
    let replaced = false;
    if ('output' in update) {
      // A snapshot replaces everything kept so far.
      log.reset(isRecord(update.output) ? bytes(update.output.data) : new Uint8Array());
      replaced = true;
    }
    if ('exitStatus' in update) {
      const exit = update.exitStatus;
      terminal.exitStatus = isRecord(exit)
        ? {
            ...(typeof exit.exitCode === 'number' ? { exitCode: exit.exitCode } : {}),
            ...(typeof exit.signal === 'string' ? { signal: exit.signal } : {}),
          }
        : undefined;
    }
    // capabilities: null clears, an object replaces.
    if ('capabilities' in update) {
      const caps = update.capabilities;
      terminal.cancellable = isRecord(caps) && caps.cancel !== undefined && caps.cancel !== null ? true : undefined;
    }
    for (const key of ['command', 'cwd', 'size', 'exitStatus', 'cancellable'] as const) if (terminal[key] === undefined) delete terminal[key];
    return { terminal, replaced };
  }
}
