/** A small agent for CLI tests: reads (no question), then asks before deleting. */
import { serveStdio } from '@deft-subspace/acp/node';

serveStdio({
  name: 'tidy',
  async prompt(turn) {
    // "env NAME": say an environment variable (for --env).
    if (turn.text.startsWith('env ')) {
      await turn.say(`${turn.text.slice(4)}=${process.env[turn.text.slice(4)] ?? ''}`);
      return;
    }
    // "fail MESSAGE": end the turn with an error.
    if (turn.text.startsWith('fail ')) throw new Error(turn.text.slice(5));
    await turn.think('Looking around.');
    const files = await turn.tool({ title: 'List files', kind: 'read' }, () => 'a.log\nb.log');
    await turn.say(`Found ${files.split('\n').length} logs.`);
    await turn.tool({ title: 'Delete 2 log files', kind: 'delete', ask: true }, () => 'deleted');
    await turn.say('Deleted them.');
  },
});
