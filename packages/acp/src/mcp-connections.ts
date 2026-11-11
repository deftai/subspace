/**
 * The agent side of a session's other MCP servers (`stdio`, `http`, `sse`):
 * the ones the agent connects to itself.
 *
 * Subspace doesn't speak MCP over those transports itself; an `McpConnector`
 * does (`mcpConnector()` in `./node` uses the official MCP SDK). A server is
 * connected the first time a turn uses it, kept for the session's later
 * turns, and closed when the session closes, the client sends new servers
 * (load or resume), or the connection closes.
 */
import type { McpCallOptions } from './mcp-caller.ts';
import type { McpOutcome, McpServer } from './mcp.ts';

export type ExternalMcpServer = McpServer & { type: 'stdio' | 'http' | 'sse' };

/** One open connection to an MCP server. */
export interface McpConnection {
  /** Any MCP request; an inner error is `{ error }`, not a throw. */
  request(method: string, params: Record<string, unknown> | null | undefined, options: McpCallOptions): Promise<McpOutcome>;
  close(): Promise<void>;
}

/** Connects to MCP servers over the transports it lists. */
export interface McpConnector {
  readonly transports: ReadonlyArray<ExternalMcpServer['type']>;
  connect(server: ExternalMcpServer, context: { cwd: string; signal?: AbortSignal }): Promise<McpConnection>;
}

/** A session's connections, by server name. */
export class SessionMcpConnections {
  private readonly open = new Map<string, Promise<McpConnection>>();
  /** Aborts the connects in flight when the connections are dropped (close, or new servers). */
  private connecting = new AbortController();
  private readonly connector: McpConnector | undefined;
  private cwd: string;
  private closed = false;

  constructor(connector: McpConnector | undefined, cwd: string) {
    this.connector = connector;
    this.cwd = cwd;
  }

  /** Why `server` can't be used here, or undefined. */
  problem(server: ExternalMcpServer): string | undefined {
    if (this.closed) return `MCP server "${server.name}": the session is closed`;
    if (!this.connector) return `MCP server "${server.name}" is ${server.type}: give serveAgent an \`mcpConnector\` (e.g. mcpConnector() from @deft-subspace/acp/node) to use it`;
    if (!this.connector.transports.includes(server.type)) {
      return `MCP server "${server.name}" is ${server.type}, which the connector does not support (${this.connector.transports.join(', ')})`;
    }
    return undefined;
  }

  /** The connection to `server`, opening it on first use. A failed connect is not kept, so a later call tries again. */
  get(server: ExternalMcpServer, signal?: AbortSignal): Promise<McpConnection> {
    const problem = this.problem(server);
    if (problem || !this.connector) return Promise.reject(new Error(problem));
    let connection = this.open.get(server.name);
    if (!connection) {
      // Not the turn's signal: the connection outlives the turn that opened it. Dropping it aborts the connect.
      connection = this.connector.connect(server, { cwd: this.cwd, signal: this.connecting.signal });
      this.open.set(server.name, connection);
      connection.catch(() => {
        if (this.open.get(server.name) === connection) this.open.delete(server.name);
      });
    }
    if (!signal) return connection;
    // The caller stops waiting on abort; the connect itself carries on for the next turn.
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      connection.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** New servers from load or resume: drop every connection, the next use reconnects. */
  async reset(cwd: string): Promise<void> {
    this.cwd = cwd;
    await this.closeOpen();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeOpen();
  }

  private async closeOpen(): Promise<void> {
    const open = [...this.open.values()];
    this.open.clear();
    // A connect still in flight is aborted rather than waited for (up to its own timeout).
    this.connecting.abort(new Error('MCP connections closed'));
    this.connecting = new AbortController();
    await Promise.all(open.map((c) => c.then((connection) => connection.close(), () => {}).catch(() => {})));
  }
}
