/**
 * Linked-transport listen + defineHarness factory.
 *
 * Owns: deferred-bridge wiring so handlers can notify during prompt before the
 * server handle exists. Does not own ModelAdapter defaults (see options) or
 * ACP method bodies (see handlers).
 */
import type { AcpTransport } from "../../acp-wire/src/index.ts";
import {
  createDeferredBridge,
  defineAcpServer,
  type AcpHandler,
  type AcpServerHandle,
  type AgentBridge,
} from "../../acp-agent/src/index.ts";
import { defineHarnessHandlers } from "./handlers.ts";
import { resolveHarnessOptions, type HarnessOptions } from "./options.ts";

/**
 * Linked-transport convenience: handlers + listen with a live bridge.
 * Order matters — bind after listen so outbound notify uses the real server.
 */
export async function listenHarness(
  transport: AcpTransport,
  options?: HarnessOptions,
): Promise<AcpServerHandle> {
  const { bridge, bind } = createDeferredBridge();
  const handlers = defineHarnessHandlers(bridge, options);
  const server = await defineAcpServer({ handlers }).listen(transport);
  // Bridge was a placeholder until the server could route hostward messages
  bind(server);
  return server;
}

/**
 * Public micro-factory: one options object, trusted defaults via resolveHarnessOptions.
 * Not a general compose / variant engine — thin facade over listen + handlers.
 */
export function defineHarness(options?: HarnessOptions): {
  /** Resolved defaults (model, name, version, instructions). */
  readonly options: ReturnType<typeof resolveHarnessOptions>;
  listen(transport: AcpTransport): Promise<AcpServerHandle>;
  handlers(bridge: AgentBridge): Record<string, AcpHandler>;
} {
  const resolved = resolveHarnessOptions(options);
  return {
    options: resolved,
    /** Same path as top-level listenHarness with factory-captured options. */
    listen(transport) {
      return listenHarness(transport, options);
    },
    /** Handlers only — caller supplies bridge (e.g. stdio stub agent). */
    handlers(bridge) {
      return defineHarnessHandlers(bridge, options);
    },
  };
}
