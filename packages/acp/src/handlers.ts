/**
 * Handler options for a turn: callbacks instead of (or as well as) iterating.
 *
 *   const result = await session.prompt('Fix the failing test', {
 *     onMessage: (delta, { separator }) => process.stdout.write(separator + delta),
 *     onToolCall: (call) => render(call),
 *     onPermission: (request) => (request.toolCall?.kind === 'read' ? 'allow' : 'reject'),
 *   }).done;
 *
 * - Handlers run in event order, one at a time; an async handler is awaited
 *   before the next event.
 * - `turn.done` settles after every handler has run. If a handler throws, the
 *   turn is cancelled and `done` rejects with that error.
 * - `onPermission` and `onQuestion` answer this turn's questions, in place of
 *   the client's `permissions` and `elicitation` options. The others observe.
 * - Set defaults for every turn with the client option `handlers`; a prompt's
 *   own handlers replace them one by one.
 */
import type { ElicitationHandler } from './client.ts';
import type { PermissionPolicy } from './permissions.ts';
import type { BackgroundItem, PlanEntry, ToolCall, TurnEvent } from './model.ts';

/** Any return value is fine (`process.stdout.write` returns a boolean); a promise is awaited. */
type Maybe = unknown;
type Of<T extends TurnEvent['type']> = Extract<TurnEvent, { type: T }>;

/** About one chunk of text, for `onMessage`, `onThought` and `onUserMessage`. */
export interface TextInfo {
  /** The whole message so far. */
  text: string;
  messageId: string;
  /** This is the message's first chunk. */
  first: boolean;
  /** Which message of its kind in the turn this is, from 0. */
  index: number;
  /**
   * What to write before this chunk so the stream reads like `result.text`:
   * a blank line before a later message (unless the last one ended a line), else ''.
   * `process.stdout.write(separator + delta)` streams exactly `result.text`.
   */
  separator: string;
}

/** About a message that ended, for `onMessageEnd`, `onThoughtEnd` and `onUserMessageEnd`. */
export interface TextEndInfo {
  messageId: string;
  /** Which message of its kind in the turn this is, from 0. */
  index: number;
  /** False when the turn ended early (cancelled, failed, not `end_turn`) while it was open. */
  complete: boolean;
}

export interface TurnHandlers {
  /** Agent text: what is new, and about its message (`first`, `separator`, the whole `text`). */
  onMessage?(delta: string, info: TextInfo, event: Of<'message'>): Maybe;
  onThought?(delta: string, info: TextInfo, event: Of<'thought'>): Maybe;
  /** The user's message as the agent echoes or replays it. */
  onUserMessage?(delta: string, info: TextInfo, event: Of<'user_message'>): Maybe;
  /**
   * A message stopped: something else came after it, or the turn ended.
   * `text` is its final text (always right, even when a v2 agent rewrote it).
   * ACP has no end signal, so this is inferred: if the agent continues the
   * same message later, it ends again with the longer text.
   */
  onMessageEnd?(text: string, info: TextEndInfo, event: Of<'message_end'>): Maybe;
  onThoughtEnd?(text: string, info: TextEndInfo, event: Of<'thought_end'>): Maybe;
  onUserMessageEnd?(text: string, info: TextEndInfo, event: Of<'user_message_end'>): Maybe;
  /** A tool call was created (`created`) or changed; `toolCall` is a snapshot. */
  onToolCall?(toolCall: Readonly<ToolCall>, info: { created: boolean }, event: Of<'tool_call'>): Maybe;
  onPlan?(entries: PlanEntry[], event: Of<'plan'>): Maybe;
  onUsage?(usage: { used: number; size: number; cost?: unknown }, event: Of<'usage'>): Maybe;
  /** A terminal the agent runs changed (v2). */
  onTerminal?(event: Of<'terminal'>): Maybe;
  /** v2 run state, and the background list when reported. */
  onState?(state: string, background: BackgroundItem[] | undefined, event: Of<'state'>): Maybe;
  /** A permission question was answered (by `onPermission`, the client policy, or a cancel). */
  onPermissionAnswered?(event: Of<'permission'>): Maybe;
  /** A turn limit fired; the turn is being cancelled. */
  onLimit?(event: Of<'exhausted'>): Maybe;
  /** Every event, after its own handler. */
  onEvent?(event: TurnEvent): Maybe;
  /**
   * Answer this turn's permission questions (replaces the client's
   * `permissions`): a function, or a fixed 'allow' / 'reject'.
   */
  onPermission?: PermissionPolicy;
  /**
   * Answer this turn's questions to the user (replaces the client's
   * `elicitation`). The client must advertise elicitation: pass an
   * `elicitation` option when connecting (`start()` does).
   */
  onQuestion?: ElicitationHandler;
}

export const HANDLER_KEYS = [
  'onMessage',
  'onThought',
  'onUserMessage',
  'onMessageEnd',
  'onThoughtEnd',
  'onUserMessageEnd',
  'onToolCall',
  'onPlan',
  'onUsage',
  'onTerminal',
  'onState',
  'onPermissionAnswered',
  'onLimit',
  'onEvent',
  'onPermission',
  'onQuestion',
] as const satisfies ReadonlyArray<keyof TurnHandlers>;

/** The handlers in `options`, over `defaults`; undefined when there are none. */
export function mergeHandlers(defaults: TurnHandlers | undefined, options: object): TurnHandlers | undefined {
  const merged: TurnHandlers = { ...(defaults ?? {}) };
  for (const key of HANDLER_KEYS) {
    const value = (options as Record<string, unknown>)[key];
    if (typeof value === 'function') (merged as Record<string, unknown>)[key] = value;
  }
  return Object.keys(merged).length ? merged : undefined;
}

/** Whether any handler observes events (onPermission and onQuestion answer, they do not observe). */
export function observes(handlers: TurnHandlers | undefined): boolean {
  return !!handlers && HANDLER_KEYS.some((key) => key !== 'onPermission' && key !== 'onQuestion' && handlers[key] !== undefined);
}

/** Per turn: which messages of each kind were seen, and how the last one ended. */
export class TextTracker {
  private readonly kinds = new Map<string, { ids: Map<string, number>; lastEnd: string }>();

  info(kind: 'message' | 'thought' | 'user_message', event: { messageId: string; delta: string; text: string }): TextInfo {
    let seen = this.kinds.get(kind);
    if (!seen) this.kinds.set(kind, (seen = { ids: new Map(), lastEnd: '' }));
    let index = seen.ids.get(event.messageId);
    const first = index === undefined;
    if (index === undefined) seen.ids.set(event.messageId, (index = seen.ids.size));
    // Same rule as result.text: messages are joined by a blank line unless the earlier ends a line.
    const separator = first && index > 0 && seen.lastEnd !== '\n' ? '\n\n' : '';
    if (event.text) seen.lastEnd = event.text.slice(-1);
    return { text: event.text, messageId: event.messageId, first, index, separator };
  }

  end(kind: 'message' | 'thought' | 'user_message', event: { messageId: string; complete: boolean }): TextEndInfo {
    const index = this.kinds.get(kind)?.ids.get(event.messageId) ?? 0;
    return { messageId: event.messageId, index, complete: event.complete };
  }
}

/** Call the handler for one event, then `onEvent`. */
export async function dispatch(event: TurnEvent, h: TurnHandlers, text: TextTracker = new TextTracker()): Promise<void> {
  switch (event.type) {
    case 'message': {
      // Always tracked, so the end handlers know each message's index.
      const info = text.info('message', event);
      await h.onMessage?.(event.delta, info, event);
      break;
    }
    case 'thought': {
      // Always tracked, so the end handlers know each message's index.
      const info = text.info('thought', event);
      await h.onThought?.(event.delta, info, event);
      break;
    }
    case 'user_message': {
      // Always tracked, so the end handlers know each message's index.
      const info = text.info('user_message', event);
      await h.onUserMessage?.(event.delta, info, event);
      break;
    }
    case 'message_end':
      await h.onMessageEnd?.(event.text, text.end('message', event), event);
      break;
    case 'thought_end':
      await h.onThoughtEnd?.(event.text, text.end('thought', event), event);
      break;
    case 'user_message_end':
      await h.onUserMessageEnd?.(event.text, text.end('user_message', event), event);
      break;
    case 'tool_call':
      await h.onToolCall?.(event.toolCall, { created: event.created }, event);
      break;
    case 'plan':
      await h.onPlan?.(event.entries, event);
      break;
    case 'usage':
      await h.onUsage?.({ used: event.used, size: event.size, ...(event.cost !== undefined ? { cost: event.cost } : {}) }, event);
      break;
    case 'terminal':
      await h.onTerminal?.(event);
      break;
    case 'state':
      await h.onState?.(event.state, event.background, event);
      break;
    case 'permission':
      await h.onPermissionAnswered?.(event);
      break;
    case 'exhausted':
      await h.onLimit?.(event);
      break;
  }
  await h.onEvent?.(event);
}
