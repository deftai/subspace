/**
 * Turn `session/update` notifications, v1 or v2, into TurnEvents.
 *
 * v1 sends a tool call once (`tool_call`) and then partial updates; v2 sends
 * every change as an upsert (`tool_call_update`) plus appended content chunks.
 * v1 message ids are optional; when missing, text between two pieces of
 * content (a tool call, a plan, a terminal) is one message. Notices, usage,
 * state and title updates do not split it. Either way the app gets the same events.
 */
import type { BackgroundItem, PlanEntry, StopReason, ToolCall, TurnEvent } from './model.ts';
import { Terminals } from './terminals.ts';

type Update = Record<string, unknown> & { sessionUpdate?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TERMINAL_KEYS = ['terminal_info', 'terminal_output', 'terminal_output_delta', 'terminal_exit'];

/**
 * Whether a v1 `tool_call_update` carries only terminal extension keys (and
 * the stamps an agent repeats in `_meta`): no field of the tool call itself.
 */
function terminalOnly(update: Update): boolean {
  if (update.sessionUpdate !== 'tool_call_update' || !isRecord(update._meta)) return false;
  if (!TERMINAL_KEYS.some((key) => key in (update._meta as Record<string, unknown>))) return false;
  return Object.keys(update).every((key) => key === 'sessionUpdate' || key === 'toolCallId' || key === '_meta');
}

/** Text as the base64 of its UTF-8 bytes, as a v2 terminal carries output (any runtime). */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

/** A state update's `background`: a list of items with a string type, else not reported (undefined). */
export function backgroundOf(update: Record<string, unknown>): BackgroundItem[] | undefined {
  const list = update.background;
  if (!Array.isArray(list)) return undefined;
  if (!list.every((item) => isRecord(item) && typeof item.type === 'string')) return undefined;
  return (list as Array<Record<string, unknown>>).map((item): BackgroundItem => {
    if (item.type === 'terminal' && typeof item.terminalId === 'string') return { type: 'terminal', terminalId: item.terminalId };
    if (item.type === 'tool_call' && typeof item.toolCallId === 'string') return { type: 'tool_call', toolCallId: item.toolCallId };
    if (item.type === 'subagent' && typeof item.sessionId === 'string') return { type: 'subagent', sessionId: item.sessionId };
    return { type: 'other', rawType: String(item.type), raw: item };
  });
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
  /** The terminal of each v1 tool call that named one (`_meta.terminal_info`), by tool call id. */
  private readonly v1Terminals = new Map<string, string>();

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
        this.lastKind = 'other';
        return { events: [{ type: 'plan', entries: (update.entries as PlanEntry[]) ?? [] }] };
      case 'plan_update': {
        this.lastKind = 'other';
        const plan = update.plan;
        const entries = isRecord(plan) && Array.isArray(plan.entries) ? (plan.entries as PlanEntry[]) : [];
        return { events: [{ type: 'plan', entries }] };
      }
      case 'terminal_update':
      case 'terminal_output_chunk': {
        this.lastKind = 'other';
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
        // A notice (available commands, mode, config, vendor updates) is not content: it does not split a message.
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
    // The terminal before the tool call that shows it, as on v2.
    const terminal = this.v1Terminal(update, toolCall);
    // A v1 report that only carries terminal output changes nothing about the
    // tool call (v2 sends such output as terminal updates alone).
    if (!create && !created && terminalOnly(update)) return terminal;
    return [...terminal, { type: 'tool_call', toolCall: { ...toolCall }, created }];
  }

  /**
   * The terminal events of a v1 tool call report that carries the terminal
   * extension in `_meta` (codex-acp, claude-agent-acp): `terminal_info` names
   * the terminal, `terminal_output` is a snapshot, `terminal_output_delta` a
   * chunk, and `terminal_exit` the exit. They become the v2 updates they stand
   * for, so a v1 agent's terminal is the same `terminal` event and
   * `session.terminals` entry as a v2 one. The extension names no command:
   * it is the tool call's `rawInput.command`.
   */
  private v1Terminal(update: Update, call: ToolCall): TurnEvent[] {
    // A report without `_meta` can still give a known terminal its command:
    // the first report of a streamed tool use has no input yet.
    const meta = isRecord(update._meta) ? update._meta : {};
    const info = isRecord(meta.terminal_info) ? meta.terminal_info : undefined;
    const output = isRecord(meta.terminal_output) ? meta.terminal_output : undefined;
    const delta = isRecord(meta.terminal_output_delta) ? meta.terminal_output_delta : undefined;
    const exit = isRecord(meta.terminal_exit) ? meta.terminal_exit : undefined;
    const idOf = (part: Record<string, unknown> | undefined) => (typeof part?.terminal_id === 'string' && part.terminal_id ? part.terminal_id : undefined);
    const terminalId = idOf(info) ?? idOf(output) ?? idOf(delta) ?? idOf(exit) ?? this.v1Terminals.get(call.id);
    if (!terminalId) return [];
    this.v1Terminals.set(call.id, terminalId);
    const updates: Record<string, unknown>[] = [];
    const command = isRecord(call.rawInput) && typeof call.rawInput.command === 'string' && call.rawInput.command ? call.rawInput.command : undefined;
    const known = this.terminals.get(terminalId);
    const head: Record<string, unknown> = { sessionUpdate: 'terminal_update', terminalId };
    if (command !== undefined && command !== known?.command) head.command = command;
    if (output) head.output = { data: base64(typeof output.data === 'string' ? output.data : '') };
    if (!known || Object.keys(head).length > 2) updates.push(head);
    if (delta && typeof delta.data === 'string' && delta.data) {
      updates.push({ sessionUpdate: 'terminal_output_chunk', terminalId, data: base64(delta.data) });
    }
    // Output first, then the exit, when one report carries both.
    if (exit) {
      updates.push({
        sessionUpdate: 'terminal_update',
        terminalId,
        exitStatus: {
          ...(typeof exit.exit_code === 'number' ? { exitCode: exit.exit_code } : {}),
          ...(typeof exit.signal === 'string' ? { signal: exit.signal } : {}),
        },
      });
    }
    const events: TurnEvent[] = [];
    for (const next of updates) {
      const applied = this.terminals.apply(next);
      if (!applied) continue;
      const { terminal, appended, replaced } = applied;
      events.push({ type: 'terminal', terminal: { ...terminal }, ...(appended ? { appended } : {}), replaced });
    }
    return events;
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
