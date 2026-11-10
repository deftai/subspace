/**
 * Recipe: give an agent tools from your own app, served over the ACP
 * connection itself (MCP-over-ACP): here an in-process agent that uses them.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, tool } from '@deft-subspace/acp';

// The app's state, which only the app can see.
const openBuffers = ['README.md', 'src/index.ts'];

// An agent that takes tools served this way (real agents advertise it with the `acp` MCP transport).
const [agentEnd, clientEnd] = channelPair<unknown>();
serveAgent(agentEnd, {
  name: 'tool-user',
  mcpTransports: ['acp'],
  async prompt(turn) {
    const editor = turn.mcp('editor');
    const result = await editor.callTool('openBuffers');
    await turn.say(`Open: ${JSON.stringify(result.structuredContent)}`);
  },
});

const client = await AcpClient.connect(clientEnd, { onPermission: 'reject' });
const editor = client.serveTools({
  name: 'editor',
  tools: {
    openBuffers: tool({ description: 'The files open in the editor', kind: 'read', run: () => ({ files: openBuffers }) }),
  },
});
const session = await client.newSession({ cwd: process.cwd(), mcpServers: [editor] });
console.log((await session.prompt('What is open?').done).text); // Open: {"files":["README.md","src/index.ts"]}
await client.close();
