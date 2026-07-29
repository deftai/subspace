/**
 * Minimum phase-4 scenarios — importable, product-only (no second client).
 *
 * 1. multi-turn create → prompt → updates → second turn
 * 2. cancel mid-prompt; session survives
 * 3. permission reverse: deny + approve-reads (never approve-all)
 */
import {
  collectEvents,
  type AcpClientProduct,
} from "@deft/acp-client";
import {
  assertCancelled,
  assertHasUpdate,
  assertPermissionOutcome,
  assertPromptDone,
  assertTextIncludes,
  textChunks,
} from "./assert.ts";
import {
  withLinkedProduct,
  withStdioProduct,
  type ProductHarness,
  type TestkitPermissionPolicy,
} from "./harness.ts";

export type ScenarioName =
  | "multi-turn"
  | "cancel-mid-prompt"
  | "permission-reverse";

export type ScenarioResult = {
  name: ScenarioName;
  mode: "linked" | "stdio";
  ok: true;
};

/** Multi-turn: create, two prompts with demuxed updates, load same session. */
export async function runMultiTurn(
  product: AcpClientProduct,
): Promise<void> {
  const session = await product.sessions.create({
    cwd: "/tmp",
    providerId: "testkit",
  });
  if (!session.localId || !session.acpSessionId) {
    throw new Error("session missing ids");
  }
  if (session.localId === session.acpSessionId) {
    throw new Error("localId must differ from acpSessionId");
  }

  const turn1 = await collectEvents(session.prompt("hello"));
  assertHasUpdate(turn1);
  assertPromptDone(turn1);
  assertTextIncludes(turn1, "turn:1:hello");

  const turn2 = await collectEvents(session.prompt("again"));
  assertHasUpdate(turn2);
  assertPromptDone(turn2);
  assertTextIncludes(turn2, "turn:2:again");

  const loaded = await product.sessions.load(session.acpSessionId);
  if (loaded.acpSessionId !== session.acpSessionId) {
    throw new Error("load returned different acpSessionId");
  }
  if (loaded.localId !== session.localId) {
    throw new Error("load returned different localId");
  }
}

/** Cancel mid-prompt; session remains usable for a follow-up turn. */
export async function runCancelMidPrompt(
  product: AcpClientProduct,
): Promise<void> {
  const session = await product.sessions.create();
  const eventsPromise = collectEvents(session.prompt("slow"));
  await new Promise((r) => setTimeout(r, 50));
  await session.cancel();
  const events = await eventsPromise;
  assertCancelled(events);

  const next = await collectEvents(session.prompt("alive"));
  assertTextIncludes(next, "alive");
  assertPromptDone(next);
}

/**
 * Permission reverse map: deny policy denies reads; approve-reads allows
 * reads and still denies writes. Never approve-all.
 */
export async function runPermissionReverse(options: {
  withPolicy: (
    policy: TestkitPermissionPolicy,
  ) => Promise<ProductHarness>;
}): Promise<void> {
  {
    const h = await options.withPolicy("deny");
    try {
      const session = await h.product.sessions.create();
      const events = await collectEvents(session.prompt("need-perm"));
      assertPermissionOutcome(events, "denied");
      const chunks = textChunks(events).join("\n");
      if (!chunks.includes("cancelled") && !chunks.includes("perm:")) {
        throw new Error(
          `deny policy: expected perm feedback in chunks, got ${JSON.stringify(chunks)}`,
        );
      }
    } finally {
      await h.dispose();
    }
  }
  {
    const h = await options.withPolicy("approve-reads");
    try {
      const session = await h.product.sessions.create();
      const readEvents = await collectEvents(session.prompt("need-perm"));
      assertPermissionOutcome(readEvents, "allowed");

      const writeEvents = await collectEvents(
        session.prompt("need-perm-write"),
      );
      assertPermissionOutcome(writeEvents, "denied");
    } finally {
      await h.dispose();
    }
  }
}

/** Run multi-turn under linked transport. */
export async function scenarioMultiTurnLinked(): Promise<ScenarioResult> {
  const h = await withLinkedProduct({ permissionPolicy: "deny" });
  try {
    await runMultiTurn(h.product);
    return { name: "multi-turn", mode: "linked", ok: true };
  } finally {
    await h.dispose();
  }
}

/** Run multi-turn under stdio spawn of session-echo-agent. */
export async function scenarioMultiTurnStdio(): Promise<ScenarioResult> {
  const h = await withStdioProduct({ permissionPolicy: "deny" });
  try {
    await runMultiTurn(h.product);
    return { name: "multi-turn", mode: "stdio", ok: true };
  } finally {
    await h.dispose();
  }
}

export async function scenarioCancelMidPromptLinked(): Promise<ScenarioResult> {
  const h = await withLinkedProduct({ permissionPolicy: "deny" });
  try {
    await runCancelMidPrompt(h.product);
    return { name: "cancel-mid-prompt", mode: "linked", ok: true };
  } finally {
    await h.dispose();
  }
}

export async function scenarioCancelMidPromptStdio(): Promise<ScenarioResult> {
  const h = await withStdioProduct({ permissionPolicy: "deny" });
  try {
    await runCancelMidPrompt(h.product);
    return { name: "cancel-mid-prompt", mode: "stdio", ok: true };
  } finally {
    await h.dispose();
  }
}

export async function scenarioPermissionReverseLinked(): Promise<ScenarioResult> {
  await runPermissionReverse({
    withPolicy: (policy) => withLinkedProduct({ permissionPolicy: policy }),
  });
  return { name: "permission-reverse", mode: "linked", ok: true };
}

/** All minimum scenarios (linked ×3 + stdio multi-turn at least). */
export async function runMinimumScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  results.push(await scenarioMultiTurnLinked());
  results.push(await scenarioCancelMidPromptLinked());
  results.push(await scenarioPermissionReverseLinked());
  results.push(await scenarioMultiTurnStdio());
  return results;
}
