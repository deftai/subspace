/**
 * MCP servers for an agent's session: the ones it starts or connects to
 * (`stdio`, `http`, `sse`), and ones the client serves over the ACP
 * connection itself (`acp`, MCP-over-ACP).
 *
 *   const session = await client.newSession({
 *     cwd,
 *     mcpServers: [
 *       { type: 'stdio', name: 'files', command: '/usr/local/bin/files-mcp', args: ['--root', cwd] },
 *       { type: 'http', name: 'search', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ...' } },
 *       client.serveMcp({ name: 'project-tools', handler }),   // needs the agent's `acp` MCP capability
 *     ],
 *   });
 *
 * Each server is checked against the transports the agent advertised before
 * session/new is sent. MCP-over-ACP follows the ACP RFD "MCP-over-ACP:
 * Stateless MCP Requests over ACP" (MCP 2026-07-28): the agent sends
 * `mcp/message` requests addressed by `serverId`; the handler answers each
 * with one MCP outcome and may send notifications scoped to it. The handler
 * shape is the official SDK's `McpRequestHandler`, so
 * `fromMcpServer(...)` from `@agentclientprotocol/sdk/experimental/mcp-server`
 * plugs in as is.
 */
import { RpcError, type RpcPeer } from '@deft-subspace/kernel';
import { CapabilityError, type AgentSupport } from './capabilities.ts';
import type { ProtocolVersion } from './model.ts';

/** An MCP server for a session, in one shape for v1 and v2. */
export type McpServer =
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; name: string; url: string; headers?: Record<string, string> }
  /** v1 only; deprecated in MCP, and gone from v2. */
  | { type: 'sse'; name: string; url: string; headers?: Record<string, string> }
  /** Served by this client over the ACP connection; see `client.serveMcp()`. */
  | { type: 'acp'; name: string; serverId: string };

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

/** Outer ACP error codes of the MCP-over-ACP binding. */
export const McpBindingError = {
  cancelled: -32800,
  resourceLimitExceeded: -33000,
  serverUnavailable: -33001,
  backendFailed: -33002,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pairs = (record: Record<string, string> | undefined) => Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));

/**
 * The `mcpServers` param for session/new, load or resume, in the agent's
 * protocol. Throws a CapabilityError for a transport the agent did not
 * advertise, and for a v2 stdio command that is not an absolute path.
 */
export function mcpServersParam(protocol: ProtocolVersion, supports: AgentSupport, servers: ReadonlyArray<McpServer | { declaration: McpServer }>): unknown[] {
  return servers.map((entry) => {
    const server = 'declaration' in entry ? entry.declaration : entry;
    if (!supports.mcp[server.type]) throw new CapabilityError(`${server.type} MCP servers`, 'agent');
    switch (server.type) {
      case 'stdio':
        if (protocol === 2 && !server.command.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(server.command)) {
          throw new Error(`MCP server ${server.name}: v2 needs an absolute command path, got "${server.command}"`);
        }
        // v1 has no type for stdio and requires args and env.
        return protocol === 2
          ? { type: 'stdio', name: server.name, command: server.command, args: server.args ?? [], env: pairs(server.env) }
          : { name: server.name, command: server.command, args: server.args ?? [], env: pairs(server.env) };
      case 'http':
      case 'sse':
        return { type: server.type, name: server.name, url: server.url, headers: pairs(server.headers) };
      case 'acp':
        return { type: 'acp', name: server.name, serverId: server.serverId };
    }
  });
}

/** One MCP operation the agent asked a served server for. Same shape as the official SDK's `McpOperationContext`. */
export interface McpOperationContext {
  serverId: string;
  /** The agent's logical MCP request id (also the inner JSON-RPC id). */
  requestId: string;
  /** Inner MCP method, such as `tools/call` or `server/discover`. */
  method: string;
  params: Record<string, unknown> | undefined;
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
  clientInfo: unknown;
  envelopeMeta: Record<string, unknown> | undefined;
  /** Fires when the agent cancels this request, the server is disposed, or the connection closes. */
  signal: AbortSignal;
  /** An MCP notification for this request (progress, subscription events). Dropped once it has been answered. */
  notify(method: string, params?: Record<string, unknown> | null): Promise<void>;
}

/** Exactly one of `result` (any JSON value) or `error`. */
export type McpOutcome =
  | { result: unknown; _meta?: Record<string, unknown> | null }
  | { error: { code: number; message: string; data?: unknown; [key: string]: unknown }; _meta?: Record<string, unknown> | null };

/**
 * Answers MCP requests for one served server. Throw an error with a
 * `toMcpError()` method (the SDK's `McpProtocolError`) for an inner MCP
 * error; any other throw is a binding failure (-33002), or -32800 when cancelled.
 */
export type McpRequestHandler = (context: McpOperationContext) => McpOutcome | Promise<McpOutcome>;

export interface ServeMcpOptions {
  name: string;
  handler: McpRequestHandler;
  /** Default: generated. Never reused on a connection, even after dispose. */
  serverId?: string;
  /** Requests running at once; more fail with -33000. Default 64. */
  maxActiveRequests?: number;
}

export interface McpRegistration {
  readonly name: string;
  readonly serverId: string;
  /** Put this (or the registration itself) in a session's `mcpServers`. */
  readonly declaration: McpServer & { type: 'acp' };
  /** Stop serving: later requests fail with -33001, running ones are cancelled. Resolves when their handlers have settled. */
  dispose(): Promise<void>;
}

interface Served {
  options: ServeMcpOptions;
  active: Map<string, Promise<unknown>>;
  controller: AbortController;
}

const invalidParams = (message: string): McpOutcome => ({ error: { code: -32602, message } });

function validOutcome(value: unknown): value is McpOutcome {
  if (!isRecord(value)) return false;
  if ('result' in value) return value.result !== undefined;
  const error = value.error;
  return isRecord(error) && Number.isInteger(error.code) && typeof error.message === 'string';
}

/** Serves MCP servers to the agent over `mcp/message`, on one connection. */
export class McpProvider {
  private readonly servers = new Map<string, Served>();
  private readonly used = new Set<string>();
  private readonly peer: RpcPeer;
  private counter = 0;

  constructor(peer: RpcPeer) {
    this.peer = peer;
    peer.onRequest('mcp/message', (params, context) => this.handle(params, context.signal));
  }

  serve(options: ServeMcpOptions): McpRegistration {
    const serverId = options.serverId ?? `${options.name}:${(++this.counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    if (this.used.has(serverId)) throw new Error(`MCP server id ${serverId} was already used on this connection`);
    const max = options.maxActiveRequests ?? 64;
    if (!Number.isInteger(max) || max < 1) throw new RangeError('maxActiveRequests must be a positive integer');
    this.used.add(serverId);
    const served: Served = { options: { ...options, maxActiveRequests: max }, active: new Map(), controller: new AbortController() };
    this.servers.set(serverId, served);
    return {
      name: options.name,
      serverId,
      declaration: { type: 'acp', name: options.name, serverId },
      dispose: async () => {
        if (this.servers.get(serverId) !== served) return;
        this.servers.delete(serverId);
        served.controller.abort(new Error(`MCP server ${serverId} was disposed`));
        await Promise.allSettled([...served.active.values()]);
      },
    };
  }

  private async handle(raw: unknown, callerSignal: AbortSignal): Promise<McpOutcome> {
    const envelope = isRecord(raw) ? raw : {};
    const { serverId, requestId, method } = envelope;
    if (typeof serverId !== 'string' || typeof requestId !== 'string' || typeof method !== 'string') {
      throw new RpcError(-32602, 'mcp/message needs string serverId, requestId and method');
    }
    if (envelope.params !== undefined && envelope.params !== null && !isRecord(envelope.params)) {
      throw new RpcError(-32602, 'mcp/message params must be an object');
    }
    const served = this.servers.get(serverId);
    if (!served) throw new RpcError(McpBindingError.serverUnavailable, 'MCP server registration unavailable', { serverId });
    if (served.active.has(requestId)) throw new RpcError(-32602, 'duplicate active MCP request id', { serverId, requestId });
    if (served.active.size >= served.options.maxActiveRequests!) {
      throw new RpcError(McpBindingError.resourceLimitExceeded, 'MCP-over-ACP active request limit exceeded', { serverId });
    }
    const signal = AbortSignal.any([callerSignal, served.controller.signal]);
    let done = false;
    const run = this.run(served, { serverId, requestId, method, params: (envelope.params ?? undefined) as Record<string, unknown> | undefined, envelopeMeta: isRecord(envelope._meta) ? envelope._meta : undefined }, signal, () => done);
    served.active.set(requestId, run.catch(() => {}));
    try {
      return await run;
    } catch (error) {
      if (signal.aborted) throw new RpcError(McpBindingError.cancelled, 'MCP request cancelled');
      throw new RpcError(McpBindingError.backendFailed, error instanceof Error ? error.message : String(error));
    } finally {
      // No notification may follow the answer.
      done = true;
      served.active.delete(requestId);
    }
  }

  private async run(
    served: Served,
    envelope: { serverId: string; requestId: string; method: string; params?: Record<string, unknown>; envelopeMeta?: Record<string, unknown> },
    signal: AbortSignal,
    isDone: () => boolean
  ): Promise<McpOutcome> {
    // Recorded as active before the handler starts.
    await Promise.resolve();
    const meta = isRecord(envelope.params?._meta) ? envelope.params._meta : undefined;
    const version = meta?.[META_VERSION];
    if (typeof version !== 'string') return invalidParams(`missing ${META_VERSION} in params._meta`);
    if (version !== MCP_PROTOCOL_VERSION) {
      return { error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [MCP_PROTOCOL_VERSION], requested: version } } };
    }
    const capabilities = meta?.[META_CAPABILITIES];
    if (!isRecord(capabilities)) return invalidParams(`missing ${META_CAPABILITIES} in params._meta`);
    // Cancelled before it started: it never starts.
    if (signal.aborted) throw signal.reason;
    let outcome: unknown;
    try {
      outcome = await served.options.handler({
        serverId: envelope.serverId,
        requestId: envelope.requestId,
        method: envelope.method,
        params: envelope.params,
        protocolVersion: version,
        clientCapabilities: capabilities,
        clientInfo: meta?.[META_CLIENT_INFO],
        envelopeMeta: envelope.envelopeMeta,
        signal,
        notify: async (method, params) => {
          if (isDone()) return;
          await this.peer.notify('mcp/message', {
            serverId: envelope.serverId,
            requestId: envelope.requestId,
            method,
            ...(params === undefined ? {} : { params }),
          });
        },
      });
    } catch (error) {
      const toMcp = (error as { toMcpError?: () => unknown } | null)?.toMcpError;
      if (typeof toMcp !== 'function') throw error;
      outcome = { error: toMcp.call(error) };
    }
    if (!validOutcome(outcome)) throw new Error('MCP handler gave an invalid outcome: exactly one of a defined `result` or an `error` with an integer `code` and string `message`');
    return outcome;
  }
}
