/**
 * The contract between a journal-first agent and this kit.
 *
 * The agent (Ideal, for example) owns an append-only event log. This kit never
 * folds that log into its own state: it projects each committed event to ACP,
 * once, in order, and routes the client's moves back as calls on the session.
 */
import type { ContentBlock, StopReason } from '@deft-subspace/acp';

/** One committed journal row. `seq` grows across the whole journal, so one session's seqs can have gaps. */
export interface JournalEvent {
  seq: number;
  type: string;
  sessionId: string;
  payload?: unknown;
  ts?: string;
}

/**
 * A journaled agent session: the interface a journal-first agent implements.
 *
 * Contract:
 * - `subscribe(fromSeq)` delivers this session's events with `seq >= fromSeq`,
 *   in order, then each later append. Listeners never throw back into the append.
 * - Every event a call appends has been delivered to subscribers by the time
 *   that call's promise settles, or at the latest by the time `head()` reports it.
 * - The session decides what is legal. Refusing a move is the session's job
 *   (journal it, throw, or both); the kit keeps no second state machine.
 */
export interface JournaledSession {
  readonly sessionId: string;
  /** Seq of this session's last event, 0 if it has none. */
  head(): number | Promise<number>;
  subscribe(fromSeq: number, listener: (event: JournalEvent) => void): () => void;
  /** One turn. Resolves after the turn's events are appended. */
  prompt(input: { text: string; prompt: ContentBlock[]; signal: AbortSignal }): Promise<{ stopReason: StopReason }>;
  cancel(): unknown;
  allow(permissionId: string): Promise<unknown>;
  deny(permissionId: string): Promise<unknown>;
  /** Append a rewind to `toSeq`. Rows after it stay in the journal. */
  rewind?(toSeq: number): Promise<unknown>;
  /** True while a turn, gate or command is running. `close` cancels first when it is. */
  busy?(): boolean;
  close(): Promise<void> | void;
}

/**
 * What an event means to ACP. A vocabulary maps journal rows to these;
 * rows it does not know are not projected.
 */
export type Fact =
  | { kind: 'message'; mode: 'delta' | 'full'; channel: 'agent' | 'thought' | 'user'; messageId: string; text: string }
  | { kind: 'tool_request'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: unknown; isError: boolean }
  | { kind: 'permission_request'; id: string; toolCallId?: string; title?: string }
  | { kind: 'permission_response'; id: string; decision?: string }
  | { kind: 'turn_end'; stopReason?: string }
  /** Ends the open work of a session: pending tool calls fail, an open gate closes. */
  | { kind: 'interrupt'; reason: 'cancelled' | 'closed' | 'rewind'; toSeq?: number };

export type Vocabulary = (event: JournalEvent) => Fact | undefined;

/** An outbound notification, in the order it must be sent. */
export interface Notification {
  method: string;
  params: Record<string, unknown>;
}
