/**
 * Transport harnesses for testkit scenarios.
 *
 * Owns: linked in-process channels + stdio spawn of session-echo-agent,
 * product connect, and dispose pairing.
 * Does not own: scenario steps or asserts (those call into the returned product).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defineLinkedChannels,
  defineStdioTransport,
} from "@deft/acp-wire";
import {
  defineAcpClientProduct,
  type AcpClientProduct,
  type PermissionPolicy,
} from "@deft/acp-client";
import {
  listenSessionEcho,
  type AcpServerHandle,
} from "@deft/acp-agent";

/** Permission policy alias for testkit call sites (same as client product). */
export type TestkitPermissionPolicy = PermissionPolicy;

/** In-process harness: product + session-echo server + joint dispose. */
export type LinkedHarness = {
  mode: "linked";
  product: AcpClientProduct;
  server: AcpServerHandle;
  dispose(): Promise<void>;
};

/** Spawned session-echo harness: product only (agent is child process). */
export type StdioHarness = {
  mode: "stdio";
  product: AcpClientProduct;
  dispose(): Promise<void>;
};

/** Either harness shape scenarios accept for dispose + product access. */
export type ProductHarness = LinkedHarness | StdioHarness;

/**
 * Resolve path to session-echo-agent fixture (workspace-relative from this package).
 * fromMetaUrl defaults to this module so callers need not pass import.meta.url.
 */
export function sessionEchoAgentPath(fromMetaUrl = import.meta.url): string {
  // packages/acp-testkit/src → repo root → packages/acp-agent/bin
  const here = path.dirname(fileURLToPath(fromMetaUrl));
  return path.resolve(
    here,
    "../../acp-agent/bin/session-echo-agent.ts",
  );
}

/**
 * Linked transport: session-echo on agent side, client product on host side.
 * dispose closes product then server (order avoids hanging reverse RPC).
 */
export async function withLinkedProduct(options?: {
  permissionPolicy?: TestkitPermissionPolicy;
}): Promise<LinkedHarness> {
  const policy = options?.permissionPolicy ?? "deny";
  const { client: cT, agent: aT } = defineLinkedChannels().connect();
  const server = await listenSessionEcho(aT);
  const product = await defineAcpClientProduct({
    permissionPolicy: policy,
  }).connect(cT);
  return {
    mode: "linked",
    product,
    server,
    async dispose() {
      // Product first so host stops requesting before agent transport dies
      await product.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

/**
 * Stdio transport: spawn session-echo-agent via node --experimental-strip-types.
 * dispose closes product only (child exits with transport).
 */
export async function withStdioProduct(options?: {
  permissionPolicy?: TestkitPermissionPolicy;
  agentScript?: string;
}): Promise<StdioHarness> {
  const policy = options?.permissionPolicy ?? "deny";
  const agentScript = options?.agentScript ?? sessionEchoAgentPath();
  const transport = await defineStdioTransport({
    mode: "spawn",
    command: process.execPath,
    args: ["--experimental-strip-types", agentScript],
  }).connect();
  const product = await defineAcpClientProduct({
    permissionPolicy: policy,
  }).connect(transport);
  return {
    mode: "stdio",
    product,
    async dispose() {
      await product.close().catch(() => undefined);
    },
  };
}
