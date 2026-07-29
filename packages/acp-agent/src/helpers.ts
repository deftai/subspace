/**
 * Shared agent product helpers — pure builders + one-liner notify.
 * Used by session-echo and @deft/acp-harness (no free-standing DX package).
 */

/** Minimal outbound face for notify / reverse request. */
export type AgentBridge = {
  notify(method: string, params?: unknown): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
};

/**
 * Normalize ACP prompt payloads to a single string.
 * Accepts string, content-part arrays (`{ type, text }`), null/undefined, or JSON fallback.
 */
export function promptToText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (prompt === undefined || prompt === null) return "";
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
 * Build the repeated `session/update` params for an agent text chunk.
 */
export function agentMessageChunkUpdate(
  sessionId: string,
  text: string,
): {
  sessionId: string;
  update: {
    sessionUpdate: "agent_message_chunk";
    content: { type: "text"; text: string };
  };
} {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

/**
 * One-liner: notify `session/update` with an agent message chunk.
 */
export async function notifyAgentMessageChunk(
  bridge: AgentBridge,
  sessionId: string,
  text: string,
): Promise<void> {
  await bridge.notify("session/update", agentMessageChunkUpdate(sessionId, text));
}

export type InitializeAgentInfo = {
  /** Agent product name (e.g. `@deft/acp-harness`). */
  name: string;
  /** Semver or free-form version string. */
  version: string;
  /** Whether `session/load` is supported. Default true. */
  loadSession?: boolean;
  /** Protocol version. Default 1. */
  protocolVersion?: number;
};

/**
 * Intelligent defaults for ACP `initialize` result.
 */
export function defaultInitializeResult(info: InitializeAgentInfo): {
  protocolVersion: number;
  agentCapabilities: { loadSession: boolean };
  agentInfo: { name: string; version: string };
} {
  return {
    protocolVersion: info.protocolVersion ?? 1,
    agentCapabilities: {
      loadSession: info.loadSession ?? true,
    },
    agentInfo: {
      name: info.name,
      version: info.version,
    },
  };
}

type BindableHandle = {
  notify(method: string, params?: unknown): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
};

/**
 * Deferred bridge bind for linked listen: handlers close over `bridge`,
 * then `bind(server)` after `defineAcpServer().listen()`.
 * One documented pattern — not a second server abstraction.
 */
export function createDeferredBridge(): {
  bridge: AgentBridge;
  bind(handle: BindableHandle): void;
} {
  let current: BindableHandle | undefined;
  return {
    bridge: {
      notify(method, params) {
        if (!current) throw new Error("server not bound");
        return current.notify(method, params);
      },
      request(method, params) {
        if (!current) throw new Error("server not bound");
        return current.request(method, params);
      },
    },
    bind(handle) {
      current = handle;
    },
  };
}
