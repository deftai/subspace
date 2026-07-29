/**
 * In-process session bookkeeping for the early harness.
 *
 * Owns: SessionRec shape, empty session factory, and per-instance Maps for
 * sessions + cooperative cancel flags. Does not own ACP protocol or model I/O.
 */
import type { ModelMessage } from "./model.ts";

export type SessionRec = {
  turns: number;
  messages: ModelMessage[];
};

/**
 * Create empty session state, optionally seeding a system instruction message.
 * System message is prepended once at create/load — not re-injected each turn.
 */
export function createSessionRec(instructions?: string): SessionRec {
  const messages: ModelMessage[] = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  return { turns: 0, messages };
}

/**
 * Mutable session + cancel maps for one harness instance.
 * Fresh Maps so concurrent harnesses (tests) do not share cancel state.
 */
export function createSessionStore(): {
  sessions: Map<string, SessionRec>;
  cancelFlags: Map<string, boolean>;
} {
  return {
    sessions: new Map(),
    cancelFlags: new Map(),
  };
}
