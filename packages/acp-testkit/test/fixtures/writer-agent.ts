/** A fixture agent for scenarios: "write <file> <text>" writes a file (asking first); anything else is greeted. */
import { writeFile } from 'node:fs/promises';
import { serveStdio } from '@deft-subspace/acp/node';

serveStdio({
  name: 'writer',
  async prompt(turn) {
    const match = /^write (\S+) (.+)$/.exec(turn.text.trim());
    if (!match) {
      await turn.say(`Hello! You said: ${turn.text}`);
      return;
    }
    const [, file, text] = match;
    await turn.tool({ title: `Write ${file}`, kind: 'edit', ask: true, locations: [{ path: file }] }, () => writeFile(file!, text!));
    await turn.say(`Wrote ${file}.`);
  },
});
