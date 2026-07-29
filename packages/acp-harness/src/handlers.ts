/**
 * Explicit ACP method map for the early harness (foundation path).
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
 * ACP agent handlers for the early harness. Bind a live bridge before prompts
 * that notify session/update.
 */
export function defineHarnessHandlers(
  bridge: AgentBridge,
  options?: HarnessOptions,
): Record<string, AcpHandler> {
  const { model, instructions, agentName, agentVersion } =
    resolveHarnessOptions(options);
  const { sessions, cancelFlags } = createSessionStore();

  return {
    async initialize(_params: unknown) {
      return defaultInitializeResult({
        name: agentName,
        version: agentVersion,
      });
    },

    async "session/new"(params: unknown) {
      const id = crypto.randomUUID();
      sessions.set(id, createSessionRec(instructions));
      cancelFlags.set(id, false);
      const p = (params ?? {}) as { cwd?: string };
      return { sessionId: id, cwd: p.cwd };
    },

    async "session/load"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/load requires sessionId");
      if (!sessions.has(p.sessionId)) {
        sessions.set(p.sessionId, createSessionRec(instructions));
      }
      cancelFlags.set(p.sessionId, false);
      return { sessionId: p.sessionId };
    },

    async "session/prompt"(params: unknown) {
      const p = params as { sessionId?: string; prompt?: unknown };
      if (!p?.sessionId) throw new Error("session/prompt requires sessionId");
      const rec = sessions.get(p.sessionId);
      if (!rec) throw new Error(`unknown session ${p.sessionId}`);

      cancelFlags.set(p.sessionId, false);
      rec.turns += 1;

      const userText = promptToText(p.prompt);
      rec.messages.push({ role: "user", content: userText });

      const completion = await Promise.resolve(model.complete(rec.messages));

      let assistantText = "";

      if (isAsyncIterable(completion)) {
        for await (const chunk of completion) {
          if (cancelFlags.get(p.sessionId)) {
            if (assistantText) {
              rec.messages.push({ role: "assistant", content: assistantText });
            }
            return { stopReason: "cancelled", turns: rec.turns };
          }
          assistantText += chunk;
          await notifyAgentMessageChunk(bridge, p.sessionId, chunk);
        }
      } else {
        if (cancelFlags.get(p.sessionId)) {
          return { stopReason: "cancelled", turns: rec.turns };
        }
        assistantText = completion;
        await notifyAgentMessageChunk(bridge, p.sessionId, assistantText);
      }

      if (cancelFlags.get(p.sessionId)) {
        if (assistantText) {
          rec.messages.push({ role: "assistant", content: assistantText });
        }
        return { stopReason: "cancelled", turns: rec.turns };
      }

      rec.messages.push({ role: "assistant", content: assistantText });
      return { stopReason: "end_turn", turns: rec.turns };
    },

    async "session/cancel"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/cancel requires sessionId");
      cancelFlags.set(p.sessionId, true);
      return null;
    },
  };
}
