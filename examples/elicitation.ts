/**
 * The agent asks the user a question through the client (form elicitation).
 * An accepted answer that does not fit the agent's schema goes back as a decline.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'asker',
  async prompt(turn) {
    const answer = await turn.elicit({
      message: 'Which branch should I use?',
      requestedSchema: { type: 'object', properties: { branch: { type: 'string', minLength: 1 } }, required: ['branch'] },
    });
    await turn.say(answer.action === 'accept' ? `Using ${String(answer.content?.branch)}` : `No answer (${answer.action})`);
    return 'end_turn';
  },
});

const client = await AcpClient.connect(clientEnd, {
  elicitationModes: ['form'],
  // Show the form to the user; here, answer at once.
  elicitation: async (request) => (request.mode === 'form' ? { action: 'accept', content: { branch: 'main' } } : { action: 'decline' }),
});
const session = await client.newSession({ cwd: process.cwd() });
console.log((await session.prompt('Deploy').done).text); // "Using main"
await client.close();
