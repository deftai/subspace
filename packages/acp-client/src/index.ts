/**
 * ACP host client — thin wire façade + phase-2 session product.
 *
 * Phase 2 (locked cut): sessions create/load/ensure, prompt → AsyncIterable,
 * one prompt queue owner, reverse permission map, host session store only.
 * No middleware stack, no foundation RpcSession, no multi-store collapse.
 */
import type { AcpMessage, AcpTransport } from "../../acp-wire/src/index.ts";

// ─── thin wire client (phase 1) ─────────────────────────────────────────────

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
                    message:
                      error instanceof Error ? error.message : String(error),
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

// ─── phase-2 product surface ────────────────────────────────────────────────

/** CI-safe defaults only — never "approve-all". */
export type PermissionPolicy = "deny" | "approve-reads";

export type AgentEvent =
  | {
      type: "update";
      sessionId: string;
      update: unknown;
    }
  | {
      type: "prompt_done";
      sessionId: string;
      result: unknown;
    }
  | {
      type: "prompt_error";
      sessionId: string;
      error: unknown;
    }
  | {
      type: "permission";
      sessionId?: string;
      params: unknown;
      outcome: "allowed" | "denied";
    };

export interface HostSessionRecord {
  readonly localId: string;
  readonly acpSessionId: string;
  readonly providerId?: string;
  softClosed: boolean;
  ensureKey?: string;
}

export interface AcpSession {
  readonly localId: string;
  readonly acpSessionId: string;
  readonly providerId?: string;
  prompt(input: unknown): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  softClose(): Promise<void>;
}

export interface AcpClientProduct {
  readonly wire: AcpClient;
  sessions: {
    create(params?: {
      cwd?: string;
      providerId?: string;
    }): Promise<AcpSession>;
    load(
      acpSessionId: string,
      params?: { providerId?: string },
    ): Promise<AcpSession>;
    ensure(
      key: string,
      params?: { cwd?: string; providerId?: string },
    ): Promise<AcpSession>;
  };
  /** Host bookkeeping only — not run/test stores. */
  readonly store: {
    getByLocalId(localId: string): HostSessionRecord | undefined;
    getByAcpId(acpSessionId: string): HostSessionRecord | undefined;
    getByEnsureKey(key: string): HostSessionRecord | undefined;
    list(): HostSessionRecord[];
  };
  close(): Promise<void>;
}

type EventSink = {
  push: (e: AgentEvent) => void;
  end: () => void;
};

type PromptJob = {
  acpSessionId: string;
  input: unknown;
  sink: EventSink;
  cancelFlag: { cancelled: boolean };
};

function makePermissionHandler(
  policy: PermissionPolicy,
  onDecision?: (info: {
    params: unknown;
    outcome: "allowed" | "denied";
  }) => void,
): (params: unknown) => Promise<unknown> {
  return async (params: unknown) => {
    const p = (params ?? {}) as {
      sessionId?: string;
      toolCall?: { kind?: string; title?: string };
    };
    const kind = (p.toolCall?.kind ?? "").toLowerCase();
    let allowed = false;
    if (policy === "approve-reads") {
      allowed =
        kind === "read" ||
        kind === "read_file" ||
        kind === "search" ||
        kind === "list";
    }
    // policy === "deny" → always deny
    const outcome = allowed ? "allowed" : "denied";
    onDecision?.({ params, outcome });
    if (allowed) {
      return {
        outcome: { outcome: "selected", optionId: "allow-once" },
      };
    }
    return {
      outcome: { outcome: "cancelled" },
    };
  };
}

/** Single FIFO prompt queue for the connection — one owner, no dual queues. */
class PromptQueue {
  private readonly q: Array<() => Promise<void>> = [];
  private running = false;

  enqueue(job: () => Promise<void>): void {
    this.q.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.q.length > 0) {
        const job = this.q.shift()!;
        await job();
      }
    } finally {
      this.running = false;
      if (this.q.length > 0) void this.drain();
    }
  }
}

function createEventStream(): {
  iterable: AsyncIterable<AgentEvent>;
  sink: EventSink;
} {
  type Q =
    | { ok: true; value: AgentEvent }
    | { ok: false; done: true };
  const queue: Q[] = [];
  let wait: ((i: Q) => void) | undefined;
  let ended = false;

  function enqueue(item: Q) {
    if (wait) {
      const w = wait;
      wait = undefined;
      w(item);
    } else {
      queue.push(item);
    }
  }

  const sink: EventSink = {
    push(e: AgentEvent) {
      if (ended) return;
      enqueue({ ok: true, value: e });
    },
    end() {
      if (ended) return;
      ended = true;
      enqueue({ ok: false, done: true });
    },
  };

  const iterable: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          const item =
            queue.shift() ??
            (await new Promise<Q>((resolve) => {
              wait = resolve;
            }));
          if (!item.ok) return { done: true, value: undefined };
          return { done: false, value: item.value };
        },
      };
    },
  };

  return { iterable, sink };
}

export function defineAcpClientProduct(options?: {
  /** Default: "deny". Never defaults to approve-all. */
  permissionPolicy?: PermissionPolicy;
  handlers?: Record<string, (params: unknown) => Promise<unknown> | unknown>;
}): {
  connect(transport: AcpTransport): Promise<AcpClientProduct>;
} {
  const policy = options?.permissionPolicy ?? "deny";

  return {
    async connect(transport: AcpTransport): Promise<AcpClientProduct> {
      const permissionEvents: AgentEvent[] = [];

      const reverseHandlers: Record<
        string,
        (params: unknown) => Promise<unknown> | unknown
      > = {
        "session/request_permission": makePermissionHandler(
          policy,
          ({ params, outcome }) => {
            const p = (params ?? {}) as { sessionId?: string };
            permissionEvents.push({
              type: "permission",
              sessionId: p.sessionId,
              params,
              outcome,
            });
          },
        ),
        ...options?.handlers,
      };

      const wire = await defineAcpClient({
        handlers: reverseHandlers,
      }).connect(transport);

      // Host session store — bookkeeping only
      const byLocal = new Map<string, HostSessionRecord>();
      const byAcp = new Map<string, HostSessionRecord>();
      const byEnsure = new Map<string, HostSessionRecord>();

      // Active prompt sinks by acp session id (for demux of session/update)
      const activeSinks = new Map<string, Set<EventSink>>();
      const cancelFlags = new Map<string, { cancelled: boolean }>();

      const queue = new PromptQueue();

      // Notification demux pump
      void (async () => {
        for await (const n of wire.notifications) {
          if (n.method !== "session/update") continue;
          const p = (n.params ?? {}) as {
            sessionId?: string;
            update?: unknown;
          };
          if (!p.sessionId) continue;
          const sinks = activeSinks.get(p.sessionId);
          if (!sinks) continue;
          const ev: AgentEvent = {
            type: "update",
            sessionId: p.sessionId,
            update: p.update,
          };
          for (const s of sinks) s.push(ev);
        }
      })();

      function attachSink(acpSessionId: string, sink: EventSink) {
        let set = activeSinks.get(acpSessionId);
        if (!set) {
          set = new Set();
          activeSinks.set(acpSessionId, set);
        }
        set.add(sink);
        return () => {
          set!.delete(sink);
          if (set!.size === 0) activeSinks.delete(acpSessionId);
        };
      }

      function wrapSession(rec: HostSessionRecord): AcpSession {
        return {
          localId: rec.localId,
          acpSessionId: rec.acpSessionId,
          providerId: rec.providerId,

          prompt(input: unknown): AsyncIterable<AgentEvent> {
            if (rec.softClosed) {
              // Resume soft-closed session on next prompt
              rec.softClosed = false;
            }
            const { iterable, sink } = createEventStream();
            const flag = { cancelled: false };
            cancelFlags.set(rec.acpSessionId, flag);

            // Drain any permission events that fire during this prompt into stream
            const drainPerms = () => {
              while (permissionEvents.length > 0) {
                const pe = permissionEvents.shift()!;
                if (
                  pe.type === "permission" &&
                  (pe.sessionId === undefined ||
                    pe.sessionId === rec.acpSessionId)
                ) {
                  sink.push(pe);
                }
              }
            };

            queue.enqueue(async () => {
              const detach = attachSink(rec.acpSessionId, sink);
              try {
                const result = await wire.request("session/prompt", {
                  sessionId: rec.acpSessionId,
                  prompt: input,
                });
                drainPerms();
                if (flag.cancelled) {
                  sink.push({
                    type: "prompt_done",
                    sessionId: rec.acpSessionId,
                    result: { stopReason: "cancelled", ...(result as object) },
                  });
                } else {
                  sink.push({
                    type: "prompt_done",
                    sessionId: rec.acpSessionId,
                    result,
                  });
                }
              } catch (error) {
                drainPerms();
                sink.push({
                  type: "prompt_error",
                  sessionId: rec.acpSessionId,
                  error,
                });
              } finally {
                detach();
                sink.end();
              }
            });

            return iterable;
          },

          async cancel() {
            const flag = cancelFlags.get(rec.acpSessionId);
            if (flag) flag.cancelled = true;
            await wire.request("session/cancel", {
              sessionId: rec.acpSessionId,
            });
          },

          async softClose() {
            rec.softClosed = true;
          },
        };
      }

      function register(
        acpSessionId: string,
        opts?: { providerId?: string; ensureKey?: string },
      ): AcpSession {
        const localId = crypto.randomUUID();
        const rec: HostSessionRecord = {
          localId,
          acpSessionId,
          providerId: opts?.providerId,
          softClosed: false,
          ensureKey: opts?.ensureKey,
        };
        byLocal.set(localId, rec);
        byAcp.set(acpSessionId, rec);
        if (opts?.ensureKey) byEnsure.set(opts.ensureKey, rec);
        return wrapSession(rec);
      }

      return {
        wire,
        store: {
          getByLocalId: (id) => byLocal.get(id),
          getByAcpId: (id) => byAcp.get(id),
          getByEnsureKey: (k) => byEnsure.get(k),
          list: () => [...byLocal.values()],
        },
        sessions: {
          async create(params) {
            const result = (await wire.request("session/new", {
              cwd: params?.cwd,
            })) as { sessionId: string };
            return register(result.sessionId, {
              providerId: params?.providerId,
            });
          },

          async load(acpSessionId, params) {
            const existing = byAcp.get(acpSessionId);
            if (existing) {
              existing.softClosed = false;
              return wrapSession(existing);
            }
            const result = (await wire.request("session/load", {
              sessionId: acpSessionId,
            })) as { sessionId: string };
            return register(result.sessionId, {
              providerId: params?.providerId,
            });
          },

          async ensure(key, params) {
            const existing = byEnsure.get(key);
            if (existing) {
              existing.softClosed = false;
              return wrapSession(existing);
            }
            const result = (await wire.request("session/new", {
              cwd: params?.cwd,
            })) as { sessionId: string };
            return register(result.sessionId, {
              providerId: params?.providerId,
              ensureKey: key,
            });
          },
        },
        async close() {
          await wire.close();
        },
      };
    },
  };
}

/** Collect an AsyncIterable into an array (test helper). */
export async function collectEvents(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}
