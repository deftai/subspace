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
  /** Every byte the agent wants shown, so far. */
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The output as text, for a transcript (invalid UTF-8 becomes U+FFFD; escape sequences are kept). */
export function terminalText(terminal: Pick<TerminalState, 'output'>): string {
  return new TextDecoder().decode(terminal.output);
}

export class Terminals {
  private readonly byId = new Map<string, TerminalState>();
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
   * Apply a `terminal_update` or `terminal_output_chunk`. Returns the terminal
   * after it and, for a chunk, the bytes appended; undefined if the update was
   * not a terminal update or had no `terminalId`.
   */
  apply(update: Record<string, unknown>): { terminal: TerminalState; appended?: Uint8Array; replaced: boolean } | undefined {
    if (typeof update.terminalId !== 'string' || !update.terminalId) return undefined;
    const id = update.terminalId;
    let terminal = this.byId.get(id);
    if (!terminal) {
      terminal = { id, output: new Uint8Array() };
      this.byId.set(id, terminal);
    }
    if (update.sessionUpdate === 'terminal_output_chunk') {
      const appended = bytes(update.data);
      terminal.output = this.cap(concat(terminal.output, appended));
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
      terminal.output = this.cap(isRecord(update.output) ? bytes(update.output.data) : new Uint8Array());
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

  private cap(output: Uint8Array): Uint8Array {
    return output.length > this.maxBytes ? output.slice(output.length - this.maxBytes) : output;
  }
}
