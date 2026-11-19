/**
 * xAI (Grok Build, `x.ai`) vendor layer for `@deft-subspace/acp-vendors`.
 *
 * Implements docs/agent-driver-design.md §6.2, docs/agent-vendor-protocols.md §3,
 * and mapping rows M15, M16, M22, M23, M27, M28, M29, M30.
 * Acts only through the workbench and layer context (X2).
 *
 * Uses no Node APIs.
 */
import { bothSpellings, type ClientEndpointContext, type ClientLayer } from '@deft-subspace/acp';
import {
  isCancelled,
  type AgentWorkbench,
  type ChoiceOption,
  type ChoiceQuestion,
  type ChoicesAskAnswer,
  type ChoicesAskRequest,
  type PlanApprovalAskAnswer,
  type PlanApprovalAskRequest,
  type QuestionAskAnswer,
  type QuestionAskRequest,
  type SubagentStats,
  type WorkState,
} from '@deft-subspace/agent-driver';
import { ErrorCode, LocalError, RpcError } from '@deft-subspace/kernel';
import { agentCapabilitiesOf, callWithFallback, isRecord } from './helpers.ts';
import { VENDOR_SERVICES } from './services.ts';

export interface XaiLayerState {
  detected: boolean;
  mainSessionId: string | null;
  contextWindow: number | null;
  readonly spawnedSubagents: Set<string>;
  readonly openElicitations: Map<string, AbortController>;
}

function getMainSession(ctx: ClientEndpointContext, state: XaiLayerState): string | null {
  return ctx.peek(VENDOR_SERVICES)?.getMainSessionId() ?? state.mainSessionId;
}

function targetWorkbench(workbench: AgentWorkbench, sessionId: unknown, mainSessionId: string | null): AgentWorkbench {
  if (typeof sessionId === 'string' && sessionId && mainSessionId && sessionId !== mainSessionId) {
    return workbench.child(sessionId);
  }
  return workbench;
}

function normalizeChoiceQuestions(raw: unknown): ChoiceQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: ChoiceQuestion[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options: ChoiceOption[] = [];
    for (const o of rawOptions) {
      if (!isRecord(o)) continue;
      options.push({
        label: String(o.label ?? ''),
        ...(typeof o.id === 'string' ? { id: o.id } : {}),
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
        ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
      });
    }
    questions.push({
      question: String(item.question ?? ''),
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      multiSelect: Boolean(item.multiSelect ?? item.multi_select),
      options,
    });
  }
  return questions;
}

function extractSubagentStats(u: Record<string, unknown>): SubagentStats | undefined {
  const stats: SubagentStats = {};
  let hasAny = false;
  const setNum = <K extends keyof SubagentStats>(key: K, ...candidates: unknown[]) => {
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c)) {
        stats[key] = c;
        hasAny = true;
        return;
      }
    }
  };
  setNum('turns', u.turn_count, u.turns);
  setNum('toolCalls', u.tool_call_count, u.tool_calls);
  setNum('tokens', u.tokens_used);
  setNum('contextPercent', u.context_usage_pct);
  setNum('durationMs', u.duration_ms);
  setNum('errors', u.error_count);
  return hasAny ? stats : undefined;
}

function finishedStatus(u: Record<string, unknown>): WorkState {
  const raw = typeof u.status === 'string' ? u.status : '';
  const lower = raw.toLowerCase();
  if (lower === 'failed' || lower === 'error') {
    const msg = typeof u.error === 'string' && u.error.length > 0 ? u.error : 'Failed';
    return { state: 'error', message: msg };
  }
  if (lower === 'cancelled' || lower === 'canceled' || lower === 'killed') {
    return { state: 'idle', message: 'Cancelled' };
  }
  if (
    lower === '' ||
    lower === 'completed' ||
    lower === 'complete' ||
    lower === 'success' ||
    lower === 'succeeded' ||
    lower === 'done'
  ) {
    return { state: 'done', message: 'Finished' };
  }
  return { state: 'idle', message: raw };
}

function computeContextWindow(params: unknown): number | null {
  if (!isRecord(params) || !Array.isArray(params.availableModels)) return null;
  let shared: number | null = null;
  for (const model of params.availableModels) {
    if (!isRecord(model) || !isRecord(model._meta)) continue;
    const tokens = model._meta.totalContextTokens;
    if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens <= 0) continue;
    if (shared === null) {
      shared = tokens;
    } else if (shared !== tokens) {
      return null;
    }
  }
  return shared;
}

function handleElicitComplete(workbench: AgentWorkbench, state: XaiLayerState, params: unknown): null {
  if (!isRecord(params) || typeof params.elicitationId !== 'string' || !params.elicitationId) return null;
  const elicitationId = params.elicitationId;
  const controller = state.openElicitations.get(elicitationId);
  if (controller) {
    state.openElicitations.delete(elicitationId);
    controller.abort();
  }
  workbench.emit({ type: 'question_completed', elicitationId });
  return null;
}

function handleModelsUpdate(state: XaiLayerState, params: unknown): null {
  state.contextWindow = computeContextWindow(params);
  return null;
}

export function xaiLayer(workbench: AgentWorkbench): ClientLayer<XaiLayerState> {
  return {
    name: 'vendor:xai',

    create(ctx): XaiLayerState {
      const state: XaiLayerState = {
        detected: false,
        mainSessionId: null,
        contextWindow: null,
        spawnedSubagents: new Set(),
        openElicitations: new Map(),
      };

      const services = ctx.peek(VENDOR_SERVICES);
      if (services) {
        services.deleteSessionHandlers.push(async (sessionId: string) => {
          if (!state.detected) return undefined;
          try {
            const res = await callWithFallback<unknown>(
              ctx.agent,
              'x.ai/session/delete',
              { sessionId },
              { timeoutMs: 30_000 },
            );
            if (isRecord(res) && res.success === true) return null;
            if (isRecord(res)) {
              if (typeof res.error === 'string' && res.error) return res.error;
              if (typeof res.message === 'string' && res.message) return res.message;
            }
            return 'The agent refused';
          } catch (err) {
            if (err instanceof LocalError && err.kind === 'timeout') {
              return "The agent didn't answer";
            }
            if (err instanceof RpcError) {
              if (err.code === -32002) return null;
              if (err.code === ErrorCode.MethodNotFound) return "This agent can't delete sessions";
              return err.message || 'The agent refused';
            }
            return err instanceof Error && err.message ? err.message : 'The agent refused';
          }
        });

        services.cancelSubagentHandlers.push(async (childSessionId: string) => {
          if (!state.spawnedSubagents.has(childSessionId)) return undefined;
          try {
            const res = await callWithFallback<unknown>(ctx.agent, 'x.ai/subagent/cancel', {
              subagentId: childSessionId,
            });
            if (isRecord(res) && res.cancelled === false) return false;
            return true;
          } catch {
            return false;
          }
        });
      }

      return state;
    },

    async outbound(call, ctx, state, next) {
      const result = await next();
      if (call.kind === 'request' && call.method === 'initialize') {
        const caps = agentCapabilitiesOf(result);
        const meta = isRecord(caps._meta) ? caps._meta : null;
        state.detected =
          meta !== null && Object.keys(meta).some((k) => k.startsWith('x.ai/') || k.startsWith('_x.ai/'));
        if (state.detected) {
          ctx.peek(VENDOR_SERVICES)?.addSessionCapability('delete');
        }
      } else if (call.kind === 'request' && call.method === 'session/new') {
        if (isRecord(result) && typeof result.sessionId === 'string' && result.sessionId) {
          state.mainSessionId = result.sessionId;
        }
      } else if (call.kind === 'request' && (call.method === 'session/load' || call.method === 'session/resume')) {
        if (isRecord(call.params) && typeof call.params.sessionId === 'string' && call.params.sessionId) {
          state.mainSessionId = call.params.sessionId;
        }
      }
      return result;
    },

    requests: bothSpellings({
      'x.ai/ask_user_question': async (call, ctx, state) => {
        const p = isRecord(call.params) ? call.params : {};
        const questions = normalizeChoiceQuestions(p.questions);
        if (questions.length === 0) return { outcome: 'cancelled' };

        const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
        const planning = p.mode === 'plan';
        const target = targetWorkbench(workbench, p.sessionId, getMainSession(ctx, state));
        const answer = await target.ask<ChoicesAskRequest, ChoicesAskAnswer>(
          { kind: 'choices', request: { toolCallId, planning, questions } },
          { signal: ctx.signal },
        );
        if (isCancelled(answer)) return { outcome: 'cancelled' };
        if (answer.outcome === 'accepted') {
          return {
            outcome: 'accepted',
            answers: answer.answers,
            ...(answer.annotations !== undefined ? { annotations: answer.annotations } : {}),
          };
        }
        return {
          outcome: answer.outcome,
          partial_answers: answer.partialAnswers,
        };
      },

      'x.ai/exit_plan_mode': async (call, ctx, state) => {
        const p = isRecord(call.params) ? call.params : {};
        const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
        const plan = typeof p.planContent === 'string' ? p.planContent : null;
        const target = targetWorkbench(workbench, p.sessionId, getMainSession(ctx, state));
        const answer = await target.ask<PlanApprovalAskRequest, PlanApprovalAskAnswer>(
          { kind: 'plan_approval', request: { toolCallId, plan } },
          { signal: ctx.signal },
        );
        if (isCancelled(answer)) return { outcome: 'cancelled' };
        if (answer.decision === 'approve') return { outcome: 'approved' };
        if (answer.decision === 'abandon') return { outcome: 'abandoned' };
        return { outcome: 'cancelled' };
      },

      'x.ai/mcp/elicit': async (call, ctx, state) => {
        const p = isRecord(call.params) ? call.params : {};
        const mode = typeof p.mode === 'string' ? p.mode : 'form';
        if (mode !== 'form' && mode !== 'url') return { outcome: 'decline' };

        const serverName = typeof p.serverName === 'string' ? p.serverName.trim() : '';
        const source = serverName ? `${serverName} (MCP server)` : 'an MCP server';
        const elicitationId = typeof p.elicitationId === 'string' ? p.elicitationId : undefined;

        const request: QuestionAskRequest = {
          mode,
          message: typeof p.message === 'string' ? p.message : '',
          ...(isRecord(p.requestedSchema) ? { requestedSchema: p.requestedSchema } : {}),
          ...(typeof p.url === 'string' ? { url: p.url } : {}),
          ...(elicitationId !== undefined ? { elicitationId } : {}),
          ...(typeof p.toolCallId === 'string' ? { toolCallId: p.toolCallId } : {}),
          source,
        };

        let elicitController: AbortController | undefined;
        let signal = ctx.signal;
        if (elicitationId) {
          elicitController = new AbortController();
          state.openElicitations.set(elicitationId, elicitController);
          signal = AbortSignal.any([ctx.signal, elicitController.signal]);
        }

        try {
          const target = targetWorkbench(workbench, p.sessionId, getMainSession(ctx, state));
          const answer = await target.ask<QuestionAskRequest, QuestionAskAnswer>(
            { kind: 'question', request },
            { signal },
          );
          if (isCancelled(answer) || answer.action === 'cancel') return { outcome: 'cancel' };
          if (answer.action === 'decline') return { outcome: 'decline' };
          return {
            outcome: 'accept',
            ...(answer.content !== undefined ? { content: answer.content } : {}),
          };
        } finally {
          if (elicitationId && state.openElicitations.get(elicitationId) === elicitController) {
            state.openElicitations.delete(elicitationId);
          }
        }
      },

      'x.ai/mcp/elicit_complete': (call, _ctx, state) => handleElicitComplete(workbench, state, call.params),
      'x.ai/models/update': (call, _ctx, state) => handleModelsUpdate(state, call.params),
    }),

    notifications: bothSpellings({
      'x.ai/mcp/elicit_complete': (call, _ctx, state) => {
        handleElicitComplete(workbench, state, call.params);
      },

      'x.ai/models/update': (call, _ctx, state) => {
        handleModelsUpdate(state, call.params);
      },

      'x.ai/session_notification': (call, ctx, state) => {
        const p = isRecord(call.params) ? call.params : null;
        if (!p || !isRecord(p.update) || typeof p.update.sessionUpdate !== 'string') return;
        const u = p.update;
        const tag = u.sessionUpdate;
        const mainId = getMainSession(ctx, state);
        const isMain = !mainId || !p.sessionId || p.sessionId === mainId;

        switch (tag) {
          case 'turn_completed': {
            if (!isMain || !isRecord(u.usage)) return;
            const ticks = u.usage.costUsdTicks;
            const cost =
              typeof ticks === 'number' && Number.isFinite(ticks)
                ? { amount: ticks / 1e10, currency: 'USD' }
                : undefined;
            workbench.emit({
              type: 'prompt_usage',
              usage: u.usage,
              ...(cost ? { cost } : {}),
            });
            return;
          }

          case 'response_completed': {
            if (!isMain || !isRecord(u.usage) || state.contextWindow === null) return;
            const input = u.usage.input_tokens;
            if (typeof input !== 'number' || !Number.isInteger(input)) return;
            const cacheRead =
              typeof u.usage.cache_read_input_tokens === 'number' && Number.isInteger(u.usage.cache_read_input_tokens)
                ? u.usage.cache_read_input_tokens
                : 0;
            const cacheCreate =
              typeof u.usage.cache_creation_input_tokens === 'number' &&
              Number.isInteger(u.usage.cache_creation_input_tokens)
                ? u.usage.cache_creation_input_tokens
                : 0;
            workbench.emit({
              type: 'usage',
              used: input + cacheRead + cacheCreate,
              size: state.contextWindow,
            });
            return;
          }

          case 'subagent_spawned': {
            const childId =
              typeof u.child_session_id === 'string' && u.child_session_id
                ? u.child_session_id
                : typeof u.subagent_id === 'string' && u.subagent_id
                  ? u.subagent_id
                  : null;
            if (!childId) return;
            state.spawnedSubagents.add(childId);
            const title =
              (typeof u.description === 'string' && u.description) ||
              (typeof u.subagent_type === 'string' && u.subagent_type) ||
              'sub-agent';
            const description =
              (typeof u.subagent_type === 'string' && u.subagent_type) || 'sub-agent';
            workbench.emit({
              type: 'subagent',
              sessionId: childId,
              title,
              description,
              status: { state: 'working' },
              cancellable: true,
            });
            return;
          }

          case 'subagent_progress': {
            const childId =
              typeof u.child_session_id === 'string' && u.child_session_id
                ? u.child_session_id
                : typeof u.subagent_id === 'string' && u.subagent_id
                  ? u.subagent_id
                  : null;
            if (!childId) return;
            const stats = extractSubagentStats(u);
            workbench.emit({
              type: 'subagent',
              sessionId: childId,
              status: { state: 'working' },
              ...(stats ? { stats } : {}),
            });
            return;
          }

          case 'subagent_finished': {
            const childId =
              typeof u.child_session_id === 'string' && u.child_session_id
                ? u.child_session_id
                : typeof u.subagent_id === 'string' && u.subagent_id
                  ? u.subagent_id
                  : null;
            if (!childId) return;
            state.spawnedSubagents.delete(childId);
            const stats = extractSubagentStats(u);
            workbench.emit({
              type: 'subagent',
              sessionId: childId,
              status: finishedStatus(u),
              ...(stats ? { stats } : {}),
              cancellable: false,
            });
            return;
          }

          case 'task_backgrounded': {
            if (typeof u.task_id !== 'string' || !u.task_id) return;
            const command = typeof u.command === 'string' ? u.command : '';
            const title =
              (typeof u.description === 'string' && u.description) ||
              (typeof u.monitor_description === 'string' && u.monitor_description) ||
              command;
            workbench.emit({
              type: 'background_work',
              taskId: u.task_id,
              title,
              subtitle: command,
              status: { state: 'working' },
              ...(typeof u.cwd === 'string' ? { cwd: u.cwd } : {}),
            });
            return;
          }

          case 'task_completed': {
            const snap = isRecord(u.task_snapshot) ? u.task_snapshot : null;
            if (!snap) return;
            const taskId =
              typeof snap.task_id === 'string' && snap.task_id
                ? snap.task_id
                : typeof snap.id === 'string' && snap.id
                  ? snap.id
                  : null;
            if (!taskId) return;
            const failed =
              snap.status === 'failed' ||
              snap.status === 'error' ||
              (typeof snap.exit_code === 'number' && snap.exit_code !== 0);
            workbench.emit({
              type: 'background_work',
              taskId,
              status: { state: failed ? 'error' : 'done' },
            });
            return;
          }

          default:
            // Ignore unknown Grok session notification kinds.
            return;
        }
      },
    }),

    closed(_info, _ctx, state) {
      for (const ac of state.openElicitations.values()) ac.abort();
      state.openElicitations.clear();
    },
  };
}
