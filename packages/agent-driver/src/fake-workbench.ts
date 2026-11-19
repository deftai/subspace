/**
 * Fake AgentWorkbench for tests and conformance checking (W1-W5, design §4.8, §8.2, §8.3).
 *
 * Uses no Node APIs.
 */
import {
  KNOWN_ASK_KINDS,
  type AgentEvent,
  type AgentWorkbench,
  type Ask,
  type AskOptions,
  type Cancelled,
  type McpServerDeclaration,
  type ToolDescriptor,
  type WorkbenchFiles,
  type WorkbenchPresentation,
  type WorkbenchProject,
  type WorkbenchSessions,
  type WorkbenchTerminals,
  type WorkbenchTools,
} from './types.ts';

export type WorkbenchRecord =
  | { kind: 'event'; workbench: string; event: AgentEvent; cloneError?: string }
  | {
      kind: 'ask';
      workbench: string;
      askKind: string;
      request: unknown;
      detached: boolean;
      turnId: string | null;
      answer?: unknown;
      settled: boolean;
      cloneError?: string;
    }
  | {
      kind: 'service';
      workbench: string;
      service: 'files' | 'terminals' | 'tools' | 'sessions' | 'project' | 'presentation';
      method: string;
      args: unknown;
      result?: unknown;
      error?: string;
    }
  | { kind: 'turn_started'; workbench: string; turnId: string }
  | { kind: 'turn_ended'; workbench: string; turnId: string; stopReason: string };

export interface AskHandlerContext {
  workbench: string;
  signal: AbortSignal;
  detached: boolean;
  turnId: string | null;
}

export type AskResponder =
  | Readonly<Record<string, readonly unknown[]>>
  | ((ask: Ask<unknown, unknown>, ctx: AskHandlerContext) => unknown | Promise<unknown>);

export interface FakeWorkbenchOptions {
  agent?: { readonly name: string; readonly identity: string | null };
  project?: {
    path?: string;
    env?: Readonly<Record<string, string>>;
    settings?: Readonly<Record<string, unknown>>;
    rememberEnv?: WorkbenchProject['rememberEnv'];
  };
  files?: Partial<WorkbenchFiles>;
  terminals?: Partial<WorkbenchTerminals>;
  tools?: Partial<WorkbenchTools>;
  sessions?: Partial<WorkbenchSessions>;
  presentation?: Partial<WorkbenchPresentation>;
  /** Scripted ask answers: either a per-kind queue of answers, or a responder function. */
  asks?: AskResponder;
}

interface OpenAskEntry {
  turnId: string | null;
  cancel: () => void;
}

const CANCELLED: Cancelled = { outcome: 'cancelled' };

function tryClone<T>(value: T): { value: T; cloneError?: string } {
  try {
    return { value: structuredClone(value) };
  } catch (err) {
    return { value, cloneError: err instanceof Error ? err.message : String(err) };
  }
}

export class FakeWorkbench implements AgentWorkbench {
  readonly records: WorkbenchRecord[] = [];
  readonly agent: { readonly name: string; readonly identity: string | null };
  readonly files: WorkbenchFiles;
  readonly terminals: WorkbenchTerminals;
  readonly tools: WorkbenchTools;
  readonly sessions: WorkbenchSessions;
  readonly project: WorkbenchProject;
  readonly presentation: WorkbenchPresentation;

  readonly #children = new Map<string, AgentWorkbench>();
  readonly #openAsks = new Set<OpenAskEntry>();
  readonly #askQueues = new Map<string, unknown[]>();
  readonly #askFn?: (ask: Ask<unknown, unknown>, ctx: AskHandlerContext) => unknown | Promise<unknown>;
  readonly #rememberedEnv = new Map<string, string>();
  readonly #options: FakeWorkbenchOptions;
  readonly #projectPath: string;
  readonly #projectEnv: Readonly<Record<string, string>>;
  readonly #settings: Readonly<Record<string, unknown>>;
  #currentTurnId: string | null = null;
  #closed = false;

  constructor(options: FakeWorkbenchOptions = {}) {
    this.#options = options;
    this.agent = options.agent ?? { name: 'test-agent', identity: null };

    if (typeof options.asks === 'function') {
      this.#askFn = options.asks;
    } else if (options.asks) {
      for (const [kind, list] of Object.entries(options.asks)) {
        this.#askQueues.set(kind, [...list]);
      }
    }

    this.#projectPath = options.project?.path ?? '/workspace';
    this.#projectEnv = { ...(options.project?.env ?? {}) };
    this.#settings = options.project?.settings ?? {};

    this.files = this.#makeFiles('main', options.files);
    this.terminals = this.#makeTerminals('main', options.terminals);
    this.tools = this.#makeTools('main', options.tools);
    this.sessions = this.#makeSessions('main', options.sessions);
    this.project = this.#makeProject('main', this.#projectPath, this.#projectEnv, this.#settings, options.project?.rememberEnv);
    this.presentation = this.#makePresentation('main', options.presentation);
  }

  /** Number of currently open (unsettled) asks in the single registry (W2). */
  get openAskCount(): number {
    return this.#openAsks.size;
  }

  /** Whether the workbench has been closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Environment variables remembered via `project.rememberEnv`. */
  get rememberedEnv(): ReadonlyMap<string, string> {
    return this.#rememberedEnv;
  }

  emit(event: AgentEvent): void {
    this.#emitOn('main', event);
  }

  ask<Request, Answer>(ask: Ask<Request, Answer>, options?: AskOptions): Promise<Answer | Cancelled> {
    return this.#askOn('main', ask, options);
  }

  turnStarted(turnId: string): void {
    this.#currentTurnId = turnId;
    this.records.push({ kind: 'turn_started', workbench: 'main', turnId });
  }

  turnEnded(turnId: string, stopReason: string): void {
    this.records.push({ kind: 'turn_ended', workbench: 'main', turnId, stopReason });
    if (this.#currentTurnId === turnId) {
      this.#currentTurnId = null;
    }
    for (const entry of [...this.#openAsks]) {
      if (entry.turnId === turnId) {
        entry.cancel();
      }
    }
  }

  /** Cancel every currently open ask (of any turn or detached). */
  cancelAllAsks(): void {
    for (const entry of [...this.#openAsks]) {
      entry.cancel();
    }
  }

  /** Close the workbench, settling every open ask as cancelled (W3). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cancelAllAsks();
  }

  child(childSessionId: string): AgentWorkbench {
    const existing = this.#children.get(childSessionId);
    if (existing) return existing;

    const parent = this;
    const childWorkbench: AgentWorkbench = {
      agent: parent.agent,
      files: parent.#makeFiles(childSessionId, parent.#options.files),
      terminals: parent.#makeTerminals(childSessionId, parent.#options.terminals),
      tools: parent.#makeTools(childSessionId, parent.#options.tools),
      sessions: parent.#makeSessions(childSessionId, parent.#options.sessions),
      project: parent.#makeProject(
        childSessionId,
        parent.#projectPath,
        parent.#projectEnv,
        parent.#settings,
        parent.#options.project?.rememberEnv,
      ),
      presentation: parent.#makePresentation(childSessionId, parent.#options.presentation),
      emit(event: AgentEvent): void {
        parent.#emitOn(childSessionId, event);
      },
      ask<Request, Answer>(ask: Ask<Request, Answer>, options?: AskOptions): Promise<Answer | Cancelled> {
        return parent.#askOn(childSessionId, ask, options);
      },
      turnStarted(turnId: string): void {
        parent.records.push({ kind: 'turn_started', workbench: childSessionId, turnId });
      },
      turnEnded(turnId: string, stopReason: string): void {
        parent.records.push({ kind: 'turn_ended', workbench: childSessionId, turnId, stopReason });
      },
      child(nestedId: string): AgentWorkbench {
        return parent.child(nestedId);
      },
    };

    this.#children.set(childSessionId, childWorkbench);
    return childWorkbench;
  }

  #emitOn(workbenchId: string, event: AgentEvent): void {
    // W1: emit MUST NOT throw.
    const { value, cloneError } = tryClone(event);
    const entry: WorkbenchRecord = {
      kind: 'event',
      workbench: workbenchId,
      event: value,
      ...(cloneError !== undefined ? { cloneError } : {}),
    };
    this.records.push(entry);
  }

  #askOn<Request, Answer>(
    workbenchId: string,
    ask: Ask<Request, Answer>,
    options?: AskOptions,
  ): Promise<Answer | Cancelled> {
    const detached = options?.detached === true;
    const turnId = detached ? null : this.#currentTurnId;
    const { value: clonedReq, cloneError } = tryClone(ask.request);

    const record: Extract<WorkbenchRecord, { kind: 'ask' }> = {
      kind: 'ask',
      workbench: workbenchId,
      askKind: ask.kind,
      request: clonedReq,
      detached,
      turnId,
      settled: false,
      ...(cloneError !== undefined ? { cloneError } : {}),
    };
    this.records.push(record);

    const finish = (answer: Answer | Cancelled): Answer | Cancelled => {
      record.answer = tryClone(answer).value;
      record.settled = true;
      return answer;
    };

    // Unknown ask kind settles cancelled at once (design §4).
    if (!KNOWN_ASK_KINDS.has(ask.kind)) {
      return Promise.resolve(finish(CANCELLED));
    }

    // Already closed or signal already aborted.
    if (this.#closed || options?.signal?.aborted) {
      return Promise.resolve(finish(CANCELLED));
    }

    return new Promise<Answer | Cancelled>((resolve) => {
      let settled = false;
      const controller = new AbortController();

      const settle = (value: Answer | Cancelled) => {
        if (settled) return;
        settled = true;
        this.#openAsks.delete(entry);
        options?.signal?.removeEventListener('abort', onExternalAbort);
        resolve(finish(value));
      };

      const cancel = () => {
        if (settled) return;
        controller.abort();
        settle(CANCELLED);
      };

      const onExternalAbort = () => cancel();

      const entry: OpenAskEntry = { turnId, cancel };
      this.#openAsks.add(entry);

      if (options?.signal) {
        options.signal.addEventListener('abort', onExternalAbort, { once: true });
      }

      const resolveAnswer = async () => {
        try {
          let raw: unknown;
          if (this.#askFn) {
            raw = await this.#askFn(ask as Ask<unknown, unknown>, {
              workbench: workbenchId,
              signal: controller.signal,
              detached,
              turnId,
            });
          } else {
            const queue = this.#askQueues.get(ask.kind);
            raw = queue && queue.length > 0 ? queue.shift() : undefined;
          }
          if (settled) return;
          if (raw === undefined) {
            settle(CANCELLED);
          } else {
            settle(raw as Answer | Cancelled);
          }
        } catch {
          settle(CANCELLED);
        }
      };

      void resolveAnswer();
    });
  }

  async #recordService<T>(
    workbenchId: string,
    service: Extract<WorkbenchRecord, { kind: 'service' }>['service'],
    method: string,
    args: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const entry: Extract<WorkbenchRecord, { kind: 'service' }> = {
      kind: 'service',
      workbench: workbenchId,
      service,
      method,
      args: tryClone(args).value,
    };
    this.records.push(entry);
    try {
      const result = await fn();
      entry.result = tryClone(result).value;
      return result;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  #makeFiles(wb: string, impl?: Partial<WorkbenchFiles>): WorkbenchFiles {
    return {
      readText: (req) =>
        this.#recordService(wb, 'files', 'readText', req, () => {
          if (impl?.readText) return impl.readText(req);
          return Promise.reject(new Error(`FakeWorkbench: files.readText not scripted for ${req.path}`));
        }),
      writeText: (req) =>
        this.#recordService(wb, 'files', 'writeText', req, () => {
          if (impl?.writeText) return impl.writeText(req);
          return Promise.resolve();
        }),
    };
  }

  #makeTerminals(wb: string, impl?: Partial<WorkbenchTerminals>): WorkbenchTerminals {
    return {
      create: (req) =>
        this.#recordService(wb, 'terminals', 'create', req, () => {
          if (impl?.create) return impl.create(req);
          return Promise.reject(new Error(`FakeWorkbench: terminals.create not scripted for ${req.command}`));
        }),
      output: (req) =>
        this.#recordService(wb, 'terminals', 'output', req, () => {
          if (impl?.output) return impl.output(req);
          return Promise.reject(new Error(`FakeWorkbench: terminals.output not scripted for ${req.terminalId}`));
        }),
      waitForExit: (req) =>
        this.#recordService(wb, 'terminals', 'waitForExit', req, () => {
          if (impl?.waitForExit) return impl.waitForExit(req);
          return Promise.reject(new Error(`FakeWorkbench: terminals.waitForExit not scripted for ${req.terminalId}`));
        }),
      kill: (req) =>
        this.#recordService(wb, 'terminals', 'kill', req, () => {
          if (impl?.kill) return impl.kill(req);
          return Promise.resolve();
        }),
      release: (req) =>
        this.#recordService(wb, 'terminals', 'release', req, () => {
          if (impl?.release) return impl.release(req);
          return Promise.resolve();
        }),
    };
  }

  #makeTools(wb: string, impl?: Partial<WorkbenchTools>): WorkbenchTools {
    return {
      list: () =>
        this.#recordService<ToolDescriptor[] | null>(wb, 'tools', 'list', undefined, () =>
          impl?.list ? impl.list() : Promise.resolve([]),
        ),
      call: (name, args, options) =>
        this.#recordService(wb, 'tools', 'call', { name, args }, () => {
          if (impl?.call) return impl.call(name, args, options);
          return Promise.resolve({ ok: false, message: `Unknown tool: ${name}` });
        }),
      mcpServers: () =>
        this.#recordService<McpServerDeclaration[]>(wb, 'tools', 'mcpServers', undefined, () =>
          impl?.mcpServers ? impl.mcpServers() : Promise.resolve([]),
        ),
    };
  }

  #makeSessions(wb: string, impl?: Partial<WorkbenchSessions>): WorkbenchSessions {
    return {
      opened: (rec) =>
        this.#recordService(wb, 'sessions', 'opened', rec, () =>
          impl?.opened ? impl.opened(rec) : Promise.resolve(),
        ),
      titled: (rec) =>
        this.#recordService(wb, 'sessions', 'titled', rec, () =>
          impl?.titled ? impl.titled(rec) : Promise.resolve(),
        ),
      used: (rec) =>
        this.#recordService(wb, 'sessions', 'used', rec, () => (impl?.used ? impl.used(rec) : Promise.resolve())),
      deleted: (rec) =>
        this.#recordService(wb, 'sessions', 'deleted', rec, () =>
          impl?.deleted ? impl.deleted(rec) : Promise.resolve(),
        ),
    };
  }

  #makeProject(
    wb: string,
    path: string,
    env: Readonly<Record<string, string>>,
    settings: Readonly<Record<string, unknown>>,
    rememberImpl?: WorkbenchProject['rememberEnv'],
  ): WorkbenchProject {
    return {
      path,
      env,
      setting: (key: string) => settings[key],
      rememberEnv: (name: string, value: string) =>
        this.#recordService(wb, 'project', 'rememberEnv', { name, value }, async () => {
          this.#rememberedEnv.set(name, value);
          if (rememberImpl) await rememberImpl(name, value);
        }),
    };
  }

  #makePresentation(wb: string, impl?: Partial<WorkbenchPresentation>): WorkbenchPresentation {
    return {
      capabilities: () =>
        this.#recordService<Readonly<Record<string, unknown>>>(wb, 'presentation', 'capabilities', undefined, () =>
          impl?.capabilities ? impl.capabilities() : Promise.resolve({}),
        ),
      systemPrompt: () =>
        this.#recordService<string | null>(wb, 'presentation', 'systemPrompt', undefined, () =>
          impl?.systemPrompt ? impl.systemPrompt() : Promise.resolve(null),
        ),
    };
  }
}
