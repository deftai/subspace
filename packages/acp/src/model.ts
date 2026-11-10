/**
 * One model for ACP v1 and v2.
 *
 * Apps see messages, thoughts, tool calls, plans and permissions as the same
 * shapes whichever protocol version the agent speaks. Wire types come from the
 * official `@agentclientprotocol/sdk`; nothing here is hand-written wire schema.
 */
import type * as v1 from '@agentclientprotocol/sdk';
import type * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type { TerminalState } from './terminals.ts';

export type { v1, v2 };

export type ProtocolVersion = 1 | 2;

/** A prompt content block. Text, images, resources: the same in v1 and v2. */
export type ContentBlock = v1.ContentBlock | v2.ContentBlock;
export type ToolCallContent = v1.ToolCallContent | v2.ToolCallContent;
/** v2 adds `paused` (started, suspended until resumed) and `cancelled` (background work stopped). */
export type ToolCallStatus = 'pending' | 'in_progress' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type PermissionOption = v1.PermissionOption | v2.PermissionOption;

/** Why a turn ended. `error` is v2's, and also what a failed v1 turn becomes. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error' | (string & {});

/** A tool call as it stands now: every update merged in. */
export interface ToolCall {
  id: string;
  title: string;
  name?: string;
  kind?: string;
  status: ToolCallStatus | (string & {});
  content: ToolCallContent[];
  locations: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  /** v2: the agent lets the client cancel this tool call alone (`session.cancelToolCall()`). */
  cancellable?: boolean;
}

/**
 * v2: work running independently of the session's foreground work, as the
 * agent lists it on state updates. Kinds this client does not know are kept
 * as `other` (they still count as running). Narrow on `type`.
 */
export type BackgroundItem =
  | { type: 'terminal'; terminalId: string }
  | { type: 'tool_call'; toolCallId: string }
  | { type: 'subagent'; sessionId: string }
  | { type: 'other'; rawType: string; raw: Record<string, unknown> };

export interface PlanEntry {
  content: string;
  priority: string;
  status: string;
}

export interface PermissionRequest {
  sessionId: string;
  title: string;
  /** The tool call this is about, if any, with the request's details merged in. */
  toolCall?: ToolCall;
  /** v2: the command a `command` subject asks to run. */
  command?: { command: string; cwd: string };
  options: PermissionOption[];
  protocol: ProtocolVersion;
  /** The request exactly as the agent sent it. */
  raw: unknown;
}

/** What was answered. `selected` names the option; `allowed` says which side of the line it was. */
export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string; allowed: boolean }
  | { outcome: 'cancelled' };

/**
 * Limits on one turn. When one is reached the turn is cancelled the normal way
 * (the agent is told, open permission questions are answered `cancelled`) and
 * the result says which limit it was. Durations are milliseconds.
 */
export interface TurnLimits {
  /** Longest the whole turn may run. */
  maxDurationMs?: number;
  /** Longest the agent may go without sending anything (a stuck agent). */
  idleMs?: number;
  /** Most tool calls the turn may start. Starting one more ends it. */
  maxToolCalls?: number;
  /** Most context tokens in use, as the agent's usage updates report them (v2). */
  maxUsage?: number;
}

/** Which limit ended a turn, its setting, and the value that crossed it. */
export interface Exhaustion {
  limit: 'duration' | 'idle' | 'toolCalls' | 'usage';
  max: number;
  value: number;
}

/** Everything that can happen during a turn, in order. */
export type TurnEvent =
  /** Agent text. `delta` is what is new; `text` is the whole message so far. */
  | { type: 'message'; messageId: string; delta: string; text: string }
  | { type: 'thought'; messageId: string; delta: string; text: string }
  /** The user's own message, as the agent echoes it (v2) or replays it on load. */
  | { type: 'user_message'; messageId: string; delta: string; text: string }
  /**
   * A message of that kind stopped: something else came after it, or the turn
   * ended. `text` is its final text. ACP has no end signal, so this is
   * inferred; if an agent later continues the same message, it ends again,
   * with the longer text. `complete` is false when the turn ended early
   * (cancelled, failed, or any stop but `end_turn`) while it was open.
   */
  | { type: 'message_end'; messageId: string; text: string; complete: boolean }
  | { type: 'thought_end'; messageId: string; text: string; complete: boolean }
  | { type: 'user_message_end'; messageId: string; text: string; complete: boolean }
  /** Session title or update time changed. Also kept on `session.info`. */
  | { type: 'session_info'; title?: string; updatedAt?: string }
  /**
   * A tool call was created or changed. `toolCall` is a snapshot of its full
   * state at that moment; `turn.toolCalls` has the latest, which can already
   * include later updates (or a permission request's fields) when you look.
   */
  | { type: 'tool_call'; toolCall: Readonly<ToolCall>; created: boolean }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'permission'; request: PermissionRequest; outcome: PermissionOutcome }
  | { type: 'usage'; used: number; size: number; cost?: unknown }
  /**
   * v2: a terminal the agent runs changed. `terminal` is a snapshot;
   * `appended` holds a chunk's new bytes; `replaced` means the output was
   * replaced by a snapshot (redraw from `terminal.output`).
   */
  | { type: 'terminal'; terminal: Readonly<TerminalState>; appended?: Uint8Array; replaced: boolean }
  /**
   * v2 only: the agent's run state. `background` is the work running in the
   * background at that moment (a snapshot); absent when the agent does not report it.
   */
  | { type: 'state'; state: string; background?: BackgroundItem[] }
  /** A turn limit was reached; the turn is being cancelled. */
  | ({ type: 'exhausted' } & Exhaustion)
  /** Anything else, unchanged (available commands, config options, notices, ...). */
  | { type: 'update'; sessionUpdate: string; update: unknown };

export interface TurnResult {
  stopReason: StopReason;
  /** All agent message text of the turn, messages separated by a blank line. */
  text: string;
  toolCalls: ToolCall[];
  /** True when the turn was cancelled from this side. */
  cancelled: boolean;
  /** True when the agent did not confirm a cancel in time and the turn was ended here. */
  forced?: boolean;
  /** v2: the error an `error` stop carried. */
  error?: unknown;
  /** Set when a turn limit ended the turn. */
  exhausted?: Exhaustion;
  /**
   * How many of the agent's permission requests this side refused (rejected,
   * or answered cancelled while the turn was not being cancelled). Absent when
   * none were. Some agents (Grok, Codex) end a turn whose request was refused
   * with stopReason "cancelled" though nobody cancelled: `cancelled` false and
   * `refused` set tells that apart from a real cancel (see `turnEnd`).
   */
  refused?: number;
}

/**
 * Why a turn ended, in one word, with the agent quirks taken out:
 * `limit` (a turn limit), `cancelled` (cancelled from this side, or by the
 * agent unprompted), `refused` (the agent stopped after a permission request
 * was refused), `error` (a v2 error stop), or `completed` (any other stop:
 * end_turn, max_tokens, refusal, ...).
 */
export type TurnEnd = 'completed' | 'cancelled' | 'refused' | 'limit' | 'error';

export function turnEnd(result: TurnResult): TurnEnd {
  if (result.exhausted) return 'limit';
  if (result.cancelled) return 'cancelled';
  if (result.stopReason === 'error') return 'error';
  if (result.stopReason === 'cancelled') return result.refused ? 'refused' : 'cancelled';
  return 'completed';
}
