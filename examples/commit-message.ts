/**
 * Recipe: write a commit message for the staged change.
 * @typecheck-only (starts Codex's ACP adapter through npx)
 */
import { execFileSync } from 'node:child_process';
import { run } from '@deft-subspace/acp/node';

const diff = execFileSync('git', ['diff', '--staged'], { encoding: 'utf8' });
if (!diff.trim()) throw new Error('Nothing is staged.');
const { text } = await run('codex', `Write a commit message for this diff: a subject under 60 characters, a blank line, then why. Only the message.\n\n${diff}`, {
  permissions: 'reject', // it needs nothing but the diff
});
console.log(text.trim());
