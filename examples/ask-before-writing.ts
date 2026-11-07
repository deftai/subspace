/**
 * Permissions with a real agent: Claude (in its ask-first mode) asks before
 * writing a file; onPermission decides. Run it twice: ALLOW=1 writes, without refuses.
 * @typecheck-only (starts Claude's ACP adapter through npx)
 */
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, turnEnd } from '@deft-subspace/acp/node';

const cwd = await mkdtemp(join(tmpdir(), 'subspace-ask-'));
const allow = process.env.ALLOW === '1';
const agent = await start('claude', {
  cwd,
  onPermission: (request) => {
    console.log(`asked: ${request.title} -> ${allow ? 'allow' : 'reject'}`);
    return allow ? 'allow' : 'reject';
  },
});
try {
  const result = await agent.run('Create a file named hello.txt containing the word hi.', {
    onToolCall: (call, { created }) => created && console.log(`[${call.title}]`),
  });
  // turnEnd: 'refused' when an agent ends a refused turn as "cancelled" (Grok, Codex); Claude
  // finishes the turn normally after a refusal, so it is 'completed' with result.refused counting it.
  console.log(`${turnEnd(result)}, ${result.refused ?? 0} refused; hello.txt ${existsSync(join(cwd, 'hello.txt')) ? 'written' : 'not written'}`);
} finally {
  await agent.close();
}
