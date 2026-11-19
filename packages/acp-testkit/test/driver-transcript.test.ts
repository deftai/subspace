import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  AcpClient,
  bothSpellings,
  clientEndpoint,
  type ClientLayer,
} from '@deft-subspace/acp';
import {
  isCancelled,
  type AcpDriverOptions,
  type AgentDriver,
  type AgentDriverCapabilities,
  type AgentWorkbench,
  type KeyAskAnswer,
  type KeyAskRequest,
  type PromptInput,
  type StopReason,
} from '@deft-subspace/agent-driver';
import {
  assertAcpDriverConforms,
  assertClientLayerConforms,
  checkAcpDriver,
  checkClientLayer,
  parseAcpTranscript,
  wireFromTrace,
  type AcpDriverTranscript,
} from '../src/index.ts';

const EXAMPLE_PATH = join(import.meta.dirname, '..', 'transcripts', 'example-vendor-key.transcript.json');

function makeExampleVendorLayer(workbench: AgentWorkbench, opts: { wrongKey?: boolean; skipMeta?: boolean } = {}): ClientLayer {
  return {
    name: 'example-vendor',
    async outbound(call, _ctx, _state, next) {
      if (!opts.skipMeta && call.kind === 'request' && call.method === 'initialize') {
        const p = (call.params ?? {}) as Record<string, unknown>;
        const caps = (p.clientCapabilities ?? {}) as Record<string, unknown>;
        const meta = (caps._meta ?? {}) as Record<string, unknown>;
        return next({
          ...call,
          params: {
            ...p,
            clientCapabilities: { ...caps, _meta: { ...meta, 'deft.co': { waitForKey: {} } } },
          },
        });
      }
      return next();
    },
    requests: bothSpellings({
      'deft.co/wait_for_key': async (call, ctx) => {
        const p = (call.params ?? {}) as { message?: string; keys?: Array<{ key: string; label: string }> };
        const answer = await workbench.ask<KeyAskRequest, KeyAskAnswer>(
          { kind: 'key', request: { message: p.message ?? '', keys: p.keys ?? [] } },
          { signal: ctx.signal },
        );
        if (isCancelled(answer)) return { outcome: 'cancelled' };
        return { outcome: 'pressed', key: opts.wrongKey ? 'WRONG' : answer.key };
      },
    }),
  };
}

function defaultCaps(): AgentDriverCapabilities {
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
  };
}

/** Minimal ACP AgentDriver over AcpClient + example vendor layer, for testing checkAcpDriver. */
function makeMinimalAcpDriver(workbench: AgentWorkbench, options: AcpDriverOptions, layerOpts: { skipMeta?: boolean } = {}): AgentDriver {
  let client: AcpClient | null = null;
  let session: Awaited<ReturnType<AcpClient['newSession']>> | null = null;

  return {
    get info() {
      return { name: options.agent.name, driver: 'minimal-acp', protocol: 'acp/1' };
    },
    get capabilities() {
      return defaultCaps();
    },
    get sessionId() {
      return session?.id ?? null;
    },
    get pid() {
      return options.pid ?? null;
    },
    async start() {
      client = await AcpClient.connect(options.channel, {
        name: options.client.name,
        version: options.client.version,
        protocol: 1,
        files: {
          readTextFile: (req) =>
            workbench.files.readText({
              sessionId: session?.id ?? 'sess-1',
              path: req.path,
              line: req.line,
              limit: req.limit,
            }),
          writeTextFile: (req) =>
            workbench.files.writeText({ sessionId: session?.id ?? 'sess-1', path: req.path, content: req.content }),
        },
        layers: [makeExampleVendorLayer(workbench, layerOpts)],
      });
      session = await client.newSession({ cwd: workbench.project.path });
    },
    async stop() {
      await client?.close();
      client = null;
      session = null;
    },
    async sendPrompt(prompt: PromptInput): Promise<StopReason | null> {
      if (!session) return null;
      const turn = session.prompt(prompt);
      for await (const event of turn) {
        if (event.type === 'message') workbench.emit(event);
      }
      const res = await turn.done;
      return res.stopReason;
    },
    async cancel() {
      return false;
    },
    async setMode() {
      return 'This agent has no modes';
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
    async setSessionTitle() {},
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
}

test('checkClientLayer runs a recorded JSON transcript against a clientEndpoint + vendor ClientLayer', async () => {
  const transcript = parseAcpTranscript(readFileSync(EXAMPLE_PATH, 'utf8'));

  const result = await assertClientLayerConforms(
    (workbench, channel, options) => {
      const endpoint = clientEndpoint(channel, {
        name: options.client.name,
        layers: [
          makeExampleVendorLayer(workbench),
          {
            name: 'base-fs-and-updates',
            requests: {
              'fs/read_text_file': async (call) => {
                const p = call.params as { sessionId: string; path: string };
                return { content: await workbench.files.readText(p) };
              },
            },
            notifications: {
              'session/update': (call) => {
                const u = (call.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })?.update;
                if (u?.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string') {
                  workbench.emit({ type: 'message', messageId: 'm1', delta: u.content.text, text: u.content.text });
                }
              },
            },
          },
        ],
      });

      let sessionId = '';
      return {
        async step(step) {
          if (step.action === 'start') {
            await endpoint.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
            const res = (await endpoint.agent.request('session/new', { cwd: workbench.project.path, mcpServers: [] })) as {
              sessionId: string;
            };
            sessionId = res.sessionId;
          } else if (step.action === 'sendPrompt') {
            await endpoint.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: String(step.prompt) }] });
          } else if (step.action === 'stop') {
            await endpoint.peer.close();
          }
        },
        async close() {
          await endpoint.peer.close();
        },
      };
    },
    transcript,
  );

  assert.equal(result.passed, true);
  assert.equal(result.records.length, 3);
});

test('checkClientLayer reports wire divergence when a layer sends a wrong reply to the agent', async () => {
  const transcript = parseAcpTranscript(readFileSync(EXAMPLE_PATH, 'utf8'));

  const result = await checkClientLayer(
    (workbench, channel, options) => {
      const endpoint = clientEndpoint(channel, {
        name: options.client.name,
        layers: [
          makeExampleVendorLayer(workbench, { wrongKey: true }),
          {
            name: 'base-fs',
            requests: {
              'fs/read_text_file': async (call) => {
                const p = call.params as { sessionId: string; path: string };
                return { content: await workbench.files.readText(p) };
              },
            },
          },
        ],
      });
      let sessionId = '';
      return {
        async step(step) {
          if (step.action === 'start') {
            await endpoint.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
            const res = (await endpoint.agent.request('session/new', { cwd: workbench.project.path, mcpServers: [] })) as {
              sessionId: string;
            };
            sessionId = res.sessionId;
          } else if (step.action === 'sendPrompt') {
            await endpoint.agent.request('session/prompt', { sessionId, prompt: [] }).catch(() => {});
          }
        },
        async close() {
          await endpoint.peer.close();
        },
      };
    },
    transcript,
  );

  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.where.startsWith('wire') && f.message.includes('response.result.key')));
});

test('checkAcpDriver runs the same recorded JSON transcript against an ACP AgentDriver and catches match failures', async () => {
  const transcript = parseAcpTranscript(readFileSync(EXAMPLE_PATH, 'utf8'));

  // Passing run
  const ok = await assertAcpDriverConforms((wb, opts) => makeMinimalAcpDriver(wb, opts), transcript);
  assert.equal(ok.passed, true);

  // Failing run: driver omits the required initialize _meta matched by `match`
  const bad = await checkAcpDriver((wb, opts) => makeMinimalAcpDriver(wb, opts, { skipMeta: true }), transcript);
  assert.equal(bad.passed, false);
  assert.ok(bad.failures.some((f) => f.where.startsWith('wire') && f.message.includes('deft.co')));
});

test('action: "exchange" synchronizes an agent-initiated vendor request without wall-clock delays', async () => {
  const transcript: AcpDriverTranscript = {
    version: 1,
    name: 'unsolicited vendor key request via exchange step',
    options: {
      agent: { name: 'example-agent', identity: null },
      client: { name: 'test-client', version: '0.1.0' },
    },
    workbench: {
      asks: { key: [{ key: 'q' }] },
    },
    steps: [
      {
        action: 'exchange',
        label: 'agent sends _deft.co/wait_for_key directly',
        wire: [
          {
            dir: 'agent',
            msg: {
              id: 0,
              method: '_deft.co/wait_for_key',
              params: { message: 'Quit?', keys: [{ key: 'q', label: 'Quit' }] },
            },
          },
          {
            dir: 'client',
            msg: { id: 0, result: { outcome: 'pressed', key: 'q' } },
          },
        ],
      },
    ],
    expected: [
      {
        kind: 'ask',
        workbench: 'main',
        askKind: 'key',
        request: { message: 'Quit?', keys: [{ key: 'q', label: 'Quit' }] },
        answer: { key: 'q' },
      },
    ],
  };

  const result = await assertClientLayerConforms(
    (workbench, channel, options) => {
      const endpoint = clientEndpoint(channel, {
        name: options.client.name,
        layers: [makeExampleVendorLayer(workbench)],
      });
      return {
        close: () => endpoint.peer.close(),
      };
    },
    transcript,
  );
  assert.equal(result.passed, true);
});

test('wireFromTrace converts a Subspace JSONL trace into AcpWireMessage[]', () => {
  const traceText = [
    JSON.stringify({ v: 1, kind: 'header', peer: 'client', started: '2026-11-19T00:00:00Z' }),
    JSON.stringify({ v: 1, kind: 'message', t: 1, dir: 'out', msg: { id: 0, method: 'initialize', params: {} } }),
    JSON.stringify({ v: 1, kind: 'message', t: 2, dir: 'in', msg: { id: 0, result: { protocolVersion: 1 } } }),
  ].join('\n');

  const wire = wireFromTrace(traceText);
  assert.deepEqual(wire, [
    { dir: 'client', t: 1, msg: { id: 0, method: 'initialize', params: {} } },
    { dir: 'agent', t: 2, msg: { id: 0, result: { protocolVersion: 1 } } },
  ]);
});
