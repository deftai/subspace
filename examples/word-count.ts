/**
 * Use the tiny agent: start it, ask it about two files, answer its question.
 */
import { start } from '@deft-subspace/acp/node';

const agent = await start(
  { command: process.execPath, args: ['--conditions=subspace-source', 'word-count-agent.ts'] },
  {
    onPermission: (request) => (console.log(`  (agent asks: ${request.title}) yes`), 'allow'),
    onMessage: (delta, { separator }) => process.stdout.write(separator + delta),
  }
);
try {
  for (const file of ['in-process.ts', 'word-count.ts']) {
    await agent.run(file);
    console.log();
  }
} finally {
  await agent.close();
}
