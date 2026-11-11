// The benchmark client on the official TypeScript SDK (@agentclientprotocol/sdk).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { parseArgs, run } from './common.ts';

const args = parseArgs();
await run(args, async () => {
  const [command, ...rest] = args.agent;
  const child = spawn(command!, rest, { stdio: ['pipe', 'pipe', 'inherit'] });
  const texts = new Map<string, string>();
  const connection = acp
    .client({ name: 'bench' })
    .onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected' as const, optionId: 'yes' } }))
    .onNotification('session/update', ({ params }) => {
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        texts.set(params.sessionId, (texts.get(params.sessionId) ?? '') + update.content.text);
      }
    })
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  return {
    async newSession() {
      return (await connection.agent.request('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
    },
    async prompt(sessionId, text) {
      texts.set(sessionId, '');
      await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      return texts.get(sessionId) ?? '';
    },
    async close() {
      const exited = once(child, 'exit');
      child.stdin!.end();
      await connection.close?.();
      await exited;
    },
  };
});
