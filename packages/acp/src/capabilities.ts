/**
 * What each side said it can do in `initialize`, as one shape for v1 and v2.
 *
 * v1 and v2 spell capabilities differently (v1 booleans and
 * `sessionCapabilities`; v2 marker objects under `session`, and some methods
 * that are simply part of v2). Read `client.supports` / `turn.clientSupports`
 * instead of the raw fields. Helpers that need a capability throw a
 * `CapabilityError` naming it, rather than sending a request the other side
 * said it cannot answer.
 */
import type { ProtocolVersion } from './model.ts';

export interface AgentSupport {
  /** Open a session and replay its history (v1 `session/load`, v2 `session/resume` from the start). */
  loadSession: boolean;
  /** Reopen a session without replay (`session/resume`). */
  resumeSession: boolean;
  closeSession: boolean;
  listSessions: boolean;
  deleteSession: boolean;
  additionalDirectories: boolean;
  /** Content a prompt may carry besides text and resource links. */
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  /**
   * MCP server transports the agent takes. v1 requires stdio of every agent;
   * v2 advertises it. `acp`: servers the client serves over the ACP
   * connection (MCP-over-ACP).
   */
  mcp: { stdio: boolean; http: boolean; sse: boolean; acp: boolean };
}

export interface ClientSupport {
  readTextFile: boolean;
  writeTextFile: boolean;
  /** v1 only; v2 removed client terminals. */
  terminal: boolean;
  elicitation: { form: boolean; url: boolean };
}

export class CapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string, who: 'agent' | 'client') {
    super(`The ${who} does not offer ${capability}`);
    this.name = 'CapabilityError';
    this.capability = capability;
  }
}

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
/** v2 capability markers are objects; v1 uses booleans. Either counts. */
const on = (value: unknown): boolean => value === true || (!!value && typeof value === 'object');

export function agentSupport(protocol: ProtocolVersion, capabilities: Record<string, unknown>): AgentSupport {
  if (protocol === 2) {
    const session = rec(capabilities.session);
    const prompt = rec(session.prompt);
    const mcp = rec(session.mcp);
    return {
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      listSessions: true,
      deleteSession: on(session.delete),
      additionalDirectories: on(session.additionalDirectories),
      prompt: { image: on(prompt.image), audio: on(prompt.audio), embeddedContext: on(prompt.embeddedContext) },
      mcp: { stdio: on(mcp.stdio), http: on(mcp.http), sse: false, acp: on(mcp.acp) },
    };
  }
  const session = rec(capabilities.sessionCapabilities);
  const prompt = rec(capabilities.promptCapabilities);
  const mcp = rec(capabilities.mcpCapabilities);
  return {
    loadSession: capabilities.loadSession === true,
    resumeSession: on(session.resume),
    closeSession: on(session.close),
    listSessions: on(session.list),
    deleteSession: on(session.delete),
    additionalDirectories: on(session.additionalDirectories),
    prompt: { image: prompt.image === true, audio: prompt.audio === true, embeddedContext: prompt.embeddedContext === true },
    mcp: { stdio: true, http: mcp.http === true, sse: mcp.sse === true, acp: mcp.acp === true },
  };
}

export function clientSupport(protocol: ProtocolVersion, capabilities: Record<string, unknown>): ClientSupport {
  const elicitation = rec(capabilities.elicitation);
  const fs = rec(capabilities.fs);
  return {
    readTextFile: protocol === 1 && fs.readTextFile === true,
    writeTextFile: protocol === 1 && fs.writeTextFile === true,
    terminal: protocol === 1 && capabilities.terminal === true,
    elicitation: { form: on(elicitation.form), url: on(elicitation.url) },
  };
}
