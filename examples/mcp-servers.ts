/**
 * Giving a real agent MCP servers: one it starts (stdio) and one it connects
 * to (http). Each is written in the agent's protocol and checked against the
 * transports it advertised.
 * @typecheck-only (starts Claude's ACP adapter through npx)
 */
import { connectAgent } from '@deft-subspace/acp/node';

const { client, close } = await connectAgent('npx', { args: ['-y', '@agentclientprotocol/claude-agent-acp'], cwd: process.cwd() });
try {
  console.log(client.supports.mcp); // { stdio: true, http: true, sse: false, acp: false }
  const session = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [
      { type: 'stdio', name: 'files', command: '/usr/local/bin/files-mcp', args: ['--root', process.cwd()] },
      { type: 'http', name: 'search', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${process.env.SEARCH_TOKEN}` } },
    ],
  });
  await session.prompt('List the tools you got from the files server.').done;
} finally {
  await close();
}
