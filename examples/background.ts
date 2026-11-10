/**
 * v2 agent terminals and background work: the agent runs a dev server in a
 * terminal it shows the client, detaches it so it outlives the turn, and the
 * client stops it later with terminal/cancel.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, terminalText } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'dev-server',
  protocols: [2],
  async prompt(turn) {
    const call = await turn.toolCall({ title: 'npm run dev', kind: 'execute', status: 'in_progress' });
    const terminal = await turn.showTerminal({ command: 'npm run dev', cwd: '/work', cancellable: true });
    await call.update({ content: [{ type: 'terminal', terminalId: terminal.id }] });
    await terminal.write('listening on http://localhost:3000\n');
    // Keep it running after the turn; stop when the client cancels it (or closes the session).
    terminal.signal.addEventListener('abort', () => void terminal.exit({ signal: 'SIGTERM' }));
    await terminal.detach();
    await call.complete();
    await turn.say('The dev server is running.');
    return 'end_turn';
  },
});

const client = await AcpClient.connect(clientEnd);
const session = await client.newSession({ cwd: '/work' });
await session.prompt('Start the dev server').done;

console.log(session.background); // [{ type: 'terminal', terminalId: 'term-…' }]
const [item] = session.background ?? [];
const terminalId = item?.type === 'terminal' ? item.terminalId : '';
console.log(terminalText(session.terminals.get(terminalId)!)); // "listening on http://localhost:3000"

await session.cancelTerminal(terminalId);
await new Promise((r) => setTimeout(r, 20));
console.log(session.terminals.get(terminalId)?.exitStatus, session.background); // { signal: 'SIGTERM' } []
await client.close();
