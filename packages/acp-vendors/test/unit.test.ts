import assert from 'node:assert/strict';
import test from 'node:test';
import { clientEndpoint } from '@deft-subspace/acp';
import { FakeWorkbench } from '@deft-subspace/agent-driver';
import { channelPair, RpcError, RpcPeer } from '@deft-subspace/kernel';
import { VENDOR_SERVICES, vendorLayers } from '../src/index.ts';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('X4: agent without vendor capabilities sees no vendor behaviour beyond Deft initialize caps', async () => {
  const wb = new FakeWorkbench({
    agent: { name: 'Plain Agent', identity: 'plain.example' },
    project: { path: '/repo' },
    services: {
      presentation: { capabilities: [{ ok: { theme: 'dark' } }] },
      tools: { list: [{ ok: null }] },
    },
  });
  const [clientCh, agentCh] = channelPair<unknown>();
  let seenInitCaps: unknown;
  let seenNewParams: unknown;

  const agent = new RpcPeer(agentCh, { name: 'plain-agent' });
  agent.onRequest('initialize', (p: Record<string, unknown>) => {
    seenInitCaps = p.clientCapabilities;
    return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  });
  agent.onRequest('session/new', (p: Record<string, unknown>) => {
    seenNewParams = p;
    return { sessionId: 's1' };
  });
  agent.start();

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: vendorLayers(wb) });
  const services = endpoint.context.get(VENDOR_SERVICES);
  try {
    await endpoint.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await endpoint.agent.request('session/new', { cwd: '/repo', mcpServers: [{ name: 'app' }] });

    // Deft capabilities are advertised to every agent (X4), tools omitted because tools.list() returned null.
    assert.deepEqual((seenInitCaps as { _meta?: unknown })?._meta, {
      'deft.co': { waitForKey: {}, display: { theme: 'dark' } },
    });
    // No vendor capabilities or takeovers active.
    assert.equal(services.emptyPrompts, false);
    assert.equal(services.stopTerminals, false);
    assert.equal(services.omitAppMcpServers, false);
    assert.equal(services.sessionCapabilities.size, 0);
    assert.deepEqual((seenNewParams as { mcpServers?: unknown })?.mcpServers, [{ name: 'app' }]);
    assert.equal('_meta' in (seenNewParams as Record<string, unknown>), false);
    assert.equal(await services.deleteSession('s1'), undefined);
    assert.equal(await services.cancelSubagent('child-1'), undefined);
    assert.equal(await services.authenticate({ id: 'gemini-api-key', name: 'Gemini', type: 'agent' }), undefined);
    assert.equal(await services.stopTerminal('tc-1'), "The agent can't stop its commands");
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});

test('Deft: agent _meta.deft.co.tools omits app mcpServers and emptyPrompt/stopTerminal flags are exposed', async () => {
  const wb = new FakeWorkbench({
    services: {
      tools: {
        list: [{ ok: [{ name: 'show_image', description: 'Show', inputSchema: { type: 'object' } }] }],
        call: [{ ok: { ok: true, message: 'shown' } }],
      },
    },
  });
  const [clientCh, agentCh] = channelPair<unknown>();
  let seenMcpServers: unknown;

  const agent = new RpcPeer(agentCh, { name: 'deft-agent' });
  agent.onRequest('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { _meta: { 'deft.co': { emptyPrompt: {}, stopTerminal: {}, tools: {} } } },
  }));
  agent.onRequest('session/new', (p: Record<string, unknown>) => {
    seenMcpServers = p.mcpServers;
    return { sessionId: 's1' };
  });
  agent.start();

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: vendorLayers(wb) });
  const services = endpoint.context.get(VENDOR_SERVICES);
  try {
    await endpoint.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await endpoint.agent.request('session/new', { cwd: '/repo', mcpServers: [{ name: 'app-mcp' }] });

    assert.equal(services.emptyPrompts, true);
    assert.equal(services.stopTerminals, true);
    assert.equal(services.omitAppMcpServers, true);
    assert.deepEqual(seenMcpServers, []);

    const callRes = await agent.request('deft.co/call_tool', {
      sessionId: 's1',
      name: 'show_image',
      arguments: { path: 'a.png' },
    });
    assert.deepEqual(callRes, { ok: true, message: 'shown' });
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});

test('xAI: models/update + response_completed + turn_completed + subagent_progress + background tasks + plan choices', async () => {
  const wb = new FakeWorkbench({
    asks: {
      choices: [{ outcome: 'chat_about_this', partialAnswers: { Q1: 'A' } }],
      plan_approval: [{ decision: 'abandon' }],
    },
  });
  const [clientCh, agentCh] = channelPair<unknown>();
  const agent = new RpcPeer(agentCh, { name: 'xai-agent' });
  agent.onRequest('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { _meta: { 'x.ai/grok': {} } },
  }));
  agent.onRequest('session/new', () => ({ sessionId: 's1' }));
  agent.start();

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: vendorLayers(wb) });
  const services = endpoint.context.get(VENDOR_SERVICES);
  try {
    await endpoint.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await endpoint.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    assert.equal(services.sessionCapabilities.has('delete'), true);

    // models/update as request (returns null) -> sets shared context window
    assert.equal(
      await agent.request('x.ai/models/update', {
        availableModels: [{ _meta: { totalContextTokens: 200000 } }, { _meta: { totalContextTokens: 200000 } }],
      }),
      null,
    );

    // response_completed + turn_completed + subagent_progress + task_backgrounded/completed
    await agent.notify('x.ai/session_notification', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'response_completed',
        usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      },
    });
    await agent.notify('x.ai/session_notification', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'turn_completed',
        usage: { totalTokens: 1500, costUsdTicks: 250000000 },
      },
    });
    await agent.notify('x.ai/session_notification', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'subagent_progress',
        child_session_id: 'sub-1',
        turn_count: 2,
        tool_call_count: 3,
        tokens_used: 500,
        context_usage_pct: 12,
        duration_ms: 400,
        error_count: 1,
      },
    });
    await agent.notify('x.ai/session_notification', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'task_backgrounded',
        task_id: 'bg-1',
        description: 'Run tests',
        command: 'pnpm test',
        cwd: '/repo',
      },
    });
    await agent.notify('x.ai/session_notification', {
      sessionId: 's1',
      update: {
        sessionUpdate: 'task_completed',
        task_snapshot: { task_id: 'bg-1', status: 'failed', exit_code: 1 },
      },
    });
    await delay(15);

    const choiceWire = await agent.request('x.ai/ask_user_question', {
      sessionId: 's1',
      toolCallId: 'tc-1',
      mode: 'plan',
      questions: [{ question: 'Q1', multi_select: true, options: [{ label: 'A' }] }],
    });
    assert.deepEqual(choiceWire, { outcome: 'chat_about_this', partial_answers: { Q1: 'A' } });

    const planWire = await agent.request('x.ai/exit_plan_mode', { sessionId: 's1', toolCallId: 'tc-2' });
    assert.deepEqual(planWire, { outcome: 'abandoned' });

    const events = wb.records.filter((r) => r.kind === 'event').map((r) => r.event);
    assert.deepEqual(events, [
      { type: 'usage', used: 1250, size: 200000 },
      { type: 'prompt_usage', usage: { totalTokens: 1500, costUsdTicks: 250000000 }, cost: { amount: 0.025, currency: 'USD' } },
      {
        type: 'subagent',
        sessionId: 'sub-1',
        status: { state: 'working' },
        stats: { turns: 2, toolCalls: 3, tokens: 500, contextPercent: 12, durationMs: 400, errors: 1 },
      },
      {
        type: 'background_work',
        taskId: 'bg-1',
        title: 'Run tests',
        subtitle: 'pnpm test',
        status: { state: 'working' },
        cwd: '/repo',
      },
      {
        type: 'background_work',
        taskId: 'bg-1',
        status: { state: 'error' },
      },
    ]);
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});

test('Antigravity: retries session/new without vendor systemPrompt meta on -32602', async () => {
  const wb = new FakeWorkbench({
    agent: { name: 'Antigravity', identity: 'antigravity.google' },
    services: {
      presentation: { systemPrompt: [{ ok: 'Append me' }] },
    },
  });
  const [clientCh, agentCh] = channelPair<unknown>();
  const newCalls: Array<Record<string, unknown>> = [];

  const agent = new RpcPeer(agentCh, { name: 'ag-agent' });
  agent.onRequest('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
  }));
  agent.onRequest('session/new', (p: Record<string, unknown>) => {
    newCalls.push(p);
    if (newCalls.length === 1) throw RpcError.invalidParams('unexpected _meta');
    return { sessionId: 's1' };
  });
  agent.start();

  const endpoint = clientEndpoint(clientCh, { name: 'client', layers: vendorLayers(wb) });
  try {
    await endpoint.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const res = await endpoint.agent.request('session/new', { cwd: '/repo', mcpServers: [] });
    assert.deepEqual(res, { sessionId: 's1' });
    assert.equal(newCalls.length, 2);
    assert.deepEqual((newCalls[0]?._meta as Record<string, unknown>)?.antigravity, {
      systemPrompt: { append: 'Append me' },
    });
    assert.equal('_meta' in (newCalls[1] ?? {}), false);
  } finally {
    await agent.close();
    await endpoint.peer.close();
  }
});
