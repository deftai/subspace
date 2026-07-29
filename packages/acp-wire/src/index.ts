/**
 * ACP wire — only package that moves AcpMessage values.
 * Option C: structured in-process; NDJSON on byte edges; optional encodeRoundTrip.
 */

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

type QueueItem =
  | { ok: true; value: AcpMessage }
  | { ok: false; done: true }
  | { ok: false; error: unknown };

function createQueuePair() {
  const ab: QueueItem[] = [];
  const ba: QueueItem[] = [];
  const abWait: { current?: (i: QueueItem) => void } = {};
  const baWait: { current?: (i: QueueItem) => void } = {};

  function push(
    q: QueueItem[],
    w: { current?: (i: QueueItem) => void },
    item: QueueItem,
  ) {
    if (w.current) {
      const fn = w.current;
      w.current = undefined;
      fn(item);
    } else {
      q.push(item);
    }
  }

  async function* read(
    q: QueueItem[],
    w: { current?: (i: QueueItem) => void },
  ): AsyncGenerator<AcpMessage> {
    for (;;) {
      const item =
        q.shift() ??
        (await new Promise<QueueItem>((resolve) => {
          w.current = resolve;
        }));
      if (!item.ok) {
        if ("error" in item) throw item.error;
        return;
      }
      yield item.value;
    }
  }

  return { ab, ba, abWait, baWait, push, read };
}

/**
 * Option C default: structured messages, no JSON.
 * encodeRoundTrip: true → encode→decode before deliver (parity CI).
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
      const { ab, ba, abWait, baWait, push, read } = createQueuePair();
      let clientClosed: TransportCloseReason | undefined;
      let agentClosed: TransportCloseReason | undefined;
      let resolveClientClosed!: (r: TransportCloseReason) => void;
      let resolveAgentClosed!: (r: TransportCloseReason) => void;
      const clientClosedP = new Promise<TransportCloseReason>((r) => {
        resolveClientClosed = r;
      });
      const agentClosedP = new Promise<TransportCloseReason>((r) => {
        resolveAgentClosed = r;
      });

      function maybeCodec(message: AcpMessage): AcpMessage {
        if (!encodeRoundTrip) return message;
        const bytes = NdjsonCodec.encode(message);
        // strip trailing newline for decodeLine contract
        const line =
          bytes[bytes.length - 1] === 10 ? bytes.subarray(0, -1) : bytes;
        return NdjsonCodec.decodeLine(line);
      }

      function make(
        sendQ: QueueItem[],
        sendW: { current?: (i: QueueItem) => void },
        recvQ: QueueItem[],
        recvW: { current?: (i: QueueItem) => void },
        getClosed: () => TransportCloseReason | undefined,
        setClosed: (r: TransportCloseReason) => void,
        resolveClosed: (r: TransportCloseReason) => void,
        closedP: Promise<TransportCloseReason>,
        peerDone: () => void,
      ): AcpTransport {
        return {
          async send(message: AcpMessage) {
            if (getClosed()) throw new Error("AcpTransport closed");
            push(sendQ, sendW, { ok: true, value: maybeCodec(message) });
          },
          get messages() {
            return read(recvQ, recvW);
          },
          async close() {
            if (getClosed()) return;
            const reason: TransportCloseReason = { _tag: "Normal" };
            setClosed(reason);
            push(recvQ, recvW, { ok: false, done: true });
            peerDone();
            resolveClosed(reason);
          },
          get closed() {
            return closedP;
          },
        };
      }

      const client = make(
        ab,
        abWait,
        ba,
        baWait,
        () => clientClosed,
        (r) => {
          clientClosed = r;
        },
        resolveClientClosed,
        clientClosedP,
        () => {
          if (!agentClosed) {
            agentClosed = { _tag: "ChannelClosed", side: "recv" };
            push(ab, abWait, { ok: false, done: true });
            resolveAgentClosed(agentClosed);
          }
        },
      );

      const agent = make(
        ba,
        baWait,
        ab,
        abWait,
        () => agentClosed,
        (r) => {
          agentClosed = r;
        },
        resolveAgentClosed,
        agentClosedP,
        () => {
          if (!clientClosed) {
            clientClosed = { _tag: "ChannelClosed", side: "recv" };
            push(ba, baWait, { ok: false, done: true });
            resolveClientClosed(clientClosed);
          }
        },
      );

      return { client, agent };
    },
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

function transportFromStdioStreams(
  stdin: Writable,
  stdout: Readable,
  onClose: () => Promise<TransportCloseReason>,
): AcpTransport {
  const pending = new Map<
    string | number,
    { resolve: (m: AcpMessage) => void; reject: (e: unknown) => void }
  >();
  // fan-out queue for all messages
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

  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    try {
      if (!line.trim()) return;
      const msg = NdjsonCodec.decodeLine(te.encode(line));
      enqueue({ ok: true, value: msg });
    } catch (error) {
      enqueue({ ok: false, error });
    }
  });
  rl.on("close", async () => {
    enqueue({ ok: false, done: true });
    if (!closedReason) {
      closedReason = await onClose();
      resolveClosed(closedReason);
    }
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
      rl.close();
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
