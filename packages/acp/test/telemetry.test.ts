/** OpenTelemetry spans from a connection's messages: live on either side, and from a saved trace. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { channelPair, parseTrace, type TraceRecord } from '@deft-subspace/kernel';
import { AcpClient, otelTap, serveAgent, spansFromTrace, type OtelApi } from '@deft-subspace/acp';

interface FakeSpan {
  name: string;
  kind: number | undefined;
  parent: string;
  attributes: Record<string, unknown>;
  events: string[];
  status?: { code: number; message?: string };
  start?: number;
  end?: number;
}

/** Just enough of @opentelemetry/api: spans are recorded, contexts name their span. */
function fakeOtel() {
  const spans: FakeSpan[] = [];
  let active: unknown = { label: 'root' };
  const api: OtelApi = {
    trace: {
      getTracer: () => ({
        startSpan(name, options = {}, context?: never) {
          const ctx = context as { span?: FakeSpan; label?: string } | undefined;
          const span: FakeSpan = { name, kind: options.kind, parent: ctx?.span ? ctx.span.name : (ctx?.label ?? 'none'), attributes: { ...options.attributes }, events: [], ...(options.startTime !== undefined ? { start: options.startTime } : {}) };
          spans.push(span);
          return {
            setAttribute: (key: string, value: unknown) => void (span.attributes[key] = value),
            addEvent: (event: string) => void span.events.push(event),
            setStatus: (status: { code: number; message?: string }) => void (span.status = status),
            end: (time?: number) => void (span.end = time ?? -1),
          };
        },
      }),
      setSpan: () => ({}), // replaced below
    },
    context: { active: () => active },
  };
  // setSpan gets the wrapper, not the FakeSpan: map wrappers back to their records.
  const wrappers = new Map<unknown, FakeSpan>();
  const tracer = api.trace.getTracer;
  api.trace.getTracer = (name, version) => {
    const t = tracer(name, version);
    return {
      startSpan: (...args: Parameters<typeof t.startSpan>) => {
        const wrapper = t.startSpan(...args);
        wrappers.set(wrapper, spans.at(-1)!);
        return wrapper;
      },
    };
  };
  api.trace.setSpan = (_context: never, span: never) => ({ span: wrappers.get(span) });
  return { api, spans, setActive: (label: string) => void (active = { label }) };
}

const named = (spans: FakeSpan[], name: string) => spans.filter((s) => s.name === name);
const one = (spans: FakeSpan[], name: string) => {
  const found = named(spans, name);
  assert.equal(found.length, 1, `one ${name} span (${spans.map((s) => s.name).join(', ')})`);
  return found[0]!;
};

function agent(protocol: 1 | 2) {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  return {
    clientEnd,
    serve: (tap?: (d: 'in' | 'out', m: unknown) => void) =>
      serveAgent(agentEnd, {
        name: 'spans',
        version: '1.0.0',
        protocols: [protocol],
        ...(tap ? { peer: { tap } } : {}),
        async prompt(turn) {
          await turn.plan([{ content: 'Read', status: 'in_progress' }]);
          await turn.tool({ title: 'Read secret.txt', kind: 'read' }, () => 'a');
          await turn.tool({ title: 'Delete secret.txt', kind: 'delete', ask: true }, () => 'x');
          await turn.say('Done.');
        },
      }),
  };
}

for (const protocol of [1, 2] as const) {
  test(`v${protocol} client: requests are spans; the prompt is the turn, under the caller's span, with its tool calls and questions inside`, async () => {
    const otel = fakeOtel();
    const a = agent(protocol);
    a.serve();
    const tap = otelTap(otel.api, { attributes: { 'acp.agent': 'spans' } });
    const client = await AcpClient.connect(a.clientEnd, { tap, permissions: 'allow' });
    const session = await client.newSession({ cwd: '/w' });
    otel.setActive('app request');
    await session.prompt('go').done;
    await client.close();

    const init = one(otel.spans, 'initialize');
    assert.equal(init.kind, 2, 'CLIENT');
    assert.equal(init.attributes['acp.protocol_version'], protocol);
    assert.equal(init.attributes['acp.agent.name'], 'spans');
    assert.equal(one(otel.spans, 'session/new').attributes['acp.session_id'], session.id);

    const turn = one(otel.spans, 'session/prompt');
    assert.equal(turn.parent, 'app request');
    assert.equal(turn.attributes['acp.stop_reason'], 'end_turn');
    assert.equal(turn.attributes['acp.session_id'], session.id);
    assert.equal(turn.attributes['rpc.system'], 'jsonrpc');
    assert.equal(turn.attributes['acp.agent'], 'spans', 'the attributes option is on every span');
    assert.ok(turn.events.includes('plan'));

    const tools = named(otel.spans, 'tool_call');
    assert.deepEqual(tools.map((t) => [t.parent, t.attributes['acp.tool_call.kind'], t.attributes['acp.tool_call.status']]), [
      ['session/prompt', 'read', 'completed'],
      ['session/prompt', 'delete', 'completed'],
    ]);
    assert.ok(tools.every((t) => !('acp.tool_call.title' in t.attributes)), 'no titles unless asked');

    const asked = one(otel.spans, 'session/request_permission');
    assert.equal(asked.kind, 1, 'SERVER: the agent asked');
    assert.equal(asked.parent, 'session/prompt');
    assert.equal(asked.attributes['acp.permission.outcome'], 'selected');

    assert.deepEqual(otel.spans.filter((s) => s.end === undefined).map((s) => s.name), [], 'everything ended');
    assert.ok(otel.spans.every((s) => s.status === undefined), 'nothing failed');
  });
}

test('agent side: the same tap on serveAgent; the prompt is a SERVER span, the question a CLIENT one', async () => {
  const otel = fakeOtel();
  const a = agent(1);
  a.serve(otelTap(otel.api, { titles: true }));
  const client = await AcpClient.connect(a.clientEnd, { permissions: 'reject' });
  const session = await client.newSession({ cwd: '/w' });
  await session.prompt('go').done;
  await client.close();
  const turn = one(otel.spans, 'session/prompt');
  assert.equal(turn.kind, 1);
  assert.equal(turn.attributes['acp.stop_reason'], 'end_turn');
  const asked = one(otel.spans, 'session/request_permission');
  assert.equal(asked.kind, 2);
  assert.equal(asked.attributes['acp.permission.outcome'], 'selected');
  const deleted = named(otel.spans, 'tool_call').find((t) => t.attributes['acp.tool_call.kind'] === 'delete')!;
  assert.equal(deleted.attributes['acp.tool_call.title'], 'Delete secret.txt', 'titles when asked');
  assert.equal(deleted.attributes['acp.tool_call.status'], 'failed');
  assert.equal(deleted.status?.code, 2, 'a failed tool call is an error span');
});

const corpus = (name: string) => parseTrace(readFileSync(fileURLToPath(new URL(`../../acp-testkit/corpus/${name}.trace.jsonl`, import.meta.url)), 'utf8'));

test('from a saved trace: a cancelled Claude turn, at the recorded times', () => {
  const otel = fakeOtel();
  const records = corpus('claude-cancel');
  spansFromTrace(records, otel.api);
  const turn = one(otel.spans, 'session/prompt');
  assert.equal(turn.attributes['acp.stop_reason'], 'cancelled');
  assert.ok(turn.events.includes('session/cancel'));
  const started = Date.parse((records[0] as Extract<TraceRecord, { kind: 'header' }>).started);
  assert.ok(turn.start! >= started && turn.end! > turn.start!, 'times come from the trace');
  assert.deepEqual(otel.spans.filter((s) => s.end === undefined).map((s) => s.name), []);
});

test('errors mark the span; close() ends what is still open, as unfinished', () => {
  const otel = fakeOtel();
  const tap = otelTap(otel.api);
  tap('out', { jsonrpc: '2.0', id: 1, method: 'session/load', params: { sessionId: 's', cwd: '/w' } });
  tap('in', { jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Resource not found' } });
  tap('out', { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's', prompt: [] } });
  tap('in', { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't', kind: 'execute', status: 'in_progress' } } });
  tap('out', { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 2 } });
  tap.close();
  const load = one(otel.spans, 'session/load');
  assert.deepEqual([load.status?.code, load.attributes['rpc.jsonrpc.error_code']], [2, -32002]);
  const turn = one(otel.spans, 'session/prompt');
  assert.ok(turn.events.includes('cancel requested'));
  assert.equal(turn.attributes['acp.unfinished'], true);
  assert.equal(one(otel.spans, 'tool_call').attributes['acp.unfinished'], true);
  assert.deepEqual(otel.spans.filter((s) => s.end === undefined).map((s) => s.name), []);
});
