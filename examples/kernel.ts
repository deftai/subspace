/**
 * The kernel on its own: a JSON-RPC peer over any channel, with timeouts and
 * cancellation. No ACP involved.
 */
import { cancelRequest, channelPair, RpcPeer } from '@deft-subspace/kernel';

const [a, b] = channelPair<unknown>();
const server = new RpcPeer(b, { name: 'server', ...cancelRequest });
server.onRequest('add', (params: { x: number; y: number }) => params.x + params.y);
server.onRequest('slow', (_params, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('stopped'))));
server.start();

// cancelRequest: send and honour $/cancel_request, as ACP does.
const client = new RpcPeer(a, { name: 'client', ...cancelRequest }).start();
console.log(await client.request('add', { x: 2, y: 3 })); // 5
// Cancel a request with an AbortSignal; the other side's handler sees its own signal fire.
// (Or pass { timeoutMs } to give up after a deadline.)
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);
await client.request('slow', {}, { signal: controller.signal }).catch((error) => console.log(error.message)); // client: slow aborted
await client.close();
await server.close();
