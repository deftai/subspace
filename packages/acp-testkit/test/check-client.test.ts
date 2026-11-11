/**
 * checkClient against our AcpClient (v1 and v2) and against a careless client
 * written with the official @agentclientprotocol/sdk.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
import type { PermissionHandler } from '@deft-subspace/acp';
import type { Channel } from '@deft-subspace/kernel';
import { workspaceFiles } from '@deft-subspace/acp/node';
import { acpClientDriver, checkClient, CLIENT_CHECKS, failures, formatReport, type CheckResult } from '@deft-subspace/acp-testkit';

const summary = (report: CheckResult[]) => report.map((r) => `${r.id}:${r.skipped ? 'skip' : r.pass ? 'pass' : 'fail'}`);

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'deft-testkit-client-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const outsideFile = join(root, 'secret.txt');
  await writeFile(outsideFile, 'secret');
  return { root, cwd, outsideFile };
}

/**
 * A user who allows after a while, unless the turn is cancelled first. The while is long
 * enough that the cancel check's cancel always comes first, even on a busy machine.
 */
const slowUser: PermissionHandler = (_request, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('allow'), 2000);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve('cancelled')), { once: true });
  });

for (const protocol of [1, 2] as const) {
  test(`AcpClient v${protocol} with workspace files passes every check`, async () => {
    const { root, cwd, outsideFile } = await workspace();
    const report = await checkClient(acpClientDriver({ cwd, permissions: slowUser, files: workspaceFiles(cwd) }), { protocol, outsideFile });
    assert.deepEqual(report.map((r) => r.id), Object.keys(CLIENT_CHECKS));
    assert.deepEqual(failures(report), [], formatReport(report));
    assert.ok(report.every((r) => !r.skipped), formatReport(report));
    assert.match(report.find((r) => r.id === 'fs.outside-workspace')!.detail, /refused.*refused.*read_text_file.*refused/);
    assert.equal(existsSync(join(root, 'deft-testkit-outside.txt')), false);
    assert.equal(existsSync(`${cwd}-deft-testkit-outside`), false);
  });
}

test('AcpClient without file access: the fs check is skipped; a reject policy still answers, too soon to test a cancel', async () => {
  const report = await checkClient(acpClientDriver({ permissions: 'reject' }));
  assert.deepEqual(summary(report), [
    'permission.answered:pass',
    'permission.cancelled-on-cancel:skip',
    'fs.outside-workspace:skip',
    'unknown-method:pass',
  ]);
  assert.match(report[0]!.detail, /selected "reject"/);
  assert.match(report[1]!.detail, /before the cancel/);
});

test('a careless official-SDK client fails the checks it breaks, and the files it wrote outside are removed', async () => {
  const { root, cwd } = await workspace();
  const written: string[] = [];
  const report = await checkClient(async (channel) => {
    let sessionId = '';
    const waiting: Array<() => void> = [];
    const connection = officialV1
      .client({ name: 'careless' })
      // Allows once the user cancels the turn (or after a while), as if the cancel did not matter.
      .onRequest('session/request_permission', async () => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          waiting.push(() => (clearTimeout(timer), resolve()));
        });
        return { outcome: { outcome: 'selected', optionId: 'allow' } };
      })
      // Writes anywhere (here: inside the temporary root).
      .onRequest('fs/write_text_file', async ({ params }) => {
        written.push(params.path);
        await mkdir(dirname(params.path), { recursive: true });
        await writeFile(params.path, params.content);
        return {};
      })
      .onRequest('fs/read_text_file', () => ({ content: '' }))
      .onNotification('session/update', () => {})
      .connect(channel as officialV1.Stream);
    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    sessionId = (await connection.agent.request('session/new', { cwd, mcpServers: [] })).sessionId;
    return {
      prompt: (text) => connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
      cancel: async () => {
        await connection.agent.notify('session/cancel', { sessionId });
        for (const allow of waiting.splice(0)) allow();
      },
      close: () => connection.close(),
    };
  });
  assert.deepEqual(summary(report), [
    'permission.answered:pass',
    'permission.cancelled-on-cancel:fail',
    'fs.outside-workspace:fail',
    'unknown-method:pass',
  ]);
  assert.match(report[1]!.detail, /"selected".*session\/cancel sent/);
  assert.deepEqual(written.map((p) => dirname(p) === cwd), [false, false]);
  assert.equal(existsSync(join(root, 'deft-testkit-outside.txt')), false);
  assert.equal(existsSync(`${cwd}-deft-testkit-outside`), false);
});

/** An official-SDK v1 client; `onCancel` is what its driver does when the user cancels. */
function sdkClient(cwd: string, fs: { readTextFile?: boolean; writeTextFile?: boolean }, onCancel: (connection: { agent: { notify(method: string, params: unknown): unknown } }, sessionId: string, pending: Array<() => void>) => unknown) {
  return async (channel: unknown) => {
    let sessionId = '';
    const pending: Array<() => void> = [];
    const connection = officialV1
      .client({ name: 'sdk-client' })
      // Waits for the user, who only ever cancels.
      .onRequest('session/request_permission', () => new Promise((resolve) => pending.push(() => resolve({ outcome: { outcome: 'cancelled' } }))))
      .onRequest('fs/read_text_file', () => {
        throw officialV1.RequestError.invalidParams({}, 'outside the workspace');
      })
      .onNotification('session/update', () => {})
      .connect(channel as officialV1.Stream);
    await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: { fs } });
    sessionId = (await connection.agent.request('session/new', { cwd, mcpServers: [] })).sessionId;
    return {
      prompt: (text: string) => connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
      cancel: () => onCancel(connection, sessionId, pending),
      close: () => connection.close(),
    };
  };
}

test('a client that answers cancelled but never sends session/cancel fails permission.cancelled-on-cancel', async () => {
  const { cwd } = await workspace();
  const report = await checkClient(
    sdkClient(cwd, {}, (_connection, _sessionId, pending) => pending.splice(0).forEach((answer) => answer())),
    { only: ['permission.cancelled-on-cancel'], timeoutMs: 300 }
  );
  assert.deepEqual(summary(report), ['permission.cancelled-on-cancel:fail']);
  assert.match(report[0]!.detail, /session\/cancel not sent/);
});

test('a client that has not read the permission request when it times out fails permission.cancelled-on-cancel', async (t) => {
  // The client stops reading after the tool call, before the permission request, until the request has timed out.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cwd } = await workspace();
  let stalled!: () => void;
  const stall = new Promise<void>((resolve) => (stalled = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const gated = (channel: Channel<unknown>): Channel<unknown> => {
    const reader = channel.readable.getReader();
    let held = false;
    return {
      readable: new ReadableStream({
        async pull(controller) {
          if (held) await released;
          const { done, value } = await reader.read();
          if (done) return controller.close();
          controller.enqueue(value);
          if ((value as { method?: unknown }).method === 'session/update' && !held) {
            held = true;
            stalled();
          }
        },
      }),
      writable: channel.writable,
    };
  };
  const connect = sdkClient(cwd, {}, (connection, sessionId) => connection.agent.notify('session/cancel', { sessionId }));
  const report = checkClient((channel) => connect(gated(channel)), { only: ['permission.cancelled-on-cancel'], timeoutMs: 1000 });
  await stall;
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await report;
  assert.deepEqual(summary(results), ['permission.cancelled-on-cancel:fail'], formatReport(results));
  assert.match(results[0]!.detail, /not answered within 1000 ms/);
});

test('the cancel comes after the client has the permission request', async () => {
  const { cwd } = await workspace();
  let pendingAtCancel = -1;
  const report = await checkClient(
    sdkClient(cwd, {}, (connection, sessionId, pending) => {
      pendingAtCancel = pending.length;
      pending.splice(0).forEach((answer) => answer());
      return connection.agent.notify('session/cancel', { sessionId });
    }),
    { only: ['permission.cancelled-on-cancel'] }
  );
  assert.deepEqual(summary(report), ['permission.cancelled-on-cancel:pass'], formatReport(report));
  assert.equal(pendingAtCancel, 1);
});

test('a client that can only read, with no outsideFile to try, skips the fs check', async () => {
  const { cwd } = await workspace();
  const report = await checkClient(sdkClient(cwd, { readTextFile: true }, () => {}), { only: ['fs.outside-workspace'] });
  assert.deepEqual(summary(report), ['fs.outside-workspace:skip']);
  assert.match(report[0]!.detail, /outsideFile/);
});

test('a client that never connects is one failed check, not a hang', async () => {
  const report = await checkClient(() => new Promise(() => {}), { timeoutMs: 50 });
  assert.deepEqual(summary(report), ['connect:fail']);
});
