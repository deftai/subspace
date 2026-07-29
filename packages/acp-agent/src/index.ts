import type { AcpTransport } from "../../acp-wire/src/index.ts";

export interface AcpServerHandle {
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export function defineAcpServer(options: {
  handlers: Record<string, (params: unknown) => Promise<unknown> | unknown>;
}): {
  listen(transport: AcpTransport): Promise<AcpServerHandle>;
} {
  const handlers = options.handlers;
  return {
    async listen(transport: AcpTransport): Promise<AcpServerHandle> {
      const pump = (async () => {
        for await (const msg of transport.messages) {
          if (msg.kind !== "request") continue;
          const handler = handlers[msg.method];
          try {
            const result = handler ? await handler(msg.params) : undefined;
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
                message:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      })();

      return {
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
