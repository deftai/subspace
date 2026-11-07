/**
 * The agent side of MCP-over-ACP: calling MCP servers the client serves over
 * the ACP connection (`"type": "acp"` in a session's `mcpServers`).
 *
 *   async prompt(turn) {
 *     const tools = turn.mcp('project-tools');
 *     for (const tool of await tools.listTools()) ...
 *     const result = await tools.callTool('echo', { message: 'hi' });
 *   }
 *
 * Each call is one stateless MCP 2026-07-28 request: a fresh request id, the
 * protocol version, client capabilities and client info in `params._meta`.
 * There is no MCP handshake. Notifications for a call (progress) go to its
 * `onNotification`; cancelling (the turn's signal by default) sends
 * `$/cancel_request`.
 */
import { RpcError, type RpcPeer } from '@deft-subspace/kernel';
import { MCP_PROTOCOL_VERSION, type McpOutcome, type McpServer } from './mcp.ts';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface McpCallOptions {
  /** Cancels the call (`$/cancel_request`). In a turn, defaults to the turn's signal. */
  signal?: AbortSignal;
  /** MCP notifications for this call, e.g. `notifications/progress`. */
  onNotification?: (notification: { method: string; params?: Record<string, unknown> }) => void;
  /** Default: generated. Never reuse one still active on the same server. */
  requestId?: string;
  timeoutMs?: number;
}

/** An inner MCP error: the server answered, with an MCP (not ACP) error. */
export class McpError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/** A tool from `tools/list` (MCP fields kept as sent). */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One served MCP server, as the agent sees it. */
export interface McpServerClient {
  readonly name: string;
  readonly serverId: string;
  /** Any MCP request; resolves with the outcome (an inner error is `{ error }`, not a throw). */
  request(method: string, params?: Record<string, unknown> | null, options?: McpCallOptions): Promise<McpOutcome>;
  /** `server/discover`. */
  discover(options?: McpCallOptions): Promise<Record<string, unknown>>;
  /** Every tool, following `nextCursor` pages. */
  listTools(options?: McpCallOptions): Promise<McpTool[]>;
  /**
   * `tools/call`. Resolves with the MCP result (`content`, `isError`, maybe
   * `resultType: "input_required"`); a tool that failed is `isError: true`,
   * not a throw. Throws `McpError` for an inner protocol error.
   */
  callTool(name: string, args?: Record<string, unknown>, options?: McpCallOptions): Promise<Record<string, unknown>>;
}

/** One per connection: sends `mcp/message` and routes its notifications. */
export class McpCaller {
  private readonly peer: RpcPeer;
  private readonly clientInfo: { name: string; version: string };
  private readonly active = new Map<string, NonNullable<McpCallOptions['onNotification']> | undefined>();
  private counter = 0;

  constructor(peer: RpcPeer, clientInfo: { name: string; version: string }) {
    this.peer = peer;
    this.clientInfo = clientInfo;
    peer.onNotification('mcp/message', (params: unknown) => {
      if (!isRecord(params) || typeof params.serverId !== 'string' || typeof params.requestId !== 'string' || typeof params.method !== 'string') return;
      // Unknown or finished requests: dropped, never given to another call.
      const listener = this.active.get(key(params.serverId, params.requestId));
      listener?.({ method: params.method, ...(isRecord(params.params) ? { params: params.params } : {}) });
    });
  }

  async request(serverId: string, method: string, params?: Record<string, unknown> | null, options: McpCallOptions = {}): Promise<McpOutcome> {
    const requestId = options.requestId ?? `mcp-${(++this.counter).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const id = key(serverId, requestId);
    if (this.active.has(id)) throw new Error(`MCP request id ${requestId} is already active on ${serverId}`);
    const inner = { ...(params ?? {}) };
    const meta = isRecord(inner._meta) ? { ...inner._meta } : {};
    // Required per request (MCP 2026-07-28); values the caller set are kept.
    meta[META_VERSION] ??= MCP_PROTOCOL_VERSION;
    meta[META_CAPABILITIES] ??= {};
    meta[META_CLIENT_INFO] ??= this.clientInfo;
    inner._meta = meta;
    this.active.set(id, options.onNotification);
    try {
      const result = await this.peer.request('mcp/message', { serverId, requestId, method, params: inner }, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 0,
      });
      if (!isRecord(result)) throw new RpcError(-33002, 'mcp/message answered without an MCP outcome');
      // `result` wins if both are present.
      if ('result' in result) return { result: result.result };
      if (isRecord(result.error) && typeof result.error.code === 'number' && typeof result.error.message === 'string') {
        return { error: result.error as { code: number; message: string; data?: unknown } };
      }
      throw new RpcError(-33002, 'mcp/message answered without an MCP outcome');
    } finally {
      this.active.delete(id);
    }
  }

  server(server: McpServer & { type: 'acp' }, defaults: Pick<McpCallOptions, 'signal'> = {}): McpServerClient {
    const call = async (method: string, params: Record<string, unknown> | undefined, options: McpCallOptions = {}) => {
      const outcome = await this.request(server.serverId, method, params, { ...defaults, ...options });
      if ('error' in outcome) throw new McpError(outcome.error.code, outcome.error.message, outcome.error.data);
      return isRecord(outcome.result) ? outcome.result : {};
    };
    return {
      name: server.name,
      serverId: server.serverId,
      request: (method, params, options = {}) => this.request(server.serverId, method, params, { ...defaults, ...options }),
      discover: (options) => call('server/discover', {}, options),
      listTools: async (options) => {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const result = await call('tools/list', cursor ? { cursor } : {}, options);
          if (Array.isArray(result.tools)) tools.push(...(result.tools.filter(isRecord) as McpTool[]));
          cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
          if (!cursor) break;
        }
        return tools;
      },
      callTool: (name, args = {}, options) => call('tools/call', { name, arguments: args }, options),
    };
  }
}

const key = (serverId: string, requestId: string) => `${serverId}\u0000${requestId}`;
