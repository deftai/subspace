/**
 * Assert helpers over demuxed AgentEvent streams.
 * Reusable by harness later — keep pure and framework-light.
 */
import assert from "node:assert/strict";
import type { AgentEvent } from "@deft/acp-client";

/** Extract agent message text chunks from update events. */
export function textChunks(events: readonly AgentEvent[]): string[] {
  return events
    .filter((e) => e.type === "update")
    .map((e) => {
      const u = e.update as { content?: { text?: string } };
      return u?.content?.text ?? JSON.stringify(e.update);
    });
}

export function findPromptDone(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: "prompt_done" }> | undefined {
  return events.find((e) => e.type === "prompt_done") as
    | Extract<AgentEvent, { type: "prompt_done" }>
    | undefined;
}

export function permissionEvents(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: "permission" }>[] {
  return events.filter((e) => e.type === "permission") as Extract<
    AgentEvent,
    { type: "permission" }
  >[];
}

export function assertHasUpdate(events: readonly AgentEvent[]): void {
  assert.ok(
    events.some((e) => e.type === "update"),
    "expected at least one session/update demux event",
  );
}

export function assertPromptDone(events: readonly AgentEvent[]): void {
  const done = findPromptDone(events);
  assert.ok(done, "expected prompt_done");
}

export function assertCancelled(events: readonly AgentEvent[]): void {
  const done = findPromptDone(events);
  assert.ok(done, "expected prompt_done after cancel");
  const result = done.result as { stopReason?: string };
  assert.equal(result?.stopReason, "cancelled");
}

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
