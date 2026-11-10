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
import { runCheck, TIMED_OUT, within, type CheckResult } from './check.ts';

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
  /** An existing file outside the client's workspace, to try reading. Without it only writes are tried. */
  outsideFile?: string;
  /** How long to wait for an answer or a turn. Default 10 s. */
  timeoutMs?: number;
  only?: string[];
}

export const CLIENT_CHECKS = {
  'permission.answered': 'answers a permission request with an option it was offered',
  'permission.cancelled-on-cancel': 'answers "cancelled" for a permission request open when the turn is cancelled',
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
  const [agentEnd, clientEnd] = channelPair<unknown>();

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
      const answer = within(agent.request('session/request_permission', permissionParams(turn, call.id)), timeout, TIMED_OUT);
      // The request is on its way; now the user cancels the turn.
      void driver!.cancel();
      const result = await answer;
      const cancelSeen = await within(aborted(turn.signal), timeout, TIMED_OUT);
      if (result === TIMED_OUT) return { pass: false, detail: `the permission request was not answered within ${timeout} ms` };
      const outcome = (result as { outcome?: { outcome?: string } })?.outcome?.outcome;
      return {
        pass: outcome === 'cancelled',
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
        const attempt = async (method: string, params: Record<string, unknown>) => {
          try {
            await agent.request(method, { sessionId, ...params }, { timeoutMs: timeout });
            pass = false;
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
    const session = await client.newSession({ cwd: options.cwd ?? '/tmp' });
    let turn: Turn | undefined;
    return {
      prompt: (text) => (turn = session.prompt(text)).done,
      cancel: () => turn?.cancel(),
      close: () => client.close(),
    };
  };
}
