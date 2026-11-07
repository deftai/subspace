/** `*_end` events and `onMessageEnd`/`onThoughtEnd`/`onUserMessageEnd`: when a message has stopped. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, Turn, TurnProjection, type TurnEvent, type TurnResult } from '@deft-subspace/acp';

/** A turn fed raw session updates, the way the client feeds it. */
function fed(updates: unknown[]) {
  const projection = new TurnProjection('t');
  const turn = new Turn('t', async () => {});
  for (const update of updates) turn.push(...projection.apply(update).events);
  return { turn, projection };
}
const result = (fields: Partial<TurnResult> = {}): TurnResult => ({ stopReason: 'end_turn', text: '', toolCalls: [], cancelled: false, ...fields }) as TurnResult;
const chunk = (sessionUpdate: string, text: string, messageId?: string) => ({ sessionUpdate, content: { type: 'text', text }, ...(messageId ? { messageId } : {}) });
const shape = (events: readonly TurnEvent[]) =>
  events.map((e) => ('delta' in e ? `${e.type} ${e.delta}` : e.type.endsWith('_end') && 'text' in e ? `${e.type} ${JSON.stringify(e.text)}${'complete' in e && !e.complete ? ' incomplete' : ''}` : e.type));

test('a message ends when a tool call, other text or the end of the turn comes; usage, title updates and notices do not end it', () => {
  const { turn } = fed([
    chunk('agent_thought_chunk', 'Hmm.'),
    chunk('agent_message_chunk', 'Let me '),
    { sessionUpdate: 'usage_update', used: 1, size: 10 },
    { sessionUpdate: 'session_info_update', title: 'Looking' },
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    chunk('agent_message_chunk', 'look.'),
    { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Read', status: 'pending' },
    chunk('agent_message_chunk', 'Done.'),
  ]);
  turn.finish(result());
  assert.deepEqual(shape(turn.history), [
    'thought Hmm.',
    'thought_end "Hmm."',
    'message Let me ',
    'usage',
    'session_info',
    'update',
    'message look.',
    'message_end "Let me look."',
    'tool_call',
    'message Done.',
    'message_end "Done."',
  ]);
});

test('a v2 rewrite of a whole message: the end has the final text, not the streamed pieces', () => {
  const { turn } = fed([chunk('agent_message_chunk', 'Hello wrold', 'm'), { sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'Hello world' }] }]);
  turn.finish(result());
  const end = turn.history.at(-1)!;
  assert.equal(end.type, 'message_end');
  assert.equal(end.type === 'message_end' && end.text, 'Hello world');
});

test('two messages with their own ids; the same id continued after a tool call ends again, longer', () => {
  const { turn } = fed([
    chunk('agent_message_chunk', 'One.', 'a'),
    chunk('agent_message_chunk', 'Two.', 'b'),
    { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Read', status: 'pending' },
    chunk('agent_message_chunk', ' More.', 'b'),
  ]);
  turn.finish(result());
  assert.deepEqual(
    turn.history.flatMap((e) => (e.type === 'message_end' ? [`${e.messageId}: ${e.text}`] : [])),
    ['a: One.', 'b: Two.', 'b: Two. More.']
  );
});

test('a message open when the turn is cancelled, stops early or fails ends incomplete', () => {
  for (const [end, expected] of [
    [(t: Turn) => t.finish(result({ stopReason: 'cancelled', cancelled: true })), false],
    [(t: Turn) => t.finish(result({ stopReason: 'max_tokens' })), false],
    [(t: Turn) => t.fail(new Error('gone')), false],
    [(t: Turn) => t.finish(result()), true],
  ] as const) {
    const { turn } = fed([chunk('agent_message_chunk', 'Half')]);
    end(turn);
    const last = turn.history.at(-1)!;
    assert.deepEqual(last.type === 'message_end' && [last.text, last.complete], ['Half', expected]);
  }
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: onMessageEnd and onThoughtEnd get each whole message, in order, before done`, async () => {
    const [agentEnd, clientEnd] = channelPair<unknown>();
    serveAgent(agentEnd, {
      name: 'ends',
      protocols: [protocol],
      async prompt(turn) {
        await turn.think('Thinking.');
        await turn.say('I will ');
        await turn.say('look.');
        await turn.tool({ title: 'List', kind: 'read' }, () => 'a');
        await turn.say('Found a.');
      },
    });
    const client = await AcpClient.connect(clientEnd);
    const session = await client.newSession({ cwd: '/w' });
    const log: string[] = [];
    await session.prompt('go', {
      onThoughtEnd: (text, info) => void log.push(`thought#${info.index}: ${text}`),
      onMessageEnd: async (text, info) => {
        await new Promise((r) => setTimeout(r, 5));
        log.push(`message#${info.index}: ${text}${info.complete ? '' : ' (incomplete)'}`);
      },
      onToolCall: (call, { created }) => void (created && log.push(`tool: ${call.title}`)),
    }).done;
    assert.deepEqual(log, ['thought#0: Thinking.', 'message#0: I will look.', 'tool: List', 'message#1: Found a.']);
    await client.close();
  });
}

test('without message ids, a notice between chunks keeps one message; a plan or terminal splits it, like a tool call', () => {
  const { turn, projection } = fed([
    chunk('agent_message_chunk', 'Let me '),
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    chunk('agent_message_chunk', 'look.'),
    { sessionUpdate: 'plan', entries: [{ content: 'Look', status: 'pending' }] },
    chunk('agent_message_chunk', 'Planned.'),
  ]);
  turn.finish(result());
  assert.equal(projection.text, 'Let me look.\n\nPlanned.');
  assert.deepEqual(
    turn.history.flatMap((e) => (e.type === 'message_end' ? [e.text] : [])),
    ['Let me look.', 'Planned.']
  );
});
