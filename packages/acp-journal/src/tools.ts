/**
 * Tool requests and results from the journal, as ACP tool calls. Display only:
 * nothing here runs a tool or answers a permission.
 *
 * - ACP `content` replaces rather than appends, so a result re-sends the
 *   input's content (code, a command) ahead of the output.
 * - A request seen twice is shown once.
 * - Calls still open when the session is cancelled, closed or rewound end `failed`.
 */
import type { Fact } from './types.ts';

type Update = Record<string, unknown>;
type Content = Array<Record<string, unknown>>;

export interface ToolDescription {
  title: string;
  kind: string;
  locations?: Array<{ path: string; line?: number }>;
  /** Shown with the call, and again with its result. */
  content?: Content;
}

export type ToolDescriber = (name: string, input: unknown) => ToolDescription;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const field = (input: unknown, keys: string[]): string => {
  if (typeof input === 'string') return input.trim();
  if (!isRecord(input)) return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (Array.isArray(input.argv) && input.argv.every((a) => typeof a === 'string')) return input.argv.join(' ');
  return '';
};

/** Display text is cut at this many characters; the full value stays in rawInput/rawOutput. */
export const DISPLAY_LIMIT = 16_000;

export function textContent(text: string): Content {
  const shown = text.length > DISPLAY_LIMIT ? `${text.slice(0, DISPLAY_LIMIT)}\n[truncated; the full value is in the journal]` : text;
  return [{ type: 'content', content: { type: 'text', text: shown } }];
}

/** A fenced block, with a fence longer than any backtick run inside. */
export function codeContent(code: string, language = ''): Content {
  let fence = '```';
  for (const match of code.matchAll(/`+/g)) if (match[0].length >= fence.length) fence = '`'.repeat(match[0].length + 1);
  return textContent(`${fence}${language}\n${code}\n${fence}`);
}

/** Read, edit and search show a path or query; exec and bash show the command; `code` input is shown as code. */
export const describeTool: ToolDescriber = (name, input) => {
  const kind =
    name === 'read' || name === 'edit' || name === 'search'
      ? name
      : name === 'exec' || name === 'bash' || name === 'executeCode'
        ? 'execute'
        : 'other';
  const intent =
    kind === 'execute'
      ? field(input, ['command', 'cmd', 'label', 'description'])
      : kind === 'search'
        ? field(input, ['query', 'pattern'])
        : field(input, ['path', 'file', 'label', 'description', 'command', 'query', 'url']);
  const rawPath = isRecord(input) ? (input.path ?? input.file) : undefined;
  const path = kind !== 'execute' && kind !== 'search' && typeof rawPath === 'string' ? rawPath.trim() : '';
  const code = isRecord(input) && typeof input.code === 'string' && input.code ? input.code : undefined;
  return {
    title: intent ? `${name} ${intent.length > 160 ? `${intent.slice(0, 160)}…` : intent}` : name,
    kind,
    ...(path ? { locations: [{ path }] } : {}),
    ...(code ? { content: codeContent(code, 'typescript') } : {}),
  };
};

export class ToolProjector {
  private readonly pending = new Map<string, Content>();
  private readonly seen = new Set<string>();
  private readonly describe: ToolDescriber;

  constructor(describe: ToolDescriber = describeTool) {
    this.describe = describe;
  }

  get open(): string[] {
    return [...this.pending.keys()];
  }

  request(fact: Extract<Fact, { kind: 'tool_request' }>): Update[] {
    if (this.seen.has(fact.id)) return [];
    this.seen.add(fact.id);
    const d = this.describe(fact.name, fact.input);
    this.pending.set(fact.id, d.content ?? []);
    return [
      {
        sessionUpdate: 'tool_call',
        toolCallId: fact.id,
        title: d.title,
        kind: d.kind,
        status: 'pending',
        rawInput: fact.input ?? null,
        content: d.content ?? [],
        ...(d.locations ? { locations: d.locations } : {}),
      },
    ];
  }

  result(fact: Extract<Fact, { kind: 'tool_result' }>): Update[] {
    const input = this.pending.get(fact.id) ?? [];
    this.pending.delete(fact.id);
    this.seen.add(fact.id);
    const output = typeof fact.output === 'string' ? fact.output : JSON.stringify(fact.output ?? null, null, 2);
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: fact.id,
        status: fact.isError ? 'failed' : 'completed',
        rawOutput: fact.output ?? null,
        content: [...input, ...textContent(output)],
      },
    ];
  }

  interrupt(reason: string): Update[] {
    const updates = [...this.pending].map(([toolCallId, input]) => ({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [...input, ...textContent(`Interrupted by ${reason}`)],
    }));
    this.pending.clear();
    return updates;
  }
}
