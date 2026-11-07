/**
 * Journals often store a message twice: streamed deltas, then the whole text
 * under the same message id. ACP chunks append, so sending both shows the text
 * twice. The coalescer sends each delta, and of the final message only the
 * part not already sent.
 */
import type { Fact } from './types.ts';

type MessageFact = Extract<Fact, { kind: 'message' }>;

export interface CoalesceDiagnostic {
  kind: 'message-diverged';
  messageId: string;
  /** What was already sent, which the final text does not start with. */
  sent: string;
  final: string;
}

export class MessageCoalescer {
  private readonly sent = new Map<string, string>();

  /** The text to send for this fact, or '' for nothing. */
  apply(fact: MessageFact, onDiagnostic?: (diagnostic: CoalesceDiagnostic) => void): string {
    const key = `${fact.channel}:${fact.messageId}`;
    const sent = this.sent.get(key);
    if (fact.mode === 'delta') {
      this.sent.set(key, (sent ?? '') + fact.text);
      return fact.text;
    }
    this.sent.set(key, fact.text);
    if (sent === undefined) return fact.text;
    if (fact.text.startsWith(sent)) return fact.text.slice(sent.length);
    // A chunk cannot be taken back. Send nothing; the journal keeps the full text.
    onDiagnostic?.({ kind: 'message-diverged', messageId: fact.messageId, sent, final: fact.text });
    return '';
  }

  /** Forget sent text, at the end of a turn. */
  reset(): void {
    this.sent.clear();
  }
}
