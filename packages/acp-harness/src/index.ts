/**
 * @deft/acp-harness — early Path A coding-agent harness.
 *
 * Serves ACP via defineAcpServer: initialize, session/new|load|prompt|cancel.
 * Brain = ModelAdapter (StubModelAdapter by default). Not a production agent.
 *
 * Prefer zero tools; cancel is cooperative between stream steps.
 */
import type { AcpTransport } from "../../acp-wire/src/index.ts";
import {
  defineAcpServer,
  type AcpHandler,
  type AcpServerHandle,
} from "../../acp-agent/src/index.ts";

// ─── model adapter ──────────────────────────────────────────────────────────

export type ModelRole = "system" | "user" | "assistant";

export type ModelMessage = {
  role: ModelRole;
  content: string;
};

/**
 * Minimal model face. Return a full string or an async iterable of text chunks
 * (chunks let the harness honor cancel between steps).
 */
export interface ModelAdapter {
  complete(
    messages: ModelMessage[],
  ): Promise<string> | AsyncIterable<string> | string;
}

export type StubModelAdapterOptions = {
  /** Prefix for deterministic replies. Default `"stub"`. */
  prefix?: string;
  /**
   * When the last user text is `"slow"`, stream this many chunks with
   * `slowChunkDelayMs` between them (cancel proof). Default 30 / 15ms.
   */
  slowChunks?: number;
  slowChunkDelayMs?: number;
};

/**
 * Deterministic offline model — no network, no provider SDK.
 * Prompt text `"slow"` yields a multi-chunk delayed stream for cancel tests.
 */
export class StubModelAdapter implements ModelAdapter {
  private readonly prefix: string;
  private readonly slowChunks: number;
  private readonly slowChunkDelayMs: number;

  constructor(options?: StubModelAdapterOptions) {
    this.prefix = options?.prefix ?? "stub";
    this.slowChunks = options?.slowChunks ?? 30;
    this.slowChunkDelayMs = options?.slowChunkDelayMs ?? 15;
  }

  complete(
    messages: ModelMessage[],
  ): string | AsyncIterable<string> {
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

    if (lastUser === "slow") {
      const { slowChunks, slowChunkDelayMs, prefix } = this;
      return (async function* () {
        for (let i = 0; i < slowChunks; i++) {
          await new Promise((r) => setTimeout(r, slowChunkDelayMs));
          yield `${prefix}:slow:${i}`;
        }
      })();
    }

    return `${this.prefix}:${lastUser}`;
  }
}

// ─── harness bridge + handlers ──────────────────────────────────────────────

export type HarnessBridge = {
  notify(method: string, params?: unknown): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
};

export type HarnessOptions = {
  model?: ModelAdapter;
  /** Optional system instructions prepended each turn. */
  instructions?: string;
  agentName?: string;
  agentVersion?: string;
};

type SessionRec = {
  turns: number;
  messages: ModelMessage[];
};

function isAsyncIterable(v: unknown): v is AsyncIterable<string> {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as AsyncIterable<string>)[Symbol.asyncIterator] === "function"
  );
}

function promptToText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (prompt === undefined || prompt === null) return "";
  // ACP content arrays sometimes show up; stringify for the stub brain.
  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string };
          if (typeof p.text === "string") return p.text;
        }
        return JSON.stringify(part);
      })
      .join("");
  }
  return JSON.stringify(prompt);
}

/**
 * ACP agent handlers for the early harness. Bind a live bridge before prompts
 * that notify session/update.
 */
export function defineHarnessHandlers(
  bridge: HarnessBridge,
  options?: HarnessOptions,
): Record<string, AcpHandler> {
  const model: ModelAdapter = options?.model ?? new StubModelAdapter();
  const instructions = options?.instructions;
  const agentName = options?.agentName ?? "@deft/acp-harness";
  const agentVersion = options?.agentVersion ?? "0.1.0";

  const sessions = new Map<string, SessionRec>();
  const cancelFlags = new Map<string, boolean>();

  return {
    async initialize(_params: unknown) {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
        agentInfo: {
          name: agentName,
          version: agentVersion,
        },
      };
    },

    async "session/new"(params: unknown) {
      const id = crypto.randomUUID();
      const messages: ModelMessage[] = [];
      if (instructions) {
        messages.push({ role: "system", content: instructions });
      }
      sessions.set(id, { turns: 0, messages });
      cancelFlags.set(id, false);
      const p = (params ?? {}) as { cwd?: string };
      return { sessionId: id, cwd: p.cwd };
    },

    async "session/load"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/load requires sessionId");
      if (!sessions.has(p.sessionId)) {
        const messages: ModelMessage[] = [];
        if (instructions) {
          messages.push({ role: "system", content: instructions });
        }
        sessions.set(p.sessionId, { turns: 0, messages });
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
          await bridge.notify("session/update", {
            sessionId: p.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
            },
          });
        }
      } else {
        if (cancelFlags.get(p.sessionId)) {
          return { stopReason: "cancelled", turns: rec.turns };
        }
        assistantText = completion;
        await bridge.notify("session/update", {
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: assistantText },
          },
        });
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

/** Linked-transport convenience: handlers + listen with live bridge. */
export async function listenHarness(
  transport: AcpTransport,
  options?: HarnessOptions,
): Promise<AcpServerHandle> {
  const bridge: { current?: AcpServerHandle } = {};
  const handlers = defineHarnessHandlers(
    {
      notify: (m, p) => {
        if (!bridge.current) throw new Error("server not bound");
        return bridge.current.notify(m, p);
      },
      request: (m, p) => {
        if (!bridge.current) throw new Error("server not bound");
        return bridge.current.request(m, p);
      },
    },
    options,
  );
  const server = await defineAcpServer({ handlers }).listen(transport);
  bridge.current = server;
  return server;
}

/**
 * Micro-sugar (≤2 local helpers): factory for options-shaped harness config.
 * Not a general compose engine — just less ugly call sites.
 */
export function defineHarness(options?: HarnessOptions): {
  listen(transport: AcpTransport): Promise<AcpServerHandle>;
  handlers(bridge: HarnessBridge): Record<string, AcpHandler>;
} {
  return {
    listen(transport) {
      return listenHarness(transport, options);
    },
    handlers(bridge) {
      return defineHarnessHandlers(bridge, options);
    },
  };
}
