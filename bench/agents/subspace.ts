// The benchmark agent on Subspace (TypeScript). See protocol.md.
import { writeFileSync } from 'node:fs';
import { serveStdio } from '@deft-subspace/acp/node';

process.on('exit', () => {
  if (process.env.BENCH_RSS_FILE) writeFileSync(process.env.BENCH_RSS_FILE, String(process.resourceUsage().maxRSS * 1024));
});

serveStdio({
  name: 'bench-subspace-ts',
  version: '1.0.0',
  async prompt(turn) {
    const [command, a, b] = turn.text.split(' ');
    if (command === 'stream') {
      const chunk = 'x'.repeat(Number(b));
      for (let i = 0; i < Number(a); i++) await turn.say(chunk);
    } else if (command === 'ask') {
      for (let i = 0; i < Number(a); i++) await turn.requestPermission({ title: `Step ${i}` });
    }
  },
});
