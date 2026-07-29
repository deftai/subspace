/**
 * In-process session bookkeeping for the early harness.
 */
import type { ModelMessage } from "./model.ts";

export type SessionRec = {
  turns: number;
  messages: ModelMessage[];
};

/**
 * Create empty session state, optionally seeding a system instruction message.
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
