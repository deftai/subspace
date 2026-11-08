/**
 * deft-subspace quickstart: an agent and a client, both written with
 * @deft-subspace/acp, talking in one process. No external agent needed.
 *
 *   node --conditions=subspace-source packages/acp/examples/quickstart.ts
 *   PROTOCOL=1 node --conditions=subspace-source packages/acp/examples/quickstart.ts
 *
 * To talk to a real agent instead, replace `connect()` with:
 *
 *   import { connectAgent } from '@deft-subspace/acp/node';
 *   const { client, close } = await connectAgent('grok', {
 *     args: ['--permission-mode', 'default', 'agent', 'stdio'],
 *     cwd: process.cwd(),
 *     workspace: process.cwd(),       // serve its file reads, confined here
 *     permissions: askTheUser,
 *   });
 */
import { channelPair, type Channel } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type PermissionHandler, type ProtocolVersion } from '@deft-subspace/acp';

// ---------------------------------------------------------------------------
// 1. An agent. One handler; the library speaks v1 or v2 on the wire for it.
// ---------------------------------------------------------------------------

function startAgent(channel: Channel<unknown>, protocol: ProtocolVersion) {
  serveAgent(channel, {
    name: 'demo-agent',
    version: '0.1.0',
    protocols: [protocol],

    async prompt(turn) {
      await turn.think('The user wants the tests run.');
      await turn.say('Running the test suite.');

      const tests = await turn.toolCall({ title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } });

      const answer = await turn.requestPermission({ title: 'Run `npm test`?', toolCallId: tests.id });
      if (!answer.allowed) {
        await tests.fail();
        await turn.say('OK, I did not run anything.');
        return 'end_turn';
      }

      await tests.update({ status: 'in_progress' });
      for (let i = 1; i <= 3; i++) {
        // Real work goes here. Stop when the client cancels.
        if (turn.signal.aborted) return 'cancelled';
        await new Promise((r) => setTimeout(r, 50));
      }
      await tests.complete({ content: [{ type: 'content', content: { type: 'text', text: '3 passed' } }] });
      await turn.say('All 3 tests pass.');
      return 'end_turn';
    },
  });
}

// ---------------------------------------------------------------------------
// 2. A client: connect, open a session, run a turn, render events.
// ---------------------------------------------------------------------------

/** Ask "the user". Anything that throws or picks an unknown option is a rejection. */
const askTheUser: PermissionHandler = async (request) => {
  console.log(`  ? ${request.title}  [tool: ${request.toolCall?.title}]  -> allow`);
  return 'allow';
};

async function connect(protocol: ProtocolVersion) {
  const [clientEnd, agentEnd] = channelPair<unknown>();
  startAgent(agentEnd, protocol);
  return AcpClient.connect(clientEnd, { name: 'quickstart', permissions: askTheUser });
}

const protocol = (Number(process.env.PROTOCOL ?? 2) as ProtocolVersion) || 2;
const client = await connect(protocol);
console.log(`connected to ${client.agent.name} ${client.agent.version}, protocol v${client.protocol}\n`);

const session = await client.newSession({ cwd: process.cwd() });

// A turn is an async iterable of events...
const turn = session.prompt('Run the tests');
for await (const event of turn) {
  switch (event.type) {
    case 'thought':
      console.log(`  (thinking) ${event.delta}`);
      break;
    case 'message':
      console.log(`  ${event.delta}`);
      break;
    case 'tool_call':
      console.log(`  [${event.toolCall.status}] ${event.toolCall.title}`);
      break;
    case 'permission':
      console.log(`  permission ${event.outcome.outcome === 'selected' && event.outcome.allowed ? 'granted' : 'refused'}`);
      break;
  }
}

// ...and `done` gives the result, after the last event.
const result = await turn.done;
console.log(`\nstopReason: ${result.stopReason}`);
console.log(`text: ${JSON.stringify(result.text)}`);
console.log(`tool calls: ${result.toolCalls.map((c) => `${c.title} [${c.status}]`).join(', ')}`);

// ---------------------------------------------------------------------------
// 3. Cancelling: the agent's signal fires, open tool calls end failed.
// ---------------------------------------------------------------------------

const second = session.prompt('Run them again');
setTimeout(() => void second.cancel(), 80);
const cancelled = await second.done;
console.log(`\nafter cancel: stopReason=${cancelled.stopReason}, tool call ${cancelled.toolCalls[0]?.status}`);

await client.close();
