/**
 * checkAgent: a client-driven conformance suite for any ACP agent.
 *
 *   const report = await checkAgent(channel, { cwd });
 *   console.log(formatReport(report));
 *
 * It speaks raw JSON-RPC (not AcpClient), so it sees exactly what the agent
 * sends and in which order. Each prompt runs in a fresh session. The prompts
 * are options, so a real agent can be steered into each situation.
 */
import { cancelRequest, ErrorCode, RpcError, RpcPeer, type Channel } from '@deft-subspace/kernel';
import { modesFrom } from '@deft-subspace/acp';
import { runCheck, TIMED_OUT, within, type CheckResult } from './check.ts';

export interface CheckAgentOptions {
  /** The cwd for sessions. Default '/tmp'. */
  cwd?: string;
  /** Protocol to ask for. Default 2 (an agent may answer 1). */
  protocol?: 1 | 2;
  /** A short turn. */
  prompt?: string;
  /** A turn long enough to cancel. */
  longPrompt?: string;
  /** A turn in which the agent asks for permission. `null` skips that check. */
  permissionPrompt?: string | null;
  /** How long a turn may take. Default 120 s. */
  turnTimeoutMs?: number;
  /** How long a cancelled turn may take to end. Default 10 s. */
  cancelGraceMs?: number;
  /** Wait this long after the long turn's first update before cancelling. Default 0. */
  cancelAfterMs?: number;
  /** Run only these check ids. */
  only?: string[];
  /**
   * Switch every session to this mode before its turn, e.g. an ask-first mode
   * (Claude "default", Codex "read-only"), since in their starting modes some
   * agents never ask permission and `cancel.permission` is skipped.
   */
  mode?: string;
}

export const AGENT_CHECKS = {
  'initialize.version': 'initialize answers with a protocol version we speak (1 or 2)',
  'session.new': 'session/new returns a sessionId',
  'prompt.ends': 'a prompt ends (v1: prompt response, v2: idle state)',
  'prompt.updates-before-end': 'updates arrive before the end, none after',
  'cancel.ends-cancelled': 'session/cancel ends the turn with stopReason "cancelled" in time',
  'session.unknown': 'a prompt for an unknown session is error -32002',
  'cancel.permission': 'a permission request open during a cancel, answered cancelled, ends the turn cancelled',
} as const;

export const DEFAULT_PROMPTS = {
  prompt: 'Reply with exactly OK and nothing else. Do not use any tools.',
  longPrompt: 'Count from 1 to 300, one number per line. Do not use any tools.',
  permissionPrompt: 'Create a file named deft-testkit.txt containing the word hi in the current directory.',
} as const;

type Update = Record<string, unknown>;

/** Watches one turn: its updates, and its end (v1 prompt answer, v2 idle after the answer). */
class TurnWatch {
  readonly updates: Update[] = [];
  afterEnd = 0;
  stopReason?: string;
  answered = false;
  error?: unknown;
  readonly ended: Promise<void>;
  readonly firstUpdate: Promise<void>;
  private resolveEnded!: () => void;
  private resolveFirst!: () => void;
  private idle?: string;
  private readonly protocol: 1 | 2;

  constructor(protocol: 1 | 2) {
    this.protocol = protocol;
    this.ended = new Promise((r) => (this.resolveEnded = r));
    this.firstUpdate = new Promise((r) => (this.resolveFirst = r));
  }

  get isEnded(): boolean {
    return this.stopReason !== undefined || this.error !== undefined;
  }

  update(update: Update): void {
    if (this.isEnded) {
      this.afterEnd++;
      return;
    }
    this.updates.push(update);
    this.resolveFirst();
    if (update.sessionUpdate === 'state_update' && update.state === 'idle') {
      this.idle = typeof update.stopReason === 'string' ? update.stopReason : 'end_turn';
      if (this.answered) this.end(this.idle);
    }
  }

  answer(result: unknown): void {
    this.answered = true;
    if (this.protocol === 1) this.end(String((result as { stopReason?: unknown } | null)?.stopReason ?? ''));
    else if (this.idle !== undefined) this.end(this.idle);
  }

  fail(error: unknown): void {
    if (this.isEnded) return;
    this.error = error;
    this.resolveFirst();
    this.resolveEnded();
  }

  private end(stopReason: string): void {
    this.stopReason = stopReason;
    this.resolveEnded();
  }
}

export async function checkAgent(channel: Channel<unknown>, options: CheckAgentOptions = {}): Promise<CheckResult[]> {
  const cwd = options.cwd ?? '/tmp';
  const turnTimeout = options.turnTimeoutMs ?? 120_000;
  const grace = options.cancelGraceMs ?? 10_000;
  const prompts = {
    prompt: options.prompt ?? DEFAULT_PROMPTS.prompt,
    longPrompt: options.longPrompt ?? DEFAULT_PROMPTS.longPrompt,
    permissionPrompt: options.permissionPrompt === undefined ? DEFAULT_PROMPTS.permissionPrompt : options.permissionPrompt,
  };
  const wanted = (id: keyof typeof AGENT_CHECKS) => !options.only || options.only.includes(id);
  const report: CheckResult[] = [];
  const check = async (id: keyof typeof AGENT_CHECKS, body: Parameters<typeof runCheck>[2]) => {
    if (wanted(id)) report.push(await runCheck(id, AGENT_CHECKS[id], body));
  };

  const watches = new Map<string, TurnWatch>();
  /** How this check answers permission requests, per session. Default: reject (or cancelled). */
  const permissionHandlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  const peer = new RpcPeer(channel, { name: 'deft-testkit', ...cancelRequest });
  peer.onNotification('session/update', (params: { sessionId?: string; update?: Update }) => {
    if (params?.sessionId && params.update) watches.get(params.sessionId)?.update(params.update);
  });
  peer.onRequest('session/request_permission', (params: Record<string, unknown>) => {
    const handler = permissionHandlers.get(String(params?.sessionId));
    if (handler) return handler(params);
    const options = Array.isArray(params?.options) ? (params.options as Array<{ optionId: string; kind: string }>) : [];
    const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
    return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
  });
  peer.start();

  let protocol: 1 | 2 | undefined;
  const asked = options.protocol ?? 2;
  try {
    const init = (await within(
      peer.request('initialize', {
        protocolVersion: asked,
        ...(asked === 2 ? { info: { name: 'deft-testkit', version: '0' }, capabilities: {} } : {}),
        clientInfo: { name: 'deft-testkit', version: '0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      60_000,
      TIMED_OUT
    )) as Record<string, unknown> | typeof TIMED_OUT;
    if (init !== TIMED_OUT) {
      const v = Number(init?.protocolVersion);
      if (v === 1 || v === 2) protocol = v;
      await check('initialize.version', async () => ({
        pass: protocol !== undefined && protocol <= asked,
        detail: `asked v${asked}, agent chose ${String(init?.protocolVersion)}`,
      }));
    } else {
      await check('initialize.version', async () => ({ pass: false, detail: 'no answer within 60 s' }));
    }
  } catch (error) {
    await check('initialize.version', async () => ({ pass: false, detail: `error: ${message(error)}` }));
  }
  if (protocol === undefined) {
    await peer.close();
    return report;
  }
  const v = protocol;

  const newSession = async (): Promise<string> => {
    const result = (await peer.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 60_000 })) as { sessionId?: unknown };
    if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error(`session/new returned ${JSON.stringify(result)}`);
    if (options.mode) await switchMode(result.sessionId, result as Record<string, unknown>, options.mode);
    return result.sessionId;
  };

  /** session/set_mode (v1 modes) or session/set_config_option (a "mode" config option). */
  const switchMode = async (sessionId: string, answer: Record<string, unknown>, modeId: string) => {
    const modes = modesFrom(answer);
    if (!modes?.available.some((m) => m.id === modeId)) {
      throw new Error(`the agent offers no mode "${modeId}" (available: ${modes?.available.map((m) => m.id).join(', ') || 'none'})`);
    }
    if (modes.via === 'modes') {
      await peer.request('session/set_mode', { sessionId, modeId }, { timeoutMs: 30_000 });
    } else {
      const params = { sessionId, configId: modes.configId, value: modeId, ...(v === 2 ? { type: 'id' } : {}) };
      await peer.request('session/set_config_option', params, { timeoutMs: 30_000 });
    }
  };

  const startTurn = (sessionId: string, text: string): TurnWatch => {
    const watch = new TurnWatch(v);
    watches.set(sessionId, watch);
    peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then(
      (result) => watch.answer(result),
      (error) => watch.fail(error)
    );
    return watch;
  };

  /** Make sure a turn that did not end is not left running. */
  const settle = async (sessionId: string, watch: TurnWatch) => {
    if (watch.isEnded) return;
    await peer.notify('session/cancel', { sessionId }).catch(() => {});
    await within(watch.ended, grace, TIMED_OUT);
  };

  let sessionId: string | undefined;
  await check('session.new', async () => {
    sessionId = await newSession();
    return { pass: true, detail: `sessionId ${sessionId}` };
  });

  if (sessionId && (wanted('prompt.ends') || wanted('prompt.updates-before-end'))) {
    const watch = startTurn(sessionId, prompts.prompt);
    const ended = await within(watch.ended, turnTimeout, TIMED_OUT);
    // Anything sent right after the end would show up now.
    await new Promise((r) => setTimeout(r, 100));
    await check('prompt.ends', async () =>
      ended === TIMED_OUT
        ? { pass: false, detail: `no end within ${turnTimeout} ms (v${v})` }
        : watch.error
          ? { pass: false, detail: `prompt failed: ${message(watch.error)}` }
          : { pass: !!watch.stopReason, detail: `v${v}, stopReason ${watch.stopReason}` }
    );
    await check('prompt.updates-before-end', async () => {
      const content = watch.updates.filter((u) => u.sessionUpdate !== 'state_update').length;
      return {
        pass: watch.isEnded && content > 0 && watch.afterEnd === 0,
        detail: `${content} update(s) before the end, ${watch.afterEnd} after`,
      };
    });
    await settle(sessionId, watch);
  }

  await check('cancel.ends-cancelled', async () => {
    const id = await newSession();
    const watch = startTurn(id, prompts.longPrompt);
    if ((await within(watch.firstUpdate, turnTimeout, TIMED_OUT)) === TIMED_OUT) {
      await settle(id, watch);
      return { pass: false, detail: `no update within ${turnTimeout} ms to cancel after` };
    }
    if (options.cancelAfterMs) await new Promise((r) => setTimeout(r, options.cancelAfterMs));
    if (watch.isEnded) return { pass: false, detail: `the turn ended (${watch.stopReason}) before the cancel; use a longer longPrompt` };
    const sent = Date.now();
    await peer.notify('session/cancel', { sessionId: id });
    if ((await within(watch.ended, grace, TIMED_OUT)) === TIMED_OUT) {
      return { pass: false, detail: `still running ${grace} ms after session/cancel` };
    }
    if (watch.error) return { pass: false, detail: `prompt failed: ${message(watch.error)}` };
    return { pass: watch.stopReason === 'cancelled', detail: `stopReason ${watch.stopReason} after ${Date.now() - sent} ms` };
  });

  await check('session.unknown', async () => {
    try {
      const result = await peer.request(
        'session/prompt',
        { sessionId: 'deft-testkit-no-such-session', prompt: [{ type: 'text', text: 'hello' }] },
        { timeoutMs: 10_000 }
      );
      return { pass: false, detail: `answered ${JSON.stringify(result)}` };
    } catch (error) {
      if (RpcError.is(error)) {
        return { pass: error.code === ErrorCode.ResourceNotFound, detail: `error ${error.code}: ${error.message}` };
      }
      return { pass: false, detail: message(error) };
    }
  });

  if (prompts.permissionPrompt !== null) {
    await check('cancel.permission', async () => {
      const id = await newSession();
      let asked = false;
      let onAsked!: () => void;
      const askedPromise = new Promise<void>((r) => (onAsked = r));
      permissionHandlers.set(id, async () => {
        asked = true;
        onAsked();
        // The user has not answered and the turn is cancelled: the spec says answer cancelled.
        await peer.notify('session/cancel', { sessionId: id });
        return { outcome: { outcome: 'cancelled' } };
      });
      const watch = startTurn(id, prompts.permissionPrompt!);
      const first = await within(Promise.race([askedPromise, watch.ended]), turnTimeout, TIMED_OUT);
      if (!asked) {
        permissionHandlers.delete(id);
        await settle(id, watch);
        return { pass: true, skipped: true, detail: `the agent asked no permission (${first === TIMED_OUT ? 'timed out' : `stopReason ${watch.stopReason}`})` };
      }
      const ended = await within(watch.ended, grace, TIMED_OUT);
      permissionHandlers.delete(id);
      if (ended === TIMED_OUT) return { pass: false, detail: `still running ${grace} ms after the cancel` };
      if (watch.error) return { pass: false, detail: `prompt failed: ${message(watch.error)}` };
      return { pass: watch.stopReason === 'cancelled', detail: `stopReason ${watch.stopReason}` };
    });
  }

  await peer.close();
  return report;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
