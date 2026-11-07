/**
 * A first turn with a real agent: start it, open a session, stream the reply.
 * @typecheck-only (starts Claude's ACP adapter through npx)
 */
import { connectAgent } from '@deft-subspace/acp/node';

const { client, close } = await connectAgent('npx', {
  args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  cwd: process.cwd(),
  workspace: process.cwd(), // serve the agent's file reads, confined here
});
try {
  console.log(`${client.agent.name} speaks ACP v${client.protocol}`);
  const session = await client.newSession({ cwd: process.cwd() });
  const turn = session.prompt('Summarize README.md in one sentence.');
  for await (const event of turn) {
    if (event.type === 'message') process.stdout.write(event.delta);
    if (event.type === 'tool_call') console.log(`\n[${event.toolCall.title}: ${event.toolCall.status}]`);
  }
  const result = await turn.done;
  console.log(`\n${result.stopReason}, ${result.toolCalls.length} tool call(s)`);
} finally {
  await close(); // closes the connection and stops the agent's process group
}
