/**
 * Giving a real agent MCP servers: one it starts (stdio) and one it connects
 * to (http). Each is written in the agent's protocol and checked against the
 * transports it advertised.
 * @typecheck-only (starts Claude's ACP adapter through npx)
 */
import { start } from '@deft-subspace/acp/node';

const agent = await start('claude', {
  permissions: 'reject',
  session: {
    mcpServers: [
      { type: 'stdio', name: 'files', command: '/usr/local/bin/files-mcp', args: ['--root', process.cwd()] },
      { type: 'http', name: 'search', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${process.env.SEARCH_TOKEN}` } },
    ],
  },
});
try {
  console.log(agent.client.supports.mcp); // { stdio: true, http: true, sse: false, acp: false }
  await agent.run('List the tools you got from the files server.', { onMessage: (delta, { separator }) => process.stdout.write(separator + delta) });
} finally {
  await agent.close();
}
