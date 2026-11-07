import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelRequest, ErrorCode, RpcError, RpcPeer, type Channel } from '@deft-subspace/kernel';
import { AcpClient, type TurnEvent } from '@deft-subspace/acp';
import { serveJournal, type ServeOptions } from '@deft-subspace/acp-journal';
import { link, until, world } from './fixture.ts';

type Log = Array<{ method: string; params: Record<string, any> }>;

function serve(w: ReturnType<typeof world>, options: Partial<ServeOptions> = {}) {
  const l = link();
  serveJournal(l.agent, w.registry, { name: 'ideal', ...options });
  return l.client;
}

/** A bare JSON-RPC client that logs every notification and lets the test answer permission questions. */
async function raw(channel: Channel<unknown>) {
  const log: Log = [];
  const asked: Array<{ params: any; signal: AbortSignal; answer: (optionId: string | 'cancelled') => void }> = [];
  const peer = new RpcPeer(channel, { name: 'raw', ...cancelRequest });
  peer.onNotification('*', (params, context) => {
    if (!context.method.startsWith('$/')) log.push({ method: context.method, params: params as Record<string, any> });
  });
  peer.onRequest('session/request_permission', (params, context) =>
    new Promise((resolve) =>
      asked.push({
        params,
        signal: context.signal,
        answer: (id) => resolve({ outcome: id === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: id } }),
      })
    )
  );
  peer.start();
  await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const call = (method: string, params: Record<string, unknown>) => peer.request<any>(method, params);
  return { peer, log, asked, call };
}

const text = (prompt: string) => [{ type: 'text', text: prompt }];
const isCode = (code: number) => (e: unknown) => RpcError.is(e) && e.code === code;

function shape(events: readonly TurnEvent[]) {
  return events.map((e) => {
    switch (e.type) {
      case 'message':
        return `message ${JSON.stringify(e.delta)} => ${JSON.stringify(e.text)}`;
      case 'tool_call':
        return `tool ${e.created ? 'new' : 'upd'} ${e.toolCall.title} [${e.toolCall.status}] content=${e.toolCall.content.length}`;
      case 'permission':
        return `permission ${e.request.title} -> ${e.outcome.outcome === 'selected' ? (e.outcome.allowed ? 'allowed' : 'rejected') : 'cancelled'}`;
      default:
        return e.type;
    }
  });
}

test('AcpClient sees streamed text once, tool calls, and permissions as TurnEvents', async () => {
  const w = world();
  const client = await AcpClient.connect(serve(w), { permissions: 'allow' });
  assert.equal(client.protocol, 1);
  const session = await client.newSession({ cwd: '/w' });

  const streamed = session.prompt('stream Hello brave world');
  const result = await streamed.done;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.text, 'Hello brave world ', 'the final full message did not repeat the deltas');
  assert.deepEqual(shape(streamed.history), [
    'message "Hello " => "Hello "',
    'message "brave " => "Hello brave "',
    'message "world " => "Hello brave world "',
  ]);

  const tool = session.prompt('tool read README.md');
  const toolResult = await tool.done;
  assert.deepEqual(shape(tool.history), [
    'tool new read README.md [pending] content=0',
    'permission read README.md -> allowed',
    'tool upd read README.md [completed] content=1',
    'message "Done." => "Done."',
  ]);
  assert.deepEqual(toolResult.toolCalls[0]?.locations, [{ path: 'README.md' }]);
  await client.close();
});

test('AcpClient: a failing policy denies; cancel mid-gate ends the turn cancelled with the tool failed', async () => {
  const w = world();
  const denying = await AcpClient.connect(serve(w), { permissions: () => { throw new Error('ui crashed'); } });
  const s1 = await denying.newSession({ cwd: '/w' });
  const denied = await s1.prompt('tool exec rm').done;
  assert.equal(denied.text, 'Not allowed.');
  assert.equal(denied.toolCalls[0]?.status, 'failed');
  await denying.close();

  const waiting = await AcpClient.connect(serve(w), {
    permissions: (_request, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('allow'))),
  });
  const s2 = await waiting.newSession({ cwd: '/w' });
  const turn = s2.prompt('tool exec make');
  await until(() => w.journal.types(s2.id).includes('session.permission_request'));
  await turn.cancel();
  const result = await turn.done;
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.forced, undefined, 'the agent confirmed the cancel');
  assert.equal(result.toolCalls[0]?.status, 'failed');
  assert.ok(shape(turn.history).includes('permission exec make -> cancelled'));
  assert.ok(!w.journal.types(s2.id).includes('session.permission_response'), 'the late allow was not applied');
  await waiting.close();
});

test('session/load replays the same updates the live client saw, then a cursor', async () => {
  const w = world();
  const commands = [{ name: 'rewind', description: 'Rewind to a seq' }];
  const live = await raw(serve(w, { commands }));
  const { sessionId } = await live.call('session/new', { cwd: '/w', mcpServers: [] });
  await live.call('session/prompt', { sessionId, prompt: text('stream one two') });
  const tool = live.call('session/prompt', { sessionId, prompt: text('tool read a.md') });
  await until(() => live.asked.length === 1);
  live.asked[0]!.answer('allow');
  await tool;
  const pending = live.call('session/prompt', { sessionId, prompt: text('tool read b.md') });
  await until(() => live.asked.length === 2);
  await live.call('_journal/rewind', { sessionId, toSeq: 3 });
  assert.equal((await pending).stopReason, 'cancelled');

  const later = await raw(serve(w, { commands }));
  await assert.rejects(later.call('session/prompt', { sessionId, prompt: text('hi') }), isCode(ErrorCode.ResourceNotFound));
  await assert.rejects(later.call('session/load', { sessionId: 'nope', cwd: '/w', mcpServers: [] }), isCode(ErrorCode.ResourceNotFound));
  await later.call('session/load', { sessionId, cwd: '/w', mcpServers: [] });

  const cursor = later.log.at(-1)!;
  assert.deepEqual(cursor, { method: '_journal/cursor', params: { sessionId, headSeq: w.sessions.get(sessionId)!.head(), rewindToSeq: 3 } });
  const replayed = later.log.slice(0, -1).filter((n) => n.params.update?.sessionUpdate !== 'user_message_chunk');
  assert.ok(later.log.some((n) => n.params.update?.sessionUpdate === 'user_message_chunk'), 'replay includes the user messages');
  assert.deepEqual(replayed, live.log);
  assert.ok(live.log.some((n) => n.method === '_journal/rewind'));
  assert.equal(later.asked.length, 0, 'replayed gates are not asked again');
  await live.peer.close();
  await later.peer.close();
});

test('a retried prompt with the same receipt runs once; session/new admission is per request id', async () => {
  const w = world();
  const a = await raw(serve(w));
  const meta = (requestId: string) => ({ _meta: { journal: { requestId } } });
  const [n1, n2] = await Promise.all([
    a.call('session/new', { cwd: '/w', mcpServers: [], ...meta('new-1') }),
    a.call('session/new', { cwd: '/w', mcpServers: [], ...meta('new-1') }),
  ]);
  assert.equal(n1.sessionId, n2.sessionId);
  assert.equal(w.opened(), 1);

  const sessionId = n1.sessionId as string;
  const prompt = { sessionId, prompt: text('stream a b'), ...meta('r1') };
  const [r1, r2] = await Promise.all([a.call('session/prompt', prompt), a.call('session/prompt', prompt)]);
  assert.deepEqual(r1, r2);
  const r3 = await a.call('session/prompt', prompt);
  assert.deepEqual(r3, r1);
  assert.equal(w.sessions.get(sessionId)!.prompts, 1);
  assert.equal(w.journal.types(sessionId).filter((t) => t === 'session.prompt').length, 1);
  await assert.rejects(a.call('session/prompt', { ...prompt, prompt: text('stream c') }), isCode(ErrorCode.InvalidParams));

  // The retry arrives on a new connection (the first one dropped): still one session, now attached here too.
  const b = await raw(serve(w));
  const again = await b.call('session/new', { cwd: '/w', mcpServers: [], ...meta('new-1') });
  assert.equal(again.sessionId, sessionId);
  assert.equal(w.opened(), 1);
  assert.deepEqual(await b.call('session/prompt', prompt), r1);
  await a.peer.close();
  await b.peer.close();
});

test('permission race: a slash allow wins; the client question is withdrawn and its late answer ignored', async () => {
  const w = world();
  const c = await raw(serve(w));
  const { sessionId } = await c.call('session/new', { cwd: '/w', mcpServers: [] });
  const turn = c.call('session/prompt', { sessionId, prompt: text('tool exec make') });
  await until(() => c.asked.length === 1);
  assert.equal(c.asked[0]!.params.toolCall.toolCallId, 't1');
  assert.equal(c.asked[0]!.params.toolCall.title, undefined, 'a known tool call is referred to by id only');
  assert.deepEqual(c.asked[0]!.params.toolCall._meta.journal, { permissionId: 'p1', seq: 4 });

  await c.call('session/prompt', { sessionId, prompt: text('/allow p1') });
  await until(() => c.asked[0]!.signal.aborted);
  c.asked[0]!.answer('reject');
  assert.equal((await turn).stopReason, 'end_turn');
  const responses = w.journal.read(sessionId).filter((e) => e.type === 'session.permission_response');
  assert.deepEqual(responses.map((e) => (e.payload as any).decision), ['allow']);
  assert.ok(!w.journal.types(sessionId).includes('session.rejected'));
  await c.peer.close();
});

test('permission race: the client answers first; a later slash deny is refused by the session', async () => {
  const w = world();
  const c = await raw(serve(w));
  const { sessionId } = await c.call('session/new', { cwd: '/w', mcpServers: [] });
  const turn = c.call('session/prompt', { sessionId, prompt: text('tool exec make') });
  await until(() => c.asked.length === 1);
  c.asked[0]!.answer('allow');
  await until(() => w.journal.types(sessionId).includes('session.permission_response'));
  await c.call('session/prompt', { sessionId, prompt: text('/deny p1') });
  assert.equal((await turn).stopReason, 'end_turn');
  const types = w.journal.types(sessionId);
  assert.equal(types.filter((t) => t === 'session.permission_response').length, 1);
  assert.ok(types.includes('session.rejected'));
  await c.peer.close();
});

test('rewind closes the open gate, fails the pending tool call, and sends the rewind signal', async () => {
  const w = world();
  const c = await raw(serve(w));
  const { sessionId } = await c.call('session/new', { cwd: '/w', mcpServers: [] });
  const turn = c.call('session/prompt', { sessionId, prompt: text('tool read x.md') });
  await until(() => c.asked.length === 1);
  const result = await c.call('_journal/rewind', { sessionId, toSeq: 1 });
  assert.equal(result.headSeq, w.sessions.get(sessionId)!.head());
  assert.equal(c.asked[0]!.signal.aborted, true);
  c.asked[0]!.answer('allow');
  assert.equal((await turn).stopReason, 'cancelled');
  const failed = c.log.find((n) => n.params.update?.sessionUpdate === 'tool_call_update' && n.params.update.status === 'failed');
  assert.match(failed!.params.update.content.at(-1).content.text, /Interrupted by session\.rewind/);
  assert.deepEqual(c.log.at(-1)!.method, '_journal/rewind');
  assert.equal(c.log.at(-1)!.params.toSeq, 1);
  assert.ok(!w.journal.types(sessionId).includes('session.permission_response'));
  await assert.rejects(c.call('_journal/rewind', { sessionId, toSeq: -1 }), isCode(ErrorCode.InvalidParams));
  await c.peer.close();
});

test('auto-allow settles gates without asking; session/close makes the id unknown', async () => {
  const w = world();
  const client = await AcpClient.connect(serve(w, { permissions: 'auto-allow' }), { permissions: 'reject' });
  const session = await client.newSession({ cwd: '/w' });
  const turn = session.prompt('tool exec make');
  const result = await turn.done;
  assert.equal(result.toolCalls[0]?.status, 'completed');
  assert.ok(!turn.history.some((e) => e.type === 'permission'));

  await client.peer.request('session/close', { sessionId: session.id });
  assert.equal(w.sessions.get(session.id)!.closed, 1);
  await assert.rejects(client.peer.request('session/prompt', { sessionId: session.id, prompt: text('hi') }), isCode(ErrorCode.ResourceNotFound));
  await client.close();
});
