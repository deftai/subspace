/** `--otlp`: a saved trace's spans, sent to an OpenTelemetry collector over OTLP/HTTP. */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTrace } from '@deft-subspace/kernel';
import { exportTrace } from '@deft-subspace/devtools/otlp';
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace';
import { main } from '../src/cli.ts';

const tracePath = fileURLToPath(new URL('../../testkit/corpus/claude-cancel.trace.jsonl', import.meta.url));
const records = parseTrace(readFileSync(tracePath, 'utf8'));

/** A collector that keeps what it is sent and answers with `status`. */
async function collector(status = 200) {
  const received: Array<{ path: string; type: string; body: Buffer }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', type: String(req.headers['content-type']), body: Buffer.concat(chunks) });
      res.writeHead(status, { 'content-type': 'application/x-protobuf' }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
  return { url, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('exportTrace: the same spans as live, at the recorded times, with the service name', async () => {
  // The in-memory exporter forgets its spans on shutdown: keep them as they come.
  const memory = new InMemorySpanExporter();
  const finished: ReadableSpan[] = [];
  const keeping: SpanExporter = { export: (spans, done) => (finished.push(...spans), memory.export(spans, done)), shutdown: () => memory.shutdown() };
  const { spans } = await exportTrace(records, { exporter: keeping, serviceName: 'replay' });
  assert.equal(spans, finished.length);
  const turn = finished.find((s) => s.name === 'session/prompt')!;
  assert.equal(turn.attributes['acp.stop_reason'], 'cancelled');
  assert.equal(turn.resource.attributes['service.name'], 'replay');
  const header = records[0] as { started: string };
  assert.ok(turn.startTime[0] >= Math.floor(Date.parse(header.started) / 1000), 'recorded time, not now');
  assert.ok(finished.every((s) => !('acp.tool_call.title' in s.attributes)), 'no titles by default');
});

test('subspace trace --otlp <url> posts protobuf spans to the collector; a refusal exits 1', async () => {
  const ok = await collector();
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };
  assert.equal(await main([tracePath, '--otlp', ok.url, '--service', 'corpus'], io), 0, err.join(''));
  await ok.close();
  assert.match(out.join(''), /^sent \d+ spans\n$/);
  assert.equal(ok.received.length, 1, 'one batch');
  assert.equal(ok.received[0]!.path, '/v1/traces');
  assert.equal(ok.received[0]!.type, 'application/x-protobuf');
  // Protobuf keeps strings as they are: the span names and service name are in there.
  const body = ok.received[0]!.body.toString('latin1');
  for (const text of ['session/prompt', 'corpus', 'acp.stop_reason']) assert.ok(body.includes(text), text);

  const refusing = await collector(400);
  assert.equal(await main([tracePath, '--otlp', refusing.url], io), 1);
  await refusing.close();
  assert.match(err.join(''), /Could not send the spans/);
});
