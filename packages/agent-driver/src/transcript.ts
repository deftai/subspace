/**
 * Protocol-neutral transcript format for driving and verifying any AgentDriver.
 *
 * Uses no Node APIs.
 */
import type { FakeWorkbench, FakeWorkbenchOptions } from './fake-workbench.ts';
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

export type TranscriptStep =
  | { action: 'start'; expectFailure?: Partial<StartFailure> }
  | { action: 'sendPrompt'; prompt: PromptInput; expectResult?: StopReason | null }
  | { action: 'cancel'; expectResult?: boolean }
  | { action: 'setMode'; modeId: string; expectResult?: string | null }
  | { action: 'setConfigOption'; id: string; value: string | boolean; expectResult?: string | null }
  | { action: 'listSessions'; cwd: string; expectResult?: AgentSessionList | null }
  | { action: 'deleteSession'; sessionId: string; expectResult?: string | null }
  | { action: 'setSessionTitle'; title: string; byUser?: boolean }
  | { action: 'logout'; expectResult?: string | null }
  | { action: 'stopTerminal'; toolCallId: string; expectResult?: string | null }
  | { action: 'cancelSubagent'; childSessionId: string; expectResult?: boolean }
  | { action: 'stop' }
  | { action: 'closeWorkbench' }
  | { action: 'custom'; label?: string; run: (ctx: { driver: AgentDriver; workbench: FakeWorkbench }) => void | Promise<void> };

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

export interface DriverTranscript {
  /** Human-readable name of this transcript. */
  name: string;
  /** Options passed to the driver factory. */
  options: AgentDriverOptions;
  /** Fake workbench setup (project, scripted asks, scripted services). */
  workbench?: FakeWorkbenchOptions;
  /** Sequence of driver actions to execute in order. */
  steps: readonly TranscriptStep[];
  /** Expected workbench records in exact order. */
  expected: readonly ExpectedRecord[];
  /** Optional assertions checked on `driver.info` after `start()` succeeds. */
  expectInfo?: Partial<AgentInfo>;
  /** Optional assertions checked on `driver.capabilities` after `start()` succeeds. */
  expectCapabilities?: Partial<AgentDriverCapabilities>;
  /** Optional assertion on `driver.sessionId` after `start()` succeeds. */
  expectSessionId?: string | null;
}
