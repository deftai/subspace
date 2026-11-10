/** Tool-call argument robustness: outcomes from rawOutput.toolInput, counted, rated and checked. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolCall, TurnResult } from '@deft-subspace/acp';
import { checkToolInput, mergeToolInput, summarizeToolInput, toolInputOf } from '@deft-subspace/acp-testkit';
import { checkTurn } from '@deft-subspace/acp-testkit/node';

let n = 0;
const call = (toolInput?: unknown, extra: Partial<ToolCall> = {}): ToolCall => ({
  id: `t${++n}`,
  title: 'Read notes.txt',
  status: 'completed',
  content: [],
  locations: [],
  ...(toolInput !== undefined ? { rawOutput: { toolInput } } : {}),
  ...extra,
});

const valid = (tool = 'read_file', backend = 'openai', model = 'model-a') => call({ status: 'valid', tool, backend, model });
const repaired = (kind: string, backend = 'openai') => call({ status: 'repaired', tool: 'read_file', backend, model: 'model-a', repairs: [{ path: 'path', kind }] });
const invalid = (path: string, backend = 'openai') =>
  call({ status: 'invalid', tool: 'write_file', backend, issues: [{ path, kind: 'missing', expected: 'string', received: 'undefined' }] });

test('an outcome is read from rawOutput.toolInput; anything else is not reported', () => {
  assert.deepEqual(toolInputOf(repaired('unwrap_markdown_link')), {
    status: 'repaired',
    tool: 'read_file',
    backend: 'openai',
    model: 'model-a',
    repairKinds: ['unwrap_markdown_link'],
    issuePaths: [],
  });
  assert.equal(toolInputOf(call()), undefined);
  assert.equal(toolInputOf(call({ status: 'maybe' })), undefined);
  // No tool name: the call's title.
  assert.equal(toolInputOf(call({ status: 'valid' }))?.tool, 'Read notes.txt');
});

test('counts and rates by backend, model and tool; repair kinds and unrepaired tool:path; each call once', () => {
  const first = repaired('omit_optional_null');
  const calls = [valid(), first, { ...first }, repaired('parse_json_array', 'gemma'), invalid('content', 'gemma'), call()];
  const s = summarizeToolInput(calls);
  assert.equal(s.toolCalls, 5);
  assert.deepEqual([s.checked, s.valid, s.repaired, s.invalid], [4, 1, 2, 1]);
  assert.equal(s.repairRate, 0.5);
  assert.equal(s.invalidRate, 0.25);
  assert.deepEqual(s.repairKinds, { omit_optional_null: 1, parse_json_array: 1 });
  assert.deepEqual(s.invalidArguments, { 'write_file:content': 1 });
  assert.deepEqual(s.byBackend.gemma, { checked: 2, valid: 0, repaired: 1, invalid: 1 });
  assert.deepEqual(s.byModel['model-a'], { checked: 3, valid: 1, repaired: 2, invalid: 0 });
  assert.deepEqual(s.byTool.write_file, { checked: 1, valid: 0, repaired: 0, invalid: 1 });
  const none = summarizeToolInput([call(), call()]);
  assert.deepEqual([none.toolCalls, none.checked, none.repairRate, none.invalidRate], [2, 0, null, null]);
});

test('names from the agent never reach Object.prototype', () => {
  const s = summarizeToolInput([call({ status: 'valid', tool: '__proto__', backend: '__proto__', model: 'constructor' })]);
  assert.deepEqual(Object.keys(s.byTool), ['__proto__']);
  assert.equal(s.byBackend['__proto__']!.checked, 1);
  assert.equal(({} as Record<string, unknown>).checked, undefined);
  assert.equal(Object.getPrototypeOf(s.byTool), Object.prototype);
});

test('summaries merge (a run of turns)', () => {
  const merged = mergeToolInput([summarizeToolInput([valid(), invalid('a')]), summarizeToolInput([repaired('k'), repaired('k')])]);
  assert.deepEqual([merged.toolCalls, merged.checked, merged.invalid, merged.repaired], [4, 4, 1, 2]);
  assert.equal(merged.invalidRate, 0.25);
  assert.deepEqual(merged.repairKinds, { k: 2 });
  assert.equal(merged.byBackend.openai!.checked, 4);
});

test('checks: invalid calls fail by default, repairs only when gated; nothing reported passes unless minChecked', () => {
  assert.deepEqual(checkToolInput(summarizeToolInput([valid(), repaired('k')])), []);
  const [failure] = checkToolInput(summarizeToolInput([valid(), invalid('content', 'gemma')]));
  assert.match(failure!, /invalid rate 50% \(1\/2\), expected at most 0%; unrepaired: write_file:content; worst: gemma 100%/);
  assert.deepEqual(checkToolInput(summarizeToolInput([valid(), invalid('x')]), { maxInvalidRate: 0.5 }), []);
  assert.match(checkToolInput(summarizeToolInput([valid(), repaired('k')]), { maxRepairRate: 0.25 })[0]!, /repair rate 50%/);
  assert.deepEqual(checkToolInput(summarizeToolInput([call(), call()])), []);
  assert.match(checkToolInput(summarizeToolInput([call()]), { minChecked: 1 })[0]!, /none reported a tool-input outcome/);
  assert.match(checkToolInput(summarizeToolInput([valid()]), { minChecked: 3 })[0]!, /1 tool calls with a tool-input outcome, expected at least 3/);
});

test('mistyped limits throw instead of turning the check off', () => {
  const s = summarizeToolInput([valid()]);
  assert.throws(() => checkToolInput(s, { maxRepairRate: '0.5' as unknown as number }), /maxRepairRate must be a number from 0 to 1/);
  assert.throws(() => checkToolInput(s, { maxInvalidRate: 2 }), /maxInvalidRate/);
  assert.throws(() => checkToolInput(s, { minChecked: 0 }), /minChecked/);
});

test('a scenario turn expectation: toolInput', async () => {
  const result = { stopReason: 'end_turn', text: '', toolCalls: [valid(), invalid('path')] } as unknown as TurnResult;
  const turn = { result, updates: 2, permissions: [], workspace: '/nonexistent' };
  assert.match((await checkTurn({ toolInput: {} }, turn)).join('\n'), /invalid rate 50%/);
  assert.deepEqual(await checkTurn({ toolInput: { maxInvalidRate: 0.5 } }, turn), []);
  assert.deepEqual(await checkTurn({}, turn), []);
});
