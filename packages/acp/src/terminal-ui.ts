/**
 * Terminal helpers (Node): a renderer for turns, and a permission prompt.
 *
 *   const agent = await start('claude', { ...terminal(), onPermission: firstOf(readOnly, askInTerminal()) });
 *
 * `terminal()` returns handlers: streamed text, thoughts dimmed, a line per
 * tool call with its final status, answered permission questions, plans and
 * limits. Colours only when the output is a terminal (and NO_COLOR is unset).
 */
import { createInterface } from 'node:readline';
import type { TurnHandlers } from './handlers.ts';
import type { PermissionHandler } from './permissions.ts';

interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface TerminalOptions {
  /** Where to write. Default `process.stdout`. */
  out?: Output;
  /** Colours. Default: when `out` is a terminal and NO_COLOR is not set. */
  color?: boolean;
  /** Show the agent's thoughts. Default true. */
  thoughts?: boolean;
  /** Show tool calls. Default true. */
  tools?: boolean;
  /** Show plans. Default true. */
  plans?: boolean;
}

const style = (on: boolean) => {
  const wrap = (open: string, close: string) => (text: string) => (on ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  return { dim: wrap('2', '22'), bold: wrap('1', '22'), green: wrap('32', '39'), red: wrap('31', '39'), yellow: wrap('33', '39'), cyan: wrap('36', '39') };
};

const FINAL = new Set(['completed', 'failed', 'cancelled']);

/** Handlers that render a turn to a terminal. Spread them into `start()`, `connect` or a prompt. */
export function terminal(options: TerminalOptions = {}): TurnHandlers {
  const out = options.out ?? process.stdout;
  const color = options.color ?? (!!out.isTTY && !process.env.NO_COLOR);
  const s = style(color);
  let lineStart = true;
  /** The output so far ends with a blank line. */
  let blank = false;
  let last: 'message' | 'thought' | 'line' | undefined;
  const finished = new Set<string>();
  /** Write `text`; `plain` is the same without styling, which says how the output now ends. */
  const write = (text: string, plain = text) => {
    if (!text) return;
    out.write(text);
    blank = plain.endsWith('\n\n') || (lineStart && plain === '\n');
    lineStart = plain.endsWith('\n');
  };
  /** Separate a new block from the text before it by one blank line. */
  const separate = () => write(blank ? '' : lineStart ? '\n' : '\n\n');
  /** Start a new line for a block, separated from text before it. */
  const line = (text: string) => {
    if (!lineStart) write('\n');
    if (last === 'message' || last === 'thought') write('\n');
    write(`${text}\n`);
    last = 'line';
  };
  return {
    onMessage: (delta, { separator, first }) => {
      if (first && last && last !== 'message') separate();
      else write(separator);
      write(delta);
      last = 'message';
    },
    ...(options.thoughts === false
      ? {}
      : {
          onThought: (delta: string, { first }: { first: boolean }) => {
            if (first && last && last !== 'thought') separate();
            // Without color a thought would read as the answer: label it.
            if (first && !color) write('thinking: ');
            write(s.dim(delta), delta);
            last = 'thought';
          },
        }),
    ...(options.tools === false
      ? {}
      : {
          onToolCall: (call, { created }) => {
            if (created) line(s.cyan(`• ${call.title || call.kind || 'tool'}`));
            if (FINAL.has(call.status) && !finished.has(call.id)) {
              finished.add(call.id);
              const mark = call.status === 'completed' ? s.green('✓') : s.red(call.status === 'cancelled' ? '⊘' : '✗');
              line(`  ${mark} ${s.dim(call.title || call.kind || 'tool')}`);
            }
          },
        }),
    onPermissionAnswered: (event) => {
      const allowed = event.outcome.outcome === 'selected' && event.outcome.allowed;
      line(s.yellow(`? ${event.request.title}`) + ` ${allowed ? s.green('allowed') : s.red(event.outcome.outcome === 'cancelled' ? 'cancelled' : 'refused')}`);
    },
    ...(options.plans === false
      ? {}
      : {
          onPlan: (entries) => {
            const marks: Record<string, string> = { completed: '[x]', in_progress: '[~]' };
            line(s.bold('Plan') + '\n' + entries.map((e) => `  ${marks[e.status as string] ?? '[ ]'} ${e.content}`).join('\n'));
          },
        }),
    onLimit: (event) => line(s.red(`! stopped: ${event.limit} limit (${event.max})`)),
  };
}

export interface AskOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
}

/**
 * Ask in the terminal: [y]es, [n]o, or [a]lways (for this kind of tool, for
 * this handler's lifetime). With no terminal to ask on, it rejects, and says
 * so on stderr once.
 */
export function askInTerminal(options: AskOptions = {}): PermissionHandler {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const always = new Set<string>();
  let warned = false;
  let queue: Promise<unknown> = Promise.resolve();
  return (request, signal) => {
    const kind = request.toolCall?.kind ?? 'other';
    if (always.has(kind)) return 'allow';
    if (!input.isTTY) {
      if (!warned) process.stderr.write(`Refused "${request.title}": askInTerminal() has no terminal to ask on.\n`);
      warned = true;
      return 'reject';
    }
    // One question at a time.
    const asked = queue.then(
      () =>
        new Promise<string>((resolve) => {
          const rl = createInterface({ input, output });
          const stop = () => {
            rl.close();
            resolve('cancelled');
          };
          signal.addEventListener('abort', stop, { once: true });
          rl.question(`? Allow ${request.title}? [y]es / [n]o / [a]lways for ${kind} tools: `, (answer) => {
            signal.removeEventListener('abort', stop);
            rl.close();
            const a = answer.trim().toLowerCase();
            if (a === 'a' || a === 'always') {
              always.add(kind);
              resolve('allow_always');
            } else resolve(a === 'y' || a === 'yes' ? 'allow' : 'reject');
          });
        })
    );
    queue = asked.catch(() => {});
    return asked;
  };
}
