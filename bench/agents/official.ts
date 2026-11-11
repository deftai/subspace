// The benchmark agent on the official TypeScript SDK (@agentclientprotocol/sdk). See protocol.md.
import { writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

process.on('exit', () => {
  if (process.env.BENCH_RSS_FILE) writeFileSync(process.env.BENCH_RSS_FILE, String(process.resourceUsage().maxRSS * 1024));
});

let sessions = 0;
const options = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
];

const app = acp
  .agent({ name: 'bench-official-ts' })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentInfo: { name: 'bench-official-ts', version: '1.0.0' }, agentCapabilities: {}, authMethods: [] }))
  .onRequest('session/new', () => ({ sessionId: `s${++sessions}` }))
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const [command, a, b] = text.split(' ');
    if (command === 'stream') {
      const chunk = 'x'.repeat(Number(b));
      for (let i = 0; i < Number(a); i++) {
        await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } });
      }
    } else if (command === 'ask') {
      for (let i = 0; i < Number(a); i++) {
        await client.request('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: `t${i}` }, options });
      }
    }
    return { stopReason: 'end_turn' };
  });

const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
process.exit(0);
