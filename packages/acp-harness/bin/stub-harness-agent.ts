#!/usr/bin/env node
/**
 * Stdio stub harness agent — Path A early cut.
 *
 * Owns: NDJSON stdio loop + HarnessBridge so defineHarnessHandlers can notify
 * the host. Brain is StubModelAdapter (no network). Spawns like session-echo.
 * Does not own product client or wire channel factories.
 */
import { createInterface } from "node:readline";
import {
  type AcpMessage,
  NdjsonCodec,
} from "../../acp-wire/src/index.ts";
import {
  defineHarnessHandlers,
  type HarnessBridge,
} from "../src/index.ts";

const te = new TextEncoder();

/** Outbound request ids for agent→host RPC (permission-style); avoid host id clash. */
let nextOutId = 9000;
const pending = new Map<
  string | number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

/** Encode one ACP message as a single NDJSON line on stdout. */
function writeMsg(msg: AcpMessage) {
  process.stdout.write(NdjsonCodec.encode(msg));
}

/**
 * Minimal bridge over stdio: notifications fire-and-forget; requests await
 * matching response lines on the same stream.
 */
const bridge: HarnessBridge = {
  async notify(method, params) {
    writeMsg({ kind: "notification", method, params });
  },
  async request(method, params) {
    const id = nextOutId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      writeMsg({ kind: "request", id, method, params });
    });
  },
};

const handlers = defineHarnessHandlers(bridge);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Line-oriented ACP: one message per line; concurrent handlers so cancel can race prompt
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg: AcpMessage;
  try {
    msg = NdjsonCodec.decodeLine(te.encode(line));
  } catch {
    // Malformed lines are ignored — keep the agent alive for the host
    continue;
  }

  if (msg.kind === "response") {
    // Complete hostward request() promises from bridge.request
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(msg.error);
    else p.resolve(msg.result);
    continue;
  }

  if (msg.kind !== "request") continue;
  // Concurrent dispatch so session/cancel can interrupt an in-flight prompt
  const handler = handlers[msg.method];
  const reqId = msg.id;
  void (async () => {
    try {
      const result = handler ? await handler(msg.params) : null;
      writeMsg({ kind: "response", id: reqId, result });
    } catch (error) {
      // Surface handler failures as JSON-RPC errors without killing the process
      writeMsg({
        kind: "response",
        id: reqId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })();
}
