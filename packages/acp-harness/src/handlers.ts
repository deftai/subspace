/**
 * Explicit ACP method map for the early harness (foundation path).
 *
 * Owns: initialize + session/new|load|prompt|cancel wired to ModelAdapter and
 * in-memory session store. Does not own transport listen or product-side session
 * store — bridge must be live before prompts that emit session/update.
 */
import type { AgentBridge, AcpHandler } from "../../acp-agent/src/index.ts";
import {
  defaultInitializeResult,
  notifyAgentMessageChunk,
  promptToText,
} from "../../acp-agent/src/index.ts";
import { isAsyncIterable } from "./model.ts";
import {
  resolveHarnessOptions,
  type HarnessOptions,
} from "./options.ts";
import { createSessionRec, createSessionStore } from "./session.ts";

/** @deprecated Prefer `AgentBridge` from `@deft/acp-agent`. */
export type HarnessBridge = AgentBridge;

/**
 * Build the ACP agent handler record for one harness instance.
 * Closes over resolved options, sessions, and cancel flags for the process lifetime.
 * Bind a live bridge before prompts that notify session/update.
 */
export function defineHarnessHandlers(
  bridge: AgentBridge,
  options?: HarnessOptions,
): Record<string, AcpHandler> {
  const { model, instructions, agentName, agentVersion } =
    resolveHarnessOptions(options);
  const { sessions, cancelFlags } = createSessionStore();

  return {
    /** Advertise agent identity; no session state yet. */
    async initialize(_params: unknown) {
      return defaultInitializeResult({
        name: agentName,
        version: agentVersion,
      });
    },

    /** Allocate a fresh session id and seed system instructions if any. */
    async "session/new"(params: unknown) {
      const id = crypto.randomUUID();
      sessions.set(id, createSessionRec(instructions));
      // Cancel starts clear so a prior session id cannot leak cancel into this one
      cancelFlags.set(id, false);
      const p = (params ?? {}) as { cwd?: string };
      return { sessionId: id, cwd: p.cwd };
    },

    /**
     * Resume or lazily create session by id (host may reload without new).
     * Missing sessions get empty history + current instructions, not an error.
     */
    async "session/load"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/load requires sessionId");
      if (!sessions.has(p.sessionId)) {
        // Host-supplied id is authoritative; create on first load
        sessions.set(p.sessionId, createSessionRec(instructions));
      }
      cancelFlags.set(p.sessionId, false);
      return { sessionId: p.sessionId };
    },

    /**
     * One user turn: append user message, run model, stream/notify chunks,
     * honor cancel between chunks (cooperative; not mid-token).
     */
    async "session/prompt"(params: unknown) {
      const p = params as { sessionId?: string; prompt?: unknown };
      if (!p?.sessionId) throw new Error("session/prompt requires sessionId");
      const rec = sessions.get(p.sessionId);
      if (!rec) throw new Error(`unknown session ${p.sessionId}`);

      // Each prompt owns a fresh cancel window; turn count is harness-local
      cancelFlags.set(p.sessionId, false);
      rec.turns += 1;

      const userText = promptToText(p.prompt);
      rec.messages.push({ role: "user", content: userText });

      const completion = await Promise.resolve(model.complete(rec.messages));

      let assistantText = "";

      if (isAsyncIterable(completion)) {
        // Stream path: check cancel between chunks so slow stubs prove interrupt
        for await (const chunk of completion) {
          if (cancelFlags.get(p.sessionId)) {
            // Persist partial assistant text so history is not silently dropped
            if (assistantText) {
              rec.messages.push({ role: "assistant", content: assistantText });
            }
            return { stopReason: "cancelled", turns: rec.turns };
          }
          assistantText += chunk;
          await notifyAgentMessageChunk(bridge, p.sessionId, chunk);
        }
      } else {
        // Non-stream: single notify; cancel only wins if set before send
        if (cancelFlags.get(p.sessionId)) {
          return { stopReason: "cancelled", turns: rec.turns };
        }
        assistantText = completion;
        await notifyAgentMessageChunk(bridge, p.sessionId, assistantText);
      }

      // Race: cancel after last chunk but before commit still reports cancelled
      if (cancelFlags.get(p.sessionId)) {
        if (assistantText) {
          rec.messages.push({ role: "assistant", content: assistantText });
        }
        return { stopReason: "cancelled", turns: rec.turns };
      }

      rec.messages.push({ role: "assistant", content: assistantText });
      return { stopReason: "end_turn", turns: rec.turns };
    },

    /** Cooperative cancel flag only — does not abort the model mid-chunk. */
    async "session/cancel"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/cancel requires sessionId");
      cancelFlags.set(p.sessionId, true);
      return null;
    },
  };
}
