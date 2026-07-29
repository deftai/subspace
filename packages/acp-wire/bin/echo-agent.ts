#!/usr/bin/env node
/**
 * Tiny stdio agent for option_c_dual_transport_echo Path C.
 * Implements _echo only — not a product agent.
 * Reads NDJSON on stdin, writes NDJSON on stdout.
 */
import { createInterface } from "node:readline";
import type { AcpMessage } from "../src/index.ts";
import { NdjsonCodec } from "../src/index.ts";

const te = new TextEncoder();

const handlers: Record<
  string,
  (params: unknown) => Promise<unknown> | unknown
> = {
  _echo(params: unknown) {
    const p = params as { n?: number };
    return { ok: true, n: p?.n };
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = NdjsonCodec.decodeLine(te.encode(line));
  if (msg.kind !== "request") continue;
  const handler = handlers[msg.method];
  let out: AcpMessage;
  try {
    const result = handler ? await handler(msg.params) : null;
    out = { kind: "response", id: msg.id, result };
  } catch (error) {
    out = {
      kind: "response",
      id: msg.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  process.stdout.write(NdjsonCodec.encode(out));
}
