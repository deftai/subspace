/** An agent served with serveStdio(): it logs with console.log mid-turn, which must not reach stdout. */
import { serveStdio } from '@deft-subspace/acp/node';

serveStdio({
  name: 'stdio-agent',
  async prompt(turn) {
    console.log('this would corrupt the protocol stream without the redirect');
    const listing = await turn.tool({ title: 'List files', kind: 'read' }, () => 'a.txt\nb.txt');
    try {
      await turn.tool({ title: 'Delete b.txt', kind: 'delete', ask: true }, () => 'deleted');
    } finally {
      await turn.say(`listed: ${listing.split('\n').length}`);
    }
  },
});
