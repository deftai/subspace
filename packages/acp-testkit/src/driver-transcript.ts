/**
 * ACP transcript runner: plays the agent side of a data-only `DriverTranscript`
 * over a `Channel` using `replayAgent`, and checks both the wire exchange and
 * the `FakeWorkbench` record against the transcript's expectations.
 *
 * Supports two targets (Finding 2, requirement 5):
 *   1. `checkAcpDriver(factory, transcript)` — any `AgentDriver` over ACP.
 *   2. `checkClientLayer(setup, transcript)` — a `clientEndpoint` / `AcpClient`
 *      with one or more `ClientLayer`s and a `FakeWorkbench`.
 *
 * Uses no Node APIs.
 */
import {
  checkDriver,
  FakeWorkbench,
  matchSubset,
  verifyWorkbenchRecords,
  type AcpDriverOptions,
  type AgentDriver,
  type AgentDriverOptions,
  type AgentWorkbench,
  type ConformanceFailure,
  type ConformanceResult,
  type DriverTranscript,
  type RecordedDriverTranscript,
  type TranscriptStep,
} from '@deft-subspace/agent-driver';
import { channelPair, parseTrace, type Channel, type TraceRecord } from '@deft-subspace/kernel';
import { messagesOf } from './record.ts';
import { replayAgent, ReplayDivergence, type ReplayOptions } from './replay.ts';

/** One JSON-RPC message in an ACP transcript's `wire` array. */
export interface AcpWireMessage {
  /** `'client'` = expected from the client; `'agent'` = sent by the replaying agent. */
  dir: 'client' | 'agent';
  /** The JSON-RPC 2.0 message body (`id`, `method`/`params` or `result`/`error`). */
  msg: Record<string, unknown>;
  /**
   * Optional subset of `msg` fields that the live client message MUST match
   * (used when `dir === 'client'`). For client responses (no `method`), if
   * `match` is omitted, `result` (or `error.code`) from `msg` is checked
   * automatically.
   */
  match?: Record<string, unknown>;
  /** Optional timestamp in ms from start (preserved from recorded traces). */
  t?: number;
}

export type AcpDriverTranscript = RecordedDriverTranscript;

export type AcpDriverFactory = (workbench: AgentWorkbench, options: AcpDriverOptions) => AgentDriver;

export interface AcpTranscriptRunOptions {
  /** How long the replaying agent waits for each client message. Default 5000 ms. */
  waitMs?: number;
  /** Reordering window for client calls (passed to `replayAgent`). Default 1 (strict order). */
  window?: number;
  /** Protocol option forwarded to `AcpDriverOptions.protocol`. */
  protocol?: 'auto' | 1 | 2;
  /**
   * When true, every client request/notification's `params` must subset-match
   * the recorded `msg.params` even if `match` is not explicitly set. Default false.
   */
  strictClientParams?: boolean;
  /** Additional custom check on each client message (same signature as `ReplayOptions.check`). */
  check?: ReplayOptions['check'];
}

export interface ClientLayerHarness {
  /** Execute a non-exchange transcript step against the client endpoint / layer. */
  step?(step: TranscriptStep, index: number): void | Promise<unknown>;
  /** Close the client endpoint / client. */
  close(): void | Promise<unknown>;
}

export type ClientLayerSetup = (
  workbench: FakeWorkbench,
  channel: Channel<unknown>,
  options: AgentDriverOptions,
) => ClientLayerHarness | Promise<ClientLayerHarness>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse and validate a JSON string containing a recorded `AcpDriverTranscript`. */
export function parseAcpTranscript(json: string): AcpDriverTranscript {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error('Transcript JSON must be an object');
  if (typeof parsed.name !== 'string' || !parsed.name) throw new Error('Transcript requires a non-empty string "name"');
  if (!isRecord(parsed.options)) throw new Error('Transcript requires an "options" object');
  if (!Array.isArray(parsed.steps)) throw new Error('Transcript requires a "steps" array');
  if (!Array.isArray(parsed.expected)) throw new Error('Transcript requires an "expected" array');
  return parsed as unknown as AcpDriverTranscript;
}

/** Convert an existing Subspace JSONL trace (`TraceRecord[]` or string) into `AcpWireMessage[]`. */
export function wireFromTrace(trace: readonly TraceRecord[] | string, recordedBy?: 'client' | 'agent'): AcpWireMessage[] {
  const records = typeof trace === 'string' ? parseTrace(trace) : trace;
  const header = records[0]?.kind === 'header' ? records[0] : undefined;
  const side = recordedBy ?? (header?.peer === 'agent' ? 'agent' : 'client');
  return messagesOf(records)
    .filter((m) => isRecord(m.msg))
    .map((m) => {
      const fromClient = side === 'client' ? m.dir === 'out' : m.dir === 'in';
      return {
        dir: fromClient ? 'client' : 'agent',
        t: m.t,
        msg: m.msg as Record<string, unknown>,
      };
    });
}

function parseWireEntry(raw: unknown, label: string): AcpWireMessage {
  if (!isRecord(raw)) throw new Error(`${label}: wire entry must be an object`);
  if (raw.dir !== 'client' && raw.dir !== 'agent') {
    throw new Error(`${label}: wire entry "dir" must be "client" or "agent", got ${JSON.stringify(raw.dir)}`);
  }
  if (!isRecord(raw.msg)) throw new Error(`${label}: wire entry "msg" must be an object`);
  if (raw.match !== undefined && !isRecord(raw.match)) {
    throw new Error(`${label}: wire entry "match" must be an object when present`);
  }
  return raw as unknown as AcpWireMessage;
}

/** Extract all ACP wire messages from a transcript (top-level `wire` plus each step's `wire`), in order. */
export function wireMessagesOf(transcript: DriverTranscript): {
  messages: AcpWireMessage[];
  /** Cumulative client-message and agent-message counts at the end of each step. */
  stepTotals: Array<{ client: number; agent: number }>;
} {
  const messages: AcpWireMessage[] = [];
  let clientCount = 0;
  let agentCount = 0;

  if (Array.isArray(transcript.wire)) {
    for (let i = 0; i < transcript.wire.length; i++) {
      const entry = parseWireEntry(transcript.wire[i], `wire[${i}]`);
      messages.push(entry);
      if (entry.dir === 'client') clientCount++;
      else agentCount++;
    }
  }

  const stepTotals: Array<{ client: number; agent: number }> = [];
  for (let s = 0; s < transcript.steps.length; s++) {
    const step = transcript.steps[s]!;
    if (Array.isArray(step.wire)) {
      for (let i = 0; i < step.wire.length; i++) {
        const entry = parseWireEntry(step.wire[i], `steps[${s}].wire[${i}]`);
        messages.push(entry);
        if (entry.dir === 'client') clientCount++;
        else agentCount++;
      }
    }
    stepTotals.push({ client: clientCount, agent: agentCount });
  }

  return { messages, stepTotals };
}

/** Convert `AcpWireMessage[]` into `TraceRecord[]` suitable for `replayAgent`. */
export function wireToTrace(messages: readonly AcpWireMessage[]): TraceRecord[] {
  const records: TraceRecord[] = [{ v: 1, kind: 'header', peer: 'client', started: '1970-01-01T00:00:00.000Z' }];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    records.push({
      v: 1,
      kind: 'message',
      t: m.t ?? i,
      dir: m.dir === 'client' ? 'out' : 'in',
      msg: m.msg,
    });
  }
  return records;
}

interface WireTracker {
  readonly replay: ReturnType<typeof replayAgent>;
  /** Wait until all wire messages up through `stepIndex` have been sent/matched (or replay finishes). */
  waitForStep(stepIndex: number): Promise<void>;
}

function startWireReplay(
  agentChannel: Channel<unknown>,
  transcript: DriverTranscript,
  options: AcpTranscriptRunOptions,
): WireTracker {
  const { messages, stepTotals } = wireMessagesOf(transcript);
  const clientEntries = messages.filter((m) => m.dir === 'client');
  let clientMatched = 0;
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const fn of waiters.splice(0)) fn();
  };

  // Build lookup of client entries by method/response so `match` checks run on the right recorded entry.
  const remainingClient = [...clientEntries];

  const check: ReplayOptions['check'] = (expected, got) => {
    const isResp = !('method' in expected) && 'id' in expected;
    // Pop the corresponding client entry from remainingClient.
    const idx = remainingClient.findIndex((e) => {
      if (isResp) return !('method' in e.msg) && 'id' in e.msg;
      return e.msg.method === expected.method && ('id' in e.msg) === ('id' in expected);
    });
    const entry = idx >= 0 ? remainingClient.splice(idx, 1)[0] : undefined;

    if (entry?.match) {
      const diff = matchSubset(entry.match, got, 'wire');
      if (diff) return diff;
    } else if (isResp) {
      if ('result' in expected) {
        if (!('result' in got)) return `expected result response, got ${JSON.stringify(got)}`;
        const diff = matchSubset(expected.result, got.result, 'response.result');
        if (diff) return diff;
      } else if ('error' in expected && isRecord(expected.error)) {
        if (!isRecord(got.error)) return `expected error response, got ${JSON.stringify(got)}`;
        if (expected.error.code !== undefined && got.error.code !== expected.error.code) {
          return `response.error.code: expected ${String(expected.error.code)}, got ${String(got.error.code)}`;
        }
      }
    } else if (options.strictClientParams && 'params' in expected) {
      const diff = matchSubset(expected.params, got.params, 'request.params');
      if (diff) return diff;
    }

    const custom = options.check?.(expected, got);
    if (custom) return custom;

    clientMatched++;
    notify();
    return undefined;
  };

  const replay = replayAgent(agentChannel, wireToTrace(messages), {
    waitMs: options.waitMs ?? 5000,
    window: options.window ?? 1,
    check,
  });

  let replaySettled = false;
  void replay.done.finally(() => {
    replaySettled = true;
    notify();
  });

  const waitForStep = async (stepIndex: number): Promise<void> => {
    const target = stepTotals[stepIndex];
    if (!target) return;
    while (!replaySettled && (clientMatched < target.client || replay.sent < target.agent)) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        // If only waiting on an agent send (no client reply follows), wake on next microtask/turn.
        if (clientMatched >= target.client && replay.sent < target.agent) {
          queueMicrotask(resolve);
        }
      });
    }
    // Yield a turn so any just-written agent notifications are processed by the client reader.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  return { replay, waitForStep };
}

function replayFailure(err: unknown): ConformanceFailure {
  if (err instanceof ReplayDivergence) {
    return {
      where: `wire[${err.step}]`,
      message: err.message,
      expected: err.expected,
      actual: err.got,
    };
  }
  return {
    where: 'wire',
    message: err instanceof Error ? err.message : String(err),
    actual: err,
  };
}

/**
 * Run a recorded ACP transcript against any `AgentDriver` over ACP.
 * Replays the agent side on a `channelPair`, runs `checkDriver`, and verifies
 * both the wire exchange (`replay.done`) and the workbench record.
 */
export async function checkAcpDriver(
  factory: AcpDriverFactory,
  transcript: DriverTranscript,
  options: AcpTranscriptRunOptions = {},
): Promise<ConformanceResult> {
  const [clientCh, agentCh] = channelPair<unknown>();
  const tracker = startWireReplay(agentCh, transcript, options);

  try {
    const result = await checkDriver(
      (workbench, driverOptions) =>
        factory(workbench, {
          ...driverOptions,
          channel: clientCh,
          ...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
        }),
      transcript,
      {
        onExchange: (_step, index) => tracker.waitForStep(index),
      },
    );

    const wireFailures: ConformanceFailure[] = [];
    try {
      await tracker.replay.done;
    } catch (err) {
      wireFailures.push(replayFailure(err));
    }

    if (wireFailures.length === 0) return result;
    return {
      passed: false,
      transcript: result.transcript,
      failures: [...result.failures, ...wireFailures],
      records: result.records,
    };
  } finally {
    await tracker.replay.close();
  }
}

/** Run `checkAcpDriver` and throw a formatted Error if any check fails. */
export async function assertAcpDriverConforms(
  factory: AcpDriverFactory,
  transcript: DriverTranscript,
  options: AcpTranscriptRunOptions = {},
): Promise<ConformanceResult> {
  const result = await checkAcpDriver(factory, transcript, options);
  if (!result.passed) {
    const lines = result.failures.map((f) => `  - [${f.where}] ${f.message}`);
    throw new Error(`ACP driver failed transcript "${result.transcript}":\n${lines.join('\n')}`);
  }
  return result;
}

/**
 * Run a recorded ACP transcript directly against a `clientEndpoint` (or
 * `AcpClient`) with one or more `ClientLayer`s in its stack and a `FakeWorkbench`.
 */
export async function checkClientLayer(
  setup: ClientLayerSetup,
  transcript: DriverTranscript,
  options: AcpTranscriptRunOptions = {},
): Promise<ConformanceResult> {
  const failures: ConformanceFailure[] = [];
  const workbench = new FakeWorkbench({
    ...transcript.workbench,
    agent: transcript.workbench?.agent ?? transcript.options.agent,
  });
  const [clientCh, agentCh] = channelPair<unknown>();
  const tracker = startWireReplay(agentCh, transcript, options);

  let harness: ClientLayerHarness | undefined;
  try {
    harness = await setup(workbench, clientCh, transcript.options);

    for (let i = 0; i < transcript.steps.length; i++) {
      const step = transcript.steps[i]!;
      try {
        if (step.action === 'closeWorkbench') {
          workbench.close();
        } else if (step.action === 'exchange') {
          await tracker.waitForStep(i);
        } else {
          await harness.step?.(step, i);
        }
      } catch (err) {
        failures.push({
          where: `step[${i}] (${step.action})`,
          message: `step threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
          actual: err,
        });
      }
    }

    try {
      await tracker.replay.done;
    } catch (err) {
      failures.push(replayFailure(err));
    }
  } catch (err) {
    failures.push({
      where: 'setup',
      message: err instanceof Error ? err.message : String(err),
      actual: err,
    });
  } finally {
    await harness?.close();
    await tracker.replay.close();
  }

  return verifyWorkbenchRecords(workbench, transcript.expected, transcript.name, failures);
}

/** Run `checkClientLayer` and throw a formatted Error if any check fails. */
export async function assertClientLayerConforms(
  setup: ClientLayerSetup,
  transcript: DriverTranscript,
  options: AcpTranscriptRunOptions = {},
): Promise<ConformanceResult> {
  const result = await checkClientLayer(setup, transcript, options);
  if (!result.passed) {
    const lines = result.failures.map((f) => `  - [${f.where}] ${f.message}`);
    throw new Error(`Client layer failed transcript "${result.transcript}":\n${lines.join('\n')}`);
  }
  return result;
}
