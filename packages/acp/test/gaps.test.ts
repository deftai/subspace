import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as officialV1 from '@agentclientprotocol/sdk';
import { ErrorCode, RpcError } from '@deft-subspace/kernel';
import { AcpClient, serveAgent, type AgentOptions, type ClientOptions, type ProtocolVersion } from '@deft-subspace/acp';
import { workspaceTerminals } from '@deft-subspace/acp/node';
import { byteLink, sleep } from './helpers.ts';

async function pair(protocol: ProtocolVersion, agent: Partial<AgentOptions>, client: ClientOptions = {}) {
  const link = byteLink();
  const calls: string[] = [];
  serveAgent(link.agent, { name: 'gaps', protocols: [protocol], prompt: () => 'end_turn', ...agent });
  const c = await AcpClient.connect(link.client, client);
  return { client: c, calls };
}

const history: AgentOptions['loadSession'] = async ({ sessionId, replay }) => {
  if (sessionId !== 'old') throw RpcError.notFound(`Unknown session ${sessionId}`);
  if (!replay) return;
  await replay.userMessage('What is 2+2?');
  await replay.say('4');
  const call = await replay.toolCall({ title: 'calc', kind: 'think' });
  await call.complete();
};

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: loadSession replays history, then the session takes prompts`, async () => {
    const { client } = await pair(protocol, {
      loadSession: history,
      prompt: async (turn) => {
        await turn.say(`again: ${turn.text}`);
        return 'end_turn';
      },
    });
    const { session, replayed } = await client.loadSession({ sessionId: 'old', cwd: '/tmp' });
    assert.deepEqual(
      replayed.map((e) => (e.type === 'tool_call' ? `tool:${e.toolCall.status}` : e.type === 'message' || e.type === 'user_message' ? `${e.type}:${e.text}` : e.type)),
      ['user_message:What is 2+2?', 'message:4', 'tool:pending', 'tool:completed']
    );
    assert.equal((await session.prompt('5?').done).text, 'again: 5?');
    await client.close();
  });

  test(`v${protocol}: resumeSession reopens without replay; unknown ids fail and are not kept`, async () => {
    let replayGiven: boolean | undefined;
    const { client } = await pair(protocol, {
      loadSession: async (r) => {
        replayGiven = !!r.replay;
        await history(r);
      },
    });
    const session = await client.resumeSession({ sessionId: 'old', cwd: '/tmp' });
    assert.equal(replayGiven, false);
    assert.equal((await session.prompt('hi').done).stopReason, 'end_turn');
    await assert.rejects(client.loadSession({ sessionId: 'nope', cwd: '/tmp' }), (e) => RpcError.is(e) && e.code === ErrorCode.ResourceNotFound);
    // A failed load leaves nothing behind: loading the same id again is allowed.
    await assert.rejects(client.loadSession({ sessionId: 'nope', cwd: '/tmp' }), /Unknown session/);
    await client.close();
  });

  test(`v${protocol}: close cancels the turn, tells the agent, and the id is then unknown`, async () => {
    let closed: string | undefined;
    const { client } = await pair(protocol, {
      closeSession: (id) => void (closed = id),
      prompt: (turn) => new Promise<'end_turn'>((resolve) => turn.signal.addEventListener('abort', () => resolve('end_turn'))),
    });
    const session = await client.newSession({ cwd: '/tmp' });
    const turn = session.prompt('long');
    await sleep(10);
    await session.close();
    assert.equal((await turn.done).stopReason, 'cancelled');
    assert.equal(closed, session.id);
    await assert.rejects(client.peer.request('session/prompt', { sessionId: session.id, prompt: [] }), (e) => RpcError.is(e) && e.code === ErrorCode.ResourceNotFound);
    await client.close();
  });

  test(`v${protocol}: session titles and the user's own message are events`, async () => {
    const { client } = await pair(protocol, {
      prompt: async (turn) => {
        await turn.userMessage(turn.text);
        await turn.sendUpdate({ sessionUpdate: 'session_info_update', title: 'Adding numbers', updatedAt: '2026-11-07T00:00:00Z' });
        await turn.say('ok');
        return 'end_turn';
      },
    });
    const session = await client.newSession({ cwd: '/tmp' });
    const turn = session.prompt('add 2 and 2');
    const result = await turn.done;
    assert.equal(result.text, 'ok', 'the user message is not part of the agent text');
    assert.ok(turn.history.some((e) => e.type === 'user_message' && e.text === 'add 2 and 2'));
    assert.ok(turn.history.some((e) => e.type === 'session_info' && e.title === 'Adding numbers'));
    assert.deepEqual(session.info, { title: 'Adding numbers', updatedAt: '2026-11-07T00:00:00Z' });
    await client.close();
  });

  test(`v${protocol}: elicitation answers, fails closed, and cancels with the turn`, async () => {
    const answers: unknown[] = [];
    let waiting!: () => void;
    const waitAsked = new Promise<void>((resolve) => (waiting = resolve));
    const { client } = await pair(
      protocol,
      {
        prompt: async (turn) => {
          answers.push(await turn.elicit({ message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }));
          answers.push(await turn.elicit({ message: 'boom' }));
          answers.push(await turn.elicit({ message: 'wait' }));
          return 'end_turn';
        },
      },
      {
        elicitation: async (request, signal) => {
          if (request.message === 'boom') throw new Error('UI crashed');
          if (request.message === 'wait') {
            waiting();
            return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ action: 'accept' })));
          }
          assert.equal(request.mode, 'form');
          return { action: 'accept', content: { name: 'Ada' } };
        },
      }
    );
    const session = await client.newSession({ cwd: '/tmp' });
    const turn = session.prompt('go');
    await waitAsked; // cancel while the third question is open
    await turn.cancel();
    await turn.done;
    assert.deepEqual(answers, [{ action: 'accept', content: { name: 'Ada' } }, { action: 'decline' }, { action: 'cancel' }]);
    await client.close();
  });
}

test('elicit throws when the client offers none', async () => {
  let error: unknown;
  const { client } = await pair(1, {
    prompt: async (turn) => {
      await turn.elicit({ message: 'x' }).catch((e) => (error = e));
      return 'end_turn';
    },
  });
  await (await client.newSession({ cwd: '/tmp' })).prompt('go').done;
  assert.match(String(error), /CapabilityError: The client does not offer form elicitation/);
  await client.close();
});

test('v1: terminals run inside the workspace, report output and exit, truncate, kill, and refuse', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'deft-subspace-term-'));
  const terminals = workspaceTerminals(ws, { allow: ({ command }) => command !== 'rm', killGraceMs: 200 });
  const seen: Record<string, unknown> = {};
  try {
    const { client } = await pair(
      1,
      {
        prompt: async (turn) => {
          const node = process.execPath;
          const ok = await turn.terminal(node, { args: ['-e', "console.log('out'); console.error('err'); process.exit(3)"] });
          seen.exit = await ok.waitForExit();
          seen.output = (await ok.output()).output;
          await ok.release();

          const big = await turn.terminal(node, { args: ['-e', "process.stdout.write('x'.repeat(5000))"], outputByteLimit: 100 });
          await big.waitForExit();
          const out = await big.output();
          seen.big = [out.output.length, out.truncated];
          await big.release();

          const forever = await turn.terminal(node, { args: ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"] });
          while (!(await forever.output()).output.includes('ready')) await sleep(10);
          await forever.kill();
          seen.killed = (await forever.waitForExit()).signal;
          await forever.release();

          seen.refused = await turn.terminal('rm', { args: ['-rf', '/'] }).catch((e) => (e as Error).message);
          seen.outside = await turn.terminal(node, { cwd: '/' }).catch((e) => (e as Error).message);
          return 'end_turn';
        },
      },
      { terminals }
    );
    await (await client.newSession({ cwd: ws })).prompt('go').done;
    assert.deepEqual(seen.exit, { exitCode: 3, signal: null });
    assert.equal(seen.output, 'out\nerr\n');
    assert.deepEqual(seen.big, [100, true]);
    assert.equal(seen.killed, 'SIGKILL');
    assert.match(String(seen.refused), /refused to run rm/);
    assert.match(String(seen.outside), /outside the workspace/);
    await client.close();
  } finally {
    await terminals.dispose();
    await rm(ws, { recursive: true, force: true });
  }
});

test('workspaceTerminals: the output limit keeps the newest bytes, drops only a character it cut in half', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'deft-subspace-term-'));
  const terminals = workspaceTerminals(ws);
  const run = async (script: string, outputByteLimit: number) => {
    const { terminalId } = await terminals.create({ sessionId: 's', command: process.execPath, args: ['-e', script], outputByteLimit });
    await terminals.waitForExit({ sessionId: 's', terminalId });
    return terminals.output({ sessionId: 's', terminalId });
  };
  try {
    // 'ab' + U+FFFD (3 bytes) + '123456': 11 bytes.
    const script = "process.stdout.write('ab\\uFFFD'); setTimeout(() => process.stdout.write('123456'), 20)";
    // The cut falls before U+FFFD: a real one is kept.
    assert.deepEqual(await run(script, 9), { output: '\uFFFD123456', truncated: true, exitStatus: { exitCode: 0, signal: null } });
    // The cut falls inside it: its tail is dropped.
    assert.equal((await run(script, 8)).output, '123456');
    // Many small writes past the limit.
    const many = await run("for (let i = 0; i < 3000; i++) process.stdout.write(String(i % 10))", 1000);
    assert.equal(many.output.length, 1000);
    assert.equal(many.output.slice(-3), '789');
  } finally {
    await terminals.dispose();
    await rm(ws, { recursive: true, force: true });
  }
});

test('v2: no client terminals (v2 removed them)', async () => {
  let error: unknown;
  const { client } = await pair(
    2,
    {
      prompt: async (turn) => {
        await turn.terminal('ls').catch((e) => (error = e));
        return 'end_turn';
      },
    },
    { terminals: workspaceTerminals(tmpdir()) }
  );
  await (await client.newSession({ cwd: '/tmp' })).prompt('go').done;
  assert.match(String(error), /CapabilityError: The client does not offer terminals/);
  await client.close();
});

test('an official SDK agent replays a loaded session to our client', async () => {
  const link = byteLink();
  officialV1
    .agent({ name: 'loader' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }))
    .onRequest('session/load', async ({ params, client }) => {
      const send = (update: officialV1.SessionUpdate) => client.notify('session/update', { sessionId: params.sessionId, update });
      await send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } });
      return {};
    })
    .connect(officialV1.ndJsonStream(link.b.writable, link.b.readable));
  const client = await AcpClient.connect(link.client);
  const { replayed } = await client.loadSession({ sessionId: 'saved', cwd: '/tmp' });
  assert.deepEqual(replayed.map((e) => (e.type === 'message' || e.type === 'user_message' ? `${e.type}:${e.text}` : e.type)), [
    'user_message:earlier question',
    'message:earlier answer',
  ]);
  await client.close();
});

test('loadSession on a v1 agent that does not offer it says so', async () => {
  const { client } = await pair(1, {});
  await assert.rejects(client.loadSession({ sessionId: 'x', cwd: '/tmp' }), /does not offer session\/load/);
  await client.close();
});
