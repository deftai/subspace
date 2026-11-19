/**
 * Google Antigravity vendor layer for `@deft-subspace/acp-vendors`.
 *
 * Implements docs/agent-driver-design.md §6.3 and docs/agent-vendor-protocols.md §4.
 * Acts only through the workbench and layer context (X2).
 *
 * Uses no Node APIs.
 */
import type { ClientLayer } from '@deft-subspace/acp';
import {
  isCancelled,
  type AgentWorkbench,
  type DriverAuthMethod,
  type QuestionAskAnswer,
  type QuestionAskRequest,
} from '@deft-subspace/agent-driver';
import { ErrorCode, RpcError } from '@deft-subspace/kernel';
import { agentCapabilitiesOf, isRecord } from './helpers.ts';
import { VENDOR_SERVICES, type VendorAuthOutcome } from './services.ts';

export interface AntigravityLayerState {
  detected: boolean;
  appendSystemPrompt: boolean;
  skipNextSystemPrompt: boolean;
}

export function antigravityLayer(workbench: AgentWorkbench): ClientLayer<AntigravityLayerState> {
  return {
    name: 'vendor:antigravity',

    create(ctx): AntigravityLayerState {
      const state: AntigravityLayerState = {
        detected: workbench.agent.identity === 'antigravity.google',
        appendSystemPrompt: false,
        skipNextSystemPrompt: false,
      };

      const services = ctx.peek(VENDOR_SERVICES);
      if (services) {
        services.authenticateHandlers.push(
          async (method: DriverAuthMethod, options?: { signal?: AbortSignal }): Promise<VendorAuthOutcome | undefined> => {
            if (!state.detected || method.id !== 'gemini-api-key') return undefined;

            // 1. Try GEMINI_API_KEY from project env first.
            const envKey = workbench.project.env.GEMINI_API_KEY?.trim();
            if (envKey) {
              try {
                await ctx.agent.request(
                  'authenticate',
                  { methodId: method.id, _meta: { apiKey: envKey } },
                  { signal: options?.signal },
                );
                return { status: 'signed_in' };
              } catch {
                // Fall through to form question.
              }
            }

            // 2. Ask the user via form question.
            const agentLabel = workbench.agent.name || 'Antigravity';
            const request: QuestionAskRequest = {
              mode: 'form',
              message: method.description || 'Enter your Gemini Developer API key.',
              source: `Sign in to ${agentLabel}`,
              requestedSchema: {
                type: 'object',
                title: method.name || 'Gemini API key',
                properties: {
                  apiKey: {
                    type: 'string',
                    title: 'GEMINI_API_KEY',
                    format: 'password',
                  },
                },
                required: ['apiKey'],
              },
            };

            const answer = await workbench.ask<QuestionAskRequest, QuestionAskAnswer>(
              { kind: 'question', request },
              { signal: options?.signal },
            );

            // 3. Handle answer.
            if (isCancelled(answer) || answer.action === 'cancel') {
              return { status: 'cancelled' };
            }
            if (answer.action === 'decline') {
              return { status: 'declined' };
            }

            const rawKey = isRecord(answer.content) ? answer.content.apiKey : undefined;
            const key = typeof rawKey === 'string' ? rawKey.trim() : '';
            if (!key) {
              return { status: 'failed', message: 'Signing in failed: No API key entered' };
            }

            try {
              await ctx.agent.request(
                'authenticate',
                { methodId: method.id, _meta: { apiKey: key } },
                { signal: options?.signal },
              );
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              return { status: 'failed', message: `Signing in failed: ${detail}` };
            }

            await workbench.project.rememberEnv('GEMINI_API_KEY', key);
            return { status: 'signed_in' };
          },
        );
      }

      return state;
    },

    async outbound(call, ctx, state, next) {
      if (call.kind === 'request' && call.method === 'initialize') {
        const result = await next();
        const caps = agentCapabilitiesOf(result);
        const meta = isRecord(caps._meta) ? caps._meta : null;
        const agMeta = meta && isRecord(meta.antigravity) ? meta.antigravity : null;

        state.detected = workbench.agent.identity === 'antigravity.google' || agMeta !== null;
        const sessionCaps = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : null;
        const hasStandardSystemPrompt = sessionCaps !== null && 'systemPrompt' in sessionCaps && sessionCaps.systemPrompt !== false;
        const agSysPrompt = agMeta && isRecord(agMeta.systemPrompt) ? agMeta.systemPrompt : null;
        state.appendSystemPrompt = state.detected && !hasStandardSystemPrompt && agSysPrompt?.append === true;
        return result;
      }

      if (
        call.kind === 'request' &&
        state.appendSystemPrompt &&
        !state.skipNextSystemPrompt &&
        (call.method === 'session/new' || call.method === 'session/load' || call.method === 'session/resume')
      ) {
        const params = isRecord(call.params) ? { ...call.params } : {};
        if (!('systemPrompt' in params)) {
          const text = await workbench.presentation.systemPrompt();
          if (typeof text === 'string' && text.length > 0) {
            const existingMeta = isRecord(params._meta) ? params._meta : {};
            const existingAg = isRecord(existingMeta.antigravity) ? existingMeta.antigravity : {};
            const withMeta = {
              ...params,
              _meta: {
                ...existingMeta,
                antigravity: {
                  ...existingAg,
                  systemPrompt: { append: text },
                },
              },
            };
            try {
              return await next({ ...call, params: withMeta });
            } catch (err) {
              if (err instanceof RpcError && err.code === ErrorCode.InvalidParams) {
                state.skipNextSystemPrompt = true;
                try {
                  return await ctx.agent.request(call.method, call.params);
                } finally {
                  state.skipNextSystemPrompt = false;
                }
              }
              throw err;
            }
          }
        }
      }

      return next();
    },
  };
}
