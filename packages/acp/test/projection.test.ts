/**
 * TurnProjection storage: event snapshots stay as they were, and what a turn
 * keeps grows linearly (no event holds its own copy of everything so far).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolCall, TurnEvent, TurnResult } from '@deft-subspace/acp';
import { TurnProjection } from '../src/projection.ts';
import { Turn } from '../src/turn.ts';

type ToolEvent = Extract<TurnEvent, { type: 'tool_call' }>;
type MessageEvent = Extract<TurnEvent, { type: 'message' }>;

const text = (t: string) => ({ type: 'content', content: { type: 'text', text: t } });

test('tool call snapshots: content chunks append without changing earlier snapshots', () => {
  const projection = new TurnProjection('t');
  const events: ToolEvent[] = [];
  const apply = (update: Record<string, unknown>) => {
    for (const event of projection.apply(update).events) if (event.type === 'tool_call') events.push(event);
  };
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', title: 'x', status: 'in_progress', content: [text('a')] });
  for (let i = 0; i < 100; i++) apply({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 'c', content: text(String(i)) });
  assert.equal(events[0]!.toolCall.content.length, 1);
  assert.equal(events[1]!.toolCall.content.length, 2);
  assert.equal(events[100]!.toolCall.content.length, 101);
  // Snapshots do not share an array with the live tool call or with each other.
  const live = projection.toolCalls.get('c')!;
  assert.notEqual(events[100]!.toolCall.content, live.content);
  assert.notEqual(events[99]!.toolCall.content, events[100]!.toolCall.content);
  // Changing a snapshot's array changes nothing else.
  (events[100]!.toolCall.content as unknown[]).push('mine');
  assert.equal(live.content.length, 101);
  assert.equal(events[99]!.toolCall.content.length, 100);
  // A replacing update starts a new list; earlier snapshots keep theirs.
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', content: [text('new')] });
  assert.deepEqual(events.at(-1)!.toolCall.content, [text('new')]);
  assert.equal(events[50]!.toolCall.content.length, 51);
  // A snapshot spreads and serializes like a plain object.
  assert.equal({ ...events[0]!.toolCall }.content.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(events[0]!.toolCall)).content, [text('a')]);
  // Failing open tool calls snapshots too.
  const failed = projection.failOpenToolCalls();
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as ToolEvent).toolCall.status, 'failed');
  assert.equal(events.at(-1)!.toolCall.status, 'in_progress');
});

test('turn history: a number keeps the last events, none keeps none, a running reader misses nothing', async () => {
  const usage = (n: number): TurnEvent => ({ type: 'usage', used: n, size: 100 });
  const result: TurnResult = { stopReason: 'end_turn', text: '', toolCalls: [], cancelled: false };
  // Kept: the last 3.
  const capped = new Turn('a', async () => {}, undefined, 3);
  for (let i = 0; i < 10; i++) capped.push(usage(i));
  assert.deepEqual(capped.history.map((e) => (e as { used: number }).used), [7, 8, 9]);
  // A reader that is behind holds events until it has had them; then they go.
  const turn = new Turn('b', async () => {}, undefined, 'none');
  const seen: number[] = [];
  const reader = (async () => {
    for await (const event of turn) seen.push((event as { used: number }).used);
  })();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 200; i++) turn.push(usage(i));
  assert.ok(turn.history.length > 0, 'the reader has not run yet');
  await new Promise((r) => setImmediate(r));
  turn.push(usage(200));
  turn.finish({ ...result });
  await reader;
  assert.deepEqual(seen, Array.from({ length: 201 }, (_, i) => i));
  assert.equal(turn.history.length, 0);
  assert.equal((turn as unknown as { events: unknown[] }).events.length < 100, true);
  // The default keeps everything.
  const all = new Turn('c', async () => {}, undefined);
  for (let i = 0; i < 10; i++) all.push(usage(i));
  assert.equal(all.history.length, 10);
  assert.throws(() => new Turn('d', async () => {}, undefined, -1), RangeError);
});

test('message events: text is the message as it was, without a copy per event', () => {
  const projection = new TurnProjection('t');
  const events: MessageEvent[] = [];
  const apply = (update: Record<string, unknown>) => {
    for (const event of projection.apply(update).events) if (event.type === 'message') events.push(event);
  };
  for (let i = 0; i < 50; i++) apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${i} ` } });
  // `text` is read from the message's log, not stored on each event.
  assert.equal(typeof Object.getOwnPropertyDescriptor(events[0]!, 'text')?.get, 'function');
  assert.equal(events[0]!.text, '0 ');
  assert.equal(events[2]!.text, '0 1 2 ');
  assert.equal(events[49]!.text, Array.from({ length: 50 }, (_, i) => `${i} `).join(''));
  assert.equal(projection.text, events[49]!.text);
  assert.deepEqual({ ...events[1]! }, { type: 'message', messageId: 't:message:1', delta: '1 ', text: '0 1 ' });
  // A v2 whole-message rewrite starts over; earlier events keep their text.
  apply({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'hello' }] });
  apply({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'hello world' }] });
  apply({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'bye' }] });
  assert.deepEqual(events.slice(-3).map((e) => [e.delta, e.text]), [['hello', 'hello'], [' world', 'hello world'], ['bye', 'bye']]);
  assert.equal(events[49]!.text.length, 140);
  // The turn's text is cached until a message changes.
  assert.equal(projection.text, `${events[49]!.text}\n\nbye`);
  apply({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: '!' } });
  assert.equal(projection.text, `${events[49]!.text}\n\nbye!`);
});

test('event snapshots: writable like plain objects, and each owns its copy once read', () => {
  const projection = new TurnProjection('t');
  const tools: ToolEvent[] = [];
  const messages: MessageEvent[] = [];
  const terminals: Array<Extract<TurnEvent, { type: 'terminal' }>> = [];
  const apply = (update: Record<string, unknown>) => {
    for (const event of projection.apply(update).events) {
      if (event.type === 'tool_call') tools.push(event);
      if (event.type === 'message') messages.push(event);
      if (event.type === 'terminal') terminals.push(event);
    }
  };
  // Two snapshots at the same content length (a status change adds no content).
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', title: 'x', status: 'pending', content: [text('a')] });
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress' });
  const [one, two] = tools.map((e) => e.toolCall);
  // Reading twice gives the same array; changing one snapshot's changes no other, nor the live call.
  assert.equal(one!.content, one!.content);
  (one!.content as unknown[]).push('mine');
  assert.equal(two!.content.length, 1);
  assert.equal(projection.toolCalls.get('c')!.content.length, 1);
  assert.equal(one!.content.length, 2);
  // A snapshot taken later at the same length does not see the change either.
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', title: 'y' });
  assert.equal(tools[2]!.toolCall.content.length, 1);
  // Assigning works, before or after reading (the event type is Readonly, as on main).
  apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', title: 'z' });
  const unread = tools[3]!.toolCall as ToolCall;
  unread.content = [];
  assert.deepEqual(unread.content, []);
  (one as ToolCall).content = [text('z')] as ToolCall['content'];
  assert.deepEqual(one!.content, [text('z')]);
  // Once read, the field is a plain data property.
  const read = Object.getOwnPropertyDescriptor(two!, 'content')!;
  assert.equal(read.writable, true);
  assert.equal(read.enumerable, true);
  // Message text: assignable too.
  apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
  const message = messages[0]!;
  message.text = 'changed';
  assert.equal(message.text, 'changed');
  assert.equal(projection.text, 'hi');
  // Terminal output: two snapshots of the same output are two copies.
  apply({ sessionUpdate: 'terminal_output_chunk', terminalId: 'term', data: btoa('abc') });
  apply({ sessionUpdate: 'terminal_update', terminalId: 'term', command: 'ls' });
  const [first, second] = terminals.map((e) => e.terminal);
  (first!.output as Uint8Array)[0] = 0;
  assert.equal(second!.output[0], 'a'.charCodeAt(0));
  assert.equal(projection.terminals.get('term')!.output[0], 'a'.charCodeAt(0));
  (second as { output: Uint8Array }).output = new Uint8Array([1]);
  assert.deepEqual([...second!.output], [1]);
  assert.equal(projection.terminals.get('term')!.output.length, 3);
});
