/**
 * Intelligent defaults for harness config — one resolve site, not a variant engine.
 *
 * Owns: HarnessOptions shape and resolveHarnessOptions (StubModelAdapter + package
 * identity). Does not own session store or ACP handler wiring.
 */
import { StubModelAdapter, type ModelAdapter } from "./model.ts";

export type HarnessOptions = {
  model?: ModelAdapter;
  /** Optional system instructions prepended each turn. */
  instructions?: string;
  agentName?: string;
  agentVersion?: string;
};

export type ResolvedHarnessOptions = {
  model: ModelAdapter;
  instructions: string | undefined;
  agentName: string;
  agentVersion: string;
};

const DEFAULT_AGENT_NAME = "@deft/acp-harness";
const DEFAULT_AGENT_VERSION = "0.1.0";

/**
 * Resolve partial harness options to full defaults.
 * - model → `StubModelAdapter`
 * - agentName / agentVersion → package identity
 * - instructions → undefined (no system prompt)
 *
 * Single resolve site so listen/handlers/factory cannot drift on defaults.
 */
export function resolveHarnessOptions(
  partial?: HarnessOptions,
): ResolvedHarnessOptions {
  return {
    model: partial?.model ?? new StubModelAdapter(),
    instructions: partial?.instructions,
    agentName: partial?.agentName ?? DEFAULT_AGENT_NAME,
    agentVersion: partial?.agentVersion ?? DEFAULT_AGENT_VERSION,
  };
}
