import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { clientEndpoint, type ClientLayer } from '@deft-subspace/acp';
import {
  checkClientLayer,
  parseAcpTranscript,
  type ClientLayerSetup,
} from '@deft-subspace/acp-testkit';
import {
  isCancelled,
  type DriverAuthMethod,
  type PermissionAskAnswer,
  type PermissionAskRequest,
  type QuestionAskAnswer,
  type QuestionAskRequest,
  type SignInAskAnswer,
  type SignInAskRequest,
} from '@deft-subspace/agent-driver';
import { RpcError } from '@deft-subspace/kernel';
import { VENDOR_SERVICES, vendorLayers } from '../src/index.ts';

const TRANSCRIPTS_DIR = join(import.meta.dirname, '..', '..', 'acp-testkit', 'transcripts');

/**
 * Minimal clientEndpoint harness that puts all three vendor layers in the stack
 * alongside minimal base ACP request/notification handling (permissions,
 * elicitation, sign-in retry loop, prompt_usage) so every vendor transcript can
 * be executed directly against `clientEndpoint` + `vendorLayers(workbench)`.
 */
function makeVendorEndpointSetup(): ClientLayerSetup {
  return (workbench, channel, options) => {
    let sessionId: string | null = null;
    let authMethods: DriverAuthMethod[] = [];
    let turnAskController: AbortController | null = null;
    const openElicitations = new Map<string, AbortController>();

    const baseLayer: ClientLayer = {
      name: 'test-base-acp',
      requests: {
        'session/request_permission': async (call, ctx) => {
          const p = (call.params ?? {}) as Record<string, unknown>;
          const reqSessionId = typeof p.sessionId === 'string' ? p.sessionId : (sessionId ?? '');
          const toolCall = p.toolCall as PermissionAskRequest['toolCall'] | undefined;
          const opts = Array.isArray(p.options) ? (p.options as PermissionAskRequest['options']) : [];
          const req: PermissionAskRequest = {
            sessionId: reqSessionId,
            title: typeof p.title === 'string' ? p.title : (toolCall?.title ?? 'Permission requested'),
            ...(toolCall ? { toolCall } : {}),
            options: opts,
          };
          const signal = turnAskController
            ? AbortSignal.any([ctx.signal, turnAskController.signal])
            : ctx.signal;
          const answer = await workbench.ask<PermissionAskRequest, PermissionAskAnswer>(
            { kind: 'permission', request: req },
            { signal },
          );
          if (isCancelled(answer)) return { outcome: { outcome: 'cancelled' } };
          return { outcome: { outcome: 'selected', optionId: answer.optionId } };
        },
        'elicitation/create': async (call, ctx) => {
          const p = (call.params ?? {}) as Record<string, unknown>;
          const mode = typeof p.mode === 'string' ? p.mode : 'form';
          if (mode !== 'form' && mode !== 'url') return { action: 'decline' };
          const elicitationId = typeof p.elicitationId === 'string' ? p.elicitationId : undefined;
          const req: QuestionAskRequest = {
            mode,
            message: typeof p.message === 'string' ? p.message : '',
            ...(typeof p.requestedSchema === 'object' && p.requestedSchema !== null
              ? { requestedSchema: p.requestedSchema as object }
              : {}),
            ...(typeof p.url === 'string' ? { url: p.url } : {}),
            ...(elicitationId !== undefined ? { elicitationId } : {}),
            ...(typeof p.toolCallId === 'string' ? { toolCallId: p.toolCallId } : {}),
          };
          let ac: AbortController | undefined;
          let signal = ctx.signal;
          if (elicitationId) {
            ac = new AbortController();
            openElicitations.set(elicitationId, ac);
            signal = AbortSignal.any([ctx.signal, ac.signal]);
          }
          try {
            const answer = await workbench.ask<QuestionAskRequest, QuestionAskAnswer>(
              { kind: 'question', request: req },
              { signal },
            );
            if (isCancelled(answer) || answer.action === 'cancel') return { action: 'cancel' };
            if (answer.action === 'decline') return { action: 'decline' };
            return { action: 'accept', ...(answer.content !== undefined ? { content: answer.content } : {}) };
          } finally {
            if (elicitationId && openElicitations.get(elicitationId) === ac) {
              openElicitations.delete(elicitationId);
            }
          }
        },
      },
      notifications: {
        'elicitation/complete': (call) => {
          const p = (call.params ?? {}) as Record<string, unknown>;
          if (typeof p.elicitationId !== 'string') return;
          const ac = openElicitations.get(p.elicitationId);
          if (ac) {
            openElicitations.delete(p.elicitationId);
            ac.abort();
          }
          workbench.emit({ type: 'question_completed', elicitationId: p.elicitationId });
        },
      },
    };

    const endpoint = clientEndpoint(channel, {
      name: options.client.name,
      layers: [...vendorLayers(workbench), baseLayer],
    });
    const services = endpoint.context.get(VENDOR_SERVICES);

    async function runWithSignIn<T>(send: () => Promise<T>): Promise<T> {
      for (;;) {
        try {
          return await send();
        } catch (err) {
          if (!(err instanceof RpcError) || err.code !== -32000 || authMethods.length === 0) {
            throw err;
          }
          let message = err.message || '';
          for (;;) {
            const pick = await workbench.ask<SignInAskRequest, SignInAskAnswer>({
              kind: 'sign_in',
              request: { methods: authMethods, message },
            });
            if (isCancelled(pick) || pick.methodId === null) {
              throw err;
            }
            const method = authMethods.find((m) => m.id === pick.methodId);
            if (!method) throw err;

            const outcome = await services.authenticate(method);
            if (outcome) {
              if (outcome.status === 'signed_in') break;
              if (outcome.status === 'cancelled') throw err;
              if (outcome.status === 'declined') {
                message = outcome.message ?? err.message ?? '';
                continue;
              }
              message = outcome.message;
              continue;
            }
            await endpoint.agent.request('authenticate', { methodId: method.id });
            break;
          }
        }
      }
    }

    let pendingPrompt: Promise<unknown> | null = null;

    return {
      async step(step) {
        switch (step.action) {
          case 'start': {
            const init = (await endpoint.agent.request('initialize', {
              protocolVersion: 1,
              clientInfo: options.client,
              clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
                session: { configOptions: { boolean: {} } },
                elicitation: { form: {}, url: {} },
                auth: { terminal: true },
                _meta: {
                  terminal_output: true,
                  terminal_output_delta: true,
                  promptSuggestions: true,
                },
              },
            })) as Record<string, unknown>;
            const rawAuth = Array.isArray(init?.authMethods) ? init.authMethods : [];
            authMethods = rawAuth
              .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string')
              .map((m) => ({
                id: String(m.id),
                name: typeof m.name === 'string' ? m.name : String(m.id),
                ...(typeof m.description === 'string' ? { description: m.description } : {}),
                type: typeof m.type === 'string' ? m.type : 'agent',
              }));

            try {
              const res = (await runWithSignIn(() =>
                endpoint.agent.request('session/new', {
                  cwd: workbench.project.path,
                  mcpServers: [],
                }),
              )) as { sessionId?: string };
              sessionId = typeof res?.sessionId === 'string' ? res.sessionId : null;
            } catch (err) {
              // Sign-in declined/cancelled transcripts end cleanly at start without throwing out of step.
              if (!(err instanceof RpcError && err.code === -32000)) throw err;
            }
            return;
          }

          case 'sendPrompt': {
            if (!sessionId) return;
            turnAskController = new AbortController();
            const req = endpoint.agent.request('session/prompt', {
              sessionId,
              prompt: typeof step.prompt === 'string' ? [{ type: 'text', text: step.prompt }] : step.prompt,
            });
            // If the next step is `cancel`, do not await prompt completion here so `cancel` can run concurrently.
            pendingPrompt = req.then((res) => {
              // Cancel any asks still open when the turn finishes (W3).
              turnAskController?.abort();
              turnAskController = null;
              workbench.cancelAllAsks();
              if (res && typeof res === 'object' && 'usage' in res && (res as { usage?: unknown }).usage) {
                workbench.emit({
                  type: 'prompt_usage',
                  usage: (res as { usage: Record<string, unknown> }).usage,
                });
              }
              return res;
            });
            if (step.expectResult !== 'cancelled') {
              const res = (await pendingPrompt) as { stopReason?: string } | undefined;
              pendingPrompt = null;
              if (step.expectResult !== undefined) {
                assert.equal(res?.stopReason ?? null, step.expectResult);
              }
            }
            return;
          }

          case 'cancel': {
            if (!sessionId) return;
            await endpoint.agent.notify('session/cancel', { sessionId });
            turnAskController?.abort();
            workbench.cancelAllAsks();
            if (pendingPrompt) {
              await pendingPrompt.catch(() => {});
              pendingPrompt = null;
            }
            return;
          }

          case 'stopTerminal': {
            const taken = await services.stopTerminal(step.toolCallId);
            const res = taken === undefined ? "The agent can't stop its commands" : taken;
            if (step.expectResult !== undefined) {
              assert.equal(res, step.expectResult);
            }
            return;
          }

          case 'deleteSession': {
            const taken = await services.deleteSession(step.sessionId);
            const res = taken === undefined ? "This agent can't delete sessions" : taken;
            if (step.expectResult !== undefined) {
              assert.equal(res, step.expectResult);
            }
            return;
          }

          case 'cancelSubagent': {
            const taken = await services.cancelSubagent(step.childSessionId);
            const res = taken === undefined ? false : taken;
            if (step.expectResult !== undefined) {
              assert.equal(res, step.expectResult);
            }
            return;
          }

          case 'stop': {
            await endpoint.peer.close();
            return;
          }
        }
      },

      async close() {
        await endpoint.peer.close();
      },
    };
  };
}

// Run every single vendor-*.transcript.json file!
const transcriptFiles = readdirSync(TRANSCRIPTS_DIR)
  .filter((f) => f.startsWith('vendor-') && f.endsWith('.transcript.json'))
  .sort();

for (const file of transcriptFiles) {
  test(`transcript ${file}`, async () => {
    const transcript = parseAcpTranscript(readFileSync(join(TRANSCRIPTS_DIR, file), 'utf8'));
    const result = await checkClientLayer(makeVendorEndpointSetup(), transcript);
    if (!result.passed) {
      const detail = result.failures.map((f) => `  - [${f.where}] ${f.message}`).join('\n');
      assert.fail(`Transcript ${file} failed:\n${detail}\nActual records:\n${JSON.stringify(result.records, null, 2)}`);
    }
  });
}

test('Phase 4: @deft-subspace/acp-vendors src/ uses no Node APIs', () => {
  const srcDir = join(import.meta.dirname, '..', 'src');
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(join(srcDir, file), 'utf8');
    assert.doesNotMatch(text, /from\s+['"]node:/, `${file} must not import node:* modules`);
  }
});
