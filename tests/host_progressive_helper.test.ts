/**
 * Host progressive helpers: demuxAgentEvents, runAcpTurn, runAcpStdioTurn.
 * Additive surface — does not replace product path.
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
  demuxAgentEvents,
  runAcpStdioTurn,
  runAcpTurn,
  type AgentEvent,
} from "../packages/acp-client/src/index.ts";
import { listenSessionEcho } from "../packages/acp-agent/src/index.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const echoAgent = path.resolve(
  root,
  "../packages/acp-agent/bin/session-echo-agent.ts",
);

function textFromUpdate(event: AgentEvent): string | undefined {
  if (event.type !== "update") return undefined;
  const u = event.update as { content?: { text?: string } };
  return u?.content?.text;
}

describe("host_progressive_helper", () => {
  it("demuxAgentEvents alone on raw product path", async () => {
    const { client: cT, agent: aT } = defineLinkedChannels().connect();
    const server = await listenSessionEcho(aT);
    const product = await defineAcpClientProduct({
      permissionPolicy: "deny",
    }).connect(cT);

    const session = await product.sessions.create();
    const updates: string[] = [];
    const demuxed = await demuxAgentEvents(session.prompt("raw-demux"), {
      onUpdate: (e) => {
        const t = textFromUpdate(e);
        if (t) updates.push(t);
      },
    });

    assert.ok(demuxed.events.some((e) => e.type === "update"));
    assert.ok(demuxed.events.some((e) => e.type === "prompt_done"));
    assert.equal(
      (demuxed.result as { stopReason?: string } | undefined)?.stopReason,
      "end_turn",
    );
    assert.ok(updates.some((t) => t.includes("raw-demux")));

    await product.close();
    await server.close();
  });

  it("runAcpStdioTurn — one prompt completes with update/done", async () => {
    const out = await runAcpStdioTurn({
      spawn: {
        command: process.execPath,
        args: ["--experimental-strip-types", echoAgent],
      },
      session: { key: "stdio-helper", cwd: process.cwd() },
      prompt: "stdio-hi",
    });

    assert.ok(out.events.some((e) => e.type === "update"));
    assert.ok(out.events.some((e) => e.type === "prompt_done"));
    assert.ok(
      out.events.some(
        (e) => e.type === "update" && textFromUpdate(e)?.includes("stdio-hi"),
      ),
    );
    assert.equal(
      (out.result as { stopReason?: string } | undefined)?.stopReason,
      "end_turn",
    );
  });

  it("runAcpStdioTurn — callbacks fire with real payloads", async () => {
    const seenUpdates: unknown[] = [];
    let doneResult: unknown;
    const out = await runAcpStdioTurn({
      spawn: {
        command: process.execPath,
        args: ["--experimental-strip-types", echoAgent],
      },
      session: { key: "cb", cwd: process.cwd() },
      prompt: "cb-prompt",
      onUpdate: (e) => seenUpdates.push(e.update),
      onPromptDone: (e) => {
        doneResult = e.result;
      },
    });

    assert.ok(seenUpdates.length >= 1);
    assert.ok(doneResult !== undefined);
    assert.equal(
      (doneResult as { stopReason?: string }).stopReason,
      "end_turn",
    );
    assert.ok(out.events.length >= 2);
  });

  it('close: "always" (default) — two independent stdio turns ok', async () => {
    const a = await runAcpStdioTurn({
      spawn: {
        command: process.execPath,
        args: ["--experimental-strip-types", echoAgent],
      },
      session: { key: "a1", cwd: process.cwd() },
      prompt: "first-turn",
      // default close: "always"
    });
    assert.ok(a.events.some((e) => e.type === "prompt_done"));

    // Second separate call (new spawn) — no leak of the first product
    const b = await runAcpStdioTurn({
      spawn: {
        command: process.execPath,
        args: ["--experimental-strip-types", echoAgent],
      },
      session: { key: "a2", cwd: process.cwd() },
      prompt: "second-turn",
    });
    assert.ok(
      b.events.some(
        (e) =>
          e.type === "update" && textFromUpdate(e)?.includes("second-turn"),
      ),
    );
  });

  it('close: "never" — second prompt works; caller closes product', async () => {
    const transport = await defineStdioTransport({
      mode: "spawn",
      command: process.execPath,
      args: ["--experimental-strip-types", echoAgent],
    }).connect();

    const first = await runAcpTurn({
      transport,
      session: { key: "multi", cwd: process.cwd() },
      prompt: "turn-1",
      close: "never",
    });
    assert.ok(first.events.some((e) => e.type === "prompt_done"));

    const second = await demuxAgentEvents(first.session.prompt("turn-2"));
    assert.ok(
      second.events.some(
        (e) => e.type === "update" && textFromUpdate(e)?.includes("turn-2"),
      ),
    );
    assert.ok(second.events.some((e) => e.type === "prompt_done"));

    await first.product.close();
  });

  it("runAcpTurn on linked transport", async () => {
    const { client: cT, agent: aT } = defineLinkedChannels().connect();
    const server = await listenSessionEcho(aT);
    const out = await runAcpTurn({
      transport: cT,
      session: { key: "linked", cwd: "/tmp" },
      prompt: "linked-helper",
      close: "always",
    });
    assert.ok(
      out.events.some(
        (e) =>
          e.type === "update" && textFromUpdate(e)?.includes("linked-helper"),
      ),
    );
    await server.close();
  });

  it("runAcpTurn — initialize failure closes transport when close always", async () => {
    // Agent rejects initialize but does not close — helper must close transport.
    const { client: cT, agent: aT } = defineLinkedChannels().connect();
    void (async () => {
      for await (const msg of aT.messages) {
        if (msg.kind === "request" && msg.method === "initialize") {
          await aT.send({
            kind: "response",
            id: msg.id,
            error: { code: -32000, message: "initialize refused" },
          });
        }
      }
    })();

    await assert.rejects(
      () =>
        runAcpTurn({
          transport: cT,
          session: { key: "fail-init", cwd: process.cwd() },
          prompt: "nope",
          close: "always",
        }),
      /initialize refused/,
    );

    const reason = await Promise.race([
      cT.closed,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("transport not closed")), 2000),
      ),
    ]);
    assert.ok(reason);
    await aT.close().catch(() => undefined);
  });

  it("demuxAgentEvents awaits async handlers in stream order", async () => {
    const { client: cT, agent: aT } = defineLinkedChannels().connect();
    const server = await listenSessionEcho(aT);
    const product = await defineAcpClientProduct({
      permissionPolicy: "deny",
    }).connect(cT);
    const session = await product.sessions.create();
    const order: string[] = [];
    await demuxAgentEvents(session.prompt("async-handlers"), {
      onUpdate: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("update");
      },
      onPromptDone: async () => {
        order.push("done");
      },
    });
    assert.ok(order.includes("update"));
    assert.ok(order.includes("done"));
    assert.ok(order.indexOf("update") < order.indexOf("done"));
    await product.close();
    await server.close();
  });
});
