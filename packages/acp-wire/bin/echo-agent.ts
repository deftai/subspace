#!/usr/bin/env node
/**
 * Tiny stdio agent for option_c_dual_transport_echo Path C.
 *
 * Owns: readline loop over stdin NDJSON, `_echo` only, response/error writes
 * on stdout via NdjsonCodec.
 * Does not own: full ACP method surface, session lifecycle, or product agent logic.
 * Reads NDJSON on stdin, writes NDJSON on stdout — not a product agent.
 */
import { createInterface } from "node:readline";
import type { AcpMessage } from "../src/index.ts";
import { NdjsonCodec } from "../src/index.ts";

const te = new TextEncoder();

/**
 * Supported methods for this fixture agent.
 * Unknown methods fall through to a null result (not a JSON-RPC method-not-found).
 */
const handlers: Record<
  string,
  (params: unknown) => Promise<unknown> | unknown
> = {
  /** Round-trip test helper: echo optional n back with ok: true. */
  _echo(params: unknown) {
    const p = params as { n?: number };
    return { ok: true, n: p?.n };
  },
};

// Line-oriented stdin so partial TCP/pipe chunks do not matter to us.
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Request/response loop: ignore blank lines and non-requests; always reply to requests.
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = NdjsonCodec.decodeLine(te.encode(line));
  if (msg.kind !== "request") continue;
  const handler = handlers[msg.method];
  let out: AcpMessage;
  try {
    // Missing method → null result (fixture simplicity, not protocol error).
    const result = handler ? await handler(msg.params) : null;
    out = { kind: "response", id: msg.id, result };
  } catch (error) {
    // Handler throw → JSON-RPC-ish error object on the response.
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
