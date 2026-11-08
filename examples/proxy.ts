/**
 * An ACP proxy on the raw agent endpoint: client → proxy → agent. Everything
 * passes through both ways (initialize, sessions, prompts, the agent's
 * permission and file requests, methods neither side knows), and one layer
 * tweaks the agent's messages on the way to the client.
 */
import { cancelRequest, channelPair, RpcPeer, type Channel } from '@deft-subspace/kernel';
import { AcpClient, agentEndpoint, serveAgent, type AgentLayer } from '@deft-subspace/acp';

/** Serve `upstream` (the client side) by forwarding to `downstream` (an agent). */
export function proxy(upstream: Channel<unknown>, downstream: Channel<unknown>, layers: AgentLayer[] = []) {
  // The agent side of the proxy talks to the downstream agent as a raw peer.
  const agent = new RpcPeer(downstream, { name: 'proxy→agent', ...cancelRequest });
  const endpoint = agentEndpoint(upstream, {
    name: 'proxy',
    layers,
    // Client → agent. Passing the signal on sends $/cancel_request downstream when the client cancels.
    request: (call, ctx) => agent.request(call.method, call.params, { signal: ctx.signal }),
    notification: (call) => void agent.notify(call.method, call.params),
  });
  // Agent → client: its requests (permissions, files, terminals, anything) and notifications.
  agent.onRequest('*', (params, ctx) => endpoint.client.request(ctx.method, params, { signal: ctx.signal }));
  agent.onNotification('*', (params, ctx) => {
    if (ctx.method !== '$/cancel_request') void endpoint.client.notify(ctx.method, params);
  });
  agent.start();
  return endpoint;
}

/** A tweak: agent text reaches the client in upper case. */
export const shout: AgentLayer = {
  name: 'shout',
  outbound(call, _ctx, _state, next) {
    const params = call.params as { update?: { sessionUpdate?: string; content?: { type: string; text?: string } } };
    const content = params?.update?.content;
    if (call.method !== 'session/update' || params.update?.sessionUpdate !== 'agent_message_chunk' || content?.type !== 'text') return next();
    return next({ ...call, params: { ...params, update: { ...params.update, content: { ...content, text: content.text?.toUpperCase() } } } });
  },
};

if (import.meta.main) {
  const [clientEnd, proxyUp] = channelPair<unknown>();
  const [proxyDown, agentEnd] = channelPair<unknown>();

  serveAgent(agentEnd, {
    name: 'reader',
    protocols: [1], // client file reads are ACP v1
    async prompt(turn) {
      const { allowed } = await turn.requestPermission({ title: 'Read notes.txt' });
      await turn.say(allowed ? `notes.txt says: ${await turn.readFile('/work/notes.txt')}` : 'not allowed');
      return 'end_turn';
    },
  });
  proxy(proxyUp, proxyDown, [shout]);

  const client = await AcpClient.connect(clientEnd, {
    permissions: 'allow',
    files: { readTextFile: async () => 'hello', writeTextFile: async () => {} },
  });
  const session = await client.newSession({ cwd: '/work' });
  const result = await session.prompt('read my notes').done;
  console.log(client.agent.name, '→', result.text); // reader → NOTES.TXT SAYS: HELLO
  await client.close();
}
