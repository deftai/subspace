/**
 * The higher layer: handler options on prompts, turn.tool() and
 * PermissionDenied, and start() / run() / serveStdio() with real processes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { channelPair } from '@deft-subspace/kernel';
import { AcpClient, connectSession, PermissionDenied, serveAgent, type TurnEvent } from '@deft-subspace/acp';
import { run, start } from '@deft-subspace/acp/node';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const node = (file: string) => ({ command: process.execPath, args: ['--conditions=subspace-source', fixture(file)] });

/** An in-process agent: says two chunks, shows a tool call, asks permission. */
function pair(protocol: 1 | 2 = 2) {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'dx',
    protocols: [protocol],
    async prompt(turn) {
      await turn.say('Hello ');
      await turn.say('world');
      if (turn.text === 'tool') {
        const ok = await turn.requestPermission({ title: 'Edit a.txt' });
        await turn.say(ok.allowed ? ' (allowed)' : ' (refused)');
      }
      if (turn.text === 'question') {
        const answer = await turn.elicit({ message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } });
        await turn.say(answer.action === 'accept' ? ` ${String(answer.content?.name)}` : ` ${answer.action}`);
      }
      return 'end_turn';
    },
  });
  return clientEnd;
}

test('handler options: events in order, done after async handlers, per-turn onPermission over the client policy', async () => {
  const client = await AcpClient.connect(pair(), { permissions: 'reject' });
  const session = await client.newSession({ cwd: '/w' });
  const seen: string[] = [];
  const all: TurnEvent['type'][] = [];
  const result = await session.prompt('tool', {
    onMessage: async (delta) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(delta);
    },
    onPermission: () => 'allow',
    onPermissionAnswered: (event) => void seen.push(`perm:${event.outcome.outcome}`),
    onEvent: (event) => void all.push(event.type),
  }).done;
  // done waited for the slow handler to see every event.
  assert.deepEqual(seen, ['Hello ', 'world', 'perm:selected', ' (allowed)']);
  assert.equal(result.text, 'Hello world (allowed)');
  assert.ok(all.includes('state') && all.includes('permission'));
  // Without the per-turn answer, the client's 'reject' applies.
  assert.equal((await session.prompt('tool').done).text, 'Hello world (refused)');
  await client.close();
});

test('client default handlers apply to every turn; a prompt replaces them one by one', async () => {
  const log: string[] = [];
  const client = await AcpClient.connect(pair(1), {
    handlers: { onMessage: (d) => void log.push(`default:${d}`), onPermission: () => 'allow' },
  });
  const session = await client.newSession({ cwd: '/w' });
  await session.prompt('tool').done;
  await session.prompt('x', { onMessage: (d) => void log.push(`own:${d}`) }).done;
  assert.deepEqual(log, ['default:Hello ', 'default:world', 'default: (allowed)', 'own:Hello ', 'own:world']);
  await client.close();
});

test('a handler that throws cancels the turn, and done rejects with its error', async () => {
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'long',
    async prompt(turn) {
      for (let i = 0; i < 100 && !turn.signal.aborted; i++) {
        await turn.say(`${i} `);
        await new Promise((r) => setTimeout(r, 5));
      }
      return turn.signal.aborted ? 'cancelled' : 'end_turn';
    },
  });
  const client = await AcpClient.connect(clientEnd);
  const session = await client.newSession({ cwd: '/w' });
  const turn = session.prompt('go', {
    onMessage: (delta) => {
      if (delta === '3 ') throw new Error('renderer broke');
    },
  });
  await assert.rejects(turn.done, /renderer broke/);
  assert.equal(turn.cancelRequested, true);
  await client.close();
});

test("onQuestion answers this turn's questions", async () => {
  const client = await AcpClient.connect(pair(), { elicitation: () => ({ action: 'decline' }), elicitationModes: ['form'] });
  const session = await client.newSession({ cwd: '/w' });
  assert.equal((await session.prompt('question').done).text, 'Hello world decline');
  const answered = await session.prompt('question', { onQuestion: () => ({ action: 'accept', content: { name: 'Ada' } }) }).done;
  assert.equal(answered.text, 'Hello world Ada');
  await client.close();
});

test('turn.tool(): runs and completes; a refusal fails the call and PermissionDenied ends the turn normally; a throw fails it', async () => {
  for (const allow of [true, false]) {
    const [agentEnd, clientEnd] = channelPair<unknown>();
    let denied: unknown;
    serveAgent(agentEnd, {
      name: 'tools',
      async prompt(turn) {
        const listing = await turn.tool({ title: 'List files', kind: 'read' }, () => 'a.txt');
        await turn.tool('Broken', () => {
          throw new Error('disk on fire');
        }).catch(() => {});
        try {
          await turn.tool({ title: 'Delete a.txt', kind: 'delete', ask: 'Delete a.txt?' }, () => 'deleted');
        } catch (error) {
          denied = error;
          throw error; // escapes: the turn still ends end_turn
        }
        await turn.say(listing);
      },
    });
    const client = await AcpClient.connect(clientEnd, { permissions: allow ? 'allow' : 'reject' });
    const session = await client.newSession({ cwd: '/w' });
    const result = await session.prompt('go').done;
    assert.equal(result.stopReason, 'end_turn');
    const status = Object.fromEntries(result.toolCalls.map((c) => [c.title, c.status]));
    assert.equal(status['List files'], 'completed');
    assert.equal(status['Broken'], 'failed');
    assert.equal(status['Delete a.txt'], allow ? 'completed' : 'failed');
    assert.equal(result.toolCalls[0]?.content[0]?.type, 'content');
    if (allow) assert.equal(result.text, 'a.txt');
    else assert.ok(denied instanceof PermissionDenied);
    await client.close();
  }
});

test('start() requires a permission answer, and rejects unknown agents', async () => {
  await assert.rejects(start('claude', {} as never), /needs an answer for the agent's permission questions/);
  await assert.rejects(start('nope' as never, { permissions: 'reject' }), /Unknown agent "nope"/);
});

test("a fixed onPermission answer is kept: for start(), and for one prompt over the client's policy", async () => {
  const { command, args } = node('login-agent.ts');
  const rejecting = await start({ command, args, mode: 'ask' }, { onPermission: 'reject', handleSignals: false });
  try {
    assert.equal((await rejecting.run('go')).text, 'mode=ask allowed=false');
  } finally {
    await rejecting.close();
  }
  const allowing = await start({ command, args, mode: 'ask' }, { permissions: 'allow', handleSignals: false });
  try {
    assert.equal((await allowing.run('go', { onPermission: 'reject' })).text, 'mode=ask allowed=false');
    assert.equal((await allowing.run('go')).text, 'mode=ask allowed=true');
  } finally {
    await allowing.close();
  }
});

test('start(): logs in once when needed, switches to the requested mode, runs turns, closes with Symbol.asyncDispose', async () => {
  const { command, args } = node('login-agent.ts');
  {
    // What `await using` calls (Node 24+); called directly so the test runs on Node 22.
    const agent = await start({ command, args, mode: 'ask' }, { onPermission: () => 'allow', handleSignals: false });
    try {
      assert.equal(agent.client.agent.name, 'login-agent');
      assert.equal(agent.session.modes?.current, 'ask');
      const deltas: string[] = [];
      const result = await agent.run('go', { onMessage: (d) => void deltas.push(d) });
      assert.equal(result.text, 'mode=ask allowed=true');
      assert.deepEqual(deltas, ['mode=ask allowed=true']);
      const second = await agent.newSession();
      assert.equal(second.modes?.current, 'ask');
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
  // A mode the agent does not offer is a warning, not a failure.
  const agent = await start({ command, args, mode: 'yolo' }, { permissions: 'reject', handleSignals: false });
  assert.match(agent.modeWarning ?? '', /no mode "yolo"/);
  assert.equal((await agent.run('go')).text, 'mode=auto allowed=false');
  await agent.close();
});

test('run(): one prompt, then the agent is stopped', async () => {
  const { command, args } = node('login-agent.ts');
  const result = await run({ command, args }, 'go', { permissions: 'allow', handleSignals: false });
  assert.equal(result.text, 'mode=auto allowed=true');
});

test('serveStdio(): an agent that logs to the console still speaks clean ACP; turn.tool() over stdio', async () => {
  const { command, args } = node('stdio-agent.ts');
  for (const permissions of ['allow', 'reject'] as const) {
    const result = await run({ command, args }, 'go', { permissions, handleSignals: false });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'listed: 2');
    assert.equal(result.toolCalls.find((c) => c.title === 'Delete b.txt')?.status, permissions === 'allow' ? 'completed' : 'failed');
  }
});

test('streaming separator + delta reproduces result.text across messages (v1 and v2)', async () => {
  for (const protocol of [1, 2] as const) {
    const [agentEnd, clientEnd] = channelPair<unknown>();
    serveAgent(agentEnd, {
      name: 'chatty',
      protocols: [protocol],
      async prompt(turn) {
        await turn.say("I'll check the README.");
        await turn.tool({ title: 'Read README.md', kind: 'read' }, () => 'text');
        await turn.say('It is a library ');
        await turn.say('for ACP.\n');
        await turn.tool({ title: 'Read package.json', kind: 'read' }, () => '{}');
        await turn.say('Version 0.');
      },
    });
    const client = await AcpClient.connect(clientEnd);
    const session = await client.newSession({ cwd: '/w' });
    let streamed = '';
    const firsts: Array<[number, boolean]> = [];
    const result = await session.prompt('go', {
      onMessage: (delta, { separator, first, index }) => {
        streamed += separator + delta;
        firsts.push([index, first]);
      },
    }).done;
    assert.equal(streamed, result.text, `v${protocol}`);
    assert.equal(result.text, "I'll check the README.\n\nIt is a library for ACP.\nVersion 0.");
    assert.deepEqual(firsts, [[0, true], [1, true], [1, false], [2, true]]);
    await client.close();
  }
});

test('connect: flat handler options are defaults for every turn; a flat onQuestion advertises form questions', async () => {
  const log: string[] = [];
  const client = await AcpClient.connect(pair(), {
    onMessage: (delta) => void log.push(delta),
    onPermission: () => 'allow',
    onQuestion: () => ({ action: 'accept', content: { name: 'Grace' } }),
  });
  const session = await client.newSession({ cwd: '/w' });
  assert.equal((await session.prompt('tool').done).text, 'Hello world (allowed)');
  assert.equal((await session.prompt('question').done).text, 'Hello world Grace');
  assert.deepEqual(log.slice(0, 3), ['Hello ', 'world', ' (allowed)']);
  await client.close();
});

test('connectSession(): a ready session over any channel; needs a permission answer; closes everything', async () => {
  await assert.rejects(connectSession(pair(), { cwd: '/w' }), /connectSession\(\) needs an answer/);
  let streamed = '';
  const connected = await connectSession(pair(), {
    cwd: '/w',
    mode: 'plan',
    onPermission: () => 'reject',
    onMessage: (delta, { separator }) => void (streamed += separator + delta),
  });
  assert.match(connected.modeWarning ?? '', /no mode "plan"/);
  const result = await connected.run('tool');
  assert.equal(result.text, 'Hello world (refused)');
  assert.equal(streamed, result.text);
  await connected.close();
  await assert.rejects(connected.session.prompt('again').done);
});
