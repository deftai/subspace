/**
 * Handler options for a turn: callbacks instead of (or as well as) iterating.
 *
 *   const result = await session.prompt('Fix the failing test', {
 *     onMessage: (delta) => process.stdout.write(delta),
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
import type { PermissionHandler } from './permissions.ts';
import type { BackgroundItem, PlanEntry, ToolCall, TurnEvent } from './model.ts';

/** Any return value is fine (`process.stdout.write` returns a boolean); a promise is awaited. */
type Maybe = unknown;
type Of<T extends TurnEvent['type']> = Extract<TurnEvent, { type: T }>;

export interface TurnHandlers {
  /** Agent text: what is new, and the whole message so far. */
  onMessage?(delta: string, text: string, event: Of<'message'>): Maybe;
  onThought?(delta: string, text: string, event: Of<'thought'>): Maybe;
  /** The user's message as the agent echoes or replays it. */
  onUserMessage?(delta: string, text: string, event: Of<'user_message'>): Maybe;
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
  /** Answer this turn's permission questions (replaces the client's `permissions`). */
  onPermission?: PermissionHandler;
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

/** Call the handler for one event, then `onEvent`. */
export async function dispatch(event: TurnEvent, h: TurnHandlers): Promise<void> {
  switch (event.type) {
    case 'message':
      await h.onMessage?.(event.delta, event.text, event);
      break;
    case 'thought':
      await h.onThought?.(event.delta, event.text, event);
      break;
    case 'user_message':
      await h.onUserMessage?.(event.delta, event.text, event);
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
