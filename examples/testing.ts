/**
 * Testing with the testkit: run the conformance checks against an agent,
 * and replay a recorded real-agent trace to a client.
 */
import { join } from 'node:path';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent } from '@deft-subspace/acp';
import { checkAgent, DEFAULT_PROMPTS, failures, formatReport, replayAgent } from '@deft-subspace/acp-testkit';
import { loadTrace } from '@deft-subspace/acp-testkit/node';

// 1. Conformance: checkAgent drives any agent over a channel and reports each check.
const [agentEnd, checkerEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'under-test',
  async prompt(turn) {
    if (turn.text === DEFAULT_PROMPTS.longPrompt) {
      for (let i = 1; i <= 300 && !turn.signal.aborted; i++) {
        await turn.say(`${i}\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return turn.signal.aborted ? 'cancelled' : 'end_turn';
    }
    await turn.say('OK');
    return 'end_turn';
  },
});
const report = await checkAgent(checkerEnd, { permissionPrompt: null });
console.log(formatReport(report));
if (failures(report).length) process.exitCode = 1;

// 2. Replay: a real Grok Build session, recorded once, played back to our client.
const trace = await loadTrace(join(import.meta.dirname, '../packages/testkit/corpus/grok-plain.trace.jsonl'));
const [replayEnd, clientEnd] = channelPair<unknown>();
const replay = replayAgent(replayEnd, trace);
const client = await AcpClient.connect(clientEnd);
const session = await client.newSession({ cwd: '/workspace' });
const prompt = (trace[0] as { meta?: { prompt?: string } }).meta?.prompt ?? '';
console.log((await session.prompt(prompt).done).text);
await replay.done; // rejects with expected vs got if the client did something else
await client.close();
