/**
 * Node-only: record a real agent, and read and write trace files.
 *
 *   const agent = await recordAgent('grok', { args: ['agent', 'stdio'], cwd, workspace: cwd, label: 'plain turn' });
 *   const session = await agent.client.newSession({ cwd });
 *   await session.prompt('hi').done;
 *   await agent.close();
 *   await saveTrace('corpus/grok-plain.trace.jsonl', agent.recorder.records);
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatTrace, ndjson, parseTrace, type TraceRecord, type TraceTapOptions } from '@deft-subspace/kernel';
import { spawnProcess, type SpawnOptions } from '@deft-subspace/kernel/node';
import { connectAgent, type ConnectAgentOptions, type ConnectedAgent } from '@deft-subspace/acp/node';
import type { CheckResult } from './check.ts';
import { checkAgent, type CheckAgentOptions } from './check-agent.ts';
import { recorder, type Recorder } from './record.ts';

export interface RecordAgentOptions extends ConnectAgentOptions {
  label?: string;
  meta?: Record<string, unknown>;
  redact?: TraceTapOptions['redact'];
}

/** connectAgent, with every message recorded from the client's side (`peer: 'client'`). */
export async function recordAgent(command: string, options: RecordAgentOptions = {}): Promise<ConnectedAgent & { recorder: Recorder }> {
  const { label, meta, redact, tap, ...rest } = options;
  const rec = recorder({
    peer: 'client',
    ...(label ? { label } : {}),
    meta: { command: [command, ...(options.args ?? [])].join(' '), ...meta },
    ...(redact ? { redact } : {}),
  });
  const agent = await connectAgent(command, {
    ...rest,
    tap: (direction, message) => {
      rec.tap(direction, message);
      tap?.(direction, message);
    },
  });
  return { ...agent, recorder: rec };
}

export async function saveTrace(path: string, records: readonly TraceRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatTrace(records), 'utf8');
}

export async function loadTrace(path: string): Promise<TraceRecord[]> {
  return parseTrace(await readFile(path, 'utf8'));
}

/** Start an agent program, run checkAgent against it, and stop it. */
export async function checkAgentProcess(
  command: string,
  options: CheckAgentOptions & Pick<SpawnOptions, 'args' | 'env' | 'onStderr'> & { cwd?: string } = {}
): Promise<CheckResult[]> {
  const { args, env, onStderr, ...checks } = options;
  const child = await spawnProcess(command, { args, env, onStderr, cwd: options.cwd });
  try {
    return await checkAgent(ndjson(child.channel), checks);
  } finally {
    await child.stop();
  }
}

export {
  check as checkTurn,
  defineScenario,
  formatJUnit,
  formatScenarios,
  loadScenarios,
  outcomeOf,
  permissionPolicy,
  runScenario,
  type Expectations,
  type RunOptions,
  type Scenario,
  type ScenarioPermissions,
  type ScenarioReport,
  type ScenarioTurn,
  type TurnOutcome,
  type TurnReport,
} from './scenario.ts';
