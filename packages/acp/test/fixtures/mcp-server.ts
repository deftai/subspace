/**
 * A small MCP server (official SDK) for the connector tests: `echo`, `where`
 * (its cwd and $SUBSPACE_TEST_ENV), `slow` (progress, then waits) and
 * `count` (how many times it was called on this server instance).
 *
 *   node mcp-server.ts            stdio
 *   import { mcpServer }          for an HTTP handler
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

let calls = 0;
/** `slow` calls that saw their cancel (in this process). */
export const stopped: string[] = [];

export function mcpServer(): McpServer {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echo a message', inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({
    content: [{ type: 'text', text: message }],
  }));
  server.registerTool('where', { description: 'Where the server runs' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), env: process.env.SUBSPACE_TEST_ENV ?? null }) }],
  }));
  server.registerTool('count', { description: 'Calls so far' }, async () => ({ content: [{ type: 'text', text: String(++calls) }] }));
  server.registerTool('slow', { description: 'Progress, then wait until cancelled' }, async (ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken !== undefined) {
      await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 2, message: 'half way' } });
    }
    await new Promise<void>((resolve) => {
      if (ctx.mcpReq.signal.aborted) return resolve();
      ctx.mcpReq.signal.addEventListener('abort', () => (stopped.push(String(ctx.mcpReq.id)), resolve()), { once: true });
    });
    return { content: [{ type: 'text', text: 'stopped' }] };
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) serveStdio(() => mcpServer());
