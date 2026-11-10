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

for (const protocol of [1, 2] as const) {
  test(`AcpClient v${protocol} with workspace files passes every check`, async () => {
    const { root, cwd, outsideFile } = await workspace();
    const report = await checkClient(acpClientDriver({ cwd, permissions: 'allow', files: workspaceFiles(cwd) }), { protocol, outsideFile });
    assert.deepEqual(report.map((r) => r.id), Object.keys(CLIENT_CHECKS));
    assert.deepEqual(failures(report), [], formatReport(report));
    assert.ok(report.every((r) => !r.skipped), formatReport(report));
    assert.match(report.find((r) => r.id === 'fs.outside-workspace')!.detail, /refused.*refused.*read_text_file.*refused/);
    assert.equal(existsSync(join(root, 'deft-testkit-outside.txt')), false);
    assert.equal(existsSync(`${cwd}-deft-testkit-outside`), false);
  });
}

test('AcpClient without file access: the fs check is skipped; a reject policy still answers', async () => {
  const report = await checkClient(acpClientDriver({ permissions: 'reject' }));
  assert.deepEqual(summary(report), [
    'permission.answered:pass',
    'permission.cancelled-on-cancel:pass',
    'fs.outside-workspace:skip',
    'unknown-method:pass',
  ]);
  assert.match(report[0]!.detail, /selected "reject"/);
});

test('a careless official-SDK client fails the checks it breaks', async () => {
  const { cwd } = await workspace();
  const written: string[] = [];
  const report = await checkClient(async (channel) => {
    let sessionId = '';
    const connection = officialV1
      .client({ name: 'careless' })
      // Always allows, even when the turn is being cancelled.
      .onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }))
      // Writes anywhere (here: only records the path).
      .onRequest('fs/write_text_file', ({ params }) => {
        written.push(params.path);
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
      cancel: () => connection.agent.notify('session/cancel', { sessionId }),
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
});

test('a client that never connects is one failed check, not a hang', async () => {
  const report = await checkClient(() => new Promise(() => {}), { timeoutMs: 50 });
  assert.deepEqual(summary(report), ['connect:fail']);
});
