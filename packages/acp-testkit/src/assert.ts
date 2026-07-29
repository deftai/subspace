/**
 * Assert helpers over demuxed AgentEvent streams.
 *
 * Owns: pure extractors + node:assert checks for scenario outcomes.
 * Does not own: transport, product lifecycle, or scenario orchestration.
 * Reusable by harness later — keep pure and framework-light.
 */
import assert from "node:assert/strict";
import type { AgentEvent } from "@deft/acp-client";

/**
 * Extract agent message text chunks from update events.
 * Falls back to JSON of the update when content.text is absent (debug noise).
 */
export function textChunks(events: readonly AgentEvent[]): string[] {
  return events
    .filter((e) => e.type === "update")
    .map((e) => {
      const u = e.update as { content?: { text?: string } };
      return u?.content?.text ?? JSON.stringify(e.update);
    });
}

/** First prompt_done event if present (terminal success signal for a turn). */
export function findPromptDone(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: "prompt_done" }> | undefined {
  return events.find((e) => e.type === "prompt_done") as
    | Extract<AgentEvent, { type: "prompt_done" }>
    | undefined;
}

/** All permission demux events (policy outcomes under reverse RPC). */
export function permissionEvents(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: "permission" }>[] {
  return events.filter((e) => e.type === "permission") as Extract<
    AgentEvent,
    { type: "permission" }
  >[];
}

/** Fail unless at least one session/update was demuxed. */
export function assertHasUpdate(events: readonly AgentEvent[]): void {
  assert.ok(
    events.some((e) => e.type === "update"),
    "expected at least one session/update demux event",
  );
}

/** Fail unless the stream includes prompt_done. */
export function assertPromptDone(events: readonly AgentEvent[]): void {
  const done = findPromptDone(events);
  assert.ok(done, "expected prompt_done");
}

/**
 * Fail unless prompt_done reports stopReason cancelled
 * (cancel-mid-prompt contract with session-echo).
 */
export function assertCancelled(events: readonly AgentEvent[]): void {
  const done = findPromptDone(events);
  assert.ok(done, "expected prompt_done after cancel");
  const result = done.result as { stopReason?: string };
  assert.equal(result?.stopReason, "cancelled");
}

/** Fail unless some agent text chunk includes needle (fixture turn markers). */
export function assertTextIncludes(
  events: readonly AgentEvent[],
  needle: string,
): void {
  const chunks = textChunks(events);
  assert.ok(
    chunks.some((t) => t.includes(needle)),
    `expected text chunk containing ${JSON.stringify(needle)}; got ${JSON.stringify(chunks)}`,
  );
}

/**
 * Fail unless enough permission events exist and the first matches outcome.
 * minCount defaults to 1; first event is the policy decision under test.
 */
export function assertPermissionOutcome(
  events: readonly AgentEvent[],
  outcome: "allowed" | "denied",
  minCount = 1,
): void {
  const perms = permissionEvents(events);
  assert.ok(
    perms.length >= minCount,
    `expected ≥${minCount} permission event(s), got ${perms.length}`,
  );
  assert.equal(perms[0]!.outcome, outcome);
}
