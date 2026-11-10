import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectAgent, workspaceFiles } from '@deft-subspace/acp/node';
import { SpawnError } from '@deft-subspace/kernel/node';

test('workspace files stay inside the workspace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'deft-subspace-ws-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(ws);
    await writeFile(join(base, 'secret.txt'), 'secret');
    await writeFile(join(ws, 'a.txt'), 'one\ntwo\nthree');
    await symlink(base, join(ws, 'out'));
    const files = workspaceFiles(ws);
    assert.equal(await files.readTextFile({ path: 'a.txt', line: 2, limit: 1 }), 'two');
    await files.writeTextFile({ path: 'new/b.txt', content: 'b' });
    assert.equal(await readFile(join(ws, 'new', 'b.txt'), 'utf8'), 'b');
    await assert.rejects(files.readTextFile({ path: `${ws}/../secret.txt` }), /outside the workspace/);
    await assert.rejects(files.readTextFile({ path: 'out/secret.txt' }), /symbolic link/);
    await assert.rejects(files.writeTextFile({ path: 'out/x.txt', content: '' }), /symbolic link/);
    assert.equal(await files.readTextFile({ path: '..notes.txt' }).catch((e) => e.code), 'ENOENT');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('connectAgent: a missing agent binary is a SpawnError with a hint', async () => {
  await assert.rejects(connectAgent('no-such-acp-agent-binary'), (e) => e instanceof SpawnError && /on PATH/.test(e.message));
});

test('connectAgent: an agent that dies during initialize reports its stderr', async () => {
  await assert.rejects(
    connectAgent(process.execPath, { args: ['-e', `console.error('auth: no API key configured'); process.exit(1)`] }),
    (e: Error) => /closed/.test(e.message) && /no API key configured/.test(e.message)
  );
});
