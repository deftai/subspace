/**
 * Model adapter face + offline stub (no network, no provider SDK).
 */

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

  complete(messages: ModelMessage[]): string | AsyncIterable<string> {
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

/** True when model.complete returned a streaming iterable. */
export function isAsyncIterable(v: unknown): v is AsyncIterable<string> {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as AsyncIterable<string>)[Symbol.asyncIterator] === "function"
  );
}
