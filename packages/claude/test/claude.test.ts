/**
 * The Claude adapter against a fake SDK client (no API calls): request
 * shape, streaming, the tool loop, pause_turn, refusals and truncation, and
 * unanswered tool calls. Then end to end through modelAgent and AcpClient.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, modelAgent, serveAgent, tool } from '@deft-subspace/acp';
import { claude, claudeContent } from '@deft-subspace/claude';

type Reply = { text?: string; thinking?: string; content: unknown[]; stop_reason: string };

/** A client whose beta.messages.stream plays `replies` in order and records every request. */
function fakeClient(replies: Reply[]) {
  const requests: Array<{ params: Record<string, any>; options: { signal?: AbortSignal } }> = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, any>, options: { signal?: AbortSignal }) => {
          // Copy messages: the adapter keeps appending to the same array.
          requests.push({ params: { ...params, messages: structuredClone(params.messages) }, options });
          const reply = replies.shift();
          if (!reply) throw new Error('no reply scripted');
          const handlers: Record<string, (d: string) => void> = {};
          return {
            on(event: string, handler: (d: string) => void) {
              handlers[event] = handler;
              return this;
            },
            async finalMessage() {
              if (reply.thinking) handlers.thinking?.(reply.thinking);
              if (reply.text) handlers.text?.(reply.text);
              return { content: reply.content, stop_reason: reply.stop_reason };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const listFiles = tool({
  description: 'List files',
  input: { properties: { path: { type: 'string' } }, required: ['path'] },
  kind: 'read',
  run: ({ path }: { path: string }) => `${path}/a.ts`,
});

test('request shape: Opus 5.5, adaptive thinking summarized, effort, fallbacks, tools; content conversion', async () => {
  const { client, requests } = fakeClient([{ text: 'Hi', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }]);
  const conversation = claude({ client }).conversation({ system: 'Be terse.', tools: [{ name: 'listFiles', description: 'List files', inputSchema: { properties: {} }, validated: true }], cwd: '/' });
  const texts: string[] = [];
  const reply = await conversation.send({ prompt: [{ type: 'text', text: 'hello' }] }, { onText: (d) => texts.push(d), onThinking: () => {}, signal: new AbortController().signal });
  assert.deepEqual(reply, { stopReason: 'end_turn', toolCalls: [] });
  assert.deepEqual(texts, ['Hi']);
  const { params } = requests[0]!;
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 64000);
  assert.deepEqual(params.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(params.output_config, { effort: 'high' });
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  assert.equal(params.system, 'Be terse.');
  assert.deepEqual(params.tools, [{ name: 'listFiles', description: 'List files', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true }]);
  assert.equal(claude({ client, fallbacks: false }) !== undefined, true);
  assert.deepEqual(
    claudeContent([
      { type: 'text', text: 'Look' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' } as never,
      { type: 'resource', resource: { uri: 'file:///w/a.md', text: '# A' } } as never,
    ]),
    [
      { type: 'text', text: 'Look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: '/w/a.md:\n\n```\n# A\n```' },
    ]
  );
});

test('the loop: pause_turn continues; tool results go back in one message; truncated or refused turns run no tools and their ids get error results next time', async () => {
  const { client, requests } = fakeClient([
    { content: [{ type: 'text', text: 'part' }], stop_reason: 'pause_turn' },
    { content: [{ type: 'tool_use', id: 't1', name: 'listFiles', input: { path: 'src' } }, { type: 'tool_use', id: 't2', name: 'listFiles', input: { path: 'lib' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'tool_use', id: 't3', name: 'listFiles', input: { path: 'x' } }], stop_reason: 'max_tokens' },
    { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
  ]);
  const conversation = claude({ client }).conversation({ tools: [], cwd: '/' });
  const s = { onText: () => {}, onThinking: () => {}, signal: new AbortController().signal };
  const first = await conversation.send({ prompt: [{ type: 'text', text: 'go' }] }, s);
  assert.deepEqual(first.toolCalls.map((c) => c.id), ['t1', 't2']);
  assert.equal(requests.length, 2, 'pause_turn was continued');
  const truncated = await conversation.send({ toolResults: [{ id: 't1', content: 'a' }, { id: 't2', content: 'b', isError: true }] }, s);
  assert.deepEqual(truncated, { stopReason: 'max_tokens', toolCalls: [] });
  assert.deepEqual(requests[2]!.params.messages.at(-1), {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'a' },
      { type: 'tool_result', tool_use_id: 't2', content: 'b', is_error: true },
    ],
  });
  await conversation.send({ prompt: [{ type: 'text', text: 'again' }] }, s);
  // t3 was never run: it gets an error result before the new prompt.
  assert.deepEqual(requests[3]!.params.messages.at(-1).content, [
    { type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Not run: the turn ended first.' },
    { type: 'text', text: 'again' },
  ]);
  // Append-only: every assistant turn is kept whole.
  assert.deepEqual(requests[3]!.params.messages.filter((m: { role: string }) => m.role === 'assistant').length, 3, 'append-only: pause, tool use and the truncated turn, all kept');
});

test('a prompt that carries results of tools that ran: real results first, "Not run" only for the rest, then the prompt', async () => {
  const { client, requests } = fakeClient([
    { content: [{ type: 'tool_use', id: 'r1', name: 'listFiles', input: {} }, { type: 'tool_use', id: 'r2', name: 'listFiles', input: {} }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
  ]);
  const conversation = claude({ client }).conversation({ tools: [], cwd: '/' });
  const s = { onText: () => {}, onThinking: () => {}, signal: new AbortController().signal };
  await conversation.send({ prompt: [{ type: 'text', text: 'go' }] }, s);
  await conversation.send({ prompt: [{ type: 'text', text: 'next' }], toolResults: [{ id: 'r1', content: 'a.ts' }] }, s);
  assert.deepEqual(requests[1]!.params.messages.at(-1).content, [
    { type: 'tool_result', tool_use_id: 'r2', is_error: true, content: 'Not run: the turn ended first.' },
    { type: 'tool_result', tool_use_id: 'r1', content: 'a.ts' },
    { type: 'text', text: 'next' },
  ]);
});

test('end to end: modelAgent with claude() and an ACP client', async () => {
  const { client: anthropic } = fakeClient([
    { thinking: 'Check the files.', text: 'Looking.', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'u1', name: 'listFiles', input: { path: 'src' } }], stop_reason: 'tool_use' },
    { text: 'There is one file.', content: [{ type: 'text', text: 'There is one file.' }], stop_reason: 'end_turn' },
  ]);
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, modelAgent({ name: 'claude-helper', model: claude({ client: anthropic }), tools: { listFiles } }));
  const client = await AcpClient.connect(clientEnd, { onPermission: 'allow' });
  const session = await client.newSession({ cwd: '/repo' });
  const thoughts: string[] = [];
  const result = await session.prompt('what is in src?', { onThought: (d) => void thoughts.push(d) }).done;
  assert.equal(result.text, 'Looking.\n\nThere is one file.');
  assert.deepEqual(thoughts, ['Check the files.']);
  assert.deepEqual(result.toolCalls.map((c) => [c.title, c.status]), [['listFiles', 'completed']]);
  await client.close();
});

test('an API error ends the turn with one readable line: status, message, login hint, request id', async () => {
  const body = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
  const failing = {
    beta: {
      messages: {
        stream: () => ({
          on() {
            return this;
          },
          async finalMessage() {
            throw Anthropic.APIError.generate(401, body, undefined, new Headers({ 'request-id': 'req_1' }));
          },
        }),
      },
    },
  } as unknown as Anthropic;
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, modelAgent({ name: 'claude-helper', model: claude({ client: failing }) }));
  const client = await AcpClient.connect(clientEnd, { onPermission: 'allow' });
  const session = await client.newSession({ cwd: '/repo' });
  const result = await session.prompt('hello').done;
  assert.equal(result.stopReason, 'error');
  assert.equal(
    (result.error as { message: string }).message,
    'Claude API 401: invalid x-api-key (check ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or `ant auth login`) [req_1]'
  );
  await client.close();
});
