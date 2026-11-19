/**
 * Shared vendor takeover service registry (docs/agent-driver-design.md §6.4, C3).
 *
 * A base driver or harness places `vendorServicesLayer()` in the `clientEndpoint`
 * stack before the vendor layers (`deftLayer`, `xaiLayer`, `antigravityLayer`).
 * Vendor layers register their capabilities and takeover handlers on this service
 * without ever registering duplicate RPC method handlers.
 *
 * Uses no Node APIs.
 */
import { stateKey, type ClientLayer, type StateKey } from '@deft-subspace/acp';
import type { DriverAuthMethod } from '@deft-subspace/agent-driver';
import { isRecord } from './helpers.ts';

export type VendorAuthOutcome =
  | { status: 'signed_in' }
  | { status: 'declined'; message?: string }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export interface VendorServices {
  getMainSessionId(): string | null;
  setMainSessionId(sessionId: string | null): void;

  /** Extra session capabilities supplied by detected vendor layers (e.g. `'delete'`). */
  readonly sessionCapabilities: ReadonlySet<string>;
  addSessionCapability(capability: string): void;

  /** Agent capabilities reported via Deft `_meta["deft.co"]`. */
  emptyPrompts: boolean;
  stopTerminals: boolean;
  /** True when the agent advertises `_meta["deft.co"].tools` (application MCP servers should be omitted). */
  omitAppMcpServers: boolean;

  readonly deleteSessionHandlers: Array<(sessionId: string) => Promise<string | null | undefined>>;
  readonly cancelSubagentHandlers: Array<(childSessionId: string) => Promise<boolean | undefined>>;
  readonly authenticateHandlers: Array<
    (method: DriverAuthMethod, options?: { signal?: AbortSignal }) => Promise<VendorAuthOutcome | undefined>
  >;
  readonly stopTerminalHandlers: Array<(toolCallId: string) => Promise<string | null | undefined>>;

  deleteSession(sessionId: string): Promise<string | null | undefined>;
  cancelSubagent(childSessionId: string): Promise<boolean | undefined>;
  authenticate(method: DriverAuthMethod, options?: { signal?: AbortSignal }): Promise<VendorAuthOutcome | undefined>;
  stopTerminal(toolCallId: string): Promise<string | null | undefined>;
}

export const VENDOR_SERVICES: StateKey<VendorServices> = stateKey<VendorServices>('acp:vendor-services');

export function createVendorServices(): VendorServices {
  let mainSessionId: string | null = null;
  const sessionCaps = new Set<string>();
  const deleteSessionHandlers: VendorServices['deleteSessionHandlers'] = [];
  const cancelSubagentHandlers: VendorServices['cancelSubagentHandlers'] = [];
  const authenticateHandlers: VendorServices['authenticateHandlers'] = [];
  const stopTerminalHandlers: VendorServices['stopTerminalHandlers'] = [];

  return {
    getMainSessionId: () => mainSessionId,
    setMainSessionId: (id) => {
      mainSessionId = id;
    },
    get sessionCapabilities(): ReadonlySet<string> {
      return sessionCaps;
    },
    addSessionCapability: (cap) => {
      sessionCaps.add(cap);
    },
    emptyPrompts: false,
    stopTerminals: false,
    omitAppMcpServers: false,
    deleteSessionHandlers,
    cancelSubagentHandlers,
    authenticateHandlers,
    stopTerminalHandlers,
    async deleteSession(sessionId) {
      for (const fn of deleteSessionHandlers) {
        const res = await fn(sessionId);
        if (res !== undefined) return res;
      }
      return undefined;
    },
    async cancelSubagent(childSessionId) {
      for (const fn of cancelSubagentHandlers) {
        const res = await fn(childSessionId);
        if (res !== undefined) return res;
      }
      return undefined;
    },
    async authenticate(method, options) {
      for (const fn of authenticateHandlers) {
        const res = await fn(method, options);
        if (res !== undefined) return res;
      }
      return undefined;
    },
    async stopTerminal(toolCallId) {
      for (const fn of stopTerminalHandlers) {
        const res = await fn(toolCallId);
        if (res !== undefined) return res;
      }
      return undefined;
    },
  };
}

/**
 * Base client layer that provides `VENDOR_SERVICES` and automatically tracks
 * the main session id from outbound `session/new`, `session/load`, and
 * `session/resume` calls.
 */
export function vendorServicesLayer(): ClientLayer<VendorServices> {
  return {
    name: 'vendor-services',
    provides: [VENDOR_SERVICES],
    create(ctx) {
      const services = createVendorServices();
      ctx.set(VENDOR_SERVICES, services);
      return services;
    },
    async outbound(call, _ctx, state, next) {
      const result = await next();
      if (call.kind === 'request') {
        if (call.method === 'session/new' && isRecord(result) && typeof result.sessionId === 'string' && result.sessionId) {
          state.setMainSessionId(result.sessionId);
        } else if (
          (call.method === 'session/load' || call.method === 'session/resume') &&
          isRecord(call.params) &&
          typeof call.params.sessionId === 'string' &&
          call.params.sessionId
        ) {
          state.setMainSessionId(call.params.sessionId);
        }
      }
      return result;
    },
  };
}
