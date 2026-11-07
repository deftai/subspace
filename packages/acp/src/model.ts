/**
 * One model for ACP v1 and v2.
 *
 * Apps see messages, thoughts, tool calls, plans and permissions as the same
 * shapes whichever protocol version the agent speaks. Wire types come from the
 * official `@agentclientprotocol/sdk`; nothing here is hand-written wire schema.
 */
import type * as v1 from '@agentclientprotocol/sdk';
import type * as v2 from '@agentclientprotocol/sdk/experimental/v2';

export type { v1, v2 };

export type ProtocolVersion = 1 | 2;

/** A prompt content block. Text, images, resources: the same in v1 and v2. */
export type ContentBlock = v1.ContentBlock | v2.ContentBlock;
export type ToolCallContent = v1.ToolCallContent | v2.ToolCallContent;
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
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
}

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
  /** v2 only: the agent's run state. */
  | { type: 'state'; state: string }
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
}
