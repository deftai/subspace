#!/usr/bin/env node
/**
 * Stdio session-echo agent for phase-2 product tests.
 *
 * Owns: NDJSON stdio loop, reverse-RPC pending map, and wiring
 * defineSessionEchoHandlers to process.stdout/stdin.
 * Does not own: session semantics (handlers in package src) or host product.
 * Implements session/new|load|prompt|cancel; reverse-requests permissions.
 */
import { createInterface } from "node:readline";
import {
  type AcpMessage,
  NdjsonCodec,
} from "../../acp-wire/src/index.ts";
import { defineSessionEchoHandlers } from "../src/index.ts";

const te = new TextEncoder();

// High outbound ids avoid colliding with typical host-assigned request ids
let nextOutId = 9000;
const pending = new Map<
  string | number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

/** Encode one ACP message as NDJSON on stdout (agent → host). */
function writeMsg(msg: AcpMessage) {
  process.stdout.write(NdjsonCodec.encode(msg));
}

// Bridge uses the same pending map as the pump so reverse RPC completes on response lines
const handlers = defineSessionEchoHandlers({
  async notify(method, params) {
    writeMsg({ kind: "notification", method, params });
  },
  async request(method, params) {
    const id = nextOutId++;
    return new Promise((resolve, reject) => {
      // Register before write so a fast host response cannot race the map
      pending.set(id, { resolve, reject });
      writeMsg({ kind: "request", id, method, params });
    });
  },
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Line-oriented pump: one NDJSON object per line until stdin ends
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg: AcpMessage;
  try {
    msg = NdjsonCodec.decodeLine(te.encode(line));
  } catch {
    // Malformed line: skip rather than crash the fixture process
    continue;
  }

  // Complete reverse RPC when the host answers our request
  if (msg.kind === "response") {
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
    // Isolate per-request errors so one handler failure doesn't kill the loop
    try {
      const result = handler ? await handler(msg.params) : null;
      writeMsg({ kind: "response", id: reqId, result });
    } catch (error) {
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
