/**
 * @deft/acp-harness — early Path A coding-agent harness (public barrel).
 *
 * Owns: re-exports of model, session, options, handlers, and listen APIs.
 * Does not own: wire codecs, client product, or real provider SDKs.
 *
 * Serves ACP via defineAcpServer: initialize, session/new|load|prompt|cancel.
 * Brain = ModelAdapter (StubModelAdapter by default). Not a production agent.
 *
 * Module layout (DX first pass): model · session · options · handlers · listen.
 * Prefer zero tools; cancel is cooperative between stream steps.
 */

export type {
  ModelAdapter,
  ModelMessage,
  ModelRole,
  StubModelAdapterOptions,
} from "./model.ts";
export { StubModelAdapter, isAsyncIterable } from "./model.ts";

export type { SessionRec } from "./session.ts";
export { createSessionRec, createSessionStore } from "./session.ts";

export type { HarnessOptions, ResolvedHarnessOptions } from "./options.ts";
export { resolveHarnessOptions } from "./options.ts";

export type { HarnessBridge } from "./handlers.ts";
export { defineHarnessHandlers } from "./handlers.ts";

export { defineHarness, listenHarness } from "./listen.ts";
