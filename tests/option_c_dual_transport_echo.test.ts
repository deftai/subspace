/**
 * option_c_dual_transport_echo — smallest dual-transport proof for Option C.
 *
 * Paths: A linked structured · B linked encodeRoundTrip · C stdio spawn.
 * Invariant: same _echo RPC works on all three; codecStats distinguishes A vs B/C.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defineLinkedChannels,
  defineStdioTransport,
  codecStats,
} from "../packages/acp-wire/src/index.ts";
import { defineAcpClient } from "../packages/acp-client/src/index.ts";
import { defineAcpServer } from "../packages/acp-agent/src/index.ts";

/** Minimal handler set — proves request routing without session product. */
const echoHandlers = {
  _echo(params: unknown) {
    const p = params as { n?: number };
    return { ok: true, n: p?.n };
  },
};

describe("option_c_dual_transport_echo", () => {
  beforeEach(() => {
    // Isolation: codec call counts must not accumulate across cases
    codecStats.reset();
  });

  it("Path A — linked structured (no JSON hop)", async () => {
    // Structured path must never touch encode/decode counters
    const { client: cT, agent: aT } = defineLinkedChannels().connect();
    const server = await defineAcpServer({ handlers: echoHandlers }).listen(aT);
    const client = await defineAcpClient().connect(cT);

    const result = await client.request("_echo", { n: 1 });
    assert.deepEqual(result, { ok: true, n: 1 });
    assert.equal(codecStats.encodeCalls, 0, "structured path must not encode");
    assert.equal(codecStats.decodeCalls, 0, "structured path must not decode");

    await client.close();
    await server.close();
  });

  it("Path B — linked encodeRoundTrip parity", async () => {
    // Same linked channels but force codec so A/B diverge only on stats
    const { client: cT, agent: aT } = defineLinkedChannels({
      encodeRoundTrip: true,
    }).connect();
    const server = await defineAcpServer({ handlers: echoHandlers }).listen(aT);
    const client = await defineAcpClient().connect(cT);

    const result = await client.request("_echo", { n: 2 });
    assert.deepEqual(result, { ok: true, n: 2 });
    assert.ok(codecStats.encodeCalls >= 1, "parity path encodes");
    assert.ok(codecStats.decodeCalls >= 1, "parity path decodes");
    assert.equal(
      codecStats.encodeCalls,
      codecStats.decodeCalls,
      "encode/decode pair counts",
    );

    await client.close();
    await server.close();
  });

  it("Path C — stdio spawn NDJSON", async () => {
    // Real process boundary using wire package echo-agent fixture
    const root = path.dirname(fileURLToPath(import.meta.url));
    const agentScript = path.resolve(
      root,
      "../packages/acp-wire/bin/echo-agent.ts",
    );
    const transport = await defineStdioTransport({
      mode: "spawn",
      command: process.execPath,
      args: ["--experimental-strip-types", agentScript],
    }).connect();

    const client = await defineAcpClient().connect(transport);
    const result = await client.request("_echo", { n: 3 });
    assert.deepEqual(result, { ok: true, n: 3 });
    assert.ok(codecStats.encodeCalls >= 1);
    assert.ok(codecStats.decodeCalls >= 1);

    await client.close();
  });
});
