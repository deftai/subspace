/**
 * @deft/acp-testkit — importable multi-turn scenarios + asserts over
 * defineAcpClientProduct.
 *
 * Owns: public barrel re-exports only (assert, harness, scenarios, client types).
 * Does not own: wire framing, a second client, or CLI smoke (sibling of acp-probe).
 */
export {
  textChunks,
  findPromptDone,
  permissionEvents,
  assertHasUpdate,
  assertPromptDone,
  assertCancelled,
  assertTextIncludes,
  assertPermissionOutcome,
} from "./assert.ts";

export {
  sessionEchoAgentPath,
  withLinkedProduct,
  withStdioProduct,
  type LinkedHarness,
  type StdioHarness,
  type ProductHarness,
  type TestkitPermissionPolicy,
} from "./harness.ts";

export {
  runMultiTurn,
  runCancelMidPrompt,
  runPermissionReverse,
  scenarioMultiTurnLinked,
  scenarioMultiTurnStdio,
  scenarioCancelMidPromptLinked,
  scenarioCancelMidPromptStdio,
  scenarioPermissionReverseLinked,
  runMinimumScenarios,
  type ScenarioName,
  type ScenarioResult,
} from "./scenarios.ts";

// Re-export product helpers consumers need alongside scenarios
export {
  collectEvents,
  defineAcpClientProduct,
  type AgentEvent,
  type AcpClientProduct,
  type PermissionPolicy,
} from "@deft/acp-client";
