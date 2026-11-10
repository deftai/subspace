import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ndjson, RpcPeer } from '@deft-subspace/kernel';
import { spawnProcess, SpawnError } from '@deft-subspace/kernel/node';

const node = process.execPath;

test('a missing program is a SpawnError with a hint', async () => {
  await assert.rejects(spawnProcess('definitely-not-a-real-agent-binary'), (e) => {
    assert.ok(e instanceof SpawnError);
    assert.equal(e.code, 'ENOENT');
    assert.match(e.message, /installed and on PATH/);
    return true;
  });
});

test('a reply written just before exit is not lost', async () => {
  const child = await spawnProcess(node, {
    args: ['-e', `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'hello',params:{last:true}})+'\\n'); process.exit(0)`],
  });
  const peer = new RpcPeer(ndjson(child.channel));
  let got: unknown;
  peer.onNotification('hello', (p) => (got = p)).start();
  await child.ended;
  await peer.closed;
  assert.deepEqual(got, { last: true });
});

test('stop() then closing the channel does not throw (Node 22 Writable.toWeb() bug)', async () => {
  // On Node 22, Writable.toWeb() threw an uncaught TypeError when its stream was closed
  // after the Node stream had already been ended, as stop() does.
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => void uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    for (let i = 0; i < 5; i++) {
      const child = await spawnProcess(node, { args: ['-e', 'setTimeout(() => {}, 5000)'], killGraceMs: 200 });
      const writer = child.channel.writable.getWriter();
      const stopping = child.stop();
      await writer.close().catch(() => {});
      await stopping;
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught, []);
});

test('writing to a process that died rejects the write', async () => {
  const child = await spawnProcess(node, { args: ['-e', 'process.exit(1)'] });
  await child.exited;
  const writer = child.channel.writable.getWriter();
  const big = new Uint8Array(1024 * 1024);
  await assert.rejects(async () => {
    for (let i = 0; i < 8; i++) await writer.write(big);
  });
});

test('stop() ends the whole process group, even a child that ignores SIGTERM', async () => {
  // The leader starts a grandchild that ignores SIGTERM, like `npx some-agent`.
  const script = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
    process.stdout.write(String(g.pid) + '\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const child = await spawnProcess(node, { args: ['-e', script], killGraceMs: 300 });
  const reader = child.channel.readable.getReader();
  const { value } = await reader.read();
  const grandchild = Number(new TextDecoder().decode(value).trim());
  reader.releaseLock();
  assert.ok(grandchild > 0);

  const started = Date.now();
  const info = await child.stop();
  assert.equal(info.signal, 'SIGKILL');
  assert.ok(Date.now() - started < 3000);
  await new Promise((r) => setTimeout(r, 50));
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'grandchild is gone');
});

test('keeps the last stderr output for error messages', async () => {
  const child = await spawnProcess(node, {
    args: ['-e', `console.error('x'.repeat(100)); console.error('fatal: no API key'); process.exit(3)`],
    stderrTailBytes: 64,
  });
  const info = await child.ended;
  assert.equal(info.code, 3);
  assert.match(child.stderrTail(), /fatal: no API key$/);
  assert.ok(child.stderrTail().length <= 64);
});
