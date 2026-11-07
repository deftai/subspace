/**
 * Two kinds of failure, kept apart on purpose:
 *
 * - `RpcError` crosses the wire. The other side sent it (or we send it).
 * - `LocalError` never crosses the wire. It says why *this* side stopped
 *   waiting: the caller aborted, a deadline passed, the connection closed, ...
 *
 * Code that cares should switch on `error.kind`, never on message text.
 */

const RPC_ERROR = Symbol.for('deft-subspace.RpcError');
const LOCAL_ERROR = Symbol.for('deft-subspace.LocalError');

/** Standard JSON-RPC 2.0 codes, plus the ones ACP and LSP use. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** ACP: the session (or other resource) does not exist. */
  ResourceNotFound: -32002,
  /** ACP: authentication required. */
  AuthRequired: -32000,
  /** LSP / ACP `$/cancel_request`: the request was cancelled. */
  RequestCancelled: -32800,
} as const;

/** An error the remote side returned, or one a handler throws to return. */
export class RpcError extends Error {
  readonly kind = 'remote' as const;
  readonly [RPC_ERROR] = true;
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  static is(value: unknown): value is RpcError {
    return typeof value === 'object' && value !== null && RPC_ERROR in value;
  }

  static methodNotFound(method: string): RpcError {
    return new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
  }

  static invalidParams(message: string, data?: unknown): RpcError {
    return new RpcError(ErrorCode.InvalidParams, message, data);
  }

  static notFound(message: string, data?: unknown): RpcError {
    return new RpcError(ErrorCode.ResourceNotFound, message, data);
  }

  static internal(message: string, data?: unknown): RpcError {
    return new RpcError(ErrorCode.InternalError, message, data);
  }

  toJSON(): { code: number; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/**
 * Why this side gave up on a request.
 *
 * - `aborted`: the caller's AbortSignal fired.
 * - `timeout`: the request's deadline passed.
 * - `closed`: the connection closed before an answer arrived.
 * - `invalid-response`: the answer was not a valid JSON-RPC response.
 * - `send-failed`: the request could not be written.
 */
export type LocalErrorKind = 'aborted' | 'timeout' | 'closed' | 'invalid-response' | 'send-failed';

export class LocalError extends Error {
  readonly [LOCAL_ERROR] = true;
  readonly kind: LocalErrorKind;
  readonly method: string | undefined;

  constructor(kind: LocalErrorKind, message: string, options?: { cause?: unknown; method?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LocalError';
    this.kind = kind;
    this.method = options?.method;
  }

  static is(value: unknown, kind?: LocalErrorKind): value is LocalError {
    return (
      typeof value === 'object' &&
      value !== null &&
      LOCAL_ERROR in value &&
      (kind === undefined || (value as LocalError).kind === kind)
    );
  }
}
