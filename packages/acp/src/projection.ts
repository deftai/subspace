/**
 * Turn `session/update` notifications, v1 or v2, into TurnEvents.
 *
 * v1 sends a tool call once (`tool_call`) and then partial updates; v2 sends
 * every change as an upsert (`tool_call_update`) plus appended content chunks.
 * v1 message ids are optional; when missing, text between two tool calls is
 * one message. Either way the app gets the same events.
 */
import type { BackgroundItem, PlanEntry, StopReason, ToolCall, TurnEvent } from './model.ts';
import { Terminals } from './terminals.ts';

type Update = Record<string, unknown> & { sessionUpdate?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (block: unknown): string =>
  isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '';

type TextKind = 'message' | 'thought' | 'user_message';

export interface StateChange {
  state: string;
  stopReason?: StopReason;
  error?: unknown;
  /** The background list on this snapshot; undefined when not reported (or malformed). */
  background?: BackgroundItem[];
}

/** A state update's `background`: a list of items with a string type, else not reported. */
export function backgroundOf(update: Record<string, unknown>): BackgroundItem[] | undefined {
  const list = update.background;
  if (!Array.isArray(list)) return undefined;
  if (!list.every((item) => isRecord(item) && typeof item.type === 'string')) return undefined;
  return list as BackgroundItem[];
}

export class TurnProjection {
  readonly toolCalls: Map<string, ToolCall>;
  private readonly messages = new Map<string, { kind: TextKind; text: string }>();
  private readonly messageOrder: string[] = [];
  private segment = 0;
  private lastKind: 'text' | 'other' = 'other';
  private readonly prefix: string;
  /** Agent terminals (v2), shared with the session so they outlive the turn. */
  readonly terminals: Terminals;

  constructor(prefix: string, terminals: Terminals = new Terminals(), toolCalls: Map<string, ToolCall> = new Map()) {
    this.prefix = prefix;
    this.terminals = terminals;
    this.toolCalls = toolCalls;
  }

  /** Apply one update. Returns the events it produced, and a state change if it was one. */
  apply(raw: unknown): { events: TurnEvent[]; state?: StateChange } {
    if (!isRecord(raw) || typeof raw.sessionUpdate !== 'string') return { events: [] };
    const update = raw as Update;
    const kind = update.sessionUpdate as string;
    switch (kind) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        return { events: this.chunk(kind === 'agent_message_chunk' ? 'message' : 'thought', update) };
      case 'agent_message':
      case 'agent_thought':
        return { events: this.whole(kind === 'agent_message' ? 'message' : 'thought', update) };
      case 'user_message_chunk':
        return { events: this.chunk('user_message', update) };
      case 'user_message':
        return { events: this.whole('user_message', update) };
      case 'session_info_update': {
        const event: TurnEvent = { type: 'session_info' };
        if (typeof update.title === 'string') event.title = update.title;
        if (typeof update.updatedAt === 'string') event.updatedAt = update.updatedAt;
        return { events: [event] };
      }
      case 'tool_call':
      case 'tool_call_update':
        return { events: this.tool(update, kind === 'tool_call') };
      case 'tool_call_content_chunk':
        return { events: this.toolChunk(update) };
      case 'plan':
        return { events: [{ type: 'plan', entries: (update.entries as PlanEntry[]) ?? [] }] };
      case 'plan_update': {
        const plan = update.plan;
        const entries = isRecord(plan) && Array.isArray(plan.entries) ? (plan.entries as PlanEntry[]) : [];
        return { events: [{ type: 'plan', entries }] };
      }
      case 'terminal_update':
      case 'terminal_output_chunk': {
        const applied = this.terminals.apply(update);
        if (!applied) return { events: [] };
        const { terminal, appended, replaced } = applied;
        return { events: [{ type: 'terminal', terminal: { ...terminal }, ...(appended ? { appended } : {}), replaced }] };
      }
      case 'usage_update':
        return { events: [{ type: 'usage', used: Number(update.used), size: Number(update.size), cost: update.cost }] };
      case 'state_update': {
        const state = String(update.state);
        const background = backgroundOf(update);
        const change: StateChange = { state, ...(background ? { background } : {}) };
        if (state === 'idle') {
          change.stopReason = (update.stopReason as StopReason | null | undefined) ?? 'end_turn';
          if (update.error !== undefined) change.error = update.error;
        }
        return { events: [{ type: 'state', state, ...(background ? { background } : {}) }], state: change };
      }
      default:
        this.lastKind = 'other';
        return { events: [{ type: 'update', sessionUpdate: kind, update }] };
    }
  }

  /** Merge a permission request's tool call into the known state (v1 sends an update with it). */
  mergeToolCall(update: Record<string, unknown>): ToolCall | undefined {
    if (typeof update.toolCallId !== 'string') return undefined;
    // A tool call first seen here still separates the text before and after it.
    this.lastKind = 'other';
    return this.upsert(update, false).toolCall;
  }

  /** Mark tool calls that never finished as failed, e.g. after a cancel. `keep` spares background work. */
  failOpenToolCalls(keep: (call: ToolCall) => boolean = () => false): TurnEvent[] {
    const events: TurnEvent[] = [];
    for (const call of this.toolCalls.values()) {
      if ((call.status === 'pending' || call.status === 'in_progress' || call.status === 'paused') && !keep(call)) {
        call.status = 'failed';
        events.push({ type: 'tool_call', toolCall: { ...call }, created: false });
      }
    }
    return events;
  }

  /**
   * All agent message text, in order. Messages are separated by a blank line,
   * except where the earlier one already ends a line.
   */
  get text(): string {
    let out = '';
    for (const id of this.messageOrder) {
      const message = this.messages.get(id)!;
      if (message.kind !== 'message' || !message.text) continue;
      if (out && !out.endsWith('\n')) out += '\n\n';
      out += message.text;
    }
    return out;
  }

  private messageId(update: Update, kind: TextKind): string {
    if (typeof update.messageId === 'string' && update.messageId) return update.messageId;
    if (this.lastKind !== 'text') this.segment++;
    return `${this.prefix}:${kind}:${this.segment}`;
  }

  private chunk(kind: TextKind, update: Update): TurnEvent[] {
    const delta = textOf(update.content);
    const messageId = this.messageId(update, kind);
    this.lastKind = 'text';
    const message = this.message(messageId, kind);
    message.text += delta;
    return delta ? [{ type: kind, messageId, delta, text: message.text }] : [];
  }

  /** v2 whole-message upsert: report only what is new, so streamed text is never shown twice. */
  private whole(kind: TextKind, update: Update): TurnEvent[] {
    const messageId = this.messageId(update, kind);
    this.lastKind = 'text';
    const text = Array.isArray(update.content) ? update.content.map(textOf).join('') : '';
    const message = this.message(messageId, kind);
    const delta = text.startsWith(message.text) ? text.slice(message.text.length) : text;
    message.text = text;
    return delta ? [{ type: kind, messageId, delta, text }] : [];
  }

  private message(id: string, kind: TextKind) {
    let message = this.messages.get(id);
    if (!message) {
      message = { kind, text: '' };
      this.messages.set(id, message);
      this.messageOrder.push(id);
    }
    return message;
  }

  private tool(update: Update, create: boolean): TurnEvent[] {
    this.lastKind = 'other';
    if (typeof update.toolCallId !== 'string') return [];
    const { toolCall, created } = this.upsert(update, create);
    return [{ type: 'tool_call', toolCall: { ...toolCall }, created }];
  }

  private toolChunk(update: Update): TurnEvent[] {
    this.lastKind = 'other';
    if (typeof update.toolCallId !== 'string') return [];
    const { toolCall, created } = this.upsert({ toolCallId: update.toolCallId }, false);
    if (update.content !== undefined) toolCall.content.push(update.content as ToolCall['content'][number]);
    return [{ type: 'tool_call', toolCall: { ...toolCall, content: [...toolCall.content] }, created }];
  }

  private upsert(update: Record<string, unknown>, create: boolean): { toolCall: ToolCall; created: boolean } {
    const id = update.toolCallId as string;
    let call = this.toolCalls.get(id);
    const created = !call;
    if (!call || create) {
      call = { id, title: '', status: 'pending', content: [], locations: [], ...(call ?? {}) };
      this.toolCalls.set(id, call);
    }
    if (typeof update.title === 'string') call.title = update.title;
    if (typeof update.name === 'string') call.name = update.name;
    if (typeof update.kind === 'string') call.kind = update.kind;
    if (typeof update.status === 'string') call.status = update.status;
    // Content and locations replace, as the spec says; chunks append (above).
    if (Array.isArray(update.content)) call.content = [...update.content] as ToolCall['content'];
    if (Array.isArray(update.locations)) call.locations = [...update.locations];
    if ('rawInput' in update && update.rawInput !== undefined) call.rawInput = update.rawInput;
    if ('rawOutput' in update && update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
    // v2 capabilities: null clears, an object replaces; `cancel` makes it cancellable.
    if ('capabilities' in update) {
      const caps = update.capabilities;
      if (isRecord(caps) && caps.cancel !== undefined && caps.cancel !== null) call.cancellable = true;
      else delete call.cancellable;
    }
    return { toolCall: call, created };
  }
}
