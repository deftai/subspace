/**
 * Idempotent admission. A client that retries a request (after a timeout, a
 * reconnect) names it with a request id of its own; the second delivery gets
 * the first one's result and runs nothing.
 *
 * - The id comes from `params._meta[ns].requestId`. JSON-RPC ids are not used:
 *   they are per connection and may be reused once answered.
 * - The receipt is stored before the work starts, so a retry that arrives
 *   while the first is still running waits for it.
 * - The same id with different params is an error (-32602), never a second run.
 * - Failures are receipts too: a retry of a refused move is refused again.
 */
import { RpcError } from '@deft-subspace/kernel';

interface Receipt {
  fingerprint: string;
  result: Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON with sorted keys, so field order does not change the fingerprint. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
  );
}

/** The client's request id, or undefined if it sent none. Throws -32602 for a present but empty one. */
export function requestIdOf(params: unknown, namespace: string): string | undefined {
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta[namespace] : undefined;
  if (!isRecord(meta) || !('requestId' in meta)) return undefined;
  const id = meta.requestId;
  if (typeof id !== 'string' || !id) throw RpcError.invalidParams(`_meta.${namespace}.requestId must be a non-empty string`);
  return id;
}

/** Params without `_meta`, for fingerprinting. */
export function withoutMeta(params: unknown): unknown {
  if (!isRecord(params)) return params;
  const { _meta: _ignored, ...rest } = params;
  return rest;
}

export class Admissions {
  private readonly scopes = new Map<string, Map<string, Receipt>>();
  private readonly limit: number;

  /** `limit`: receipts kept per scope; the oldest go first. */
  constructor(options: { limit?: number } = {}) {
    this.limit = options.limit ?? 1024;
  }

  /** Run `work` once per (scope, requestId). Without a request id it simply runs. */
  admit<T>(scope: string, requestId: string | undefined, print: string, work: () => Promise<T> | T): Promise<T> {
    if (requestId === undefined) return Promise.resolve().then(work);
    let receipts = this.scopes.get(scope);
    if (!receipts) this.scopes.set(scope, (receipts = new Map()));
    const previous = receipts.get(requestId);
    if (previous) {
      if (previous.fingerprint !== print) {
        return Promise.reject(RpcError.invalidParams(`Request id ${requestId} was already used for a different request`, { requestId }));
      }
      return previous.result as Promise<T>;
    }
    const result = Promise.resolve().then(work);
    result.catch(() => {});
    receipts.set(requestId, { fingerprint: print, result });
    if (receipts.size > this.limit) receipts.delete(receipts.keys().next().value as string);
    return result;
  }

  /** Drop a scope's receipts, e.g. when its session is gone for good. */
  forget(scope: string): void {
    this.scopes.delete(scope);
  }
}
