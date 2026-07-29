/**
 * Phase 2 done-when: session product on linked + stdio.
 *
 * Gates: create/load, multi-turn stream, cancel mid-prompt, permissions, soft-close.
 * Uses listenSessionEcho fixture — product path only; not the Path A harness.
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
import { listenSessionEcho } from "../packages/acp-agent/src/index.ts";

/** Collect streamed update texts for substring asserts on echo fixture. */
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
 * Linked client product + session-echo server with a fixed permission policy.
 * Shared setup so each case only varies the scenario under test.
 */
async function runLinkedScenario(permissionPolicy: "deny" | "approve-reads") {
  const { client: cT, agent: aT } = defineLinkedChannels().connect();
  const server = await listenSessionEcho(aT);
  const product = await defineAcpClientProduct({
    permissionPolicy,
  }).connect(cT);
  return { product, server };
}

describe("phase2_session_product", () => {
  it("linked — create/load multi-turn prompt stream", async () => {
    // localId vs acpSessionId identity + store round-trip + turn counter in stream
    const { product, server } = await runLinkedScenario("deny");

    const session = await product.sessions.create({
      cwd: "/tmp",
      providerId: "prov-1",
    });
    assert.ok(session.localId);
    assert.ok(session.acpSessionId);
    assert.notEqual(session.localId, session.acpSessionId);
    assert.equal(session.providerId, "prov-1");

    const storeRec = product.store.getByAcpId(session.acpSessionId);
    assert.ok(storeRec);
    assert.equal(storeRec.localId, session.localId);
    assert.equal(storeRec.providerId, "prov-1");

    const turn1 = await collectEvents(session.prompt("hello"));
    assert.ok(turn1.some((e) => e.type === "update"));
    assert.ok(turn1.some((e) => e.type === "prompt_done"));
    assert.ok(textChunks(turn1).some((t) => t.includes("turn:1:hello")));

    const turn2 = await collectEvents(session.prompt("again"));
    assert.ok(textChunks(turn2).some((t) => t.includes("turn:2:again")));

    const loaded = await product.sessions.load(session.acpSessionId);
    assert.equal(loaded.acpSessionId, session.acpSessionId);
    assert.equal(loaded.localId, session.localId);

    await product.close();
    await server.close();
  });

  it("linked — ensure + soft-close resume", async () => {
    // ensure is idempotent by key; softClose must not drop acpSessionId on resume
    const { product, server } = await runLinkedScenario("deny");

    const a = await product.sessions.ensure("workspace-a", { cwd: "/a" });
    const b = await product.sessions.ensure("workspace-a");
    assert.equal(a.acpSessionId, b.acpSessionId);
    assert.equal(a.localId, b.localId);

    await a.softClose();
    assert.equal(product.store.getByLocalId(a.localId)?.softClosed, true);

    const resumed = await product.sessions.ensure("workspace-a");
    assert.equal(resumed.acpSessionId, a.acpSessionId);
    assert.equal(product.store.getByLocalId(a.localId)?.softClosed, false);

    const after = await collectEvents(resumed.prompt("post-soft"));
    assert.ok(after.some((e) => e.type === "prompt_done"));

    await product.close();
    await server.close();
  });

  it("linked — cancel mid-prompt does not kill session", async () => {
    // cancel returns stopReason cancelled; next prompt must still work
    const { product, server } = await runLinkedScenario("deny");
    const session = await product.sessions.create();

    const eventsPromise = collectEvents(session.prompt("slow"));
    // Let a few chunks land, then cancel
    await new Promise((r) => setTimeout(r, 50));
    await session.cancel();
    const events = await eventsPromise;

    const done = events.find((e) => e.type === "prompt_done");
    assert.ok(done, "prompt should complete after cancel");
    const result = (done as { result: { stopReason?: string } }).result;
    assert.equal(result?.stopReason, "cancelled");

    // Session still usable for another turn
    const next = await collectEvents(session.prompt("alive"));
    assert.ok(textChunks(next).some((t) => t.includes("alive")));
    assert.ok(next.some((e) => e.type === "prompt_done"));

    await product.close();
    await server.close();
  });

  it("linked — permission reverse map deny / approve-reads (never approve-all)", async () => {
    // Two policies in one case: deny all, then approve-reads (write still denied)
    {
      const { product, server } = await runLinkedScenario("deny");
      const session = await product.sessions.create();
      const events = await collectEvents(session.prompt("need-perm"));
      const perms = events.filter((e) => e.type === "permission");
      assert.ok(perms.length >= 1);
      assert.equal(perms[0]!.type, "permission");
      if (perms[0]!.type === "permission") {
        assert.equal(perms[0]!.outcome, "denied");
      }
      const chunks = textChunks(events).join("\n");
      assert.ok(chunks.includes("cancelled") || chunks.includes("perm:"));
      await product.close();
      await server.close();
    }
    {
      const { product, server } = await runLinkedScenario("approve-reads");
      const session = await product.sessions.create();
      const readEvents = await collectEvents(session.prompt("need-perm"));
      const readPerms = readEvents.filter((e) => e.type === "permission");
      assert.ok(readPerms.length >= 1);
      if (readPerms[0]!.type === "permission") {
        assert.equal(readPerms[0]!.outcome, "allowed");
      }

      const writeEvents = await collectEvents(session.prompt("need-perm-write"));
      const writePerms = writeEvents.filter((e) => e.type === "permission");
      assert.ok(writePerms.length >= 1);
      if (writePerms[0]!.type === "permission") {
        assert.equal(writePerms[0]!.outcome, "denied");
      }

      await product.close();
      await server.close();
    }
  });

  it("stdio — multi-turn + cancel without process death", async () => {
    // Process boundary: cancel must not exit the child; permissions still reverse
    const root = path.dirname(fileURLToPath(import.meta.url));
    const agentScript = path.resolve(
      root,
      "../packages/acp-agent/bin/session-echo-agent.ts",
    );
    const transport = await defineStdioTransport({
      mode: "spawn",
      command: process.execPath,
      args: ["--experimental-strip-types", agentScript],
    }).connect();

    const product = await defineAcpClientProduct({
      permissionPolicy: "approve-reads",
    }).connect(transport);

    const session = await product.sessions.create({ providerId: "stdio" });
    assert.notEqual(session.localId, session.acpSessionId);

    const t1 = await collectEvents(session.prompt("stdio-hi"));
    assert.ok(textChunks(t1).some((t) => t.includes("stdio-hi")));
    assert.ok(t1.some((e) => e.type === "prompt_done"));

    const t2 = await collectEvents(session.prompt("stdio-2"));
    assert.ok(textChunks(t2).some((t) => t.includes("turn:2:stdio-2")));

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

    // Process/session still alive for another turn
    const alive = await collectEvents(session.prompt("still-here"));
    assert.ok(textChunks(alive).some((t) => t.includes("still-here")));

    const perm = await collectEvents(session.prompt("need-perm"));
    assert.ok(perm.some((e) => e.type === "permission"));

    await product.close();
  });
});
