/**
 * Replay: play the agent side of a recorded trace to a live client.
 *
 *   const replay = replayAgent(channel, parseTrace(text));
 *   const client = await AcpClient.connect(otherEnd);
 *   ...
 *   await replay.done; // rejects with a ReplayDivergence if the client did something else
 *
 * - The agent's recorded messages are sent in recorded order, as soon as the
 *   client messages recorded before them have arrived.
 * - Client requests and notifications are matched by method, in order. Their
 *   params may differ (pass `check` to be stricter). Responses to the agent's
 *   requests are matched by id.
 * - JSON-RPC ids are remapped both ways: recorded answers go out with the
 *   client's live ids, and the agent's requests get fresh ids.
 * - When the client sends something else, or nothing within `waitMs`, the
 *   replay stops with a ReplayDivergence naming what was expected and what
 *   arrived, answers the offending request with that error, and closes the
 *   connection, so the client fails instead of hanging.
 */
import { ErrorCode, parseTrace, type Channel, type JsonRpcId, type TraceRecord } from '@deft-subspace/kernel';
import { messagesOf } from './record.ts';

export interface ReplayOptions {
  /** How long to wait for each message the client is expected to send. Default 5000 ms. */
  waitMs?: number;
  /** 0 (default) sends as fast as possible; 1 keeps the recorded gaps before the agent's messages; 0.5 halves them. */
  pace?: number;
  /** Which side recorded the trace. Default: the header's `peer` if it is 'agent', else 'client'. */
  recordedBy?: 'client' | 'agent';
  /**
   * Compare a client message with the recorded one (both whole JSON-RPC
   * messages). Return a description to stop the replay as diverged.
   */
  check?: (expected: Record<string, unknown>, got: Record<string, unknown>) => string | undefined | void;
}

/** The client did something the recording did not. */
export class ReplayDivergence extends Error {
  /** 1-based position in the trace's messages. */
  readonly step: number;
  readonly expected: unknown;
  readonly got: unknown;

  constructor(step: number, total: number, description: string, expected: unknown, got: unknown) {
    super(`Replay diverged at message ${step} of ${total}: ${description}`);
    this.name = 'ReplayDivergence';
    this.step = step;
    this.expected = expected;
    this.got = got;
  }
}

export interface Replay {
  /** Settles when every recorded message has been sent and matched; rejects with a ReplayDivergence. */
  readonly done: Promise<void>;
  /** Messages sent so far. */
  readonly sent: number;
  /** Stop and close the connection. */
  close(): Promise<void>;
}

type Message = Record<string, unknown>;
type Step = { dir: 'send' | 'expect'; t: number; msg: Message };

const isRecord = (value: unknown): value is Message => typeof value === 'object' && value !== null && !Array.isArray(value);
const key = (id: unknown) => JSON.stringify(id ?? null);
const isCall = (m: Message) => typeof m.method === 'string';
const isResponse = (m: Message) => !isCall(m) && 'id' in m && ('result' in m || 'error' in m);
const describe = (m: Message | undefined): string => {
  if (!m) return 'nothing';
  if (isCall(m)) return `${'id' in m ? 'request' : 'notification'} "${String(m.method)}"`;
  if (isResponse(m)) return `a response to request ${key(m.id)}`;
  return 'a malformed message';
};

export function replayAgent(channel: Channel<unknown>, trace: readonly TraceRecord[] | string, options: ReplayOptions = {}): Replay {
  const records = typeof trace === 'string' ? parseTrace(trace) : trace;
  const header = records[0]?.kind === 'header' ? records[0] : undefined;
  const recordedBy = options.recordedBy ?? (header?.peer === 'agent' ? 'agent' : 'client');
  // As the agent sees it: `in` is what the client sent.
  const steps: Step[] = messagesOf(records)
    .filter((m) => isRecord(m.msg))
    .map((m) => {
      const fromClient = recordedBy === 'client' ? m.dir === 'out' : m.dir === 'in';
      return { dir: fromClient ? 'expect' : 'send', t: m.t, msg: m.msg as Message };
    });
  const waitMs = options.waitMs ?? 5000;
  const pace = options.pace ?? 0;

  const writer = channel.writable.getWriter();
  const reader = channel.readable.getReader();
  const calls: Message[] = []; // client requests and notifications not matched yet
  const responses = new Map<string, Message>(); // by live id
  const clientIds = new Map<string, JsonRpcId>(); // recorded client request id -> live id
  const agentIds = new Map<string, JsonRpcId>(); // recorded agent request id -> live id
  let nextAgentId = 0;
  let wake: (() => void) | undefined;
  let finished = false;
  let clientGone = false;
  let sent = 0;
  let scriptOver = false;

  const write = async (message: Message) => {
    await writer.write({ jsonrpc: '2.0', ...message });
    sent++;
  };

  const shutdown = async () => {
    if (finished) return;
    finished = true;
    wake?.();
    await writer.close().catch(() => {});
    await reader.cancel().catch(() => {});
  };

  // Read the client's messages into the buffers.
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!isRecord(value)) continue;
        if (isResponse(value)) responses.set(key(value.id), value);
        else if (isCall(value)) {
          if (scriptOver && 'id' in value) {
            // Nothing recorded answers this: say so instead of leaving it open.
            void write({
              id: value.id,
              error: { code: ErrorCode.InternalError, message: `Replay has ended; nothing was recorded for ${String(value.method)}` },
            }).catch(() => {});
            continue;
          }
          calls.push(value);
        }
        wake?.();
      }
    } catch {
      // The connection failed; treated like an end.
    }
    clientGone = true;
    wake?.();
  })();

  /** Wait until `take` finds something, the client leaves, or time runs out. */
  const waitFor = async <T>(take: () => T | undefined): Promise<T | undefined> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const found = take();
      if (found !== undefined || clientGone || finished) return found;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(handle);
          resolve();
        };
      });
      wake = undefined;
    }
  };

  /** Methods of the agent's recorded requests, for the text of a missing answer. */
  const methods = new Map<string, string>();
  const methodOf = (response: Message) => methods.get(key(response.id)) ?? '?';

  /** A recorded agent message with live ids. */
  const outgoing = (message: Message): Message => {
    const { jsonrpc: _jsonrpc, ...rest } = message;
    if (isResponse(rest)) {
      const live = clientIds.get(key(rest.id));
      return live === undefined ? rest : { ...rest, id: live };
    }
    if (isCall(rest) && 'id' in rest) {
      const live = nextAgentId++;
      agentIds.set(key(rest.id), live);
      methods.set(key(rest.id), String(rest.method));
      return { ...rest, id: live };
    }
    if (rest.method === '$/cancel_request' && isRecord(rest.params)) {
      const live = clientIds.get(key(rest.params.requestId));
      if (live !== undefined) return { ...rest, params: { ...rest.params, requestId: live } };
    }
    return rest;
  };

  const run = async () => {
    let lastT = 0;
    for (let index = 0; index < steps.length; index++) {
      if (finished) return;
      const step = steps[index]!;
      const expected = step.msg;
      const diverge = async (description: string, got?: Message) => {
        const error = new ReplayDivergence(index + 1, steps.length, description, expected, got);
        if (got && isCall(got) && 'id' in got) {
          await write({ id: got.id, error: { code: ErrorCode.InternalError, message: error.message, data: { expected, got } } }).catch(() => {});
        }
        throw error;
      };
      const silence = () => (clientGone ? 'the client closed the connection' : `nothing within ${waitMs} ms`);

      if (step.dir === 'send') {
        if (pace > 0 && step.t > lastT) await new Promise((resolve) => setTimeout(resolve, (step.t - lastT) * pace));
        lastT = step.t;
        await write(outgoing(expected)).catch(() => {});
        continue;
      }
      lastT = step.t;

      if (isResponse(expected)) {
        const live = agentIds.get(key(expected.id));
        const liveKey = key(live === undefined ? expected.id : live);
        const got = await waitFor(() => {
          const r = responses.get(liveKey);
          if (r) responses.delete(liveKey);
          return r;
        });
        if (!got) await diverge(`expected the client to answer request "${methodOf(expected)}", got ${silence()}`);
        continue;
      }

      if (!isCall(expected)) continue;
      const got = await waitFor(() => calls.shift());
      if (!got) {
        await diverge(`expected the client to send ${describe(expected)}, got ${silence()}`);
        return;
      }
      if (got.method !== expected.method || ('id' in got) !== ('id' in expected)) {
        await diverge(`expected the client to send ${describe(expected)}, got ${describe(got)}`, got);
      }
      const complaint = options.check?.(expected, got);
      if (complaint) await diverge(complaint, got);
      if ('id' in expected) clientIds.set(key(expected.id), got.id as JsonRpcId);
    }
    scriptOver = true;
    // Requests already buffered past the end get the same answer as later ones.
    for (const extra of calls.splice(0)) {
      if ('id' in extra) {
        await write({ id: extra.id, error: { code: ErrorCode.InternalError, message: `Replay has ended; nothing was recorded for ${String(extra.method)}` } }).catch(() => {});
      }
    }
  };

  const done = run().then(
    () => undefined,
    async (error) => {
      await shutdown();
      throw error;
    }
  );
  done.catch(() => {});

  return {
    done,
    get sent() {
      return sent;
    },
    close: shutdown,
  };
}
