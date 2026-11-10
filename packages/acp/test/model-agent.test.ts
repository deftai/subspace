/** modelAgent() with a scripted model; tool() with useTool() and client.serveTools(). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { channelPair } from '@deft-subspace/kernel';
import {
  AcpClient,
  modelAgent,
  readOnly,
  serveAgent,
  tool,
  type ModelAdapter,
  type ModelInput,
  type ModelReply,
} from '@deft-subspace/acp';

type Step = (input: ModelInput, s: { onText(d: string): unknown; onThinking(d: string): unknown; signal: AbortSignal }) => Promise<ModelReply> | ModelReply;

/** A model that plays `steps` in order, recording what it was sent. */
function scripted(steps: Step[]) {
  const sent: ModelInput[] = [];
  const setups: unknown[] = [];
  const model: ModelAdapter = {
    conversation: (setup) => {
      setups.push(setup);
      let i = 0;
      return {
        send: async (input, stream) => {
          sent.push(input);
          const step = steps[i++];
          if (!step) throw new Error('model script ran out');
          return step(input, stream);
        },
      };
    },
  };
  return { model, sent, setups };
}

const listFiles = tool({
  description: 'List files',
  schema: z.object({ path: z.string() }),
  input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  kind: 'read',
  title: ({ path }: { path: string }) => `List ${path}`,
  run: ({ path }: { path: string }) => [`${path}/a.ts`, `${path}/b.ts`],
});
const remove = tool({ description: 'Delete a file', kind: 'delete', ask: true, run: () => 'deleted' });

test('modelAgent: streams text and thinking, runs tools (checked, shown, asked), sends results back', async () => {
  const { model, sent, setups } = scripted([
    async (_input, s) => {
      await s.onThinking('Look first.');
      await s.onText('Looking.');
      return { stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'listFiles', input: { path: 'src' } }, { id: 'c2', name: 'listFiles', input: { path: 3 } }, { id: 'c3', name: 'nope', input: {} }] };
    },
    async (_input, s) => {
      await s.onText('Deleting.');
      return { stopReason: 'tool_use', toolCalls: [{ id: 'c4', name: 'remove', input: {} }] };
    },
    async (_input, s) => {
      await s.onText('Done.');
      return { stopReason: 'end_turn', toolCalls: [] };
    },
  ]);
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, modelAgent({ name: 'helper', model, system: ({ cwd }) => `Work in ${cwd}.`, tools: { listFiles, remove } }));
  const client = await AcpClient.connect(clientEnd, { onPermission: 'reject' });
  const session = await client.newSession({ cwd: '/repo' });
  const thoughts: string[] = [];
  const result = await session.prompt('tidy src', { onThought: (d) => void thoughts.push(d) }).done;

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.text, 'Looking.\n\nDeleting.\n\nDone.');
  assert.deepEqual(thoughts, ['Look first.']);
  assert.deepEqual((setups[0] as { system: string }).system, 'Work in /repo.');
  assert.deepEqual((setups[0] as { tools: Array<{ name: string; validated: boolean }> }).tools.map((t) => [t.name, t.validated]), [['listFiles', true], ['remove', false]]);
  // Shown in the client with the tool's title and kind; the refused one failed.
  assert.deepEqual(result.toolCalls.map((c) => [c.title, c.kind, c.status]), [['List src', 'read', 'completed'], ['remove', 'delete', 'failed']]);
  // What the model got back.
  const first = sent[1] as Extract<ModelInput, { toolResults: unknown }>;
  assert.equal(first.toolResults[0]!.content, JSON.stringify(['src/a.ts', 'src/b.ts'], null, 2));
  assert.match(first.toolResults[1]!.content, /Invalid input: path: /);
  assert.equal(first.toolResults[1]!.isError, true);
  assert.equal(first.toolResults[2]!.content, 'There is no tool named nope.');
  const second = sent[2] as Extract<ModelInput, { toolResults: unknown }>;
  assert.deepEqual(second.toolResults, [{ id: 'c4', content: 'The user did not allow this tool call.', isError: true }]);
  await client.close();
});

test('modelAgent: maxSteps stops a looping model; a cancel stops it', async () => {
  const loop: Step = () => ({ stopReason: 'tool_use', toolCalls: [{ id: 'x', name: 'listFiles', input: { path: '.' } }] });
  const { model } = scripted([loop, loop, loop]);
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, modelAgent({ name: 'loopy', model, tools: { listFiles }, maxSteps: 2 }));
  const client = await AcpClient.connect(clientEnd, { onPermission: 'allow' });
  const session = await client.newSession({ cwd: '/' });
  assert.equal((await session.prompt('go').done).stopReason, 'max_turn_requests');

  const slow = scripted([(_i, s) => new Promise((resolve) => s.signal.addEventListener('abort', () => resolve({ stopReason: 'cancelled', toolCalls: [] })))]);
  const [a2, c2] = channelPair<unknown>();
  serveAgent(a2, modelAgent({ name: 'slow', model: slow.model }));
  const client2 = await AcpClient.connect(c2, { onPermission: 'allow' });
  const turn = (await client2.newSession({ cwd: '/' })).prompt('go');
  setTimeout(() => void turn.cancel(), 20);
  assert.equal((await turn.done).stopReason, 'cancelled');
  await client.close();
  await client2.close();
});

test('turn.useTool() runs a defined tool as a step; client.serveTools() serves tools without an MCP handler', async () => {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const seen: unknown[] = [];
  serveAgent(agentEnd, {
    name: 'user',
    mcpTransports: ['acp'],
    async prompt(turn) {
      const files = await turn.useTool(listFiles, { path: 'lib' }, 'listFiles');
      seen.push(files);
      const editor = turn.mcp('editor');
      seen.push((await editor.listTools()).map((t) => [t.name, (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint ?? false]));
      seen.push(await editor.callTool('openBuffers', {}));
      seen.push(await editor.callTool('listFiles', { path: 7 }));
      seen.push(await editor.callTool('broken', {}));
      seen.push((await editor.discover()).supportedVersions);
    },
  });
  const client = await AcpClient.connect(clientEnd, { onPermission: 'allow' });
  const editor = client.serveTools({
    name: 'editor',
    tools: {
      openBuffers: tool({ description: 'Open buffers', kind: 'read', run: () => ({ buffers: ['README.md'] }) }),
      listFiles,
      broken: tool({ description: 'Fails', run: () => { throw new Error('disk on fire'); } }),
    },
  });
  const session = await client.newSession({ cwd: '/', mcpServers: [editor] });
  const result = await session.prompt('go').done;
  assert.deepEqual(result.toolCalls.map((c) => [c.title, c.status]), [['List lib', 'completed']]);
  assert.deepEqual(seen[0], ['lib/a.ts', 'lib/b.ts']);
  assert.deepEqual(seen[1], [['openBuffers', true], ['listFiles', true], ['broken', false]]);
  assert.deepEqual(seen[2], { resultType: 'complete', content: [{ type: 'text', text: '{\n  "buffers": [\n    "README.md"\n  ]\n}' }], structuredContent: { buffers: ['README.md'] }, isError: false });
  assert.equal((seen[3] as { isError: boolean }).isError, true);
  assert.deepEqual(seen[4], { resultType: 'complete', content: [{ type: 'text', text: 'disk on fire' }], isError: true });
  assert.deepEqual(seen[5], ['2026-07-28']);
  await client.close();
});

test("client.serveTools(): a tool with ask runs only when the client's permission policy allows it", async () => {
  const run = async (onPermission: 'allow' | 'reject' | ((r: { title: string }) => 'allow' | 'reject')) => {
    const [agentEnd, clientEnd] = channelPair<unknown>();
    const seen: unknown[] = [];
    let ran = 0;
    serveAgent(agentEnd, {
      name: 'user',
      mcpTransports: ['acp'],
      async prompt(turn) {
        seen.push(await turn.mcp('editor').callTool('wipe', {}));
      },
    });
    const client = await AcpClient.connect(clientEnd, { onPermission });
    const editor = client.serveTools({
      name: 'editor',
      tools: { wipe: tool({ description: 'Wipe the buffer', kind: 'delete', ask: 'Wipe the buffer?', run: () => `wiped ${++ran}` }) },
    });
    const session = await client.newSession({ cwd: '/', mcpServers: [editor] });
    await session.prompt('go').done;
    await client.close();
    return { result: seen[0] as { content: Array<{ text: string }>; isError: boolean }, ran };
  };
  const refused = await run('reject');
  assert.equal(refused.ran, 0);
  assert.deepEqual([refused.result.isError, refused.result.content[0]!.text], [true, 'Not allowed']);
  const titles: string[] = [];
  const allowed = await run((r) => (titles.push(r.title), 'allow'));
  assert.equal(allowed.ran, 1);
  assert.deepEqual([allowed.result.isError, allowed.result.content[0]!.text], [false, 'wiped 1']);
  assert.deepEqual(titles, ['Wipe the buffer?']);
});

test('client.serveTools(): the ask question carries the tool, so readOnly and path rules apply to it', async () => {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  const seen: Array<{ isError: boolean }> = [];
  serveAgent(agentEnd, {
    name: 'user',
    mcpTransports: ['acp'],
    async prompt(turn) {
      const editor = turn.mcp('editor');
      seen.push((await editor.callTool('peek', { path: 'notes.md' })) as { isError: boolean });
      seen.push((await editor.callTool('wipe', { path: 'notes.md' })) as { isError: boolean });
    },
  });
  const asked: unknown[] = [];
  const client = await AcpClient.connect(clientEnd, {
    onPermission: (request) => {
      asked.push({ kind: request.toolCall?.kind, name: request.toolCall?.name, input: request.toolCall?.rawInput });
      return readOnly(request, new AbortController().signal);
    },
  });
  const path = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const editor = client.serveTools({
    name: 'editor',
    tools: {
      peek: tool({ description: 'Read a file', kind: 'read', ask: true, input: path, run: () => 'contents' }),
      wipe: tool({ description: 'Delete a file', kind: 'delete', ask: true, input: path, run: () => 'gone' }),
    },
  });
  const session = await client.newSession({ cwd: '/', mcpServers: [editor] });
  await session.prompt('go').done;
  await client.close();
  assert.deepEqual(seen.map((r) => r.isError), [false, true]);
  assert.deepEqual(asked, [
    { kind: 'read', name: 'peek', input: { path: 'notes.md' } },
    { kind: 'delete', name: 'wipe', input: { path: 'notes.md' } },
  ]);
});
