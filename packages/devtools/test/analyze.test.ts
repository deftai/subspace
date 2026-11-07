import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTrace } from '@deft-subspace/kernel';
import { analyzeTrace, formatSummary, readTrace } from '@deft-subspace/devtools';
import { err, note, req, res, text, trace, update } from './helpers.ts';

const S = 'sess-1';
const codes = (a: ReturnType<typeof analyzeTrace>) => a.diagnostics.map((d) => d.code);

test('v1: a turn with streaming, a tool call and an allowed permission', () => {
  const a = analyzeTrace(
    trace(
      'client',
      [0, 'out', req(0, 'initialize', { protocolVersion: 2, clientInfo: { name: 'c', version: '1' } })],
      [3, 'in', res(0, { protocolVersion: 1, agentInfo: { name: 'agent', version: '9' } })],
      [4, 'out', req(1, 'session/new', { cwd: '/w', mcpServers: [] })],
      [6, 'in', res(1, { sessionId: S })],
      [10, 'out', req(2, 'session/prompt', { sessionId: S, prompt: [text('Run the tests')] })],
      [11, 'in', update(S, { sessionUpdate: 'agent_thought_chunk', content: text('hmm') })],
      [12, 'in', update(S, { sessionUpdate: 'agent_message_chunk', content: text('Running ') })],
      [13, 'in', update(S, { sessionUpdate: 'agent_message_chunk', content: text('them.') })],
      [14, 'in', update(S, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'npm test', kind: 'execute', status: 'pending' })],
      // The agent's own id 0: a different request from the client's id 0.
      [15, 'in', req(0, 'session/request_permission', { sessionId: S, toolCall: { toolCallId: 'c1' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] })],
      [40, 'out', res(0, { outcome: { outcome: 'selected', optionId: 'ok' } })],
      [41, 'in', update(S, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' })],
      [60, 'in', update(S, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })],
      [61, 'in', update(S, { sessionUpdate: 'agent_message_chunk', content: text('All pass.') })],
      [62, 'in', res(2, { stopReason: 'end_turn' })]
    )
  );
  assert.equal(a.protocol, 1);
  assert.equal(a.agent?.name, 'agent');
  assert.equal(a.client?.name, 'c');
  assert.equal(a.recorder, 'client');
  assert.deepEqual(a.diagnostics, []);
  assert.deepEqual(a.sessions.map((s) => [s.id, s.via, s.cwd, s.turns]), [[S, 'session/new', '/w', [0]]]);

  assert.equal(a.requests.length, 4);
  assert.deepEqual(a.requests.map((r) => [r.method, r.from, r.outcome, r.latency]), [
    ['initialize', 'client', 'result', 3],
    ['session/new', 'client', 'result', 2],
    ['session/prompt', 'client', 'result', 52],
    ['session/request_permission', 'agent', 'result', 25],
  ]);

  const [turn] = a.turns;
  assert.equal(turn!.prompt, 'Run the tests');
  assert.equal(turn!.status, 'ended');
  assert.equal(turn!.stopReason, 'end_turn');
  assert.equal(turn!.duration, 52);
  assert.equal(turn!.text, 'Running them.\n\nAll pass.');
  assert.equal(turn!.thoughts, 'hmm');
  assert.equal(turn!.messages, 11);
  assert.deepEqual(turn!.toolCalls, [0]);
  assert.deepEqual(turn!.permissions, [0]);

  assert.deepEqual(a.toolCalls[0]!.history.map((h) => [h.status, h.t]), [['pending', 14], ['in_progress', 41], ['completed', 60]]);
  assert.equal(a.toolCalls[0]!.title, 'npm test');
  assert.equal(a.permissions[0]!.title, 'npm test');
  assert.equal(a.permissions[0]!.result, 'allowed');
  assert.equal(a.permissions[0]!.optionId, 'ok');
  assert.equal(a.permissions[0]!.latency, 25);

  const fromAgent = a.events.filter((e) => e.from === 'agent').length;
  assert.equal(fromAgent, 11);
  assert.equal(a.updates.agent_message_chunk, 3);
  assert.equal(a.methods['session/update'], 7);
  assert.match(formatSummary(a), /1 turns[\s\S]*"Run the tests"\s+end_turn · 52 ms · 1 tools · 1 permissions \(allowed\)/);
});

test('v1: cancel, a rejected permission, an error answer and ids 0 and "0"', () => {
  const a = analyzeTrace(
    trace(
      'client',
      [0, 'out', req(0, 'session/prompt', { sessionId: S, prompt: [text('go')] })],
      [1, 'in', req(0, 'session/request_permission', { sessionId: S, toolCall: { toolCallId: 't', title: 'rm' }, options: [{ optionId: 'r', kind: 'reject_once' }] })],
      [2, 'out', res(0, { outcome: { outcome: 'selected', optionId: 'r' } })],
      [5, 'out', note('session/cancel', { sessionId: S })],
      [9, 'in', update(S, { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed' })],
      [12, 'in', res(0, { stopReason: 'cancelled' })],
      [20, 'out', req('0', 'session/prompt', { sessionId: 'nope', prompt: [text('hi')] })],
      [21, 'in', err('0', -32002, 'Unknown session nope')]
    )
  );
  // "nope" only ever failed: noted, and not counted as a session.
  assert.deepEqual(codes(a), ['session-unconfirmed']);
  assert.deepEqual(a.sessions.map((s) => s.id), [S]);
  assert.deepEqual(a.turns.map((t) => [t.sessionId, t.status, t.stopReason]), [[S, 'cancelled', 'cancelled'], ['nope', 'error', 'error']]);
  assert.equal(a.turns[0]!.cancelEvent, 3);
  assert.deepEqual(a.cancels.map((c) => [c.kind, c.turn, c.confirmedAfter]), [['session', 0, 7]]);
  assert.equal(a.permissions[0]!.result, 'rejected');
  assert.equal(a.toolCalls[0]!.status, 'failed');
  assert.deepEqual(a.requests[2]!.error, { code: -32002, message: 'Unknown session nope' });
  assert.equal(a.requests[2]!.outcome, 'error');
  assert.equal(a.events[7]!.level, 'error');
  // Every response found its own request.
  assert.deepEqual(a.requests.map((r) => r.response), [5, 2, 7]);
});

test('v2: upserts, a titled permission, a whole message and the idle state ending the turn', () => {
  const a = analyzeTrace(
    trace(
      'client',
      [0, 'out', req(0, 'initialize', { protocolVersion: 2 })],
      [1, 'in', res(0, { protocolVersion: 2, info: { name: 'v2agent' }, capabilities: {} })],
      [2, 'out', req(1, 'session/new', { cwd: '/w' })],
      [3, 'in', res(1, { sessionId: S })],
      [10, 'out', req(2, 'session/prompt', { sessionId: S, prompt: [text('Write it')] })],
      [11, 'in', res(2, { messageId: 'u1' })],
      [12, 'in', update(S, { sessionUpdate: 'state_update', state: 'running' })],
      [13, 'in', update(S, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('Writ') })],
      [14, 'in', update(S, { sessionUpdate: 'agent_message', messageId: 'm1', content: [text('Writing now.')] })],
      [15, 'in', update(S, { sessionUpdate: 'tool_call_update', toolCallId: 'w', title: 'Write a.txt', kind: 'edit', status: 'pending' })],
      [16, 'in', req(0, 'session/request_permission', { sessionId: S, title: 'Write a.txt?', subject: { type: 'tool_call', toolCall: { toolCallId: 'w' } }, options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] })],
      [30, 'out', res(0, { outcome: { outcome: 'selected', optionId: 'n' } })],
      [31, 'in', update(S, { sessionUpdate: 'tool_call_update', toolCallId: 'w', status: 'failed' })],
      [40, 'in', update(S, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })],
      [41, 'in', update(S, { sessionUpdate: 'usage_update', used: 10, size: 100 })]
    )
  );
  assert.equal(a.protocol, 2);
  assert.equal(a.agent?.name, 'v2agent');
  assert.deepEqual(a.diagnostics, []);
  const turn = a.turns[0]!;
  assert.equal(turn.status, 'ended');
  assert.equal(turn.duration, 30);
  assert.equal(turn.endEvent, 13);
  assert.equal(turn.text, 'Writing now.');
  assert.equal(a.requests[2]!.latency, 1);
  assert.deepEqual(a.toolCalls.map((c) => [c.id, c.title, c.history.map((h) => h.status)]), [['w', 'Write a.txt', ['pending', 'failed']]]);
  assert.deepEqual([a.permissions[0]!.title, a.permissions[0]!.result, a.permissions[0]!.toolCall], ['Write a.txt?', 'rejected', 0]);
  // The update after idle belongs to no turn.
  assert.equal(a.events[14]!.turn, undefined);
});

test('v2: an agent cancels its permission request, the answer comes after; -32800 is a cancel', () => {
  const a = analyzeTrace(
    trace(
      'client',
      [0, 'out', req(5, 'session/prompt', { sessionId: S, prompt: [text('big')] })],
      [1, 'in', res(5, { messageId: 'u' })],
      [2, 'in', req(3, 'session/request_permission', { sessionId: S, title: 'Rewrite?', subject: { type: 'tool_call', toolCall: { toolCallId: 'b' } }, options: [] })],
      [10, 'out', note('session/cancel', { sessionId: S })],
      [11, 'in', note('$/cancel_request', { requestId: 3 })],
      [12, 'out', res(3, { outcome: { outcome: 'cancelled' } })],
      [13, 'in', update(S, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' })],
      [20, 'out', req(6, 'session/load', { sessionId: 'old', cwd: '/x' })],
      [21, 'out', note('$/cancel_request', { requestId: 6 })],
      [22, 'in', err(6, -32800, 'Request cancelled')]
    )
  );
  const perm = a.requests[1]!;
  assert.equal(perm.cancelEvent, 4);
  assert.equal(perm.late, true);
  assert.equal(a.permissions[0]!.result, 'cancelled');
  assert.equal(a.turns[0]!.status, 'cancelled');
  assert.deepEqual(a.cancels.map((c) => [c.kind, c.from, c.request ?? c.turn, c.confirmedAfter]), [
    ['session', 'client', 0, 3],
    ['request', 'agent', 1, 1],
    ['request', 'client', 2, 1],
  ]);
  assert.equal(a.requests[2]!.outcome, 'cancelled');
  assert.equal(a.sessions.find((s) => s.id === 'old')?.via, 'session/load');
  assert.deepEqual(a.diagnostics, []);
});

test('unanswered requests, orphan and duplicate responses, malformed messages', () => {
  const a = analyzeTrace(
    trace(
      'client',
      [0, 'in', res(99, {})],
      [1, 'out', req(1, 'session/new', { cwd: '/' })],
      [2, 'in', res(1, { sessionId: S })],
      [3, 'in', res(1, { sessionId: S })],
      [4, 'in', 'garbage'],
      [5, 'in', { jsonrpc: '2.0', id: 4 }],
      [6, 'out', { id: 2, method: 'x' }],
      [7, 'out', req(3, 'session/set_mode', { sessionId: S, modeId: 'ask' })]
    )
  );
  assert.deepEqual(codes(a), ['orphan-response', 'duplicate-response', 'invalid-message', 'invalid-message', 'not-jsonrpc-2', 'unanswered', 'unanswered']);
  assert.deepEqual(a.requests.map((r) => [r.method, r.outcome]), [['session/new', 'result'], ['x', 'unanswered'], ['session/set_mode', 'unanswered']]);
  assert.deepEqual(a.events.map((e) => e.kind), ['response', 'request', 'response', 'response', 'invalid', 'invalid', 'request', 'request']);
  assert.equal(a.events[3]!.level, 'error');
  assert.equal(a.events[0]!.level, 'warning');
});

test('a truncated trace: the cut-off line is reported and the open turn stays open', () => {
  const full = formatTrace(
    trace(
      'client',
      [0, 'out', req(1, 'session/prompt', { sessionId: S, prompt: [text('long job')] })],
      [5, 'in', update(S, { sessionUpdate: 'agent_message_chunk', content: text('working') })],
      [9, 'in', update(S, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'build', status: 'in_progress' })]
    )
  );
  const cut = full.slice(0, full.length - 30);
  const { records, diagnostics } = readTrace(cut);
  assert.equal(records.length, 3);
  assert.deepEqual(diagnostics.map((d) => [d.code, d.line]), [['truncated', 4]]);
  const a = analyzeTrace(records, { diagnostics });
  assert.deepEqual(codes(a), ['truncated', 'unanswered', 'turn-open']);
  assert.equal(a.turns[0]!.status, 'open');
  assert.equal(a.turns[0]!.text, 'working');
  assert.equal(a.duration, 5);
  assert.match(formatSummary(a), /"long job"\s+open/);
  // A bad line in the middle is an error, not truncation.
  assert.deepEqual(readTrace('{"v":1,"kind":"header","peer":"c"}\n{oops\n{"v":1,"kind":"note","t":1,"text":"x"}\n').diagnostics.map((d) => d.code), ['bad-line']);
});

test('a trace that starts mid-session, with no header, recorded by the agent', () => {
  const records = [
    { v: 1, kind: 'message', t: 0, dir: 'out', msg: update(S, { sessionUpdate: 'agent_message_chunk', content: text('x') }) },
    { v: 1, kind: 'message', t: 1, dir: 'in', msg: req(7, 'session/prompt', { sessionId: S, prompt: [text('next')] }) },
    { v: 1, kind: 'message', t: 4, dir: 'out', msg: res(7, { stopReason: 'end_turn' }) },
  ];
  const a = analyzeTrace(records, { recorder: 'agent' });
  assert.deepEqual(codes(a), ['no-header']);
  assert.deepEqual(a.events.map((e) => e.from), ['agent', 'client', 'agent']);
  assert.equal(a.sessions[0]!.via, 'seen');
  assert.equal(a.turns[0]!.status, 'ended');
  assert.equal(a.events[0]!.turn, undefined);
  // From the header, too.
  assert.equal(analyzeTrace([{ v: 1, kind: 'header', started: '', peer: 'my-agent' }]).recorder, 'agent');
});

test('an id seen only in failed requests is not a session; one with updates or results is', () => {
  const a = analyzeTrace(
    trace(
      'client',
      [0, 'out', req(0, 'session/prompt', { sessionId: 'ghost', prompt: [text('hi')] })],
      [1, 'in', err(0, -32002, 'Resource not found')],
      [2, 'out', req(1, 'session/set_mode', { sessionId: 'early', modeId: 'default' })],
      [3, 'in', res(1, {})],
      [4, 'in', update('started-before-trace', { sessionUpdate: 'agent_message_chunk', content: text('x') })]
    )
  );
  assert.deepEqual(a.sessions.map((s) => s.id), ['early', 'started-before-trace']);
  assert.ok(a.diagnostics.some((d) => d.code === 'session-unconfirmed' && d.message.includes('"ghost"')));
});
