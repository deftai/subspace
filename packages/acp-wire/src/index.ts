/**
 * ACP wire — only package that moves AcpMessage values on the wire path.
 *
 * Owns: AcpMessage / AcpTransport shapes, JSON-RPC↔ACP mapping, NDJSON codec
 * stats, in-process linked channels (Option C), and stdio spawn/inherit transports.
 * Does not own: foundation duplex/framer implementations (composed from
 * @deft/subspace-foundation), session policy, or agent method handlers.
 *
 * Option C: structured in-process by default; NDJSON on byte edges;
 * optional encodeRoundTrip for parity CI.
 * Phase 1.5: foundation underlays for duplex + NDJSON framing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  defineMessagePair,
  defineNdjsonFramer,
  type MessageTransport,
  type CloseReason,
} from "@deft/subspace-foundation";

/** Discriminated ACP message: request, response, or notification (no JSON-RPC envelope). */
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

/**
 * Why an AcpTransport settled closed — tagged for host/agent policy.
 * ChildExit is stdio-spawn only; ChannelClosed is peer/underlay half-close.
 */
export type TransportCloseReason =
  | { readonly _tag: "Normal" }
  | { readonly _tag: "ChildExit"; code: number | null }
  | { readonly _tag: "ChannelClosed"; side: "send" | "recv" }
  | { readonly _tag: "Error"; error: Error };

/**
 * ACP-facing duplex: send messages, async-iterate inbound, await closed reason.
 * Higher layers should not see foundation MessageTransport or raw bytes.
 */
export interface AcpTransport {
  send(message: AcpMessage): Promise<void>;
  readonly messages: AsyncIterable<AcpMessage>;
  close(reason?: string): Promise<void>;
  readonly closed: Promise<TransportCloseReason>;
}

/**
 * Test hook: counts NdjsonCodec use for Option C encodeRoundTrip assertions.
 * Not for production metrics — mutable module state on purpose.
 */
export const codecStats = {
  encodeCalls: 0,
  decodeCalls: 0,
  /** Zero counters between cases so CI assertions stay independent. */
  reset() {
    this.encodeCalls = 0;
    this.decodeCalls = 0;
  },
};

/**
 * Map AcpMessage → JSON-RPC 2.0 object for wire encoding.
 * Notifications omit id; responses prefer error when both error and result exist.
 */
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
    // JSON-RPC allows either error or result, not both — error wins.
    if (message.error !== undefined) {
      return { jsonrpc: "2.0", id: message.id, error: message.error };
    }
    return { jsonrpc: "2.0", id: message.id, result: message.result ?? null };
  }
  // Notification: method present, id absent.
  return {
    jsonrpc: "2.0",
    method: message.method,
    ...(message.params !== undefined ? { params: message.params } : {}),
  };
}

/**
 * Map JSON-RPC 2.0 object → AcpMessage.
 * Classification: method+no id → notification; method+id → request; id only → response.
 */
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

/**
 * NDJSON line codec for AcpMessage on byte edges.
 * encode always appends newline; decodeLine strips trailing CR/LF and rejects empty.
 * Increments codecStats for Option C parity tests.
 */
export const NdjsonCodec = {
  /** Serialize message as one JSON-RPC line + \\n. */
  encode(message: AcpMessage): Uint8Array {
    codecStats.encodeCalls += 1;
    return te.encode(JSON.stringify(toJsonRpc(message)) + "\n");
  },
  /** Parse one line (with or without trailing newline) into AcpMessage. */
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
 *
 * Close tags: self close → Normal; peer/underlay → peerCloseReason (default
 * ChannelClosed recv) or Error when underlay CloseReason carries error.
 * Optional mapInbound/mapOutbound sit on the message path only (e.g. encodeRoundTrip).
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

  // closedReason is the single settlement; selfClosed disambiguates Normal vs peer.
  let selfClosed = false;
  let closedReason: TransportCloseReason | undefined;
  let resolveClosed!: (r: TransportCloseReason) => void;
  const closedP = new Promise<TransportCloseReason>((r) => {
    resolveClosed = r;
  });

  // Bridge foundation close → ACP tagged reason; first settlement wins.
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
    /** Fail fast after close so callers do not write into a dead underlay. */
    async send(message: AcpMessage) {
      if (closedReason) throw new Error("AcpTransport closed");
      await transport.send(mapOut(message));
    },
    get messages() {
      // Fresh generator each get — consumers must not share one iterator accidentally.
      return (async function* () {
        for await (const message of transport.readable) {
          yield mapIn(message);
        }
      })();
    },
    /**
     * Local close: mark Normal, close underlay, settle closed if not already.
     * Underlay may also settle via transport.closed; selfClosed keeps tag Normal.
     */
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
 * Option C default: structured messages across a foundation message pair (no JSON).
 * encodeRoundTrip: true → encode→decode on outbound before deliver (parity CI).
 * Underlay: defineMessagePair — single duplex implementation for both ends.
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
    /**
     * Create a fresh pair of adapted transports sharing one in-memory duplex.
     * Client is side a, agent is side b — both optional outbound codec pass.
     */
    connect() {
      const { a, b } = defineMessagePair<AcpMessage>();

      /**
       * When encodeRoundTrip is on, force NDJSON encode/decode so codec path
       * matches byte edges without leaving process memory.
       */
      function maybeCodec(message: AcpMessage): AcpMessage {
        if (!encodeRoundTrip) return message;
        const bytes = NdjsonCodec.encode(message);
        // encode appends \\n; decodeLine accepts with or without — strip for stability.
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

/**
 * Build AcpTransport over Writable stdin + Readable stdout NDJSON streams.
 * onClose supplies the tagged reason when the read side ends (peer death, inherit EOF, etc.).
 * Owns: framer, message queue, stream listeners; does not spawn processes.
 */
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

  /** Hand item to parked reader or buffer — same pattern as foundation pair. */
  function enqueue(item: Q) {
    if (wait) {
      const w = wait;
      wait = undefined;
      w(item);
    } else {
      queue.push(item);
    }
  }

  /**
   * Decode complete NDJSON frames from a chunk; per-frame errors enqueue as errors
   * so one bad line does not drop the whole stream buffer.
   */
  const onData = (chunk: Buffer | Uint8Array) => {
    try {
      // Normalize Buffer → Uint8Array view without copying when already typed.
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
    // Peer finished writing — end iterator and settle closed from onClose policy.
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
    /** Write one NDJSON line; reject if already closed. */
    async send(message: AcpMessage) {
      if (closedReason) throw new Error("AcpTransport closed");
      const bytes = NdjsonCodec.encode(message);
      await new Promise<void>((resolve, reject) => {
        stdin.write(bytes, (err) => (err ? reject(err) : resolve()));
      });
    },
    get messages() {
      // Pull from queue or park until enqueue — mirrors foundation readable.
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
    /**
     * Local teardown: Normal reason, end stdin, detach data, reset framer, wake readers.
     * Does not kill a child process — spawn mode's onClose may kill when streams end.
     */
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
 * - spawn: host spawns agent child (default when mode omitted)
 * - inherit: this process is the agent (stdin/stdout swapped for host-facing pipes)
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
    /**
     * Open the channel: inherit uses process stdio; spawn waits for child ready.
     * Spawn failures (ENOENT etc.) reject connect() rather than uncaught errors.
     */
    async connect(): Promise<AcpTransport> {
      if (options.mode === "inherit") {
        // Agent role: host writes our stdin; we write responses on stdout.
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
      // Host role: write child.stdin, read child.stdout; onClose kills and tags ChildExit.
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
