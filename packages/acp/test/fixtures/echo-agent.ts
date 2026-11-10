/** Says an environment variable back: "env NAME" -> "NAME=value". */
import { serveStdio } from '@deft-subspace/acp/node';

serveStdio({
  name: 'echo-agent',
  async prompt(turn) {
    const name = turn.text.replace(/^env /, '');
    await turn.say(`${name}=${process.env[name] ?? ''}`);
  },
});
