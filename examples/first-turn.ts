/**
 * A first turn with a real agent: start Claude (in its ask-first mode),
 * stream the reply, decide its permission questions.
 * @typecheck-only (starts Claude's ACP adapter through npx)
 */
import { start } from '@deft-subspace/acp/node';

const agent = await start('claude', {
  // Required: how to answer the agent's permission questions. Here: reads yes, everything else no.
  onPermission: (request) => (request.toolCall?.kind === 'read' ? 'allow' : 'reject'),
});
try {
  const result = await agent.run('Summarize README.md in one sentence.', {
    onMessage: (delta) => process.stdout.write(delta),
    onToolCall: (call, { created }) => created && console.log(`\n[${call.title}]`),
  });
  console.log(`\n${result.stopReason}, ${result.toolCalls.length} tool call(s)`);
} finally {
  await agent.close(); // or: await using agent = await start(...)  (Node 24+)
}
