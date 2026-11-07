/**
 * Sessions, modes, config options and login with a real agent.
 * @typecheck-only (starts Codex's ACP adapter through npx)
 */
import { connectAgent } from '@deft-subspace/acp/node';

const { client, close } = await connectAgent('npx', { args: ['-y', '@agentclientprotocol/codex-acp'], cwd: process.cwd() });
try {
  // Login, if the agent needs it: methods it handles itself ("agent"), or terminal ones (with terminalAuth).
  for (const method of client.authMethods) console.log(`login: ${method.id} (${method.type})`);

  const session = await client.newSession({ cwd: process.cwd() });

  // Modes, whichever way the agent offers them (session/set_mode or a "mode" config option).
  console.log('modes', session.modes?.available.map((m) => m.id), 'current', session.modes?.current);
  await session.setMode('read-only'); // Codex's ask-first mode

  // Config options: model, reasoning effort, on/off switches. Values the agent did not offer are refused here.
  for (const option of session.configOptions) console.log(option.id, option.type, option.currentValue);
  if (session.model) await session.setModel(session.model.currentValue ?? session.model.choices[0]!.value);

  // History, if the agent keeps it.
  if (client.supports.listSessions) console.log((await client.listSessions({ cwd: process.cwd() })).sessions.length, 'sessions');
  await session.close();
  if (client.supports.deleteSession) await client.deleteSession(session.id);
} finally {
  await close();
}
