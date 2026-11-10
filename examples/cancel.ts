/**
 * Cancelling a turn, and limiting one. A cancelled agent should stop when
 * `turn.signal` fires; if it does not confirm in time, the turn ends here
 * anyway (`forced: true`).
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, turnEnd } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'counter',
  async prompt(turn) {
    for (let i = 1; i <= 1000; i++) {
      if (turn.signal.aborted) return 'cancelled';
      await turn.say(`${i} `);
      await new Promise((r) => setTimeout(r, 10));
    }
    return 'end_turn';
  },
});

const client = await AcpClient.connect(clientEnd);
const session = await client.newSession({ cwd: process.cwd() });

const turn = session.prompt('Count to 1000');
setTimeout(() => void turn.cancel(), 100);
const result = await turn.done;
console.log(result.stopReason, turnEnd(result)); // cancelled cancelled

// Or let a limit cancel it: no messages for 1 s, at most 20 tool calls, at most 5 s.
const limited = await session.prompt('Count again', { limits: { idleMs: 1000, maxToolCalls: 20, maxDurationMs: 200 } }).done;
console.log(limited.exhausted); // { limit: 'duration', max: 200, value: ... }
await client.close();
