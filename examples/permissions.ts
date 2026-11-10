/**
 * Answering an agent's permission questions. The default is 'reject':
 * nothing is allowed unless you say so.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type PermissionHandler } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'careful',
  async prompt(turn) {
    const call = await turn.toolCall({ title: 'Delete build/', kind: 'delete' });
    const answer = await turn.requestPermission({ title: 'Delete build/?', toolCallId: call.id });
    if (!answer.allowed) {
      await call.fail();
      await turn.say('Left build/ alone.');
      return 'end_turn';
    }
    await call.complete();
    await turn.say('Deleted build/.');
    return 'end_turn';
  },
});

// Decide each question; here, allow reads and refuse everything else.
const permissions: PermissionHandler = (request) => (request.toolCall?.kind === 'read' ? 'allow' : 'reject');

const client = await AcpClient.connect(clientEnd, { permissions });
const session = await client.newSession({ cwd: process.cwd() });
const turn = session.prompt('Clean up');
for await (const event of turn) {
  if (event.type === 'permission') console.log(`${event.request.title} -> ${event.outcome.outcome === 'selected' && event.outcome.allowed ? 'allowed' : 'refused'}`);
}
console.log((await turn.done).text); // "Left build/ alone."
await client.close();
