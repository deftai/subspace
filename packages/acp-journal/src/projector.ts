/**
 * Journal events in, ACP notifications out. Pure: no I/O, no clock.
 *
 * - Each event is projected once: an event at or below the high-water seq is
 *   dropped, so two observers of the same row (or a re-delivered row) render once.
 * - Every `session/update` carries `_meta[ns] = { seq, headSeq }`: the event's
 *   seq, and the session head after that event (the same number for a live event).
 * - Live and replay produce the same updates, except that replay also shows the
 *   user's own messages (a live client already has them) and ends with a cursor.
 */
import { MessageCoalescer, type CoalesceDiagnostic } from './coalesce.ts';
import { ToolProjector, type ToolDescriber } from './tools.ts';
import type { Fact, JournalEvent, Notification, Vocabulary } from './types.ts';
import { idealVocabulary } from './vocabulary.ts';

export interface ProjectorOptions {
  sessionId: string;
  /** `_meta` key and extension-method prefix (`_<ns>/rewind`). Default `journal`. */
  namespace?: string;
  vocabulary?: Vocabulary;
  describeTool?: ToolDescriber;
  /** Also send every event, unchanged, as `_<ns>/event`. For clients that read the log itself. */
  rawEvents?: boolean;
  onDiagnostic?: (diagnostic: CoalesceDiagnostic & { seq: number }) => void;
}

export interface Projected {
  fact?: Fact;
  notifications: Notification[];
}

export class JournalProjector {
  readonly sessionId: string;
  readonly namespace: string;
  /** Highest seq projected so far. */
  head = 0;
  /** The target of the last rewind, if any. */
  rewindToSeq?: number;

  private readonly vocabulary: Vocabulary;
  private readonly messages = new MessageCoalescer();
  private readonly tools: ToolProjector;
  private readonly options: ProjectorOptions;

  constructor(options: ProjectorOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.namespace = options.namespace ?? 'journal';
    this.vocabulary = options.vocabulary ?? idealVocabulary;
    this.tools = new ToolProjector(options.describeTool);
  }

  /** Tool calls requested and not yet finished. */
  get openToolCalls(): string[] {
    return this.tools.open;
  }

  project(event: JournalEvent, mode: { replay: boolean }): Projected {
    if (event.sessionId !== this.sessionId || !Number.isSafeInteger(event.seq) || event.seq <= this.head) {
      return { notifications: [] };
    }
    this.head = event.seq;
    const fact = this.vocabulary(event);
    const updates: Record<string, unknown>[] = [];
    const signals: Notification[] = [];
    switch (fact?.kind) {
      case 'message': {
        if (fact.channel === 'user' && !mode.replay) break;
        const shown = this.messages.apply(fact, (d) => this.options.onDiagnostic?.({ ...d, seq: event.seq }));
        if (!shown) break;
        const sessionUpdate =
          fact.channel === 'user' ? 'user_message_chunk' : fact.channel === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk';
        updates.push({ sessionUpdate, messageId: fact.messageId, content: { type: 'text', text: shown } });
        break;
      }
      case 'tool_request':
        updates.push(...this.tools.request(fact));
        break;
      case 'tool_result':
        updates.push(...this.tools.result(fact));
        break;
      case 'turn_end':
        this.messages.reset();
        break;
      case 'interrupt':
        this.messages.reset();
        updates.push(...this.tools.interrupt(fact.reason === 'cancelled' ? 'session.cancelled' : `session.${fact.reason}`));
        if (fact.reason === 'rewind' && fact.toSeq !== undefined) {
          this.rewindToSeq = fact.toSeq;
          signals.push(this.signal('rewind', { headSeq: event.seq, toSeq: fact.toSeq }));
        }
        break;
      default:
        break;
    }
    const notifications: Notification[] = updates.map((update) => this.update(update, event.seq));
    notifications.push(...signals);
    if (this.options.rawEvents) notifications.push(this.signal('event', { event }));
    return { fact, notifications };
  }

  /** Fail every open tool call, e.g. when this connection closes the session. */
  interrupt(reason: string): Notification[] {
    this.messages.reset();
    return this.tools.interrupt(reason).map((update) => this.update(update, this.head));
  }

  /** The end of a replay: where the journal stands, and the last rewind if there was one. */
  cursor(headSeq: number): Notification {
    return this.signal('cursor', {
      headSeq: Math.max(headSeq, this.head),
      ...(this.rewindToSeq !== undefined ? { rewindToSeq: this.rewindToSeq } : {}),
    });
  }

  private update(update: Record<string, unknown>, seq: number): Notification {
    const prior = (update._meta as Record<string, unknown> | undefined) ?? {};
    return {
      method: 'session/update',
      params: { sessionId: this.sessionId, update: { ...update, _meta: { ...prior, [this.namespace]: { seq, headSeq: seq } } } },
    };
  }

  private signal(name: string, params: Record<string, unknown>): Notification {
    return { method: `_${this.namespace}/${name}`, params: { sessionId: this.sessionId, ...params } };
  }
}
