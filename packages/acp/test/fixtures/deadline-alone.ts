/**
 * A process with nothing pending but deadlines: an in-process agent that never
 * answers, a prompt with a time limit, and a request with a timeout. Both must
 * be reported before Node exits.
 */
import { channelPair, RpcPeer } from '@deft-subspace/kernel';
import { AcpClient, serveAgent } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, { name: 'silent', prompt: () => new Promise(() => {}) });
const client = await AcpClient.connect(clientEnd);
const session = await client.newSession({ cwd: '/w' });
const turn = await session.prompt('hi', { timeoutMs: 200 }).done;
console.log(`turn: ${turn.stopReason} ${turn.exhausted?.limit}`);
// A peer whose other end never answers (nor reads).
const [, silentEnd] = channelPair<unknown>();
const request = await new RpcPeer(silentEnd)
  .start()
  .request('never', {}, { timeoutMs: 200 })
  .then(
    () => 'answered',
    (error: { kind?: string; name: string }) => error.kind ?? error.name
  );
console.log(`request: ${request}`);
await client.close();
