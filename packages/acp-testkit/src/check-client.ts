/**
 * checkClient: an agent-driven conformance suite for any ACP client.
 *
 *   const report = await checkClient(acpClientDriver({ permissions: 'allow', files }), { protocol: 1 });
 *
 * The suite plays the agent. `connect` gets the client's end of a channel; it
 * connects the client (initialize, session/new) and returns a driver the
 * suite uses to start and cancel turns. Each check is one prompt; the agent
 * reads which check it is from the prompt text.
 */
import { channelPair, ErrorCode, RpcError, type Channel, type Call, type InboundContext, type RpcPeer } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type AgentTurn, type ClientOptions, type ProtocolVersion, type Turn } from '@deft-subspace/acp';
import { defaultTempDir, runCheck, TIMED_OUT, within, type CheckResult } from './check.ts';

export interface ClientDriver {
  /** Send a prompt and resolve when the client considers the turn over. */
  prompt(text: string): Promise<unknown>;
  /** Cancel the running turn, as the user would. */
  cancel(): unknown;
  close?(): unknown;
}

export type ConnectClient = (channel: Channel<unknown>) => Promise<ClientDriver>;

export interface CheckClientOptions {
  /** Protocol the agent speaks. Default 1. */
  protocol?: ProtocolVersion;
  /**
   * An existing file outside the client's workspace, to try reading. Without
   * it only writes are tried (and a client that can only read is skipped).
   */
  outsideFile?: string;
  /** How long to wait for an answer or a turn. Default 10 s. */
  timeoutMs?: number;
  only?: string[];
}

export const CLIENT_CHECKS = {
  'permission.answered': 'answers a permission request with an option it was offered',
  'permission.cancelled-on-cancel': 'answers "cancelled" for a permission request open when the turn is cancelled, and sends session/cancel',
  'fs.outside-workspace': 'refuses file paths outside its workspace (if it advertises fs)',
  'unknown-method': 'answers an unknown method with MethodNotFound (-32601)',
} as const;

const OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

type Outcome = { pass: boolean; detail: string; skipped?: boolean };

export async function checkClient(connect: ConnectClient, options: CheckClientOptions = {}): Promise<CheckResult[]> {
  const protocol = options.protocol ?? 1;
  const timeout = options.timeoutMs ?? 10_000;
  const wanted = (id: keyof typeof CLIENT_CHECKS) => !options.only || options.only.includes(id);
  const [agentEnd, rawClientEnd] = channelPair<unknown>();
  // Watch what the client reads, to cancel only once it has the permission request.
  let onPermissionRead: (() => void) | undefined;
  const clientEnd: Channel<unknown> = {
    readable: rawClientEnd.readable.pipeThrough(
      new TransformStream<unknown, unknown>({
        transform(message, controller) {
          controller.enqueue(message);
          if ((message as { method?: unknown } | null)?.method === 'session/request_permission') onPermissionRead?.();
        },
      })
    ),
    writable: rawClientEnd.writable,
  };

  let init: Record<string, unknown> = {};
  let cwd = '';
  let sessionId = '';
  let sessions = 0;
  let driver: ClientDriver | undefined;
  /** What the running check's prompt handler found. */
  const found = new Map<string, Outcome>();

  const capture = async (call: Call, next: () => Promise<unknown>, _context: InboundContext) => {
    if (call.method === 'initialize' && call.params && typeof call.params === 'object') init = call.params as Record<string, unknown>;
    return next();
  };

  const permissionParams = (turn: AgentTurn, toolCallId: string) =>
    protocol === 2
      ? { sessionId: turn.sessionId, title: 'Write notes.txt', subject: { type: 'tool_call', toolCall: { toolCallId } }, options: OPTIONS }
      : { sessionId: turn.sessionId, toolCall: { toolCallId }, options: OPTIONS };

  const scenarios: Record<string, (turn: AgentTurn) => Promise<Outcome>> = {
    'permission.answered': async (turn) => {
      const call = await turn.toolCall({ title: 'Write notes.txt', kind: 'edit' });
      const answer = await within(agent.request('session/request_permission', permissionParams(turn, call.id)), timeout, TIMED_OUT);
      await call.complete();
      if (answer === TIMED_OUT) return { pass: false, detail: `no answer within ${timeout} ms` };
      const outcome = (answer as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
      if (outcome?.outcome === 'selected') {
        const offered = OPTIONS.some((o) => o.optionId === outcome.optionId);
        return { pass: offered, detail: `selected ${JSON.stringify(outcome.optionId)}${offered ? '' : ', which was not offered'}` };
      }
      return { pass: outcome?.outcome === 'cancelled', detail: `answered ${JSON.stringify(answer)}` };
    },
    'permission.cancelled-on-cancel': async (turn) => {
      const call = await turn.toolCall({ title: 'Write notes.txt', kind: 'edit' });
      const read = new Promise<void>((resolve) => (onPermissionRead = resolve));
      let settled = false;
      const answer = within(agent.request('session/request_permission', permissionParams(turn, call.id)), timeout, TIMED_OUT).finally(() => (settled = true));
      // Once the client has read the request (and had a moment to handle it), the user cancels the turn.
      const delivered = await within(read, timeout, TIMED_OUT);
      onPermissionRead = undefined;
      if (delivered !== TIMED_OUT) await new Promise((resolve) => setTimeout(resolve, 0));
      if (settled) {
        // Answered at once (a fixed policy): no request was open to cancel.
        const result = await answer.catch((error) => `error ${String(error)}`);
        return { pass: true, skipped: true, detail: `the client answered ${JSON.stringify(result)} before the cancel; nothing was open to cancel` };
      }
      void driver!.cancel();
      const result = await answer;
      const cancelSeen = await within(aborted(turn.signal), timeout, TIMED_OUT);
      if (result === TIMED_OUT) return { pass: false, detail: `the permission request was not answered within ${timeout} ms` };
      const outcome = (result as { outcome?: { outcome?: string } })?.outcome?.outcome;
      // Both: the open request answered cancelled, and the turn itself cancelled with session/cancel.
      return {
        pass: outcome === 'cancelled' && cancelSeen !== TIMED_OUT,
        detail: `answered ${JSON.stringify(result)}; session/cancel ${cancelSeen === TIMED_OUT ? 'not sent' : 'sent'}`,
      };
    },
  };

  const agent: RpcPeer = serveAgent(agentEnd, {
    name: 'deft-testkit-agent',
    protocols: [protocol],
    peer: { inbound: [capture] },
    newSession(request) {
      cwd = request.cwd;
      sessionId = `deft-testkit-session-${++sessions}`;
      return { sessionId };
    },
    async prompt(turn) {
      const scenario = scenarios[turn.text];
      if (!scenario) return 'end_turn';
      found.set(turn.text, await scenario(turn).catch((error) => ({ pass: false, detail: `threw: ${String(error)}` })));
      return turn.signal.aborted ? 'cancelled' : 'end_turn';
    },
  });

  const report: CheckResult[] = [];
  try {
    driver = await within(connect(clientEnd), timeout, TIMED_OUT).then((d) => {
      if (d === TIMED_OUT) throw new Error(`the client did not connect within ${timeout} ms`);
      return d;
    });
  } catch (error) {
    await agent.close();
    return [{ id: 'connect', title: 'the client connects (initialize, session/new)', pass: false, detail: String(error) }];
  }

  for (const id of ['permission.answered', 'permission.cancelled-on-cancel'] as const) {
    if (!wanted(id)) continue;
    report.push(
      await runCheck(id, CLIENT_CHECKS[id], async () => {
        const ended = await within(driver!.prompt(id).then(() => 'ok', (e) => `failed: ${String(e)}`), timeout * 2, TIMED_OUT);
        const outcome = found.get(id);
        if (!outcome) return { pass: false, detail: ended === TIMED_OUT ? 'the turn did not run' : `the turn ${ended}` };
        if (ended === TIMED_OUT) return { pass: false, detail: `${outcome.detail}; the turn did not end on the client` };
        return outcome;
      })
    );
  }

  if (wanted('fs.outside-workspace')) {
    report.push(
      await runCheck('fs.outside-workspace', CLIENT_CHECKS['fs.outside-workspace'], async () => {
        const fs = ((init.clientCapabilities as Record<string, unknown> | undefined)?.fs ??
          (init.capabilities as Record<string, unknown> | undefined)?.fs) as { readTextFile?: boolean; writeTextFile?: boolean } | undefined;
        if (!fs?.readTextFile && !fs?.writeTextFile) return { pass: true, skipped: true, detail: 'the client advertises no fs access' };
        const base = cwd.replace(/[\\/]+$/, '');
        const tried: string[] = [];
        let pass = true;
        const written: string[] = [];
        const attempt = async (method: string, params: Record<string, unknown>) => {
          try {
            await agent.request(method, { sessionId, ...params }, { timeoutMs: timeout });
            pass = false;
            if (method === 'fs/write_text_file') written.push(String(params.path));
            tried.push(`${method} ${String(params.path)}: allowed`);
          } catch {
            tried.push(`${method} ${String(params.path)}: refused`);
          }
        };
        if (fs.writeTextFile) {
          await attempt('fs/write_text_file', { path: `${base}/../deft-testkit-outside.txt`, content: 'deft-testkit' });
          await attempt('fs/write_text_file', { path: `${base}-deft-testkit-outside/escape.txt`, content: 'deft-testkit' });
        }
        if (fs.readTextFile && options.outsideFile) await attempt('fs/read_text_file', { path: options.outsideFile });
        // A client that let the writes through leaves files behind: remove them (when it shares our file system).
        if (written.length) await removeWritten(written, `${base}-deft-testkit-outside`);
        if (!tried.length) return { pass: true, skipped: true, detail: 'the client can only read files; pass outsideFile to try a read outside the workspace' };
        return { pass, detail: tried.join('; ') };
      })
    );
  }

  if (wanted('unknown-method')) {
    report.push(
      await runCheck('unknown-method', CLIENT_CHECKS['unknown-method'], async () => {
        try {
          const result = await agent.request('deft-testkit/no-such-method', {}, { timeoutMs: timeout });
          return { pass: false, detail: `answered ${JSON.stringify(result)}` };
        } catch (error) {
          if (RpcError.is(error)) return { pass: error.code === ErrorCode.MethodNotFound, detail: `error ${error.code}: ${error.message}` };
          return { pass: false, detail: String(error) };
        }
      })
    );
  }

  await driver?.close?.();
  await agent.close();
  return report;
}

/** Best effort, and only in Node (this module also runs elsewhere): the test files, then the folder made for one. */
async function removeWritten(paths: string[], folder: string): Promise<void> {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
  if (!node) return;
  const specifier = 'node:fs/promises';
  const fs = (await import(/* @vite-ignore */ specifier).catch(() => undefined)) as typeof import('node:fs/promises') | undefined;
  if (!fs) return;
  for (const path of paths) await fs.rm(path, { force: true }).catch(() => {});
  await fs.rmdir(folder).catch(() => {});
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** A driver for our own AcpClient: connects, opens a session in `cwd`, runs turns. */
export function acpClientDriver(options: ClientOptions & { cwd?: string } = {}): ConnectClient {
  return async (channel) => {
    const client = await AcpClient.connect(channel, options);
    const session = await client.newSession({ cwd: options.cwd ?? defaultTempDir() });
    let turn: Turn | undefined;
    return {
      prompt: (text) => (turn = session.prompt(text)).done,
      cancel: () => turn?.cancel(),
      close: () => client.close(),
    };
  };
}
