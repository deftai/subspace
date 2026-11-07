import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import type { TraceRecord } from '@deft-subspace/kernel';
import { analyzeTrace, renderTraceHtml } from '@deft-subspace/devtools';
import { req, res, text, trace, update } from './helpers.ts';

const S = 's';

/** The data block and the inline script, taken out of the page. */
function parts(html: string) {
  const data = /<script type="application\/json" id="trace-data">([\s\S]*?)<\/script>/.exec(html);
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html);
  assert.ok(data && script, 'page has a data block and a script');
  return { data: JSON.parse(data[1]!) as { records: unknown[]; title: string }, script: script[1]! };
}

/** A big v2-style trace: turns of streamed text, a tool call and a permission each. */
function bigTrace(messages: number): TraceRecord[] {
  const steps: Array<[number, 'in' | 'out', unknown]> = [];
  let t = 0;
  let id = 1;
  let turn = 0;
  while (steps.length < messages) {
    const p = id++;
    steps.push([t++, 'out', req(p, 'session/prompt', { sessionId: S, prompt: [text(`Task ${turn}`)] })]);
    steps.push([t++, 'in', res(p, { messageId: `u${turn}` })]);
    steps.push([t++, 'in', update(S, { sessionUpdate: 'tool_call_update', toolCallId: `c${turn}`, title: 'work', status: 'pending' })]);
    steps.push([t++, 'in', req(turn, 'session/request_permission', { sessionId: S, title: 'ok?', options: [{ optionId: 'a', kind: 'allow_once' }] })]);
    steps.push([t++, 'out', res(turn, { outcome: { outcome: 'selected', optionId: 'a' } })]);
    for (let i = 0; i < 90; i++) steps.push([t++, 'in', update(S, { sessionUpdate: 'agent_message_chunk', messageId: `m${turn}`, content: text(`word${i} `) })]);
    steps.push([t++, 'in', update(S, { sessionUpdate: 'tool_call_update', toolCallId: `c${turn}`, status: 'completed' })]);
    steps.push([t++, 'in', update(S, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })]);
    turn++;
  }
  return trace('client', ...steps.slice(0, messages));
}

test('the trace is embedded so that </script> and <!-- in it cannot break out', () => {
  const nasty = 'a </script><script>globalThis.pwned = 1</script> b <!-- <script> c   d </SCRIPT >';
  const records = trace(
    'client',
    [0, 'out', req(1, 'session/prompt', { sessionId: S, prompt: [text(nasty)] })],
    [1, 'in', update(S, { sessionUpdate: 'agent_message_chunk', content: text(nasty) })],
    [2, 'in', res(1, { stopReason: 'end_turn' })]
  );
  const html = renderTraceHtml(records, { title: '<b>&title</b>' });
  // Only our two scripts open and close.
  assert.equal(html.match(/<script/gi)!.length, 2);
  assert.equal(html.match(/<\/script/gi)!.length, 2);
  assert.equal(html.indexOf('<!--'), -1);
  assert.match(html, /<title>&lt;b&gt;&amp;title&lt;\/b&gt; · Subspace trace<\/title>/);
  const { data } = parts(html);
  assert.deepEqual(data.records, records);
  assert.equal(data.title, '<b>&title</b>');
});

test('the inline script parses, and its embedded analyzer agrees with analyzeTrace', () => {
  const records = bigTrace(400);
  const html = renderTraceHtml(records);
  const { script } = parts(html);
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'viewer.js' }));
  // Run only the analyzer part (everything before the app's IIFE) in a bare context.
  const analyzer = script.slice(0, script.lastIndexOf('\n(function'));
  const context = vm.createContext({});
  vm.runInContext(`${analyzer}\nglobalThis.result = JSON.stringify(analyzeTrace(${JSON.stringify(records)}));`, context);
  assert.equal(context.result, JSON.stringify(analyzeTrace(records)));
  const read = vm.runInContext(`JSON.stringify(readTrace('{"v":1}\\n{bad'))`, context) as string;
  assert.equal(JSON.parse(read).diagnostics[0].code, 'truncated');
});

test('the page has no external resources', () => {
  const html = renderTraceHtml(bigTrace(50));
  assert.doesNotMatch(html, /<link|\ssrc=|@import|https?:\/\/(?!www\.w3\.org)/);
});

test('10,000 messages: analysis and HTML stay fast and linear', () => {
  const records = bigTrace(10_000);
  const t0 = performance.now();
  const analysis = analyzeTrace(records);
  const t1 = performance.now();
  const html = renderTraceHtml(records);
  const t2 = performance.now();
  assert.equal(analysis.events.length, 10_000);
  assert.ok(analysis.turns.length > 90);
  assert.ok(analysis.turns.slice(0, -1).every((t) => t.status === 'ended' && t.text.startsWith('word0 word1')));
  assert.ok(t1 - t0 < 1000, `analysis took ${Math.round(t1 - t0)} ms`);
  assert.ok(t2 - t1 < 1500, `render took ${Math.round(t2 - t1)} ms`);
  // The page is the data plus a fixed-size viewer.
  const viewer = renderTraceHtml([]).length;
  assert.ok(html.length - viewer < JSON.stringify(records).length * 1.1);

  // Doubling the input roughly doubles the time: no quadratic step.
  const double = bigTrace(20_000);
  const t3 = performance.now();
  analyzeTrace(double);
  const t4 = performance.now();
  assert.ok(t4 - t3 < Math.max(200, (t1 - t0) * 5), `20k took ${Math.round(t4 - t3)} ms vs ${Math.round(t1 - t0)} ms for 10k`);
});
