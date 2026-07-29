import type { AcpMessage, AcpTransport } from "../../acp-wire/src/index.ts";

export interface AcpClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  readonly notifications: AsyncIterable<AcpMessage>;
  close(): Promise<void>;
}

export function defineAcpClient(options?: {
  handlers?: Record<string, (params: unknown) => Promise<unknown> | unknown>;
}): {
  connect(transport: AcpTransport): Promise<AcpClient>;
} {
  const handlers = options?.handlers ?? {};
  return {
    async connect(transport: AcpTransport): Promise<AcpClient> {
      let nextId = 1;
      const pending = new Map<
        string | number,
        {
          resolve: (v: unknown) => void;
          reject: (e: unknown) => void;
        }
      >();

      type NQ =
        | { ok: true; value: AcpMessage }
        | { ok: false; done: true };
      const notifQ: NQ[] = [];
      let notifWait: ((i: NQ) => void) | undefined;

      function pushNotif(item: NQ) {
        if (notifWait) {
          const w = notifWait;
          notifWait = undefined;
          w(item);
        } else {
          notifQ.push(item);
        }
      }

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
            if (msg.kind === "request") {
              const handler = handlers[msg.method];
              try {
                const result = handler
                  ? await handler(msg.params)
                  : undefined;
                await transport.send({
                  kind: "response",
                  id: msg.id,
                  result: result ?? null,
                });
              } catch (error) {
                await transport.send({
                  kind: "response",
                  id: msg.id,
                  error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : String(error),
                  },
                });
              }
              continue;
            }
            if (msg.kind === "notification") {
              pushNotif({ ok: true, value: msg });
            }
          }
        } finally {
          pushNotif({ ok: false, done: true });
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
              .send({ kind: "request", id, method, params })
              .catch(reject);
          });
        },
        notify(method: string, params?: unknown): Promise<void> {
          return transport.send({ kind: "notification", method, params });
        },
        get notifications() {
          return (async function* () {
            for (;;) {
              const item =
                notifQ.shift() ??
                (await new Promise<NQ>((resolve) => {
                  notifWait = resolve;
                }));
              if (!item.ok) return;
              yield item.value;
            }
          })();
        },
        async close() {
          await transport.close();
          await pump.catch(() => undefined);
        },
      };
    },
  };
}
