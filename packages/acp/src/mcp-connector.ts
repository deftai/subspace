/**
 * `mcpConnector()`: the agent connects to a session's `stdio`, `http` and
 * `sse` MCP servers with the official MCP SDK (`@modelcontextprotocol/client`,
 * an optional peer dependency, loaded on first use).
 *
 *   serveStdio({ name: 'my-agent', mcpConnector: mcpConnector(), async prompt(turn) {
 *     const files = turn.mcp('filesystem');
 *     const tools = await files.listTools();
 *     ...
 *   } });
 *
 * The connection negotiates the protocol version (2026-07-28 servers, and the
 * 2025 ones). A stdio server runs in the session's `cwd` with this process's
 * environment plus the server's `env`, its stderr going to this process's
 * stderr (stdout is the ACP channel, so a server can't write there).
 * Requests go as sent (`tools/call` results, `input_required` included, are
 * not interpreted), like `acp` servers.
 */
import type { McpCallOptions } from './mcp-caller.ts';
import type { ExternalMcpServer, McpConnection, McpConnector } from './mcp-connections.ts';
import type { McpOutcome } from './mcp.ts';

export interface McpConnectorOptions {
  /** `clientInfo` sent to the servers. Default `subspace`. */
  name?: string;
  version?: string;
  /** Transports to support. Default stdio, http and sse. */
  transports?: Array<ExternalMcpServer['type']>;
  /**
   * stdio servers' environment: `inherit` (this process's, plus the
   * server's `env`; the default) or `minimal` (the SDK's short safe list,
   * plus `env`).
   */
  env?: 'inherit' | 'minimal';
  /** Where stdio servers' stderr goes. Default `inherit`. */
  stderr?: 'inherit' | 'ignore' | ((line: string, server: string) => void);
  /** Default per-request timeout. Default: none (cancel with the turn instead). */
  timeoutMs?: number;
  /** Longest a connect (start and handshake) may take; a stdio server still starting is stopped. Default 60 s. */
  connectTimeoutMs?: number;
}

/** The parts of `@modelcontextprotocol/client` used here (typed locally: it is optional, and its types are not ours to ship). */
interface SdkTransport {
  close(): Promise<void>;
}
interface SdkClient {
  connect(transport: SdkTransport, options?: Record<string, unknown>): Promise<void>;
  request(request: { method: string; params?: Record<string, unknown> }, schema: unknown, options: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
interface Sdk {
  Client: new (info: { name: string; version: string }, options: Record<string, unknown>) => SdkClient;
  StreamableHTTPClientTransport: new (url: URL, options: Record<string, unknown>) => SdkTransport;
  SSEClientTransport: new (url: URL, options: Record<string, unknown>) => SdkTransport;
  ProtocolError: abstract new (...args: never[]) => Error & { code: number; data?: unknown };
}
interface SdkStdio {
  StdioClientTransport: new (params: Record<string, unknown>) => SdkTransport & { stderr: NodeJS.ReadableStream | null };
  getDefaultEnvironment(): Record<string, string>;
}

// Literal specifiers, so bundlers see the dependency; loaded on first use only.
let loading: Promise<[Sdk, SdkStdio]> | undefined;
const load = () =>
  (loading ??= Promise.all([
    import('@modelcontextprotocol/client') as unknown as Promise<Sdk>,
    import('@modelcontextprotocol/client/stdio') as unknown as Promise<SdkStdio>,
  ]).catch((error: unknown) => {
    loading = undefined;
    throw new Error('mcpConnector() needs @modelcontextprotocol/client: npm install @modelcontextprotocol/client', { cause: error });
  }));

/** Results are passed on as they came: a schema that accepts anything. */
const anything = { '~standard': { version: 1 as const, vendor: 'subspace', validate: (value: unknown) => ({ value }) } };

export function mcpConnector(options: McpConnectorOptions = {}): McpConnector {
  const transports = options.transports ?? ['stdio', 'http', 'sse'];
  return {
    transports,
    async connect(server, context) {
      const [sdk, stdio] = await load();
      const client = new sdk.Client({ name: options.name ?? 'subspace', version: options.version ?? '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
      let transport: SdkTransport;
      if (server.type === 'stdio') {
        const base = options.env === 'minimal' ? stdio.getDefaultEnvironment() : (Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>);
        const stderr = options.stderr ?? 'inherit';
        const t = new stdio.StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: { ...base, ...(server.env ?? {}) },
          cwd: context.cwd,
          stderr: typeof stderr === 'function' ? 'pipe' : stderr,
        });
        if (typeof stderr === 'function') {
          let buffered = '';
          t.stderr?.on('data', (chunk: Buffer) => {
            buffered += chunk.toString('utf8');
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            for (const line of lines) stderr(line, server.name);
          });
        }
        transport = t;
      } else {
        const url = new URL(server.url);
        const requestInit = server.headers ? { headers: server.headers } : undefined;
        transport =
          server.type === 'http'
            ? new sdk.StreamableHTTPClientTransport(url, requestInit ? { requestInit } : {})
            : new sdk.SSEClientTransport(url, requestInit ? { requestInit } : {});
      }
      try {
        await client.connect(transport, { timeout: options.connectTimeoutMs ?? 60_000, ...(context.signal ? { signal: context.signal } : {}) });
      } catch (error) {
        // Don't leave a half-started server behind.
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        throw error;
      }
      const connection: McpConnection = {
        async request(method, params, callOptions: McpCallOptions): Promise<McpOutcome> {
          const onNotification = callOptions.onNotification;
          const timeout = callOptions.timeoutMs ?? options.timeoutMs;
          try {
            const result = await client.request({ method, ...(params ? { params } : {}) }, anything, {
              ...(callOptions.signal ? { signal: callOptions.signal } : {}),
              ...(timeout ? { timeout } : { timeout: 2 ** 31 - 1 }),
              ...(onNotification
                ? { onprogress: (progress: Record<string, unknown>) => onNotification({ method: 'notifications/progress', params: { ...progress } }) }
                : {}),
            });
            return { result };
          } catch (error) {
            // An answer with an error is the server's; anything else (abort, timeout, transport) throws.
            if (error instanceof sdk.ProtocolError) {
              return { error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } };
            }
            throw error;
          }
        },
        close: () => client.close(),
      };
      return connection;
    },
  };
}
