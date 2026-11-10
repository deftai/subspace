/**
 * An agent and a client in one process, joined by an in-memory channel.
 * The quickest way to try the API, and how most tests are written.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();

serveAgent(agentEnd, {
  name: 'echo',
  async prompt(turn) {
    await turn.say(`You said: ${turn.text}`);
    return 'end_turn';
  },
});

const client = await AcpClient.connect(clientEnd);
const session = await client.newSession({ cwd: process.cwd() });
const result = await session.prompt('hello').done;
console.log(result.text); // "You said: hello"
await client.close();
