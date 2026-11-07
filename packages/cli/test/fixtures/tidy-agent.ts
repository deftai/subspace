/** A small agent for CLI tests: reads (no question), then asks before deleting. */
import { serveStdio } from '@deft-subspace/acp/node';

serveStdio({
  name: 'tidy',
  async prompt(turn) {
    await turn.think('Looking around.');
    const files = await turn.tool({ title: 'List files', kind: 'read' }, () => 'a.log\nb.log');
    await turn.say(`Found ${files.split('\n').length} logs.`);
    await turn.tool({ title: 'Delete 2 log files', kind: 'delete', ask: true }, () => 'deleted');
    await turn.say('Deleted them.');
  },
});
