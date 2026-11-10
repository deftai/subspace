/**
 * MCP-over-ACP: the client serves tools over the ACP connection itself (no
 * extra process or port), and the agent calls them with `turn.mcp(name)`.
 */
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent } from '@deft-subspace/acp';

const [agentEnd, clientEnd] = channelPair<unknown>();

// The agent: advertise the acp transport, then use the session's served tools.
serveAgent(agentEnd, {
  name: 'tool-user',
  mcpTransports: ['acp'],
  async prompt(turn) {
    const editor = turn.mcp('editor');
    const tools = await editor.listTools();
    const result = await editor.callTool('open_buffers');
    await turn.say(`${tools.map((t) => t.name).join(', ')}: ${JSON.stringify(result.content)}`);
    return 'end_turn';
  },
});

// The client: serve one tool. The handler has the official SDK's McpRequestHandler shape.
const client = await AcpClient.connect(clientEnd);
const editor = client.serveMcp({
  name: 'editor',
  handler: async ({ method }) => {
    if (method === 'tools/list') return { result: { tools: [{ name: 'open_buffers', inputSchema: { type: 'object' } }] } };
    if (method === 'tools/call') return { result: { content: [{ type: 'text', text: 'README.md, src/index.ts' }], isError: false } };
    return { error: { code: -32601, message: `no ${method}` } };
  },
});
const session = await client.newSession({ cwd: process.cwd(), mcpServers: [editor] });
console.log((await session.prompt('Which files are open?').done).text);
await editor.dispose();
await client.close();
