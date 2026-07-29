#!/usr/bin/env node
/**
 * Stdio session-echo agent for phase-2 product tests.
 * Implements session/new|load|prompt|cancel; reverse-requests permissions.
 * Handlers live in defineSessionEchoHandlers (shared helpers).
 */
import { createInterface } from "node:readline";
import {
  type AcpMessage,
  NdjsonCodec,
} from "../../acp-wire/src/index.ts";
import { defineSessionEchoHandlers } from "../src/index.ts";

const te = new TextEncoder();

let nextOutId = 9000;
const pending = new Map<
  string | number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();

function writeMsg(msg: AcpMessage) {
  process.stdout.write(NdjsonCodec.encode(msg));
}

const handlers = defineSessionEchoHandlers({
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
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let msg: AcpMessage;
  try {
    msg = NdjsonCodec.decodeLine(te.encode(line));
  } catch {
    continue;
  }

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
