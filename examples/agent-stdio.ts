/**
 * An agent program on stdio, ready for any ACP client (Zed, Toad, ...).
 * @typecheck-only (it waits for a client on stdin)
 */
import { Readable, Writable } from 'node:stream';
import { ndjson } from '@deft-subspace/kernel';
import { serveAgent } from '@deft-subspace/acp';

serveAgent(
  ndjson({
    readable: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  }),
  {
    name: 'my-agent',
    version: '0.1.0',
    async prompt(turn) {
      await turn.think('Looking it up.');
      const call = await turn.toolCall({ title: 'Look something up', kind: 'read', status: 'in_progress' });
      const ok = await turn.requestPermission({ title: 'Look it up?', toolCallId: call.id });
      if (!ok.allowed) {
        await call.fail();
        return 'end_turn';
      }
      if (turn.signal.aborted) return 'cancelled'; // the client cancelled
      await call.complete({ content: [{ type: 'content', content: { type: 'text', text: 'found it' } }] });
      await turn.say(`You asked: ${turn.text}`);
      return 'end_turn';
    },
  }
);
