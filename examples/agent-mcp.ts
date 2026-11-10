/**
 * An agent that uses the MCP servers the client gives its session. The client
 * passes a stdio server (this file, started with `mcp-server`); the agent
 * connects with `mcpConnector()`, lists the tools and calls one.
 *
 * Needs `@modelcontextprotocol/client` (for the connector) and, for the server
 * half, `@modelcontextprotocol/server`.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio as serveMcpStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, serveAgent } from '@deft-subspace/acp';
import { mcpConnector } from '@deft-subspace/acp/node';

// The MCP server: one tool, `count_words`.
if (process.argv.includes('mcp-server')) {
  serveMcpStdio(() => {
    const server = new McpServer({ name: 'words', version: '1.0.0' });
    server.registerTool('count_words', { description: 'Count the words in a text', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
      content: [{ type: 'text', text: String(text.split(/\s+/).filter(Boolean).length) }],
    }));
    return server;
  });
} else {
  const [agentEnd, clientEnd] = channelPair<unknown>();

  // The agent: connects to the session's stdio and http servers on first use.
  serveAgent(agentEnd, {
    name: 'word-counter',
    mcpConnector: mcpConnector(),
    async prompt(turn) {
      const words = turn.mcp('words');
      const tools = await words.listTools();
      await turn.say(`Tools: ${tools.map((t) => t.name).join(', ')}. `);
      const result = await words.callTool('count_words', { text: turn.text });
      const [first] = result.content as Array<{ type: string; text?: string }>;
      await turn.say(`"${turn.text}" has ${first?.text} words.`);
      return 'end_turn';
    },
  });

  // The client: gives the session the server, as a command to start.
  const client = await AcpClient.connect(clientEnd);
  console.log(client.supports.mcp); // { stdio: true, http: true, sse: false, acp: false } (v2 has no sse)
  const session = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [{ type: 'stdio', name: 'words', command: process.execPath, args: [...process.execArgv, import.meta.filename, 'mcp-server'] }],
  });
  const result = await session.prompt('the quick brown fox').done;
  console.log(result.text); // Tools: count_words. "the quick brown fox" has 4 words.
  await session.close(); // stops the server
  await client.close();
}
