/**
 * ACP agent (server) façade — thin request dispatch + outbound request/notify.
 * Phase 2: supports reverse RPC so session agents can call host methods
 * (e.g. session/request_permission) during a prompt.
 */
import type { AcpMessage, AcpTransport } from "../../acp-wire/src/index.ts";

export type AcpHandler = (
  params: unknown,
) => Promise<unknown> | unknown;

export interface AcpServerHandle {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export function defineAcpServer(options: {
  handlers: Record<string, AcpHandler>;
}): {
  listen(transport: AcpTransport): Promise<AcpServerHandle>;
} {
  const handlers = options.handlers;
  return {
    async listen(transport: AcpTransport): Promise<AcpServerHandle> {
      let nextId = 1;
      const pending = new Map<
        string | number,
        {
          resolve: (v: unknown) => void;
          reject: (e: unknown) => void;
        }
      >();

      const pump = (async () => {
        try {
          for await (const msg of transport.messages) {
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
              try {
                const result = handler ? await handler(msg.params) : undefined;
                await transport.send({
                  kind: "response",
                  id: reqId,
                  result: result ?? null,
                });
              } catch (error) {
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
          for (const [, p] of pending) {
            p.reject(new Error("transport closed"));
          }
          pending.clear();
        }
      })();

      return {
        request(method: string, params?: unknown): Promise<unknown> {
          const id = nextId++;
          return new Promise((resolve, reject) => {
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
        notify(method: string, params?: unknown) {
          return transport.send({ kind: "notification", method, params });
        },
        async close() {
          await transport.close();
          await pump.catch(() => undefined);
        },
      };
    },
  };
}

export type SessionEchoBridge = {
  notify(method: string, params?: unknown): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
};

/**
 * Minimal session-capable agent handlers for phase-2 product tests.
 * Bind a live AcpServerHandle (or stdio bridge) before handling prompts
 * that need notify / reverse request.
 */
export function defineSessionEchoHandlers(
  bridge: SessionEchoBridge,
): Record<string, AcpHandler> {
  const sessions = new Map<string, { turns: number }>();
  const cancelFlags = new Map<string, boolean>();

  return {
    async "session/new"(params: unknown) {
      const id = crypto.randomUUID();
      sessions.set(id, { turns: 0 });
      cancelFlags.set(id, false);
      const p = (params ?? {}) as { cwd?: string };
      return { sessionId: id, cwd: p.cwd };
    },

    async "session/load"(params: unknown) {
      const p = params as { sessionId?: string };
      if (!p?.sessionId) throw new Error("session/load requires sessionId");
      if (!sessions.has(p.sessionId)) {
        sessions.set(p.sessionId, { turns: 0 });
      }
      cancelFlags.set(p.sessionId, false);
      return { sessionId: p.sessionId };
    },

    async "session/prompt"(params: unknown) {
      const p = params as { sessionId?: string; prompt?: unknown };
      if (!p?.sessionId) throw new Error("session/prompt requires sessionId");
      if (!sessions.has(p.sessionId)) {
        throw new Error(`unknown session ${p.sessionId}`);
      }
      cancelFlags.set(p.sessionId, false);
      const rec = sessions.get(p.sessionId)!;
      rec.turns += 1;
      const promptText =
        typeof p.prompt === "string"
          ? p.prompt
          : JSON.stringify(p.prompt ?? null);

      await bridge.notify("session/update", {
        sessionId: p.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `turn:${rec.turns}:${promptText}` },
        },
      });

      if (promptText === "need-perm") {
        const perm = await bridge.request("session/request_permission", {
          sessionId: p.sessionId,
          toolCall: { kind: "read", title: "read workspace file" },
        });
        await bridge.notify("session/update", {
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `perm:${JSON.stringify(perm)}`,
            },
          },
        });
      }

      if (promptText === "need-perm-write") {
        const perm = await bridge.request("session/request_permission", {
          sessionId: p.sessionId,
          toolCall: { kind: "edit", title: "write file" },
        });
        await bridge.notify("session/update", {
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `perm:${JSON.stringify(perm)}`,
            },
          },
        });
      }

      if (promptText === "slow") {
        for (let i = 0; i < 30; i++) {
          if (cancelFlags.get(p.sessionId)) {
            return { stopReason: "cancelled" };
          }
          await new Promise((r) => setTimeout(r, 15));
          await bridge.notify("session/update", {
            sessionId: p.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `slow:${i}` },
            },
          });
        }
      }

      if (cancelFlags.get(p.sessionId)) {
        return { stopReason: "cancelled" };
      }
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
export async function listenSessionEcho(
  transport: AcpTransport,
): Promise<AcpServerHandle> {
  const bridge: {
    current?: AcpServerHandle;
  } = {};
  const handlers = defineSessionEchoHandlers({
    notify: (m, p) => {
      if (!bridge.current) throw new Error("server not bound");
      return bridge.current.notify(m, p);
    },
    request: (m, p) => {
      if (!bridge.current) throw new Error("server not bound");
      return bridge.current.request(m, p);
    },
  });
  const server = await defineAcpServer({ handlers }).listen(transport);
  bridge.current = server;
  return server;
}
