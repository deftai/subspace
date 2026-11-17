import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectAgent, insideWorkspace, workspaceFiles } from '@deft-subspace/acp/node';
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

test(
  'workspace files follow a link before the .. after it',
  { skip: process.platform === 'win32' && 'Windows applies `..` to the text before following links' },
  async (t) => {
    // As the OS opens it: alias/../c.txt (alias -> a/b) is a/c.txt, not c.txt.
    const base = await mkdtemp(join(tmpdir(), 'deft-subspace-ws-'));
    try {
      const ws = join(base, 'ws');
      await mkdir(join(ws, 'a', 'b'), { recursive: true });
      await mkdir(join(base, 'outside'));
      await writeFile(join(base, 'secret.txt'), 'secret');
      await writeFile(join(ws, 'c.txt'), 'top');
      await writeFile(join(ws, 'a', 'c.txt'), 'deep');
      try {
        await symlink(join(ws, 'a', 'b'), join(ws, 'alias'), 'dir');
        await symlink(join(base, 'outside'), join(ws, 'up'), 'dir');
        await symlink(base, join(ws, 'a', 'escape'), 'dir');
      } catch (error) {
        t.skip(`cannot create symbolic links here: ${(error as Error).message}`);
        return;
      }
      const files = workspaceFiles(ws);
      const real = await realpath(ws);

      // An existing target: the file the OS opens.
      assert.equal(await readFile(`${ws}/alias/../c.txt`, 'utf8'), 'deep');
      assert.equal(await files.readTextFile({ path: 'alias/../c.txt' }), 'deep');
      assert.equal(await insideWorkspace(ws, 'alias/../c.txt'), join(real, 'a', 'c.txt'));
      // The terminal cwd uses the same resolution.
      assert.equal(await insideWorkspace(ws, 'alias/..'), join(real, 'a'));
      // Lexically outside, but the OS lands inside: allowed.
      assert.equal(await files.readTextFile({ path: 'alias/../../c.txt' }), 'top');

      // A target that does not exist yet, also with `..` after a missing folder.
      await files.writeTextFile({ path: 'alias/../new.txt', content: 'n' });
      assert.equal(await readFile(join(ws, 'a', 'new.txt'), 'utf8'), 'n');
      assert.equal(existsSync(join(ws, 'new.txt')), false);
      await files.writeTextFile({ path: 'alias/../missing/../d.txt', content: 'd' });
      assert.equal(await readFile(join(ws, 'a', 'd.txt'), 'utf8'), 'd');
      assert.equal(await insideWorkspace(ws, 'alias/../missing/x/../../e.txt'), join(real, 'a', 'e.txt'));
      // A link after the missing folder's `..` is still followed, and refused.
      await assert.rejects(files.writeTextFile({ path: 'alias/../missing/../escape/x.txt', content: '' }), /symbolic link/);

      // A link that leads outside, then `..`: outside unless it lands back inside.
      assert.equal(await files.readTextFile({ path: 'up/../ws/c.txt' }), 'top');
      await assert.rejects(files.readTextFile({ path: 'up/../secret.txt' }), /symbolic link/);
      await assert.rejects(files.writeTextFile({ path: 'up/../new.txt', content: '' }), /symbolic link/);
      assert.equal(existsSync(join(base, 'new.txt')), false);
      // Outside by the text and by the OS: the same error as before.
      await assert.rejects(files.readTextFile({ path: '../secret.txt' }), /Path is outside the workspace/);
      // `..` after a file is refused, as the OS does (ENOTDIR), also through a link.
      await assert.rejects(files.readTextFile({ path: 'a/c.txt/../c.txt' }), { code: 'ENOTDIR' });
      await assert.rejects(files.writeTextFile({ path: 'alias/../c.txt/../x.txt', content: '' }), { code: 'ENOTDIR' });
      assert.equal(existsSync(join(ws, 'a', 'x.txt')), false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
);

test('connectAgent: a missing agent binary is a SpawnError with a hint', async () => {
  await assert.rejects(connectAgent('no-such-acp-agent-binary'), (e) => e instanceof SpawnError && /on PATH/.test(e.message));
});

test('connectAgent: an agent that dies during initialize reports its stderr', async () => {
  await assert.rejects(
    connectAgent(process.execPath, { args: ['-e', `console.error('auth: no API key configured'); process.exit(1)`] }),
    (e: Error) => /closed/.test(e.message) && /no API key configured/.test(e.message)
  );
});
