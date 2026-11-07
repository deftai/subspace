/**
 * Handler options: callbacks per event kind instead of a for-await loop.
 * `done` settles after they ran; a handler that throws cancels the turn.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'helper',
  async prompt(turn) {
    await turn.think('Checking the tests first.');
    const output = await turn.tool({ title: 'npm test', kind: 'execute', ask: 'Run npm test?' }, () => '12 passed');
    await turn.say(`All good: ${output}.`);
  },
});

const client = await AcpClient.connect(clientEnd, {
  // Defaults for every turn; a prompt's own handlers replace them one by one.
  handlers: { onThought: (delta) => console.log(`(thinking) ${delta}`) },
});
const session = await client.newSession({ cwd: process.cwd() });
const result = await session.prompt('Are the tests passing?', {
  onMessage: (delta, { separator }) => process.stdout.write(separator + delta),
  onToolCall: (call) => console.log(`[${call.title}: ${call.status}]`),
  onPermission: (request) => (request.title.startsWith('Run npm test') ? 'allow' : 'reject'),
}).done;
console.log(`\n${result.stopReason}`);
await client.close();
