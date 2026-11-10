/**
 * Typed vendor extensions: names start with "_", as ACP requires. Optional
 * validators check params where they arrive and results where they return.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, extensionRequest, handle, serveAgent } from '@deft-subspace/acp';

const steer = extensionRequest<{ sessionId: string; text: string }, { ok: boolean }>('_acme/steer');

const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'steerable',
  prompt: () => 'end_turn',
  extensions: [handle(steer, ({ text }) => ({ ok: text.length > 0 }))],
});

const client = await AcpClient.connect(clientEnd);
const session = await client.newSession({ cwd: process.cwd() });
console.log(await client.call(steer, { sessionId: session.id, text: 'focus on the tests' })); // { ok: true }
await client.close();
