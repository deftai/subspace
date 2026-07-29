/**
 * Linked-transport listen + defineHarness factory.
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

/** Linked-transport convenience: handlers + listen with live bridge. */
export async function listenHarness(
  transport: AcpTransport,
  options?: HarnessOptions,
): Promise<AcpServerHandle> {
  const { bridge, bind } = createDeferredBridge();
  const handlers = defineHarnessHandlers(bridge, options);
  const server = await defineAcpServer({ handlers }).listen(transport);
  bind(server);
  return server;
}

/**
 * Public micro-factory: one options object, trusted defaults via resolveHarnessOptions.
 * Not a general compose / variant engine.
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
    listen(transport) {
      return listenHarness(transport, options);
    },
    handlers(bridge) {
      return defineHarnessHandlers(bridge, options);
    },
  };
}
