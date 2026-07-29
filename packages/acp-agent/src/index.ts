/**
 * ACP agent (server) façade — thin request dispatch + outbound request/notify.
 *
 * Owns: inbound method→handler map, concurrent request handling, reverse RPC
 * pending map, and the session-echo product fixture handlers.
 * Does not own: transport framing/codec, client product, or permission policy
 * (those live in acp-wire / acp-client). Phase 2 reverse RPC lets session
 * agents call host methods (e.g. session/request_permission) during a prompt.
 *
 * DX helpers (promptToText, chunk notify, init defaults) live in `./helpers.ts`.
 */
import type { AcpMessage, AcpTransport } from "../../acp-wire/src/index.ts";
import {
  createDeferredBridge,
  notifyAgentMessageChunk,
  promptToText,
  type AgentBridge,
} from "./helpers.ts";

export type {
  AgentBridge,
  InitializeAgentInfo,
} from "./helpers.ts";
export {
  agentMessageChunkUpdate,
  createDeferredBridge,
  defaultInitializeResult,
  notifyAgentMessageChunk,
  promptToText,
} from "./helpers.ts";

/** Inbound method handler: params → result (sync or async). */
export type AcpHandler = (
  params: unknown,
) => Promise<unknown> | unknown;

/**
 * Live server face after `listen`: reverse request/notify toward the client,
 * plus teardown. Bound into AgentBridge for handlers that need outbound I/O.
 */
export interface AcpServerHandle {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

/**
 * Build an ACP server definition from a method→handler map.
 * Call `.listen(transport)` to attach wire I/O; handlers may be async and
 * run concurrently so cancel can interrupt an in-flight prompt.
 */
export function defineAcpServer(options: {
  handlers: Record<string, AcpHandler>;
}): {
  listen(transport: AcpTransport): Promise<AcpServerHandle>;
} {
  const handlers = options.handlers;
  return {
    /**
     * Attach handlers to a transport: pump inbound messages, expose reverse
     * request/notify, reject pending outbound calls on close.
     */
    async listen(transport: AcpTransport): Promise<AcpServerHandle> {
      let nextId = 1;
      // Outbound reverse-RPC waiters keyed by request id (client → us responses)
      const pending = new Map<
        string | number,
        {
          resolve: (v: unknown) => void;
          reject: (e: unknown) => void;
        }
      >();

      // Background pump owns the message loop for this listen lifetime
      const pump = (async () => {
        try {
          for await (const msg of transport.messages) {
            // Complete reverse RPC when the host answers our request
            if (msg.kind === "response") {
              const p = pending.get(msg.id);
              if (!p) continue;
              pending.delete(msg.id);
              if (msg.error !== undefined) p.reject(msg.error);
              else p.resolve(msg.result);
              continue;
            }
            if (msg.kind !== "request") continue;
            // Concurrent dispatch so session/cancel can interrupt an in-flight prompt
            const handler = handlers[msg.method];
            const reqId = msg.id;
            void (async () => {
              // Isolate per-request errors so one handler failure doesn't kill the pump
              try {
                const result = handler ? await handler(msg.params) : undefined;
                await transport.send({
                  kind: "response",
                  id: reqId,
                  result: result ?? null,
                });
              } catch (error) {
                // Map thrown errors to JSON-RPC-style application errors
                await transport.send({
                  kind: "response",
                  id: reqId,
                  error: {
                    code: -32000,
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                });
              }
            })();
          }
        } finally {
          // Transport ended: fail any reverse RPC still waiting
          for (const [, p] of pending) {
            p.reject(new Error("transport closed"));
          }
          pending.clear();
        }
      })();

      return {
        /** Send a reverse request to the host and await its response. */
        request(method: string, params?: unknown): Promise<unknown> {
          const id = nextId++;
          return new Promise((resolve, reject) => {
            // Register before send so a fast response cannot race the map
            pending.set(id, { resolve, reject });
            transport
              .send({
                kind: "request",
                id,
                method,
                params,
              } satisfies AcpMessage)
              .catch(reject);
          });
        },
        /** Fire-and-forget notification toward the host (e.g. session/update). */
        notify(method: string, params?: unknown) {
          return transport.send({ kind: "notification", method, params });
        },
        /** Close transport then drain pump (ignore pump rejection after close). */
        async close() {
          await transport.close();
          await pump.catch(() => undefined);
        },
      };
    },
  };
}

/** @deprecated Prefer `AgentBridge` — same shape. */
export type SessionEchoBridge = AgentBridge;

/**
 * Minimal session-capable agent handlers for phase-2 product tests.
 * Owns in-memory session ids, turn counts, and cancel flags only.
 * Bind a live AcpServerHandle (or stdio bridge) before handling prompts
 * that need notify / reverse request — bridge is closed over, not created here.
 */
export function defineSessionEchoHandlers(
  bridge: AgentBridge,
): Record<string, AcpHandler> {
  // Fixture state: not durable; restarts lose sessions
  const sessions = new Map<string, { turns: number }>();
  const cancelFlags = new Map<string, boolean>();

  return {
    /** Allocate a new session id; optional cwd echoed for host alignment. */
    async "session/new"(params: unknown) {
      const id = crypto.randomUUID();
      sessions.set(id, { turns: 0 });
      cancelFlags.set(id, false);
      const p = (params ?? {}) as { cwd?: string };
      return { sessionId: id, cwd: p.cwd };
    },

    /**
     * Re-bind an existing sessionId (create empty record if unknown) so load
     * after reconnect still works in fixtures without durable storage.
     */
    async "session/load"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/load requires sessionId");
      if (!sessions.has(p.sessionId)) {
        sessions.set(p.sessionId, { turns: 0 });
      }
      cancelFlags.set(p.sessionId, false);
      return { sessionId: p.sessionId };
    },

    /**
     * Drive one turn: chunk notify, optional reverse permission, optional slow
     * loop for cancel tests. Special prompt texts are fixture contracts, not protocol.
     */
    async "session/prompt"(params: unknown) {
      const p = params as { sessionId?: string; prompt?: unknown };
      if (!p?.sessionId) throw new Error("session/prompt requires sessionId");
      if (!sessions.has(p.sessionId)) {
        throw new Error(`unknown session ${p.sessionId}`);
      }
      // Clear cancel at turn start so a prior cancel does not poison this turn
      cancelFlags.set(p.sessionId, false);
      const rec = sessions.get(p.sessionId)!;
      rec.turns += 1;
      const promptText = promptToText(p.prompt);

      // Deterministic chunk for multi-turn assertions (turn:N:text)
      await notifyAgentMessageChunk(
        bridge,
        p.sessionId,
        `turn:${rec.turns}:${promptText}`,
      );

      // Fixture: reverse-request read permission when host policy is under test
      if (promptText === "need-perm") {
        const perm = await bridge.request("session/request_permission", {
          sessionId: p.sessionId,
          toolCall: { kind: "read", title: "read workspace file" },
        });
        await notifyAgentMessageChunk(
          bridge,
          p.sessionId,
          `perm:${JSON.stringify(perm)}`,
        );
      }

      // Fixture: reverse-request write/edit permission (approve-reads should deny)
      if (promptText === "need-perm-write") {
        const perm = await bridge.request("session/request_permission", {
          sessionId: p.sessionId,
          toolCall: { kind: "edit", title: "write file" },
        });
        await notifyAgentMessageChunk(
          bridge,
          p.sessionId,
          `perm:${JSON.stringify(perm)}`,
        );
      }

      // Fixture: long turn so cancel-mid-prompt can win the race
      if (promptText === "slow") {
        for (let i = 0; i < 30; i++) {
          if (cancelFlags.get(p.sessionId)) {
            return { stopReason: "cancelled" };
          }
          await new Promise((r) => setTimeout(r, 15));
          await notifyAgentMessageChunk(bridge, p.sessionId, `slow:${i}`);
        }
      }

      // Cancel may arrive after last slow tick or without slow path
      if (cancelFlags.get(p.sessionId)) {
        return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn", turns: rec.turns };
    },

    /** Cooperative cancel: set flag; in-flight prompt polls and returns cancelled. */
    async "session/cancel"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/cancel requires sessionId");
      cancelFlags.set(p.sessionId, true);
      return null;
    },
  };
}

/**
 * Linked-transport convenience: build deferred bridge, listen, then bind so
 * handlers can notify/request on the live handle. One pattern — not a second server type.
 */
export async function listenSessionEcho(
  transport: AcpTransport,
): Promise<AcpServerHandle> {
  const { bridge, bind } = createDeferredBridge();
  const handlers = defineSessionEchoHandlers(bridge);
  const server = await defineAcpServer({ handlers }).listen(transport);
  bind(server);
  return server;
}
