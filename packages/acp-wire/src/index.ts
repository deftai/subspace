/**
 * ACP wire — only package that moves AcpMessage values.
 * Option C: structured in-process; NDJSON on byte edges; optional encodeRoundTrip.
 *
 * Phase 1.5: composes @deft/subspace-foundation for duplex + NDJSON framing underlays.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  defineMessagePair,
  defineNdjsonFramer,
  type MessageTransport,
  type CloseReason,
} from "@deft/subspace-foundation";

export type AcpMessage =
  | {
      kind: "request";
      id: string | number;
      method: string;
      params?: unknown;
    }
  | {
      kind: "response";
      id: string | number;
      result?: unknown;
      error?: unknown;
    }
  | {
      kind: "notification";
      method: string;
      params?: unknown;
    };

export type TransportCloseReason =
  | { readonly _tag: "Normal" }
  | { readonly _tag: "ChildExit"; code: number | null }
  | { readonly _tag: "ChannelClosed"; side: "send" | "recv" }
  | { readonly _tag: "Error"; error: Error };

export interface AcpTransport {
  send(message: AcpMessage): Promise<void>;
  readonly messages: AsyncIterable<AcpMessage>;
  close(reason?: string): Promise<void>;
  readonly closed: Promise<TransportCloseReason>;
}

/** Test hook: counts codec use for Option C assertions. */
export const codecStats = {
  encodeCalls: 0,
  decodeCalls: 0,
  reset() {
    this.encodeCalls = 0;
    this.decodeCalls = 0;
  },
};

function toJsonRpc(message: AcpMessage): unknown {
  if (message.kind === "request") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      method: message.method,
      ...(message.params !== undefined ? { params: message.params } : {}),
    };
  }
  if (message.kind === "response") {
    if (message.error !== undefined) {
      return { jsonrpc: "2.0", id: message.id, error: message.error };
    }
    return { jsonrpc: "2.0", id: message.id, result: message.result ?? null };
  }
  return {
    jsonrpc: "2.0",
    method: message.method,
    ...(message.params !== undefined ? { params: message.params } : {}),
  };
}

function fromJsonRpc(raw: unknown): AcpMessage {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid JSON-RPC message");
  }
  const o = raw as Record<string, unknown>;
  if ("method" in o && !("id" in o)) {
    return {
      kind: "notification",
      method: String(o.method),
      params: o.params,
    };
  }
  if ("method" in o && "id" in o) {
    return {
      kind: "request",
      id: o.id as string | number,
      method: String(o.method),
      params: o.params,
    };
  }
  if ("id" in o) {
    return {
      kind: "response",
      id: o.id as string | number,
      result: o.result,
      error: o.error,
    };
  }
  throw new Error("Unrecognized JSON-RPC shape");
}

const te = new TextEncoder();
const td = new TextDecoder();

export const NdjsonCodec = {
  encode(message: AcpMessage): Uint8Array {
    codecStats.encodeCalls += 1;
    return te.encode(JSON.stringify(toJsonRpc(message)) + "\n");
  },
  decodeLine(line: Uint8Array): AcpMessage {
    codecStats.decodeCalls += 1;
    const text = td.decode(line).replace(/\r?\n$/, "");
    if (text.length === 0) {
      throw new Error("Empty NDJSON line");
    }
    return fromJsonRpc(JSON.parse(text) as unknown);
  },
} as const;

/**
 * Adapt foundation MessageTransport → AcpTransport.
 * Close tags: self → Normal; peer/underlay → ChannelClosed (or mapped reason).
 */
function adaptMessageTransport(
  transport: MessageTransport<AcpMessage>,
  options?: {
    mapInbound?: (message: AcpMessage) => AcpMessage;
    mapOutbound?: (message: AcpMessage) => AcpMessage;
    peerCloseReason?: TransportCloseReason;
  },
): AcpTransport {
  const mapIn = options?.mapInbound ?? ((m: AcpMessage) => m);
  const mapOut = options?.mapOutbound ?? ((m: AcpMessage) => m);
  const peerCloseReason =
    options?.peerCloseReason ??
    ({ _tag: "ChannelClosed", side: "recv" } as const);

  let selfClosed = false;
  let closedReason: TransportCloseReason | undefined;
  let resolveClosed!: (r: TransportCloseReason) => void;
  const closedP = new Promise<TransportCloseReason>((r) => {
    resolveClosed = r;
  });

  void transport.closed.then((reason: CloseReason | undefined) => {
    if (closedReason) return;
    if (selfClosed) {
      closedReason = { _tag: "Normal" };
    } else if (reason?.error !== undefined) {
      closedReason = {
        _tag: "Error",
        error:
          reason.error instanceof Error
            ? reason.error
            : new Error(String(reason.error)),
      };
    } else {
      closedReason = peerCloseReason;
    }
    resolveClosed(closedReason);
  });

  return {
    async send(message: AcpMessage) {
      if (closedReason) throw new Error("AcpTransport closed");
      await transport.send(mapOut(message));
    },
    get messages() {
      return (async function* () {
        for await (const message of transport.readable) {
          yield mapIn(message);
        }
      })();
    },
    async close() {
      if (closedReason) return;
      selfClosed = true;
      closedReason = { _tag: "Normal" };
      await transport.close({});
      resolveClosed(closedReason);
    },
    get closed() {
      return closedP;
    },
  };
}

/**
 * Option C default: structured messages, no JSON.
 * encodeRoundTrip: true → encode→decode before deliver (parity CI).
 * Underlay: foundation defineMessagePair (single duplex implementation).
 */
export function defineLinkedChannels(options?: {
  encodeRoundTrip?: boolean;
}): {
  connect(): { client: AcpTransport; agent: AcpTransport };
} {
  const encodeRoundTrip = options?.encodeRoundTrip ?? false;
  return {
    _tag: "LinkedChannels" as const,
    encodeRoundTrip,
    connect() {
      const { a, b } = defineMessagePair<AcpMessage>();

      function maybeCodec(message: AcpMessage): AcpMessage {
        if (!encodeRoundTrip) return message;
        const bytes = NdjsonCodec.encode(message);
        const line =
          bytes[bytes.length - 1] === 10 ? bytes.subarray(0, -1) : bytes;
        return NdjsonCodec.decodeLine(line);
      }

      const client = adaptMessageTransport(a, {
        mapOutbound: maybeCodec,
      });
      const agent = adaptMessageTransport(b, {
        mapOutbound: maybeCodec,
      });

      return { client, agent };
    },
  };
}

function transportFromStdioStreams(
  stdin: Writable,
  stdout: Readable,
  onClose: () => Promise<TransportCloseReason>,
): AcpTransport {
  // Foundation NDJSON framer on the byte hot path (cumulating partial chunks).
  const framer = defineNdjsonFramer();

  type Q =
    | { ok: true; value: AcpMessage }
    | { ok: false; done: true }
    | { ok: false; error: unknown };
  const queue: Q[] = [];
  let wait: ((i: Q) => void) | undefined;
  let closedReason: TransportCloseReason | undefined;
  let resolveClosed!: (r: TransportCloseReason) => void;
  const closedP = new Promise<TransportCloseReason>((r) => {
    resolveClosed = r;
  });

  function enqueue(item: Q) {
    if (wait) {
      const w = wait;
      wait = undefined;
      w(item);
    } else {
      queue.push(item);
    }
  }

  const onData = (chunk: Buffer | Uint8Array) => {
    try {
      const bytes =
        chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const frames = framer.push(bytes);
      for (const frame of frames) {
        try {
          const msg = NdjsonCodec.decodeLine(frame);
          enqueue({ ok: true, value: msg });
        } catch (error) {
          enqueue({ ok: false, error });
        }
      }
    } catch (error) {
      enqueue({ ok: false, error });
    }
  };

  stdout.on("data", onData);
  stdout.on("error", (error) => {
    enqueue({ ok: false, error });
  });
  stdout.on("end", async () => {
    enqueue({ ok: false, done: true });
    if (!closedReason) {
      closedReason = await onClose();
      resolveClosed(closedReason);
    }
  });
  stdout.on("close", async () => {
    // Some streams fire close without end; avoid double-resolve.
    if (closedReason) return;
    enqueue({ ok: false, done: true });
    closedReason = await onClose();
    resolveClosed(closedReason);
  });

  return {
    async send(message: AcpMessage) {
      if (closedReason) throw new Error("AcpTransport closed");
      const bytes = NdjsonCodec.encode(message);
      await new Promise<void>((resolve, reject) => {
        stdin.write(bytes, (err) => (err ? reject(err) : resolve()));
      });
    },
    get messages() {
      return (async function* () {
        for (;;) {
          const item =
            queue.shift() ??
            (await new Promise<Q>((resolve) => {
              wait = resolve;
            }));
          if (!item.ok) {
            if ("error" in item) throw item.error;
            return;
          }
          yield item.value;
        }
      })();
    },
    async close() {
      if (closedReason) return;
      closedReason = { _tag: "Normal" };
      stdin.end();
      stdout.off("data", onData);
      framer.reset?.();
      enqueue({ ok: false, done: true });
      resolveClosed(closedReason);
    },
    get closed() {
      return closedP;
    },
  };
}

/**
 * Byte-edge transport over stdio NDJSON.
 * - spawn: host spawns agent child
 * - inherit: this process is the agent (stdin/stdout)
 * Framing underlay: foundation defineNdjsonFramer.
 */
export function defineStdioTransport(
  options:
    | {
        mode?: "spawn";
        command: string;
        args?: readonly string[];
        cwd?: string;
        env?: Record<string, string>;
      }
    | { mode: "inherit" },
): { connect(): Promise<AcpTransport> } {
  return {
    _tag: "StdioTransport" as const,
    async connect(): Promise<AcpTransport> {
      if (options.mode === "inherit") {
        return transportFromStdioStreams(
          process.stdout as unknown as Writable,
          process.stdin as unknown as Readable,
          async () => ({ _tag: "Normal" as const }),
        );
      }
      const command = options.command;
      const args = options.args ?? [];
      const child: ChildProcess = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "inherit"],
      });
      // Surface ENOENT / spawn failures as connect() rejection (not uncaught).
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          child.off("spawn", onSpawn);
          reject(err);
        };
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };
        child.once("error", onError);
        child.once("spawn", onSpawn);
        // If already failed synchronously, 'error' may have fired; check pid.
        if (child.pid !== undefined) {
          // spawn may still emit error later; keep listeners until one fires.
        }
      });
      if (!child.stdin || !child.stdout) {
        throw new Error("spawn did not provide stdio pipes");
      }
      return transportFromStdioStreams(child.stdin, child.stdout, async () => {
        const code = await new Promise<number | null>((resolve) => {
          child.once("exit", (c) => resolve(c));
          child.kill();
        });
        return { _tag: "ChildExit", code };
      });
    },
  };
}
