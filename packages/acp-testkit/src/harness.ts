/**
 * Transport harnesses for testkit scenarios.
 * Linked = in-process channels; stdio = spawn session-echo-agent.
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

export type TestkitPermissionPolicy = PermissionPolicy;

export type LinkedHarness = {
  mode: "linked";
  product: AcpClientProduct;
  server: AcpServerHandle;
  dispose(): Promise<void>;
};

export type StdioHarness = {
  mode: "stdio";
  product: AcpClientProduct;
  dispose(): Promise<void>;
};

export type ProductHarness = LinkedHarness | StdioHarness;

/** Resolve path to session-echo-agent fixture (workspace-relative). */
export function sessionEchoAgentPath(fromMetaUrl = import.meta.url): string {
  // packages/acp-testkit/src → repo root → packages/acp-agent/bin
  const here = path.dirname(fileURLToPath(fromMetaUrl));
  return path.resolve(
    here,
    "../../acp-agent/bin/session-echo-agent.ts",
  );
}

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
      await product.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

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
