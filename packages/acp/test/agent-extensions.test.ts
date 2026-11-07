import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcPeer } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type ProtocolVersion } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: pipeline-shaped tool updates, client calls, capabilities`, async () => {
    const link = byteLink();
    let seenCaps: Record<string, unknown> | undefined;
    serveAgent(link.agent, {
      name: 'pipeline',
      protocols: [protocol as ProtocolVersion],
      capabilities: { promptCapabilities: { image: false } },
      newSession: ({ params }) => ({ sessionId: `s-${String(params.cwd).length}` }),
      async prompt(turn) {
        seenCaps = turn.clientCapabilities;
        await turn.toolCallUpdate({ toolCallId: 'p1', title: 'Read a.txt', kind: 'read', status: 'pending' }, { create: true });
        const file = await turn.request<{ content: string }>('fs/read_text_file', { sessionId: turn.sessionId, path: 'a.txt' });
        await turn.toolCallUpdate({ toolCallId: 'p1', status: 'completed', rawOutput: file });
        await turn.sendUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] });
        await turn.say(file.content);
        return 'end_turn';
      },
    });
    const client = await AcpClient.connect(link.client, {
      files: { readTextFile: async () => 'hello file', writeTextFile: async () => {} },
    });
    assert.equal(client.protocol, protocol);
    if (protocol === 1) assert.deepEqual((client.capabilities as { promptCapabilities?: unknown }).promptCapabilities, { image: false });
    const session = await client.newSession({ cwd: '/tmp' });
    assert.equal(session.id, 's-4');
    const turn = session.prompt('read it');
    const result = await turn.done;
    assert.equal(result.text, 'hello file');
    assert.deepEqual(result.toolCalls.map((c) => [c.title, c.status]), [['Read a.txt', 'completed']]);
    assert.ok(turn.history.some((e) => e.type === 'update' && e.sessionUpdate === 'available_commands_update'));
    if (protocol === 1) assert.deepEqual((seenCaps as { fs?: unknown }).fs, { readTextFile: true, writeTextFile: true });
    await client.close();
  });
}

test('extra methods are served before the first message', async () => {
  const link = byteLink();
  serveAgent(link.agent, {
    name: 'ext',
    prompt: () => 'end_turn',
    methods: { '_bridge/ping': (params: { n: number }) => ({ pong: params.n + 1 }) },
  });
  const peer = new RpcPeer(link.client).start();
  assert.deepEqual(await peer.request('_bridge/ping', { n: 1 }), { pong: 2 });
  await peer.close();
});
