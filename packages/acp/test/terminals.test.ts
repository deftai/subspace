/**
 * v2 agent terminals (`terminal_update`, `terminal_output_chunk`), from an
 * agent written with the official SDK.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV2 from '@agentclientprotocol/sdk/experimental/v2';
import { AcpClient, terminalText, type TurnEvent } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64');

test('v2 terminals: upserts, chunks split mid-character, snapshot replaces, exit, kept after the turn', async () => {
  const link = byteLink();
  let later!: () => Promise<void>;
  officialV2
    .agent({ name: 'terminals-v2' })
    .onRequest('initialize', () => ({ protocolVersion: 2, info: { name: 'terminals-v2', version: '1' }, capabilities: {}, authMethods: [] }))
    .onRequest('session/new', () => ({ sessionId: 's' }))
    .onRequest('session/prompt', ({ params, client }) => {
      const send = (update: officialV2.SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update });
      const check = Buffer.from('ok ✓\n'); // ✓ is 3 bytes: split it across two chunks
      later = () => send({ sessionUpdate: 'terminal_output_chunk', terminalId: 'term1', data: b64('late\n') });
      setTimeout(async () => {
        await send({ sessionUpdate: 'state_update', state: 'running' });
        // The terminal before the tool call that shows it.
        await send({ sessionUpdate: 'terminal_update', terminalId: 'term1', command: 'npm test', cwd: '/work', size: { cols: 80, rows: 24 } });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call1', title: 'Run tests', kind: 'execute', status: 'in_progress' });
        await send({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 'call1', content: { type: 'terminal', terminalId: 'term1' } });
        await send({ sessionUpdate: 'terminal_output_chunk', terminalId: 'term1', data: b64(check.subarray(0, 4)) });
        await send({ sessionUpdate: 'terminal_output_chunk', terminalId: 'term1', data: b64(check.subarray(4)) });
        // A snapshot replaces what was kept; null clears the size.
        await send({ sessionUpdate: 'terminal_update', terminalId: 'term1', output: { data: b64('all 3 passed\n') }, size: null });
        await send({ sessionUpdate: 'terminal_update', terminalId: 'term1', exitStatus: { exitCode: 0 } });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call1', status: 'completed' });
        await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 5);
      return { messageId: 'u1' };
    })
    .connect(officialV2.ndJsonStream(link.b.writable, link.b.readable));

  const client = await AcpClient.connect(link.client);
  const session = await client.newSession({ cwd: '/work' });
  const turn = session.prompt('run the tests');
  const terminalEvents: Array<Extract<TurnEvent, { type: 'terminal' }>> = [];
  for await (const event of turn) if (event.type === 'terminal') terminalEvents.push(event);
  const result = await turn.done;

  assert.deepEqual(result.toolCalls[0]?.content, [{ type: 'terminal', terminalId: 'term1' }]);
  assert.equal(terminalEvents.length, 5);
  const [first, chunk1, chunk2, snapshot, exit] = terminalEvents;
  assert.deepEqual({ ...first!.terminal, output: terminalText(first!.terminal) }, {
    id: 'term1', command: 'npm test', cwd: '/work', size: { cols: 80, rows: 24 }, output: '',
  });
  // Each chunk decoded on its own; together they make whole text.
  assert.equal(chunk1!.appended?.length, 4);
  assert.equal(terminalText(chunk2!.terminal), 'ok ✓\n');
  assert.equal(chunk2!.replaced, false);
  assert.equal(snapshot!.replaced, true);
  assert.equal(terminalText(snapshot!.terminal), 'all 3 passed\n');
  assert.equal(snapshot!.terminal.size, undefined);
  assert.deepEqual(exit!.terminal.exitStatus, { exitCode: 0 });
  // Events carry snapshots: the first is unchanged by later updates.
  assert.equal(terminalText(first!.terminal), '');

  // The session keeps the terminal after the turn, and output that arrives later.
  const seen: TurnEvent[] = [];
  session.onIdleUpdate((event) => seen.push(event));
  await later();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(terminalText(session.terminals.get('term1')!), 'all 3 passed\nlate\n');
  assert.equal(seen.filter((e) => e.type === 'terminal').length, 1);
  assert.equal(session.terminals.all.length, 1);
  await client.close();
});
