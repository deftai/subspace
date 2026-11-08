/** OpenTelemetry with the real SDK: one trace across the connection, handlers inside their request's span. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as otel from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, otelTap, serveAgent } from '@deft-subspace/acp';

const exporter = new InMemorySpanExporter();
otel.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
otel.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
otel.trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));

const side = (spans: ReadableSpan[], which: string) => spans.filter((s) => s.attributes['acp.side'] === which);
const find = (spans: ReadableSpan[], name: string) => {
  const found = spans.filter((s) => s.name === name);
  assert.equal(found.length, 1, `one ${name}: ${spans.map((s) => s.name).join(', ')}`);
  return found[0]!;
};
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: with telemetry on both sides, the agent's turn continues the client's trace and its handler runs inside it`, async () => {
    exporter.reset();
    const [agentEnd, clientEnd] = channelPair<unknown>();
    let activeInHandler: string | undefined;
    serveAgent(agentEnd, {
      name: 'traced',
      protocols: [protocol],
      telemetry: otelTap(otel, { attributes: { 'acp.side': 'agent' } }),
      async prompt(turn) {
        activeInHandler = otel.trace.getActiveSpan()?.spanContext().spanId;
        // The agent's own work, as an app would trace it.
        await otel.trace.getTracer('agent app').startActiveSpan('call the model', async (span) => {
          await turn.tool({ title: 'Delete a', kind: 'delete', ask: true }, () => 'x');
          span.end();
        });
        await turn.say('Done.');
      },
    });
    const wire: Array<Record<string, unknown>> = [];
    const client = await AcpClient.connect(clientEnd, {
      permissions: 'allow',
      tap: (direction, message) => void (direction === 'out' && wire.push(message as Record<string, unknown>)),
      telemetry: otelTap(otel, { attributes: { 'acp.side': 'client' } }),
    });
    const session = await client.newSession({ cwd: '/w' });
    await otel.trace.getTracer('client app').startActiveSpan('handle a request', async (span) => {
      await session.prompt('go').done;
      span.end();
    });
    await client.close();

    const spans = exporter.getFinishedSpans();
    const app = find(spans, 'handle a request');
    const clientTurn = find(side(spans, 'client'), 'session/prompt');
    const agentTurn = find(side(spans, 'agent'), 'session/prompt');
    assert.equal(parentOf(clientTurn), app.spanContext().spanId, "the client's turn is under the app's span");
    assert.equal(parentOf(agentTurn), clientTurn.spanContext().spanId, "the agent's turn continues the client's");
    assert.equal(agentTurn.spanContext().traceId, app.spanContext().traceId, 'one trace');
    assert.equal(activeInHandler, agentTurn.spanContext().spanId, 'the prompt handler runs inside its span');

    // The agent's own span, and its question to the client, are inside the turn.
    const work = find(spans, 'call the model');
    assert.equal(parentOf(work), agentTurn.spanContext().spanId);
    const asked = find(side(spans, 'agent'), 'session/request_permission');
    assert.equal(parentOf(asked), work.spanContext().spanId, 'sent from inside the agent app span');
    const answered = find(side(spans, 'client'), 'session/request_permission');
    assert.equal(parentOf(answered), asked.spanContext().spanId, "the client's answer continues the agent's question");

    // On the wire: W3C trace context in _meta, as ACP reserves it.
    const prompt = wire.find((m) => m.method === 'session/prompt')!;
    const meta = (prompt.params as { _meta?: Record<string, unknown> })._meta!;
    assert.match(String(meta.traceparent), /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    assert.ok(String(meta.traceparent).includes(clientTurn.spanContext().spanId));
  });
}

test('without telemetry nothing is added to _meta; a tap alone makes spans but does not propagate', async () => {
  exporter.reset();
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, { name: 'plain', async prompt(turn) { await turn.say('ok'); } });
  const wire: Array<Record<string, unknown>> = [];
  const tap = otelTap(otel);
  const client = await AcpClient.connect(clientEnd, {
    tap: (direction, message) => {
      tap(direction, message);
      if (direction === 'out') wire.push(message as Record<string, unknown>);
    },
  });
  const session = await client.newSession({ cwd: '/w' });
  await session.prompt('go').done;
  await client.close();
  assert.ok(wire.every((m) => !(m.params as { _meta?: unknown } | undefined)?._meta), 'no _meta');
  assert.ok(exporter.getFinishedSpans().some((s) => s.name === 'session/prompt'));
});
