/**
 * Vendor extension methods, declared once and typed on both sides.
 *
 *   export const steer = extensionRequest<{ sessionId: string; text: string }, { ok: boolean }>('_acme/steer');
 *
 *   // agent:  serveAgent(channel, { extensions: [handle(steer, (p) => ({ ok: true }))], ... })
 *   // client: await client.call(steer, { sessionId, text: 'focus on tests' })
 *
 * ACP reserves names that start with `_` for extensions, so declarations must
 * use one. Pass a validator (anything with `parse`, such as a zod schema) to
 * check params on the receiving side and results on the calling side; a
 * failed check is `InvalidParams` there and an `invalid-response` error here.
 */
import { LocalError, RpcError, type InboundContext, type RequestHandler, type RpcPeer } from '@deft-subspace/kernel';

/** Anything with `parse` that throws on bad input, e.g. a zod schema. */
export interface Validator<T> {
  parse(value: unknown): T;
}

export interface ExtensionRequest<Params, Result> {
  readonly kind: 'request';
  readonly method: string;
  readonly params?: Validator<Params>;
  readonly result?: Validator<Result>;
}

export interface ExtensionNotification<Params> {
  readonly kind: 'notification';
  readonly method: string;
  readonly params?: Validator<Params>;
}

function checkName(method: string): void {
  if (!method.startsWith('_') || method.length < 2) {
    throw new Error(`Extension method names start with "_" (ACP reserves them for extensions): ${method}`);
  }
}

export function extensionRequest<Params = unknown, Result = unknown>(
  method: `_${string}`,
  validators: { params?: Validator<Params>; result?: Validator<Result> } = {}
): ExtensionRequest<Params, Result> {
  checkName(method);
  return { kind: 'request', method, ...validators };
}

export function extensionNotification<Params = unknown>(
  method: `_${string}`,
  validators: { params?: Validator<Params> } = {}
): ExtensionNotification<Params> {
  checkName(method);
  return { kind: 'notification', method, ...validators };
}

/** A handler bound to its declaration, for `serveAgent({ extensions })` or `AcpClient.connect({ extensions })`. */
export type ExtensionHandler =
  | { kind: 'request'; method: string; handler: RequestHandler }
  | { kind: 'notification'; method: string; handler: (params: unknown, context: InboundContext) => void };

const parse = <T>(validator: Validator<T> | undefined, value: unknown, what: string): T => {
  if (!validator) return value as T;
  try {
    return validator.parse(value);
  } catch (error) {
    throw RpcError.invalidParams(`Invalid ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export function handle<Params, Result>(
  extension: ExtensionRequest<Params, Result>,
  handler: (params: Params, context: InboundContext) => Result | Promise<Result>
): ExtensionHandler;
export function handle<Params>(
  extension: ExtensionNotification<Params>,
  handler: (params: Params, context: InboundContext) => void
): ExtensionHandler;
export function handle(
  extension: ExtensionRequest<unknown, unknown> | ExtensionNotification<unknown>,
  handler: (params: unknown, context: InboundContext) => unknown
): ExtensionHandler {
  if (extension.kind === 'request') {
    return {
      kind: 'request',
      method: extension.method,
      handler: (params, context) => handler(parse(extension.params, params, `params for ${extension.method}`), context),
    };
  }
  return {
    kind: 'notification',
    method: extension.method,
    handler: (params, context) => {
      // A notification cannot be answered; bad params are dropped.
      let parsed: unknown;
      try {
        parsed = parse(extension.params, params, `params for ${extension.method}`);
      } catch {
        return;
      }
      handler(parsed, context);
    },
  };
}

/** @internal Register handlers on a peer. */
export function registerExtensions(peer: RpcPeer, handlers: readonly ExtensionHandler[] = []): void {
  for (const h of handlers) {
    if (h.kind === 'request') peer.onRequest(h.method, h.handler);
    else peer.onNotification(h.method, h.handler);
  }
}

/** @internal Call an extension request, checking the result if a validator was given. */
export async function callExtension<Params, Result>(
  peer: RpcPeer,
  extension: ExtensionRequest<Params, Result>,
  params: Params,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Result> {
  const result = await peer.request(extension.method, params, options);
  if (!extension.result) return result as Result;
  try {
    return extension.result.parse(result);
  } catch (error) {
    throw new LocalError('invalid-response', `Invalid result for ${extension.method}`, { method: extension.method, cause: error });
  }
}
