/**
 * Deft vendor layer (`deft.co`) for `@deft-subspace/acp-vendors`.
 *
 * Implements docs/agent-driver-design.md §6.1, docs/agent-vendor-protocols.md §2,
 * and mapping rows M31 / M41. Acts only through the workbench and layer context (X2).
 *
 * Uses no Node APIs.
 */
import { bothSpellings, type ClientEndpointContext, type ClientLayer } from '@deft-subspace/acp';
import {
  isCancelled,
  type AgentWorkbench,
  type KeyAskAnswer,
  type KeyAskRequest,
  type KeyOption,
  type ToolDescriptor,
} from '@deft-subspace/agent-driver';
import { RpcError } from '@deft-subspace/kernel';
import { agentCapabilitiesOf, isRecord } from './helpers.ts';
import { VENDOR_SERVICES } from './services.ts';

export interface DeftLayerState {
  emptyPrompts: boolean;
  stopTerminals: boolean;
  agentTools: boolean;
  mainSessionId: string | null;
  /** Cached result of `workbench.tools.list()` from `initialize` (`undefined` if not yet fetched). */
  advertisedTools: ToolDescriptor[] | null | undefined;
}

function isPrintableNonSpaceChar(value: string): boolean {
  if (value.length !== 1) return false;
  const code = value.charCodeAt(0);
  // Printable ASCII other than space (0x21..0x7E) or non-ASCII non-control printable char.
  if (code <= 0x20 || code === 0x7f) return false;
  return !/\s/.test(value);
}

function normalizeKeys(raw: unknown): KeyOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KeyOption[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.key !== 'string') continue;
    if (!isPrintableNonSpaceChar(item.key)) continue;
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const label = typeof item.label === 'string' && item.label.length > 0 ? item.label : item.key;
    out.push({ key: item.key, label });
    if (out.length >= 9) break;
  }
  return out;
}

function getMainSession(ctx: ClientEndpointContext, state: DeftLayerState): string | null {
  return ctx.peek(VENDOR_SERVICES)?.getMainSessionId() ?? state.mainSessionId;
}

function targetWorkbench(workbench: AgentWorkbench, sessionId: unknown, mainSessionId: string | null): AgentWorkbench {
  if (typeof sessionId === 'string' && sessionId && mainSessionId && sessionId !== mainSessionId) {
    return workbench.child(sessionId);
  }
  return workbench;
}

export function deftLayer(workbench: AgentWorkbench): ClientLayer<DeftLayerState> {
  return {
    name: 'vendor:deft',

    create(ctx): DeftLayerState {
      const state: DeftLayerState = {
        emptyPrompts: false,
        stopTerminals: false,
        agentTools: false,
        mainSessionId: null,
        advertisedTools: undefined,
      };

      const services = ctx.peek(VENDOR_SERVICES);
      if (services) {
        services.stopTerminalHandlers.push(async (toolCallId: string) => {
          const sessionId = getMainSession(ctx, state);
          if (!state.stopTerminals || !sessionId) {
            return "The agent can't stop its commands";
          }
          try {
            await ctx.agent.request('_deft.co/stop_terminal', { sessionId, toolCallId });
            return null;
          } catch (err) {
            const msg = err instanceof RpcError ? err.message : err instanceof Error ? err.message : '';
            return msg.trim().length > 0 ? msg : "The agent didn't stop the command";
          }
        });
      }

      return state;
    },

    async outbound(call, ctx, state, next) {
      if (call.kind === 'request' && call.method === 'initialize') {
        const params = isRecord(call.params) ? { ...call.params } : {};
        const display = await workbench.presentation.capabilities();
        const tools = await workbench.tools.list();
        state.advertisedTools = tools;
        const deftCaps: Record<string, unknown> = {
          waitForKey: {},
          display,
          ...(tools !== null ? { tools } : {}),
        };

        // Add to v1 clientCapabilities._meta["deft.co"] (and v2 capabilities._meta if present).
        const v1Caps = isRecord(params.clientCapabilities) ? { ...params.clientCapabilities } : {};
        const v1Meta = isRecord(v1Caps._meta) ? { ...v1Caps._meta } : {};
        params.clientCapabilities = {
          ...v1Caps,
          _meta: { ...v1Meta, 'deft.co': deftCaps },
        };
        if (isRecord(params.capabilities)) {
          const v2Meta = isRecord(params.capabilities._meta) ? { ...params.capabilities._meta } : {};
          params.capabilities = {
            ...params.capabilities,
            _meta: { ...v2Meta, 'deft.co': deftCaps },
          };
        }

        const initResult = await next({ ...call, params });

        const agentCaps = agentCapabilitiesOf(initResult);
        const agentMeta = isRecord(agentCaps._meta) ? agentCaps._meta['deft.co'] : undefined;
        if (isRecord(agentMeta)) {
          state.emptyPrompts = isRecord(agentMeta.emptyPrompt);
          state.stopTerminals = isRecord(agentMeta.stopTerminal);
          state.agentTools = isRecord(agentMeta.tools);
          const services = ctx.peek(VENDOR_SERVICES);
          if (services) {
            services.emptyPrompts = state.emptyPrompts;
            services.stopTerminals = state.stopTerminals;
            services.omitAppMcpServers = state.agentTools;
          }
        }

        return initResult;
      }

      if (
        call.kind === 'request' &&
        (call.method === 'session/new' || call.method === 'session/load' || call.method === 'session/resume')
      ) {
        let outgoingCall = call;
        if (state.agentTools && isRecord(call.params) && Array.isArray(call.params.mcpServers)) {
          outgoingCall = { ...call, params: { ...call.params, mcpServers: [] } };
        }
        const result = await next(outgoingCall);
        if (call.method === 'session/new' && isRecord(result) && typeof result.sessionId === 'string' && result.sessionId) {
          state.mainSessionId = result.sessionId;
        } else if (
          (call.method === 'session/load' || call.method === 'session/resume') &&
          isRecord(call.params) &&
          typeof call.params.sessionId === 'string' &&
          call.params.sessionId
        ) {
          state.mainSessionId = call.params.sessionId;
        }
        return result;
      }

      return next();
    },

    requests: bothSpellings({
      'deft.co/wait_for_key': async (call, ctx, state) => {
        const p = isRecord(call.params) ? call.params : {};
        const keys = normalizeKeys(p.keys);
        if (keys.length === 0) {
          throw RpcError.internal('wait_for_key needs at least one single-character key');
        }
        const message = typeof p.message === 'string' ? p.message : '';
        const target = targetWorkbench(workbench, p.sessionId, getMainSession(ctx, state));
        const answer = await target.ask<KeyAskRequest, KeyAskAnswer>(
          { kind: 'key', request: { message, keys } },
          { signal: ctx.signal },
        );
        if (isCancelled(answer)) return { outcome: 'cancelled' };
        return { outcome: 'pressed', key: answer.key };
      },

      'deft.co/call_tool': async (call, ctx, state) => {
        const p = isRecord(call.params) ? call.params : {};
        const tools = state.advertisedTools !== undefined ? state.advertisedTools : await workbench.tools.list();
        if (tools === null) {
          throw RpcError.internal('Tools are disabled');
        }
        const mainSessionId = getMainSession(ctx, state);
        if (mainSessionId !== null && p.sessionId !== mainSessionId) {
          throw RpcError.invalidParams(`Tools work in session '${mainSessionId}' only`);
        }
        const name = typeof p.name === 'string' ? p.name : '';
        if (!name || !tools.some((t) => t.name === name)) {
          throw RpcError.invalidParams(`Unknown tool: ${String(p.name ?? '')}`);
        }
        const args = p.arguments;
        if (args !== undefined && args !== null && !isRecord(args)) {
          throw RpcError.invalidParams('arguments must be an object or null');
        }
        const res = await workbench.tools.call(name, (args ?? {}) as Record<string, unknown>, { signal: ctx.signal });
        return { ok: res.ok, message: res.message };
      },
    }),
  };
}
