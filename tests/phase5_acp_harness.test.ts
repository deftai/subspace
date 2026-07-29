/**
 * Phase 5 early harness done-when:
 * linked turn + stream, stdio turn, cancel, stub model (no network).
 *
 * Exercises @deft/acp-harness (StubModelAdapter + listenHarness / defineHarness)
 * via client product — not session-echo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defineLinkedChannels,
  defineStdioTransport,
} from "../packages/acp-wire/src/index.ts";
import {
  defineAcpClientProduct,
  collectEvents,
  type AgentEvent,
} from "../packages/acp-client/src/index.ts";
import {
  defineHarness,
  listenHarness,
  StubModelAdapter,
} from "../packages/acp-harness/src/index.ts";

/** Collect streamed update texts for stub: prefix asserts. */
function textChunks(events: AgentEvent[]): string[] {
  return events
    .filter((e) => e.type === "update")
    .map((e) => {
      const u = e.update as {
        content?: { text?: string };
      };
      return u?.content?.text ?? JSON.stringify(e.update);
    });
}

/**
 * Linked product against listenHarness with optional model override.
 * Default stub + system instructions prove options plumbing.
 */
async function runLinked(model?: StubModelAdapter) {
  const { client: cT, agent: aT } = defineLinkedChannels().connect();
  const server = await listenHarness(aT, {
    model: model ?? new StubModelAdapter(),
    instructions: "you are a stub harness",
  });
  const product = await defineAcpClientProduct({
    permissionPolicy: "deny",
  }).connect(cT);
  return { product, server };
}

describe("phase5_acp_harness", () => {
  it("linked — initialize + prompt streams stub model chunk", async () => {
    // Deterministic stub:hello and multi-turn stub:again without network
    const { product, server } = await runLinked();
    const session = await product.sessions.create({
      cwd: "/tmp",
      providerId: "harness-stub",
    });
    assert.ok(session.acpSessionId);
    assert.notEqual(session.localId, session.acpSessionId);

    const events = await collectEvents(session.prompt("hello"));
    assert.ok(events.some((e) => e.type === "update"), "streamed update");
    assert.ok(events.some((e) => e.type === "prompt_done"), "turn completed");
    const chunks = textChunks(events).join("\n");
    assert.ok(
      chunks.includes("stub:hello"),
      `expected stub:hello in chunks, got: ${chunks}`,
    );

    const done = events.find((e) => e.type === "prompt_done");
    assert.equal(
      (done as { result: { stopReason?: string } }).result?.stopReason,
      "end_turn",
    );

    // Multi-turn keeps going
    const t2 = await collectEvents(session.prompt("again"));
    assert.ok(textChunks(t2).some((t) => t.includes("stub:again")));

    await product.close();
    await server.close();
  });

  it("linked — cancel mid-stream stopReason cancelled; session still usable", async () => {
    // "slow" stub stream is the cancel proof path for the harness
    const { product, server } = await runLinked();
    const session = await product.sessions.create();

    const eventsPromise = collectEvents(session.prompt("slow"));
    await new Promise((r) => setTimeout(r, 50));
    await session.cancel();
    const events = await eventsPromise;

    const done = events.find((e) => e.type === "prompt_done");
    assert.ok(done, "prompt should complete after cancel");
    assert.equal(
      (done as { result: { stopReason?: string } }).result?.stopReason,
      "cancelled",
    );

    const next = await collectEvents(session.prompt("alive"));
    assert.ok(textChunks(next).some((t) => t.includes("stub:alive")));
    assert.ok(next.some((e) => e.type === "prompt_done"));

    await product.close();
    await server.close();
  });

  it("linked — defineHarness factory wires the same path", async () => {
    // Factory prefix override proves options flow through defineHarness.listen
    const { client: cT, agent: aT } = defineLinkedChannels().connect();
    const server = await defineHarness({
      model: new StubModelAdapter({ prefix: "hx" }),
    }).listen(aT);
    const product = await defineAcpClientProduct({
      permissionPolicy: "deny",
    }).connect(cT);

    const session = await product.sessions.create();
    const events = await collectEvents(session.prompt("factory"));
    assert.ok(textChunks(events).some((t) => t.includes("hx:factory")));

    await product.close();
    await server.close();
  });

  it("stdio — prompt + cancel without process death", async () => {
    // stub-harness-agent.bin is the stdio peer for Path A early cut
    const root = path.dirname(fileURLToPath(import.meta.url));
    const agentScript = path.resolve(
      root,
      "../packages/acp-harness/bin/stub-harness-agent.ts",
    );
    const transport = await defineStdioTransport({
      mode: "spawn",
      command: process.execPath,
      args: ["--experimental-strip-types", agentScript],
    }).connect();

    const product = await defineAcpClientProduct({
      permissionPolicy: "deny",
    }).connect(transport);

    const session = await product.sessions.create({ providerId: "stdio-h" });
    const t1 = await collectEvents(session.prompt("stdio-hi"));
    assert.ok(textChunks(t1).some((t) => t.includes("stub:stdio-hi")));
    assert.ok(t1.some((e) => e.type === "prompt_done"));

    const slowP = collectEvents(session.prompt("slow"));
    await new Promise((r) => setTimeout(r, 50));
    await session.cancel();
    const slowEvents = await slowP;
    const done = slowEvents.find((e) => e.type === "prompt_done");
    assert.ok(done);
    assert.equal(
      (done as { result: { stopReason?: string } }).result?.stopReason,
      "cancelled",
    );

    const alive = await collectEvents(session.prompt("still-here"));
    assert.ok(textChunks(alive).some((t) => t.includes("stub:still-here")));

    await product.close();
  });
});
