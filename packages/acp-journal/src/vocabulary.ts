/**
 * Ideal's event names, mapped to facts. Pass your own `Vocabulary` for a
 * different log; this one is the default because Ideal is the first user.
 */
import type { Fact, JournalEvent, Vocabulary } from './types.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

export const idealVocabulary: Vocabulary = (event: JournalEvent): Fact | undefined => {
  const p = isRecord(event.payload) ? event.payload : {};
  switch (event.type) {
    case 'session.message.delta':
    case 'session.message': {
      const role = p.role === 'user' ? 'user' : p.role === 'thought' ? 'thought' : p.role === undefined || p.role === 'assistant' ? 'agent' : undefined;
      if (!role) return undefined; // tool and system rows are not shown
      return {
        kind: 'message',
        mode: event.type === 'session.message' ? 'full' : 'delta',
        channel: role,
        messageId: str(p.messageId) ?? str(p.id) ?? `m-${event.seq}`,
        text: typeof p.text === 'string' ? p.text : '',
      };
    }
    case 'session.prompt':
      return typeof p.text === 'string'
        ? { kind: 'message', mode: 'full', channel: 'user', messageId: str(p.messageId) ?? `user-${event.seq}`, text: p.text }
        : undefined;
    case 'session.steer':
      return typeof p.text === 'string'
        ? { kind: 'message', mode: 'full', channel: 'user', messageId: `steer-${event.seq}`, text: p.text }
        : undefined;
    case 'session.tool_request':
      return { kind: 'tool_request', id: str(p.id) ?? String(event.seq), name: str(p.name) ?? 'tool', input: p.input ?? null };
    case 'session.tool_result':
      return { kind: 'tool_result', id: str(p.id) ?? String(event.seq), output: p.output ?? null, isError: p.isError === true };
    case 'session.permission_request':
      return { kind: 'permission_request', id: str(p.id) ?? String(event.seq), toolCallId: str(p.toolCallId), title: str(p.title) };
    case 'session.permission_response':
      return { kind: 'permission_response', id: str(p.id) ?? '', decision: str(p.decision) };
    case 'session.turn_complete':
      return { kind: 'turn_end', stopReason: str(p.stopReason) };
    case 'session.cancelled':
      return { kind: 'interrupt', reason: 'cancelled' };
    case 'session.closed':
      return { kind: 'interrupt', reason: 'closed' };
    case 'session.rewind':
      return typeof p.toSeq === 'number' ? { kind: 'interrupt', reason: 'rewind', toSeq: p.toSeq } : undefined;
    default:
      return undefined;
  }
};
