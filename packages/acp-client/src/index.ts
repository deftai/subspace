/**
 * ACP host client — thin wire façade + phase-2 session product.
 *
 * Owns: host→agent JSON-RPC over `AcpTransport`, reverse-method handlers
 * (agent→host), a single prompt FIFO per connection, host-side session
 * bookkeeping, and progressive one-shot turn helpers.
 *
 * Phase 2 (locked cut): sessions create/load/ensure, prompt → AsyncIterable,
 * one prompt queue owner, reverse permission map, host session store only.
 *
 * Does not own: middleware stacks, foundation `RpcSession`, multi-store
 * collapse, agent-side server logic, or byte framing (see `@deft/acp-wire`).
 */
import {
  defineStdioTransport,
  type AcpMessage,
  type AcpTransport,
} from "../../acp-wire/src/index.ts";

// ─── thin wire client (phase 1) ─────────────────────────────────────────────

/** Minimal host wire surface over an already-open `AcpTransport`. */
export interface AcpClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  readonly notifications: AsyncIterable<AcpMessage>;
  close(): Promise<void>;
}

/**
 * Turn JSON-RPC / unknown failures into a readable string.
 * Never returns "[object Object]" for plain error objects.
 */
export function formatWireError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    // Prefer structured RPC error fields when present (message/code/data).
    const e = error as { message?: unknown; code?: unknown; data?: unknown };
    if (typeof e.message === "string") {
      const code = e.code !== undefined ? `code=${String(e.code)} ` : "";
      let data = "";
      if (e.data !== undefined) {
        // Keep data inline so logs stay one-line and greppable.
        data =
          typeof e.data === "string"
            ? ` data=${e.data}`
            : ` data=${JSON.stringify(e.data)}`;
      }
      return `${code}${e.message}${data}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Circular / non-serializable objects fall back to String().
      return String(error);
    }
  }
  return String(error);
}

/** Params required by real ACP agents for session/new (cwd + mcpServers). */
export type SessionNewParams = {
  cwd?: string;
  /** Default [] when omitted — required by Grok Build / claude-code-acp. */
  mcpServers?: unknown[];
  providerId?: string;
};

/**
 * Normalize `session/new` params: real agents require `cwd` + `mcpServers`.
 * Defaults are process cwd and an empty MCP list (never omit the fields).
 */
export function buildSessionNewParams(params?: {
  cwd?: string;
  mcpServers?: unknown[];
}): { cwd: string; mcpServers: unknown[] } {
  return {
    cwd: params?.cwd ?? process.cwd(),
    mcpServers: params?.mcpServers ?? [],
  };
}

/**
 * Wire-level ACP client factory: outbound request/notify, reverse handlers for
 * inbound agent requests, and a single notification async-iterable.
 * Does not manage sessions — use `defineAcpClientProduct` for the host product.
 */
export function defineAcpClient(options?: {
  handlers?: Record<string, (params: unknown) => Promise<unknown> | unknown>;
}): {
  connect(transport: AcpTransport): Promise<AcpClient>;
} {
  const handlers = options?.handlers ?? {};
  return {
    /**
     * Attach to a live transport: start the demux pump and return the client.
     * One pump owns inbound messages for the lifetime of this connection.
     */
    async connect(transport: AcpTransport): Promise<AcpClient> {
      let nextId = 1;
      // Correlate JSON-RPC response ids → pending host promises.
      const pending = new Map<
        string | number,
        {
          resolve: (v: unknown) => void;
          reject: (e: unknown) => void;
        }
      >();

      // Single-waiter notification handoff: buffer if no consumer, else push.
      type NQ =
        | { ok: true; value: AcpMessage }
        | { ok: false; done: true };
      const notifQ: NQ[] = [];
      let notifWait: ((i: NQ) => void) | undefined;

      /** Deliver one notification item without dropping or double-delivering. */
      function pushNotif(item: NQ) {
        if (notifWait) {
          // Wake the blocked notifications consumer immediately.
          const w = notifWait;
          notifWait = undefined;
          w(item);
        } else {
          notifQ.push(item);
        }
      }

      // Inbound demux: responses → pending; requests → reverse handlers;
      // notifications → notif stream. Ends when transport messages complete.
      const pump = (async () => {
        try {
          for await (const msg of transport.messages) {
            if (msg.kind === "response") {
              // Unknown ids are ignored (late/duplicate responses after cancel).
              const p = pending.get(msg.id);
              if (!p) continue;
              pending.delete(msg.id);
              if (msg.error !== undefined) {
                p.reject(new Error(formatWireError(msg.error)));
              } else p.resolve(msg.result);
              continue;
            }
            if (msg.kind === "request") {
              // Agent→host reverse RPC (e.g. session/request_permission).
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
                // Always answer the agent — leave no hanging reverse request.
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
          // Unblock consumers and fail in-flight requests on transport death.
          pushNotif({ ok: false, done: true });
          for (const [, p] of pending) {
            p.reject(new Error("transport closed"));
          }
          pending.clear();
        }
      })();

      return {
        /** Outbound JSON-RPC request; id is allocated here, not by the agent. */
        request(method: string, params?: unknown): Promise<unknown> {
          const id = nextId++;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            transport
              .send({ kind: "request", id, method, params })
              .catch(reject);
          });
        },
        /** Fire-and-forget outbound notification (no response correlation). */
        notify(method: string, params?: unknown): Promise<void> {
          return transport.send({ kind: "notification", method, params });
        },
        /**
         * AsyncIterable of inbound notifications only (not responses/requests).
         * Each get starts a fresh consumer over the shared queue/waiter.
         */
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
        /** Close transport then await pump settlement (errors swallowed). */
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

/** Events surfaced on a host `prompt()` stream (updates + terminal + permission). */
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

/** Host bookkeeping row — local id, agent id, soft-close, optional ensure key. */
export interface HostSessionRecord {
  readonly localId: string;
  readonly acpSessionId: string;
  readonly providerId?: string;
  softClosed: boolean;
  ensureKey?: string;
}

/** Product session handle: prompt stream, cancel, soft-close (no hard destroy). */
export interface AcpSession {
  readonly localId: string;
  readonly acpSessionId: string;
  readonly providerId?: string;
  prompt(input: unknown): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  softClose(): Promise<void>;
}

/**
 * Host product over wire: session create/load/ensure + host-only store.
 * One product owns one connection's prompt queue and reverse permission path.
 */
export interface AcpClientProduct {
  readonly wire: AcpClient;
  sessions: {
    create(params?: SessionNewParams): Promise<AcpSession>;
    load(
      acpSessionId: string,
      params?: { providerId?: string },
    ): Promise<AcpSession>;
    ensure(key: string, params?: SessionNewParams): Promise<AcpSession>;
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

/** Producer side of a prompt event stream (push events, then end once). */
type EventSink = {
  push: (e: AgentEvent) => void;
  end: () => void;
};

/** Queued prompt work unit: session id, input, sink, and cancel flag. */
type PromptJob = {
  acpSessionId: string;
  input: unknown;
  sink: EventSink;
  cancelFlag: { cancelled: boolean };
};

/**
 * Reverse handler for `session/request_permission`.
 * Policy is CI-safe: deny-all, or approve only common read/search/list kinds.
 */
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
      // Explicit allowlist — anything else stays denied under this policy.
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
      // ACP selected option shape expected by agents for allow-once.
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

  /** Enqueue work and kick drain if idle (fire-and-forget). */
  enqueue(job: () => Promise<void>): void {
    this.q.push(job);
    void this.drain();
  }

  /**
   * Run jobs serially. Re-entrant: if more work arrives after a drain finishes,
   * a follow-up drain starts so nothing sits stranded behind `running`.
   */
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
      // Race: jobs may have been pushed after the while exited but before clear.
      if (this.q.length > 0) void this.drain();
    }
  }
}

/**
 * Linked sink + AsyncIterable for one prompt's event stream.
 * Invariant: after `end()`, further pushes are no-ops (no late events).
 */
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

  /** Hand off to a waiting consumer or buffer — same pattern as wire notifs. */
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
      // Idempotent terminal signal so multiple finally paths stay safe.
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

/**
 * Host product factory: wire client + session APIs + host store + prompt queue.
 * Default permission policy is `"deny"` (never approve-all).
 */
export function defineAcpClientProduct(options?: {
  /** Default: "deny". Never defaults to approve-all. */
  permissionPolicy?: PermissionPolicy;
  handlers?: Record<string, (params: unknown) => Promise<unknown> | unknown>;
}): {
  connect(transport: AcpTransport): Promise<AcpClientProduct>;
} {
  const policy = options?.permissionPolicy ?? "deny";

  return {
    /**
     * Connect product to transport: initialize agent, install reverse handlers,
     * start session/update demux, own the connection-wide prompt FIFO.
     */
    async connect(transport: AcpTransport): Promise<AcpClientProduct> {
      // Permission decisions buffer until a prompt stream can own them.
      const permissionEvents: AgentEvent[] = [];

      // Default permission reverse method; caller handlers may override after.
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

      // Real agents (e.g. Grok Build) reject session/new until initialize completes.
      // Fixture agents that ignore unknown methods still accept this.
      await wire.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: { name: "@deft/acp-client", version: "0.0.0" },
      });

      // Host session store — bookkeeping only (not run/test product stores).
      const byLocal = new Map<string, HostSessionRecord>();
      const byAcp = new Map<string, HostSessionRecord>();
      const byEnsure = new Map<string, HostSessionRecord>();

      // Fan-out session/update notifications to sinks attached for that session.
      const activeSinks = new Map<string, Set<EventSink>>();
      const cancelFlags = new Map<string, { cancelled: boolean }>();

      // One FIFO owner for all session prompts on this connection.
      const queue = new PromptQueue();

      // Background demux: only session/update is product-relevant today.
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

      /**
       * Register a prompt sink for demux fan-out; return detach that drops the
       * session entry when the last sink leaves (no empty sets retained).
       */
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

      /** Build the public `AcpSession` handle bound to a store record. */
      function wrapSession(rec: HostSessionRecord): AcpSession {
        return {
          localId: rec.localId,
          acpSessionId: rec.acpSessionId,
          providerId: rec.providerId,

          /**
           * Enqueue one prompt; return AsyncIterable of updates + terminal event.
           * Soft-closed sessions reopen on the next prompt (host-only flag).
           */
          prompt(input: unknown): AsyncIterable<AgentEvent> {
            if (rec.softClosed) {
              // Resume soft-closed session on next prompt (no agent round-trip).
              rec.softClosed = false;
            }
            const { iterable, sink } = createEventStream();
            const flag = { cancelled: false };
            cancelFlags.set(rec.acpSessionId, flag);

            // Flush permission events that belong to this session into the stream.
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

            // Serialized with other prompts — one session/prompt at a time on wire.
            queue.enqueue(async () => {
              const detach = attachSink(rec.acpSessionId, sink);
              try {
                const result = await wire.request("session/prompt", {
                  sessionId: rec.acpSessionId,
                  prompt: input,
                });
                drainPerms();
                if (flag.cancelled) {
                  // Preserve agent result but mark host cancel intent for consumers.
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
                // Always detach demux + end stream so consumers cannot hang.
                detach();
                sink.end();
              }
            });

            return iterable;
          },

          /** Best-effort cancel: set local flag and ask agent via session/cancel. */
          async cancel() {
            const flag = cancelFlags.get(rec.acpSessionId);
            if (flag) flag.cancelled = true;
            await wire.request("session/cancel", {
              sessionId: rec.acpSessionId,
            });
          },

          /** Host-only soft close — does not destroy the agent session. */
          async softClose() {
            rec.softClosed = true;
          },
        };
      }

      /**
       * Insert a new host record under local/acp/(optional ensure) indexes.
       * Local id is host-generated; acp id comes from the agent.
       */
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
          /** Always `session/new` then register under a fresh local id. */
          async create(params) {
            const result = (await wire.request(
              "session/new",
              buildSessionNewParams(params),
            )) as { sessionId: string };
            return register(result.sessionId, {
              providerId: params?.providerId,
            });
          },

          /**
           * Reuse host record if known; otherwise `session/load` then register.
           * Clears softClosed when returning an existing record.
           */
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

          /**
           * Idempotent by host ensure key: reuse or `session/new` + index by key.
           * Key is host-local — not sent to the agent.
           */
          async ensure(key, params) {
            const existing = byEnsure.get(key);
            if (existing) {
              existing.softClosed = false;
              return wrapSession(existing);
            }
            const result = (await wire.request(
              "session/new",
              buildSessionNewParams(params),
            )) as { sessionId: string };
            return register(result.sessionId, {
              providerId: params?.providerId,
              ensureKey: key,
            });
          },
        },
        /** Tear down wire (and transport) for this product connection. */
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

// ─── progressive host helpers (additive — do not replace product path) ──────

/**
 * Optional callbacks while demuxing an `AgentEvent` stream.
 * Does not replace `for await` — demux always drives the iterable.
 * Handlers may be sync or async; demux `await`s each before the next event.
 */
export type DemuxAgentEventHandlers = {
  onUpdate?: (
    event: Extract<AgentEvent, { type: "update" }>,
  ) => void | Promise<void>;
  onPromptDone?: (
    event: Extract<AgentEvent, { type: "prompt_done" }>,
  ) => void | Promise<void>;
  onPromptError?: (
    event: Extract<AgentEvent, { type: "prompt_error" }>,
  ) => void | Promise<void>;
  onPermission?: (
    event: Extract<AgentEvent, { type: "permission" }>,
  ) => void | Promise<void>;
};

/** Collected events plus last terminal result/error from a demux pass. */
export type DemuxAgentEventsResult = {
  events: AgentEvent[];
  result?: unknown;
  error?: unknown;
};

/**
 * Demux an agent event stream into callbacks + collected events.
 * Always `for await` under the hood (one stream path).
 * Awaits handlers so async callback rejections surface on this path.
 */
export async function demuxAgentEvents(
  iterable: AsyncIterable<AgentEvent>,
  handlers?: DemuxAgentEventHandlers,
): Promise<DemuxAgentEventsResult> {
  const events: AgentEvent[] = [];
  let result: unknown;
  let error: unknown;
  for await (const event of iterable) {
    events.push(event);
    // Route by discriminant; last prompt_done/error wins on result/error fields.
    switch (event.type) {
      case "update":
        await handlers?.onUpdate?.(event);
        break;
      case "prompt_done":
        result = event.result;
        await handlers?.onPromptDone?.(event);
        break;
      case "prompt_error":
        error = event.error;
        await handlers?.onPromptError?.(event);
        break;
      case "permission":
        await handlers?.onPermission?.(event);
        break;
    }
  }
  return { events, result, error };
}

export type RunAcpTurnClose = "always" | "never";

export type RunAcpTurnOptions = {
  /** Already-connected transport. */
  transport: AcpTransport;
  permissionPolicy?: PermissionPolicy;
  /**
   * Host ensure key + session/new params (`cwd` / `mcpServers` defaulted by
   * `buildSessionNewParams`).
   */
  session: { key: string } & SessionNewParams;
  prompt: unknown;
  /**
   * Lifecycle after this call. Default `"always"`: product (or transport if
   * product never connected) is closed even when ensure/prompt/connect fails.
   * `"never"` leaves lifecycle to the caller (`product.close()`).
   */
  close?: RunAcpTurnClose;
} & DemuxAgentEventHandlers;

export type RunAcpTurnResult = DemuxAgentEventsResult & {
  product: AcpClientProduct;
  session: AcpSession;
};

/**
 * One-shot host turn on an open transport: product → ensure → demux prompt.
 * Default `close: "always"` closes the product after the turn (and closes the
 * transport on connect/initialize failure before product owns it).
 * Use `close: "never"` for multi-turn; caller must `product.close()`.
 */
export async function runAcpTurn(
  opts: RunAcpTurnOptions,
): Promise<RunAcpTurnResult> {
  const closeMode: RunAcpTurnClose = opts.close ?? "always";
  let product: AcpClientProduct | undefined;
  try {
    product = await defineAcpClientProduct({
      permissionPolicy: opts.permissionPolicy ?? "deny",
    }).connect(opts.transport);
    const { key, ...sessionParams } = opts.session;
    const session = await product.sessions.ensure(key, sessionParams);
    const demuxed = await demuxAgentEvents(session.prompt(opts.prompt), {
      onUpdate: opts.onUpdate,
      onPromptDone: opts.onPromptDone,
      onPromptError: opts.onPromptError,
      onPermission: opts.onPermission,
    });
    return { ...demuxed, product, session };
  } finally {
    if (closeMode === "always") {
      if (product) {
        await product.close();
      } else {
        // Connect/initialize failed before product owned the transport.
        try {
          await opts.transport.close();
        } catch {
          // best-effort cleanup
        }
      }
    }
  }
}

/** Spawn descriptor for an agent child process (stdio transport). */
export type RunAcpStdioSpawn = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type RunAcpStdioTurnOptions = Omit<RunAcpTurnOptions, "transport"> & {
  /** Agent child process (passed to `defineStdioTransport` spawn mode). */
  spawn: RunAcpStdioSpawn;
};

/**
 * Script/tutorial happy path: spawn stdio agent → `runAcpTurn`.
 * No second product implementation — composes wire + turn helper only.
 */
export async function runAcpStdioTurn(
  opts: RunAcpStdioTurnOptions,
): Promise<RunAcpTurnResult> {
  const transport = await defineStdioTransport({
    mode: "spawn",
    command: opts.spawn.command,
    args: opts.spawn.args,
    cwd: opts.spawn.cwd,
    env: opts.spawn.env,
  }).connect();
  return runAcpTurn({
    transport,
    permissionPolicy: opts.permissionPolicy,
    session: opts.session,
    prompt: opts.prompt,
    close: opts.close,
    onUpdate: opts.onUpdate,
    onPromptDone: opts.onPromptDone,
    onPromptError: opts.onPromptError,
    onPermission: opts.onPermission,
  });
}
