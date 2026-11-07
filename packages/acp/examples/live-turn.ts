/**
 * Run one turn against a real agent and print the normalized events.
 *
 *   node --conditions=source packages/acp/examples/live-turn.ts grok --permission-mode default agent stdio
 *   node --conditions=source packages/acp/examples/live-turn.ts npx -y @agentclientprotocol/claude-agent-acp
 *
 * PROMPT and CWD can be set in the environment. CANCEL_AFTER_MS cancels the
 * turn that long after the first agent message.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgent } from '@deft-subspace/acp/node';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('usage: live-turn.ts <command> [args...]');
const cwd = process.env.CWD ?? (await mkdtemp(join(tmpdir(), 'deft-subspace-live-')));
const prompt = process.env.PROMPT ?? 'Reply with exactly SUBSPACE_OK and nothing else. Do not use any tools.';

const started = Date.now();
const ms = () => `${String(Date.now() - started).padStart(6)}ms`;
const agent = await connectAgent(command, { args, cwd, workspace: cwd, name: 'deft-subspace-live', permissions: 'reject' });
const { client } = agent;
console.log(`${ms()} connected: ${client.agent.name ?? '?'} ${client.agent.version ?? ''} protocol v${client.protocol}`);
try {
  const session = await client.newSession({ cwd });
  console.log(`${ms()} session ${session.id}`);
  const turn = session.prompt(prompt);
  const cancelAfter = Number(process.env.CANCEL_AFTER_MS ?? NaN);
  let cancelScheduled = false;
  for await (const event of turn) {
    if (event.type === 'message' && Number.isFinite(cancelAfter) && !cancelScheduled) {
      cancelScheduled = true;
      setTimeout(() => {
        console.log(`${ms()} cancel   (asking the agent to stop)`);
        void turn.cancel();
      }, cancelAfter);
    }
    switch (event.type) {
      case 'message':
      case 'thought':
        console.log(`${ms()} ${event.type.padEnd(8)} ${JSON.stringify(event.delta)}`);
        break;
      case 'tool_call':
        console.log(`${ms()} tool     ${event.toolCall.title} [${event.toolCall.status}]`);
        break;
      case 'permission':
        console.log(
          `${ms()} perm     ${event.request.title} -> ${event.outcome.outcome === 'selected' ? (event.outcome.allowed ? 'allowed' : 'rejected') : 'cancelled'}`
        );
        break;
      case 'update':
        console.log(`${ms()} update   ${event.sessionUpdate}`);
        break;
      default:
        console.log(`${ms()} ${event.type}`);
    }
  }
  const result = await turn.done;
  const text = result.text.length > 120 ? `${result.text.slice(0, 120)}… (${result.text.length} chars)` : result.text;
  console.log(`${ms()} done: stopReason=${result.stopReason} cancelled=${result.cancelled} forced=${result.forced ?? false} text=${JSON.stringify(text)}`);
} finally {
  await agent.close();
  console.log(`${ms()} closed; agent process exit ${JSON.stringify(await agent.process.exited)}`);
}
