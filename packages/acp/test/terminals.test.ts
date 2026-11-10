/**
 * Agent terminals from agents written with the official SDK: v2's
 * `terminal_update` and `terminal_output_chunk`, and v1's terminal extension
 * (`_meta.terminal_info`, `terminal_output`, `terminal_output_delta`,
 * `terminal_exit`), as claude-agent-acp and codex-acp send it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
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

/** A v1 agent that reports a command as claude-agent-acp does, and records the client's terminal extension. */
function v1TerminalAgent(link: ReturnType<typeof byteLink>, seen: { meta?: unknown }) {
  const command = 'make test';
  const ref = { terminal_id: 'toolu_1' };
  officialV1
    .agent({ name: 'terminals-v1' })
    .onRequest('initialize', ({ params }) => {
      seen.meta = (params.clientCapabilities as { _meta?: unknown } | undefined)?._meta;
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
    })
    .onRequest('session/new', () => ({ sessionId: 's' }))
    .onRequest('session/prompt', async ({ params, client }) => {
      const send = (update: Record<string, unknown>) =>
        client.notify('session/update', { sessionId: params.sessionId, update } as never);
      await send({
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_1',
        title: command,
        kind: 'execute',
        status: 'pending',
        rawInput: { command },
        content: [{ type: 'terminal', terminalId: 'toolu_1' }],
        _meta: { terminal_info: ref },
      });
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', _meta: { terminal_output_delta: { ...ref, data: 'line1\n' } } });
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', _meta: { terminal_output_delta: { ...ref, data: 'line2 ✓\n' } } });
      // The result: a snapshot replaces what streamed, then the exit.
      await send({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_1',
        status: 'completed',
        _meta: { terminal_output: { ...ref, data: 'line1\nline2 ✓' }, terminal_exit: { ...ref, exit_code: 0, signal: null } },
      });
      return { stopReason: 'end_turn' };
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
}

test('v1 agent terminals: the terminal extension is advertised and becomes the same terminal events as v2', async () => {
  const link = byteLink();
  const seen: { meta?: unknown } = {};
  v1TerminalAgent(link, seen);
  const client = await AcpClient.connect(link.client);
  assert.equal(client.protocol, 1);
  assert.deepEqual(seen.meta, { terminal_output: true, terminal_output_delta: true });

  const session = await client.newSession({ cwd: '/work' });
  const turn = session.prompt('run the tests');
  const order: string[] = [];
  const terminalEvents: Array<Extract<TurnEvent, { type: 'terminal' }>> = [];
  for await (const event of turn) {
    if (event.type === 'terminal') {
      terminalEvents.push(event);
      order.push('terminal');
    } else if (event.type === 'tool_call') order.push('tool_call');
  }
  const result = await turn.done;

  // The terminal is known before the tool call that shows it.
  assert.deepEqual(order.slice(0, 2), ['terminal', 'tool_call']);
  assert.deepEqual(result.toolCalls[0]?.content, [{ type: 'terminal', terminalId: 'toolu_1' }]);
  const [first, chunk1, chunk2, snapshot, exit] = terminalEvents;
  assert.equal(terminalEvents.length, 5);
  assert.equal(first!.terminal.command, 'make test');
  assert.equal(terminalText(first!.terminal), '');
  assert.equal(new TextDecoder().decode(chunk1!.appended), 'line1\n');
  assert.equal(terminalText(chunk2!.terminal), 'line1\nline2 ✓\n');
  assert.equal(snapshot!.replaced, true);
  assert.equal(terminalText(snapshot!.terminal), 'line1\nline2 ✓');
  assert.equal(snapshot!.terminal.exitStatus, undefined);
  assert.deepEqual(exit!.terminal.exitStatus, { exitCode: 0 });
  assert.equal(terminalText(session.terminals.get('toolu_1')!), 'line1\nline2 ✓');
  await client.close();
});

test('v1 agent terminals: agentTerminals false advertises no terminal extension', async () => {
  const link = byteLink();
  const seen: { meta?: unknown } = {};
  v1TerminalAgent(link, seen);
  const client = await AcpClient.connect(link.client, { agentTerminals: false });
  assert.equal(seen.meta, undefined);
  await client.close();
});
