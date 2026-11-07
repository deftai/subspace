import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelPair, LocalError, ndjson, type FramingDiagnostic } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type AgentTurn } from '@deft-subspace/acp';
import { closeWhen, coalesce, delay, disconnectAfter, faultChannel, injectLines, isUpdate, rechunk } from '@deft-subspace/acp-testkit';
import { byteLink, sleep } from './helpers.ts';

async function chatty(turn: AgentTurn) {
  for (const word of ['one ', 'two ', 'three']) {
    await turn.say(word);
    await sleep(2);
  }
  return 'end_turn';
}

/** A byte link whose agent-to-client direction runs through `faults`. */
function faultyBytes(...faults: Array<() => TransformStream<Uint8Array, Uint8Array>>) {
  const aToB = new TransformStream<Uint8Array, Uint8Array>();
  const bToA = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = faults.reduce((stream, f) => stream.pipeThrough(f()), bToA.readable);
  return { client: { readable: toClient, writable: aToB.writable }, agent: { readable: aToB.readable, writable: bToA.writable } };
}

test('banner lines, odd chunks and merged chunks do not change the turn', async () => {
  for (const faults of [[injectLines(), rechunk(3)], [injectLines(['{"not": "closed'], { every: 2 }), coalesce(5)]] as const) {
    const link = faultyBytes(() => faults[0], () => faults[1]);
    serveAgent(ndjson(link.agent), { name: 'chatty', prompt: chatty });
    const skipped: FramingDiagnostic[] = [];
    const client = await AcpClient.connect(ndjson(link.client, { onDiagnostic: (d) => skipped.push(d) }));
    const result = await (await client.newSession({ cwd: '/tmp' })).prompt('go').done;
    assert.equal(result.text, 'one two three');
    assert.ok(skipped.length >= 2 && skipped.every((d) => d.kind === 'invalid-json'), `skipped ${skipped.length}`);
    await client.close();
  }
});

test('delay holds messages but keeps their order', async () => {
  const [a, b] = channelPair<unknown>();
  serveAgent(b, { name: 'chatty', prompt: chatty });
  const slow = faultChannel(a, { read: [delay((m) => (isUpdate()(m) ? 10 : 0))], write: [delay(5)] });
  const client = await AcpClient.connect(slow);
  const started = Date.now();
  const result = await (await client.newSession({ cwd: '/tmp' })).prompt('go').done;
  assert.equal(result.text, 'one two three');
  assert.ok(Date.now() - started >= 30, 'three updates, 10 ms each');
  await client.close();
});

test('disconnect after N messages: the client sees the connection close', async () => {
  const [a, b] = channelPair<unknown>();
  serveAgent(b, { name: 'chatty', protocols: [1], prompt: chatty });
  // initialize answer, session/new answer, then one update.
  const client = await AcpClient.connect(faultChannel(a, { read: [disconnectAfter(3)] }));
  const turn = (await client.newSession({ cwd: '/tmp' })).prompt('go');
  await assert.rejects(turn.done, (e) => LocalError.is(e, 'closed'));
  assert.equal(turn.text, 'one ');
});

test('close mid-turn, at the first message chunk', async () => {
  for (const protocol of [1, 2] as const) {
    const link = byteLink();
    serveAgent(link.agent, { name: 'chatty', protocols: [protocol], prompt: chatty });
    const cut = faultChannel(link.client, { read: [closeWhen(isUpdate('agent_message_chunk'), { including: false })] });
    const client = await AcpClient.connect(cut);
    const turn = (await client.newSession({ cwd: '/tmp' })).prompt('go');
    await assert.rejects(turn.done, (e) => LocalError.is(e, 'closed'));
    assert.equal(turn.text, '');
  }
});

test('a fault on the writing side: the agent never hears the prompt', async () => {
  const [a, b] = channelPair<unknown>();
  let prompted = false;
  serveAgent(b, { name: 'deaf', prompt: () => void (prompted = true) });
  const client = await AcpClient.connect(faultChannel(a, { write: [disconnectAfter(2)] }));
  const turn = (await client.newSession({ cwd: '/tmp' })).prompt('go');
  await assert.rejects(turn.done, (e) => LocalError.is(e));
  assert.equal(prompted, false);
  await client.close();
});
