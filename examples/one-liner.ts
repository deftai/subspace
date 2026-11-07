/**
 * One prompt, one line: start an agent, run the prompt, stop the agent.
 * @typecheck-only (starts Codex's ACP adapter through npx)
 */
import { run } from '@deft-subspace/acp/node';

const { text } = await run('codex', 'What does this repository do? Two sentences.', {
  permissions: 'reject', // read-only question: refuse anything else it asks
  onMessage: (delta, { separator }) => process.stdout.write(separator + delta),
});
console.log(`\n(${text.length} characters)`);
