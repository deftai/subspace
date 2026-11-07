/**
 * The ready-made helpers: permission rules, the terminal renderer and
 * prompt, tracing, and errors that say what to do next.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { channelPair, parseTrace } from '@deft-subspace/kernel';
import {
  AcpClient,
  allow,
  allowInside,
  firstOf,
  readOnly,
  reject,
  serveAgent,
  type PermissionRequest,
} from '@deft-subspace/acp';
import { askInTerminal, start, terminal } from '@deft-subspace/acp/node';

const request = (fields: Partial<PermissionRequest> & { kind?: string; rawInput?: unknown; locations?: unknown[] }): PermissionRequest => ({
  sessionId: 's',
  title: fields.title ?? 'Do it',
  options: [],
  protocol: 2,
  raw: {},
  toolCall: { id: 't', title: fields.title ?? 'Do it', status: 'pending', content: [], locations: fields.locations ?? [], kind: fields.kind, rawInput: fields.rawInput },
  ...(fields.command ? { command: fields.command } : {}),
});
const signal = new AbortController().signal;

test('permission rules: readOnly, allow/reject matches, allowInside, firstOf ordering and fallback', async () => {
  assert.equal(await readOnly(request({ kind: 'read' }), signal), 'allow');
  assert.equal(await readOnly(request({ kind: 'edit' }), signal), 'reject');

  const policy = firstOf(
    reject({ commands: /rm -rf/ }),
    allow({ kinds: ['execute'], commands: /^npm test/ }),
    allowInside('/repo'),
    'reject'
  );
  assert.equal(await policy(request({ kind: 'execute', rawInput: { command: 'npm test -- --watch' } }), signal), 'allow');
  assert.equal(await policy(request({ kind: 'execute', rawInput: { command: 'rm -rf /repo/build' } }), signal), 'reject');
  assert.equal(await policy(request({ kind: 'edit', locations: [{ path: '/repo/src/a.ts' }] }), signal), 'allow');
  assert.equal(await policy(request({ kind: 'edit', rawInput: { file_path: 'src/../README.md' } }), signal), 'allow', 'relative to the root');
  assert.equal(await policy(request({ kind: 'edit', locations: [{ path: '/repo/../etc/passwd' }] }), signal), 'reject', '.. cannot leave');
  assert.equal(await policy(request({ kind: 'edit', locations: [{ path: '/repository/a' }] }), signal), 'reject', 'a prefix is not inside');
  assert.equal(await policy(request({ kind: 'edit' }), signal), 'reject', 'no paths: no opinion, then the fallback');
  // No fallback at all rejects.
  assert.equal(await firstOf(allow({ kinds: ['read'] }))(request({ kind: 'edit' }), signal), 'reject');
});

test('terminal(): streams text, dims thoughts, shows tool calls and answered permissions', async () => {
  let written = '';
  const out = { write: (text: string) => void (written += text), isTTY: false };
  const [agentEnd, clientEnd] = channelPair<unknown>();
  serveAgent(agentEnd, {
    name: 'r',
    async prompt(turn) {
      await turn.think('Looking.');
      await turn.say('Checking ');
      await turn.say('files.');
      await turn.tool({ title: 'List files', kind: 'read' }, () => 'a');
      await turn.tool({ title: 'Delete a', kind: 'delete', ask: true }, () => 'x').catch(() => {});
      await turn.say('Done.');
    },
  });
  const client = await AcpClient.connect(clientEnd, { ...terminal({ out }), onPermission: 'reject' });
  const session = await client.newSession({ cwd: '/w' });
  await session.prompt('go').done;
  assert.equal(
    written,
    ['Looking.', '', 'Checking files.', '', '• List files', '  ✓ List files', '• Delete a', '? Delete a refused', '  ✗ Delete a', '', 'Done.'].join('\n')
  );
  await client.close();
});

test('askInTerminal(): y, n and always (remembered per kind); no terminal rejects', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  const ask = askInTerminal({ input, output });
  const answer = (text: string) => setTimeout(() => input.write(`${text}\n`), 5);
  answer('y');
  assert.equal(await ask(request({ kind: 'edit', title: 'Edit a' }), signal), 'allow');
  answer('n');
  assert.equal(await ask(request({ kind: 'edit', title: 'Edit b' }), signal), 'reject');
  answer('a');
  assert.equal(await ask(request({ kind: 'execute', title: 'Run x' }), signal), 'allow_always');
  assert.equal(await ask(request({ kind: 'execute', title: 'Run y' }), signal), 'allow', 'not asked again');
  const notTty = askInTerminal({ input: Object.assign(new PassThrough(), { isTTY: false }), output });
  assert.equal(await notTty(request({ kind: 'edit' }), signal), 'reject');
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('start({ trace }) records the connection; errors say what to do next', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subspace-trace-'));
  const trace = join(dir, 'run.jsonl');
  const agent = await start(
    { command: process.execPath, args: ['--conditions=source', fixture('login-agent.ts')] },
    { permissions: 'allow', trace, handleSignals: false, quiet: true }
  );
  await agent.run('go');
  await agent.close();
  const records = parseTrace(await readFile(trace, 'utf8'));
  assert.equal(records[0]?.kind, 'header');
  const methods = records.flatMap((r) => (r.kind === 'message' ? [String((r.msg as { method?: unknown }).method ?? '')] : []));
  for (const m of ['initialize', 'authenticate', 'session/new', 'session/prompt', 'session/request_permission']) assert.ok(methods.includes(m), m);

  await assert.rejects(
    start({ command: '/no/such/agent', args: [], install: 'Install it with `brew install agent`' }, { permissions: 'reject', handleSignals: false, quiet: true }),
    /Install it with `brew install agent`/
  );
  await assert.rejects(
    start(
      { command: process.execPath, args: ['--conditions=source', fixture('login-agent.ts')], login: 'Run `agent login`' },
      { permissions: 'reject', handleSignals: false, quiet: true, env: { ...process.env, NO_LOGIN_METHODS: '1' } as Record<string, string> }
    ),
    /needs a login\. Run `agent login`/
  );
});
