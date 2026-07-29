/**
 * Minimum phase-4 scenarios — importable, product-only (no second client).
 *
 * Owns: multi-turn, cancel-mid-prompt, permission-reverse runners and
 * linked/stdio wrappers that allocate harnesses.
 * Does not own: asserts (./assert) or harness construction details (./harness).
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

/** Known minimum scenario identifiers (stable for reporting). */
export type ScenarioName =
  | "multi-turn"
  | "cancel-mid-prompt"
  | "permission-reverse";

/** Successful scenario run record (failures throw rather than ok:false). */
export type ScenarioResult = {
  name: ScenarioName;
  mode: "linked" | "stdio";
  ok: true;
};

/**
 * Multi-turn: create, two prompts with demuxed updates, load same session.
 * Invariant: localId ≠ acpSessionId; load preserves both ids.
 */
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
  // Client must allocate a host-local id distinct from the agent session id
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

  // Load must reattach the same dual-id mapping, not mint a new localId
  const loaded = await product.sessions.load(session.acpSessionId);
  if (loaded.acpSessionId !== session.acpSessionId) {
    throw new Error("load returned different acpSessionId");
  }
  if (loaded.localId !== session.localId) {
    throw new Error("load returned different localId");
  }
}

/**
 * Cancel mid-prompt; session remains usable for a follow-up turn.
 * Relies on session-echo "slow" prompt + cancel flag polling.
 */
export async function runCancelMidPrompt(
  product: AcpClientProduct,
): Promise<void> {
  const session = await product.sessions.create();
  // Start slow turn before cancel so the agent is mid-loop
  const eventsPromise = collectEvents(session.prompt("slow"));
  await new Promise((r) => setTimeout(r, 50));
  await session.cancel();
  const events = await eventsPromise;
  assertCancelled(events);

  // Session must still accept a normal turn after cancel
  const next = await collectEvents(session.prompt("alive"));
  assertTextIncludes(next, "alive");
  assertPromptDone(next);
}

/**
 * Permission reverse map: deny policy denies reads; approve-reads allows
 * reads and still denies writes. Never approve-all.
 * withPolicy supplies a fresh harness per policy so product policy is fixed at connect.
 */
export async function runPermissionReverse(options: {
  withPolicy: (
    policy: TestkitPermissionPolicy,
  ) => Promise<ProductHarness>;
}): Promise<void> {
  // deny: read reverse-RPC should surface denied + fixture perm feedback
  {
    const h = await options.withPolicy("deny");
    try {
      const session = await h.product.sessions.create();
      const events = await collectEvents(session.prompt("need-perm"));
      assertPermissionOutcome(events, "denied");
      const chunks = textChunks(events).join("\n");
      // Agent may echo cancelled or perm: payload depending on host mapping
      if (!chunks.includes("cancelled") && !chunks.includes("perm:")) {
        throw new Error(
          `deny policy: expected perm feedback in chunks, got ${JSON.stringify(chunks)}`,
        );
      }
    } finally {
      await h.dispose();
    }
  }
  // approve-reads: read allowed, write/edit still denied (no approve-all)
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

/** Run multi-turn under linked transport; always dispose harness. */
export async function scenarioMultiTurnLinked(): Promise<ScenarioResult> {
  const h = await withLinkedProduct({ permissionPolicy: "deny" });
  try {
    await runMultiTurn(h.product);
    return { name: "multi-turn", mode: "linked", ok: true };
  } finally {
    await h.dispose();
  }
}

/** Run multi-turn under stdio spawn of session-echo-agent; always dispose. */
export async function scenarioMultiTurnStdio(): Promise<ScenarioResult> {
  const h = await withStdioProduct({ permissionPolicy: "deny" });
  try {
    await runMultiTurn(h.product);
    return { name: "multi-turn", mode: "stdio", ok: true };
  } finally {
    await h.dispose();
  }
}

/** Cancel-mid-prompt on linked transport. */
export async function scenarioCancelMidPromptLinked(): Promise<ScenarioResult> {
  const h = await withLinkedProduct({ permissionPolicy: "deny" });
  try {
    await runCancelMidPrompt(h.product);
    return { name: "cancel-mid-prompt", mode: "linked", ok: true };
  } finally {
    await h.dispose();
  }
}

/** Cancel-mid-prompt on stdio session-echo spawn. */
export async function scenarioCancelMidPromptStdio(): Promise<ScenarioResult> {
  const h = await withStdioProduct({ permissionPolicy: "deny" });
  try {
    await runCancelMidPrompt(h.product);
    return { name: "cancel-mid-prompt", mode: "stdio", ok: true };
  } finally {
    await h.dispose();
  }
}

/** Permission reverse on linked transport only (policy matrix is product-side). */
export async function scenarioPermissionReverseLinked(): Promise<ScenarioResult> {
  await runPermissionReverse({
    withPolicy: (policy) => withLinkedProduct({ permissionPolicy: policy }),
  });
  return { name: "permission-reverse", mode: "linked", ok: true };
}

/**
 * All minimum scenarios (linked ×3 + stdio multi-turn at least).
 * Order is stable for logs; each scenario allocates its own harness.
 */
export async function runMinimumScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  results.push(await scenarioMultiTurnLinked());
  results.push(await scenarioCancelMidPromptLinked());
  results.push(await scenarioPermissionReverseLinked());
  results.push(await scenarioMultiTurnStdio());
  return results;
}
