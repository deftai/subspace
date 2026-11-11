/**
 * Use an agent from a script: npm start -- "What does this project do?"
 * Change the agent (claude, codex, grok, gemini, opencode) and the permission rules below.
 */
import { askInTerminal, firstOf, readOnly, start, terminal } from '@deft-subspace/acp/node';

const prompt = process.argv.slice(2).join(' ') || 'What does this project do? Two sentences.';

const agent = await start('claude', {
  ...terminal(), // streamed text, tool calls, permission answers
  onPermission: firstOf(readOnly, askInTerminal()), // reads yes; ask about the rest
});
try {
  await agent.run(prompt);
  console.log();
} finally {
  await agent.close();
}
