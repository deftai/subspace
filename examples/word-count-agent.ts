/**
 * A tiny agent: counts the words in a file, asking before it reads.
 * @typecheck-only (it waits for a client on stdin; word-count.ts starts it)
 */
import { readFile } from 'node:fs/promises';
import { serveStdio } from '@deft-subspace/acp/node';

serveStdio({
  name: 'word-count',
  async prompt(turn) {
    const file = turn.text.trim();
    const words = await turn.tool({ title: `Read ${file}`, kind: 'read', ask: true }, async () => {
      const text = await readFile(file, 'utf8');
      return String(text.split(/\s+/).filter(Boolean).length);
    });
    await turn.say(`${file} has ${words} words.`);
  },
});
