import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertDriverConforms,
  checkDriver,
  isCancelled,
  StartFailureError,
  type AgentDriver,
  type AgentDriverCapabilities,
  type AgentDriverFactory,
  type AgentDriverOptions,
  type AgentInfo,
  type AgentWorkbench,
  type DriverTranscript,
  type PermissionAskAnswer,
  type PermissionAskRequest,
  type PromptInput,
  type StopReason,
} from '../src/index.ts';

function defaultCapabilities(overrides: Partial<AgentDriverCapabilities> = {}): AgentDriverCapabilities {
  return {
    logout: false,
    stopTerminals: false,
    emptyPrompts: false,
    loadSession: false,
    resumeSession: false,
    listSessions: false,
    deleteSessions: false,
    modes: false,
    configOptions: false,
    sessionCapabilities: [],
    promptContent: { image: false, audio: false, embeddedContext: false },
    ...overrides,
  };
}

interface ScriptedDriverConfig {
  sessionId?: string;
  startFailure?: { kind: 'failed' | 'not_signed_in' | 'cannot_reopen' | 'restarting' | 'stopped'; message: string; details: string };
  onPrompt?: (prompt: PromptInput, wb: AgentWorkbench, signal: AbortSignal) => Promise<StopReason | null>;
}

function makeScriptedDriverFactory(config: ScriptedDriverConfig = {}): AgentDriverFactory {
  return (workbench: AgentWorkbench, options: AgentDriverOptions): AgentDriver => {
    let stopped = false;
    let sessionId: string | null = null;
    let turnController: AbortController | null = null;

    const info: AgentInfo = {
      name: options.agent.name,
      title: 'Scripted Agent',
      version: '1.0.0',
      driver: 'scripted-in-memory',
    };
    const capabilities = defaultCapabilities({ modes: true });

    return {
      get info() {
        return info;
      },
      get capabilities() {
        return capabilities;
      },
      get sessionId() {
        return sessionId;
      },
      get pid() {
        return options.pid ?? null;
      },
      async start() {
        if (stopped) {
          throw new StartFailureError({ kind: 'stopped', message: 'Stopped', details: '' });
        }
        if (config.startFailure) {
          throw new StartFailureError(config.startFailure);
        }
        sessionId = config.sessionId ?? 'sess-1';
        await workbench.sessions.opened({
          sessionId,
          cwd: workbench.project.path,
          how: 'new',
          reopenable: false,
        });
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        turnController?.abort();
        turnController = null;
      },
      async sendPrompt(prompt: PromptInput): Promise<StopReason | null> {
        if (stopped || !sessionId) return null;
        const ac = new AbortController();
        turnController = ac;
        workbench.turnStarted('turn-1');
        try {
          const reason = config.onPrompt ? await config.onPrompt(prompt, workbench, ac.signal) : 'end_turn';
          workbench.turnEnded('turn-1', reason ?? 'error');
          return reason;
        } finally {
          if (turnController === ac) turnController = null;
        }
      },
      async cancel() {
        if (stopped || !turnController) return false;
        turnController.abort();
        return true;
      },
      async setMode() {
        return stopped ? 'This agent has no modes' : null;
      },
      async setConfigOption() {
        return 'This agent has no session options';
      },
      async listSessions() {
        return null;
      },
      async deleteSession() {
        return "This agent can't delete sessions";
      },
      async setSessionTitle(title, byUser = false) {
        if (stopped || !sessionId) return;
        await workbench.sessions.titled({ sessionId, title, byUser });
      },
      async logout() {
        return "This agent doesn't support signing out";
      },
      async stopTerminal() {
        return "The agent can't stop its commands";
      },
      async cancelSubagent() {
        return false;
      },
    };
  };
}

test('checkDriver passes when a scripted in-memory driver matches the transcript', async () => {
  const factory = makeScriptedDriverFactory({
    sessionId: 'sess-42',
    onPrompt: async (_prompt, wb, signal) => {
      const content = await wb.files.readText({ sessionId: 'sess-42', path: 'README.md' });
      const permReq: PermissionAskRequest = {
        sessionId: 'sess-42',
        title: 'Write summary',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      };
      const answer = await wb.ask<PermissionAskRequest, PermissionAskAnswer>(
        { kind: 'permission', request: permReq },
        { signal },
      );
      const outcome = isCancelled(answer)
        ? { outcome: 'cancelled' as const }
        : { outcome: 'selected' as const, optionId: answer.optionId, allowed: true };
      wb.emit({ type: 'permission', request: permReq, outcome });
      wb.emit({ type: 'message', messageId: 'm1', delta: content, text: content });
      wb.emit({ type: 'message_end', messageId: 'm1', text: content, complete: true });

      const sub = wb.child('sub-1');
      sub.emit({ type: 'message', messageId: 'sm1', delta: 'child note', text: 'child note' });
      return 'end_turn';
    },
  });

  const transcript: DriverTranscript = {
    name: 'in-memory prompt with permission, file read, and child message',
    options: {
      agent: { name: 'scripted', identity: null },
      client: { name: 'test-client', version: '0.1.0' },
    },
    workbench: {
      project: { path: '/repo' },
      files: {
        readText: async () => 'Hello world',
      },
      asks: {
        permission: [{ optionId: 'allow' }],
      },
    },
    expectInfo: { name: 'scripted', driver: 'scripted-in-memory' },
    expectCapabilities: { modes: true, logout: false },
    expectSessionId: 'sess-42',
    steps: [
      { action: 'start' },
      { action: 'sendPrompt', prompt: 'Summarize README', expectResult: 'end_turn' },
      { action: 'logout', expectResult: "This agent doesn't support signing out" },
      { action: 'stop' },
    ],
    expected: [
      {
        kind: 'service',
        workbench: 'main',
        service: 'sessions',
        method: 'opened',
        args: { sessionId: 'sess-42', cwd: '/repo', how: 'new', reopenable: false },
      },
      { kind: 'turn_started', workbench: 'main', turnId: 'turn-1' },
      {
        kind: 'service',
        workbench: 'main',
        service: 'files',
        method: 'readText',
        args: { sessionId: 'sess-42', path: 'README.md' },
        result: 'Hello world',
      },
      {
        kind: 'ask',
        workbench: 'main',
        askKind: 'permission',
        request: { sessionId: 'sess-42', title: 'Write summary' },
        answer: { optionId: 'allow' },
      },
      {
        kind: 'event',
        workbench: 'main',
        event: { type: 'permission', outcome: { outcome: 'selected', optionId: 'allow', allowed: true } },
      },
      {
        kind: 'event',
        workbench: 'main',
        event: { type: 'message', messageId: 'm1', delta: 'Hello world', text: 'Hello world' },
      },
      {
        kind: 'event',
        workbench: 'main',
        event: { type: 'message_end', messageId: 'm1', text: 'Hello world', complete: true },
      },
      {
        kind: 'event',
        workbench: 'sub-1',
        event: { type: 'message', messageId: 'sm1', delta: 'child note', text: 'child note' },
      },
      { kind: 'turn_ended', workbench: 'main', turnId: 'turn-1', stopReason: 'end_turn' },
    ],
  };

  const result = await assertDriverConforms(factory, transcript);
  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
});

test('checkDriver verifies expected StartFailure rejections', async () => {
  const factory = makeScriptedDriverFactory({
    startFailure: { kind: 'not_signed_in', message: 'Sign in required', details: 'Run login' },
  });

  const transcript: DriverTranscript = {
    name: 'start fails with not_signed_in',
    options: {
      agent: { name: 'scripted', identity: null },
      client: { name: 'test-client', version: '0.1.0' },
    },
    steps: [{ action: 'start', expectFailure: { kind: 'not_signed_in', message: 'Sign in required' } }],
    expected: [],
  };

  const result = await checkDriver(factory, transcript);
  assert.equal(result.passed, true);
});

test('checkDriver fails when a driver violates a transcript (wrong event, wrong result, extra record)', async () => {
  const factory = makeScriptedDriverFactory({
    onPrompt: async (_prompt, wb) => {
      wb.emit({ type: 'message', messageId: 'm1', delta: 'wrong text', text: 'wrong text' });
      return 'max_tokens';
    },
  });

  const transcript: DriverTranscript = {
    name: 'deliberately failing transcript',
    options: {
      agent: { name: 'scripted', identity: null },
      client: { name: 'test-client', version: '0.1.0' },
    },
    steps: [
      { action: 'start' },
      { action: 'sendPrompt', prompt: 'Hello', expectResult: 'end_turn' },
      { action: 'stop' },
    ],
    expected: [
      { kind: 'service', service: 'sessions', method: 'opened' },
      { kind: 'turn_started', turnId: 'turn-1' },
      { kind: 'event', event: { type: 'message', delta: 'expected text' } },
      { kind: 'turn_ended', stopReason: 'end_turn' },
    ],
  };

  const result = await checkDriver(factory, transcript);
  assert.equal(result.passed, false);
  assert.ok(result.failures.length >= 2, `expected multiple failures, got ${result.failures.length}`);
  assert.ok(result.failures.some((f) => f.where.includes('sendPrompt')));
  assert.ok(result.failures.some((f) => f.where === 'record[2]'));

  await assert.rejects(() => assertDriverConforms(factory, transcript), /Driver failed transcript/);
});

test('Phase 1: @deft-subspace/agent-driver src/ uses no Node APIs', () => {
  const srcDir = join(import.meta.dirname, '..', 'src');
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(join(srcDir, file), 'utf8');
    assert.doesNotMatch(text, /from\s+['"]node:/, `${file} must not import node:* modules`);
  }
});
