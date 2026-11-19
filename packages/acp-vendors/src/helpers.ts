/**
 * Shared internal helpers for vendor ACP client layers.
 * Uses no Node APIs.
 */
import type { EndpointAgent } from '@deft-subspace/acp';
import { ErrorCode, RpcError, type RequestOptions } from '@deft-subspace/kernel';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Call a vendor method by its bare name: try `_name` first, and on
 * MethodNotFound (-32601) fall back to `name` (docs/agent-vendor-protocols.md §1).
 */
export async function callWithFallback<Result = unknown>(
  agent: EndpointAgent,
  bareMethod: string,
  params: unknown,
  options?: RequestOptions,
): Promise<Result> {
  const bare = bareMethod.startsWith('_') ? bareMethod.slice(1) : bareMethod;
  const prefixed = `_${bare}`;
  try {
    return await agent.request<Result>(prefixed, params, options);
  } catch (err) {
    if (err instanceof RpcError && err.code === ErrorCode.MethodNotFound) {
      return await agent.request<Result>(bare, params, options);
    }
    throw err;
  }
}

/** Extract the agent capabilities object from an `initialize` result (v1 `agentCapabilities` or v2 `capabilities`). */
export function agentCapabilitiesOf(initResult: unknown): Record<string, unknown> {
  if (!isRecord(initResult)) return {};
  const caps = initResult.capabilities ?? initResult.agentCapabilities;
  return isRecord(caps) ? caps : {};
}
