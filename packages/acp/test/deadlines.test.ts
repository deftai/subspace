/** Deadlines keep the process alive until they fire (Node only: a child process with nothing else pending). */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('a time limit and a request timeout are reported though nothing else keeps Node running', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/deadline-alone.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ['--conditions=subspace-source', fixture], { timeout: 20_000 });
  assert.match(stdout, /^turn: cancelled duration$/m);
  assert.match(stdout, /^request: timeout$/m);
});
