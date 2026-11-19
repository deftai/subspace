/**
 * Protocol-neutral transcript format for driving and verifying any AgentDriver.
 *
 * A recorded transcript (`RecordedDriverTranscript`) is pure JSON data with no
 * functions. Protocol-specific wire messages live in the opaque `wire` fields
 * (either per step, placed relative to the driver action that causes them, or
 * at the top level) and are interpreted by a protocol-specific runner such as
 * `@deft-subspace/acp-testkit`.
 *
 * Uses no Node APIs.
 */
import type { FakeWorkbench, FakeWorkbenchData, FakeWorkbenchOptions } from './fake-workbench.ts';
import type {
  AgentDriver,
  AgentDriverCapabilities,
  AgentDriverOptions,
  AgentInfo,
  AgentSessionList,
  PromptInput,
  StartFailure,
  StopReason,
} from './types.ts';

/** Pure-data driver steps storable in a JSON transcript file. */
export type RecordedTranscriptStep =
  | { action: 'start'; expectFailure?: Partial<StartFailure>; wire?: readonly unknown[] }
  | { action: 'sendPrompt'; prompt: PromptInput; expectResult?: StopReason | null; wire?: readonly unknown[] }
  | { action: 'cancel'; expectResult?: boolean; wire?: readonly unknown[] }
  | { action: 'setMode'; modeId: string; expectResult?: string | null; wire?: readonly unknown[] }
  | { action: 'setConfigOption'; id: string; value: string | boolean; expectResult?: string | null; wire?: readonly unknown[] }
  | { action: 'listSessions'; cwd: string; expectResult?: AgentSessionList | null; wire?: readonly unknown[] }
  | { action: 'deleteSession'; sessionId: string; expectResult?: string | null; wire?: readonly unknown[] }
  | { action: 'setSessionTitle'; title: string; byUser?: boolean; wire?: readonly unknown[] }
  | { action: 'logout'; expectResult?: string | null; wire?: readonly unknown[] }
  | { action: 'stopTerminal'; toolCallId: string; expectResult?: string | null; wire?: readonly unknown[] }
  | { action: 'cancelSubagent'; childSessionId: string; expectResult?: boolean; wire?: readonly unknown[] }
  | { action: 'stop'; wire?: readonly unknown[] }
  | { action: 'closeWorkbench'; wire?: readonly unknown[] }
  /**
   * An exchange initiated by the agent (or driven directly against a layer)
   * without a corresponding AgentDriver method call.
   */
  | { action: 'exchange'; label?: string; wire?: readonly unknown[] };

/** All transcript steps, including `custom` for hand-written in-memory tests. */
export type TranscriptStep =
  | RecordedTranscriptStep
  | {
      action: 'custom';
      label?: string;
      wire?: readonly unknown[];
      run: (ctx: { driver: AgentDriver; workbench: FakeWorkbench }) => void | Promise<void>;
    };

/**
 * Expected workbench record entry. Every field present is matched against the
 * actual record at the same position (nested objects match by subset; arrays
 * match element-by-element of equal length).
 */
export type ExpectedRecord =
  | { kind: 'event'; workbench?: string; event: Record<string, unknown> }
  | {
      kind: 'ask';
      workbench?: string;
      askKind: string;
      request?: Record<string, unknown>;
      detached?: boolean;
      answer?: unknown;
    }
  | {
      kind: 'service';
      workbench?: string;
      service: 'files' | 'terminals' | 'tools' | 'sessions' | 'project' | 'presentation';
      method: string;
      args?: unknown;
      result?: unknown;
      error?: string;
    }
  | { kind: 'turn_started'; workbench?: string; turnId?: string }
  | { kind: 'turn_ended'; workbench?: string; turnId?: string; stopReason?: string };

/** Pure-data transcript format, storable as a JSON file with no functions. */
export interface RecordedDriverTranscript {
  /** Format version (1). */
  version?: 1;
  /** Human-readable name of this transcript. */
  name: string;
  /** Options passed to the driver factory. */
  options: AgentDriverOptions;
  /** Data-only fake workbench setup (project, scripted asks, scripted service replies). */
  workbench?: FakeWorkbenchData;
  /** Sequence of driver actions to execute in order, each optionally carrying its wire exchange. */
  steps: readonly RecordedTranscriptStep[];
  /** Optional protocol-specific wire messages when not placed per step. Opaque to `@deft-subspace/agent-driver`. */
  wire?: readonly unknown[];
  /** Expected workbench records in exact order. */
  expected: readonly ExpectedRecord[];
  /** Optional assertions checked on `driver.info` after `start()` succeeds. */
  expectInfo?: Partial<AgentInfo>;
  /** Optional assertions checked on `driver.capabilities` after `start()` succeeds. */
  expectCapabilities?: Partial<AgentDriverCapabilities>;
  /** Optional assertion on `driver.sessionId` after `start()` succeeds. */
  expectSessionId?: string | null;
}

/** Transcript accepted by `checkDriver` (data-only or with hand-written test hooks). */
export interface DriverTranscript extends Omit<RecordedDriverTranscript, 'workbench' | 'steps'> {
  workbench?: FakeWorkbenchData | FakeWorkbenchOptions;
  steps: readonly TranscriptStep[];
}
