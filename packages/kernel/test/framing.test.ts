import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ndjsonDecoder, ndjsonEncoder, type FramingDiagnostic } from '@deft-subspace/kernel';
import { merge, rechunk } from '@deft-subspace/kernel/testing';

async function decode(
  chunks: Uint8Array[],
  options: Parameters<typeof ndjsonDecoder>[0] = {},
  fault?: TransformStream<Uint8Array, Uint8Array>
): Promise<unknown[]> {
  let source: ReadableStream<Uint8Array> = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  if (fault) source = source.pipeThrough(fault);
  const out: unknown[] = [];
  for await (const value of source.pipeThrough(ndjsonDecoder(options))) out.push(value);
  return out;
}

const bytes = (text: string) => new TextEncoder().encode(text);

test('keeps a multi-byte character that is split across chunks', async () => {
  const line = bytes('{"text":"héllo 🌍"}\n');
  const split = line.indexOf(0xc3) + 1; // inside é
  assert.deepEqual(await decode([line.slice(0, split), line.slice(split)]), [{ text: 'héllo 🌍' }]);
});

test('decodes the same values byte by byte and with chunks merged', async () => {
  const input = bytes('{"a":1}\n{"b":"ü"}\r\n\n{"c":[1,2,3]}\n');
  const expected = [{ a: 1 }, { b: 'ü' }, { c: [1, 2, 3] }];
  assert.deepEqual(await decode([input], {}, rechunk(1)), expected);
  assert.deepEqual(await decode([input], {}, merge(100)), expected);
});

test('skips and reports lines that are not JSON, and keeps going', async () => {
  const diagnostics: FramingDiagnostic[] = [];
  const out = await decode([bytes('Welcome to Agent v1.2!\n{"ok":true}\n[INFO] ready\n')], {
    onDiagnostic: (d) => diagnostics.push(d),
  });
  assert.deepEqual(out, [{ ok: true }]);
  assert.deepEqual(
    diagnostics.map((d) => [d.kind, d.preview]),
    [
      ['invalid-json', 'Welcome to Agent v1.2!'],
      ['invalid-json', '[INFO] ready'],
    ]
  );
});

test('skips an over-long line without buffering it, then recovers', async () => {
  const diagnostics: FramingDiagnostic[] = [];
  const long = `{"x":"${'a'.repeat(5000)}"}`;
  const out = await decode([bytes(`${long}\n{"after":1}\n`)], { maxLineLength: 1000, onDiagnostic: (d) => diagnostics.push(d) }, rechunk(64));
  assert.deepEqual(out, [{ after: 1 }]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.kind, 'too-large');
});

test('accepts a last line without a newline', async () => {
  assert.deepEqual(await decode([bytes('{"a":1}\n{"b":2}')]), [{ a: 1 }, { b: 2 }]);
});

test('large lines cost linear time, not quadratic', async () => {
  const big = `{"x":"${'z'.repeat(4_000_000)}"}\n`;
  const started = performance.now();
  const out = await decode([bytes(big)], {}, rechunk(4096));
  const ms = performance.now() - started;
  assert.equal((out[0] as { x: string }).x.length, 4_000_000);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

test('encoder writes one line per value and escapes newlines inside strings', async () => {
  const writer = new ReadableStream({
    start(controller) {
      controller.enqueue({ text: 'a\nb' });
      controller.enqueue(0);
      controller.close();
    },
  }).pipeThrough(ndjsonEncoder());
  let text = '';
  for await (const chunk of writer) text += new TextDecoder().decode(chunk);
  assert.equal(text, '{"text":"a\\nb"}\n0\n');
});

test('encoder drops an unserializable value instead of breaking the stream', async () => {
  const errors: unknown[] = [];
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const out = new ReadableStream({
    start(controller) {
      controller.enqueue({ a: 1 });
      controller.enqueue(cycle);
      controller.enqueue({ b: 2 });
      controller.close();
    },
  }).pipeThrough(ndjsonEncoder({ onError: (e) => errors.push(e) }));
  let text = '';
  for await (const chunk of out) text += new TextDecoder().decode(chunk);
  assert.equal(text, '{"a":1}\n{"b":2}\n');
  assert.equal(errors.length, 1);
});
