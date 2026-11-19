/**
 * Conformance runner: drives an AgentDriver from a DriverTranscript and
 * compares the workbench's record against what the transcript requires.
 *
 * Uses no Node APIs.
 */
import { FakeWorkbench, type WorkbenchRecord } from './fake-workbench.ts';
import type { DriverTranscript, ExpectedRecord, TranscriptStep } from './transcript.ts';
import { isStartFailureError, type AgentDriver, type AgentDriverFactory } from './types.ts';

export interface ConformanceFailure {
  where: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ConformanceResult {
  passed: boolean;
  transcript: string;
  failures: ConformanceFailure[];
  records: readonly WorkbenchRecord[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/**
 * Recursive subset matcher:
 * - Primitives: Object.is
 * - Uint8Array: equal length and bytes
 * - Arrays: equal length and element-by-element match
 * - Objects: every own key in `expected` (with value !== undefined) must match `actual[key]`
 */
function matchSubset(expected: unknown, actual: unknown, path: string): string | null {
  if (expected === actual || Object.is(expected, actual)) return null;

  if (expected instanceof Uint8Array) {
    if (!(actual instanceof Uint8Array)) return `${path}: expected Uint8Array, got ${typeof actual}`;
    if (expected.length !== actual.length) {
      return `${path}: Uint8Array length ${actual.length} !== expected ${expected.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) return `${path}[${i}]: ${actual[i]} !== ${expected[i]}`;
    }
    return null;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected array, got ${typeof actual}`;
    if (expected.length !== actual.length) {
      return `${path}: array length ${actual.length} !== expected ${expected.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = matchSubset(expected[i], actual[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return `${path}: expected object, got ${actual === null ? 'null' : typeof actual}`;
    for (const [key, expVal] of Object.entries(expected)) {
      if (expVal === undefined) continue;
      if (!(key in actual)) return `${path}.${key}: missing property (expected ${JSON.stringify(expVal)})`;
      const diff = matchSubset(expVal, actual[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }

  return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function compareRecord(expected: ExpectedRecord, actual: WorkbenchRecord, index: number): ConformanceFailure | null {
  const where = `record[${index}]`;
  if (expected.kind !== actual.kind) {
    return {
      where,
      message: `expected record kind "${expected.kind}", got "${actual.kind}"`,
      expected,
      actual,
    };
  }
  if (expected.workbench !== undefined && expected.workbench !== actual.workbench) {
    return {
      where,
      message: `expected workbench "${expected.workbench}", got "${actual.workbench}"`,
      expected: expected.workbench,
      actual: actual.workbench,
    };
  }

  const diff = matchSubset(expected, actual, where);
  if (diff) {
    return { where, message: diff, expected, actual };
  }
  return null;
}

async function runStep(
  step: TranscriptStep,
  index: number,
  driver: AgentDriver,
  workbench: FakeWorkbench,
  transcript: DriverTranscript,
  failures: ConformanceFailure[],
): Promise<void> {
  const where = `step[${index}] (${step.action})`;
  const checkValue = (expected: unknown, actual: unknown) => {
    if (expected === undefined) return;
    const diff = matchSubset(expected, actual, where);
    if (diff) {
      failures.push({ where, message: diff, expected, actual });
    }
  };

  switch (step.action) {
    case 'start': {
      try {
        await driver.start();
        if (step.expectFailure) {
          failures.push({
            where,
            message: 'expected start() to reject with StartFailure, but it resolved',
            expected: step.expectFailure,
          });
          return;
        }
        if (transcript.expectInfo) {
          const diff = matchSubset(transcript.expectInfo, driver.info, `${where}.info`);
          if (diff) failures.push({ where: `${where}.info`, message: diff, expected: transcript.expectInfo, actual: driver.info });
        }
        if (transcript.expectCapabilities) {
          const diff = matchSubset(transcript.expectCapabilities, driver.capabilities, `${where}.capabilities`);
          if (diff) {
            failures.push({
              where: `${where}.capabilities`,
              message: diff,
              expected: transcript.expectCapabilities,
              actual: driver.capabilities,
            });
          }
        }
        if (transcript.expectSessionId !== undefined && driver.sessionId !== transcript.expectSessionId) {
          failures.push({
            where: `${where}.sessionId`,
            message: `expected sessionId ${JSON.stringify(transcript.expectSessionId)}, got ${JSON.stringify(driver.sessionId)}`,
            expected: transcript.expectSessionId,
            actual: driver.sessionId,
          });
        }
      } catch (err) {
        if (!step.expectFailure) {
          failures.push({
            where,
            message: `start() rejected unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
            actual: err,
          });
          return;
        }
        if (!isStartFailureError(err)) {
          failures.push({
            where,
            message: 'start() rejected with an error that does not carry a valid StartFailure',
            expected: step.expectFailure,
            actual: err,
          });
          return;
        }
        const diff = matchSubset(step.expectFailure, err.failure, `${where}.failure`);
        if (diff) {
          failures.push({ where, message: diff, expected: step.expectFailure, actual: err.failure });
        }
      }
      return;
    }
    case 'sendPrompt': {
      const result = await driver.sendPrompt(step.prompt);
      checkValue(step.expectResult, result);
      return;
    }
    case 'cancel': {
      const result = await driver.cancel();
      checkValue(step.expectResult, result);
      return;
    }
    case 'setMode': {
      const result = await driver.setMode(step.modeId);
      checkValue(step.expectResult, result);
      return;
    }
    case 'setConfigOption': {
      const result = await driver.setConfigOption(step.id, step.value);
      checkValue(step.expectResult, result);
      return;
    }
    case 'listSessions': {
      const result = await driver.listSessions(step.cwd);
      checkValue(step.expectResult, result);
      return;
    }
    case 'deleteSession': {
      const result = await driver.deleteSession(step.sessionId);
      checkValue(step.expectResult, result);
      return;
    }
    case 'setSessionTitle': {
      await driver.setSessionTitle(step.title, step.byUser);
      return;
    }
    case 'logout': {
      const result = await driver.logout();
      checkValue(step.expectResult, result);
      return;
    }
    case 'stopTerminal': {
      const result = await driver.stopTerminal(step.toolCallId);
      checkValue(step.expectResult, result);
      return;
    }
    case 'cancelSubagent': {
      const result = await driver.cancelSubagent(step.childSessionId);
      checkValue(step.expectResult, result);
      return;
    }
    case 'stop': {
      await driver.stop();
      return;
    }
    case 'closeWorkbench': {
      workbench.close();
      return;
    }
    case 'custom': {
      await step.run({ driver, workbench });
      return;
    }
  }
}

/**
 * Drive a driver produced by `factory` through `transcript` and compare the
 * fake workbench's recorded events, asks, service calls and turn boundaries
 * against what the transcript requires.
 */
export async function checkDriver(
  factory: AgentDriverFactory,
  transcript: DriverTranscript,
): Promise<ConformanceResult> {
  const failures: ConformanceFailure[] = [];
  const workbench = new FakeWorkbench({
    ...transcript.workbench,
    agent: transcript.workbench?.agent ?? transcript.options.agent,
  });

  const driver = factory(workbench, transcript.options);

  for (let i = 0; i < transcript.steps.length; i++) {
    const step = transcript.steps[i]!;
    try {
      await runStep(step, i, driver, workbench, transcript, failures);
    } catch (err) {
      failures.push({
        where: `step[${i}] (${step.action})`,
        message: `step threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        actual: err,
      });
    }
  }

  // Plain-data check: every emitted event and ask request must be structured-cloneable.
  for (let i = 0; i < workbench.records.length; i++) {
    const rec = workbench.records[i]!;
    if ((rec.kind === 'event' || rec.kind === 'ask') && rec.cloneError) {
      failures.push({
        where: `record[${i}]`,
        message: `${rec.kind} is not structured-cloneable: ${rec.cloneError}`,
        actual: rec,
      });
    }
  }

  // W3: no asks left pending at the end of a run.
  if (workbench.openAskCount > 0) {
    failures.push({
      where: 'asks',
      message: `${workbench.openAskCount} ask(s) remained open at end of transcript`,
      expected: 0,
      actual: workbench.openAskCount,
    });
  }

  // Compare recorded entries in order.
  const count = Math.min(transcript.expected.length, workbench.records.length);
  for (let i = 0; i < count; i++) {
    const mismatch = compareRecord(transcript.expected[i]!, workbench.records[i]!, i);
    if (mismatch) failures.push(mismatch);
  }
  if (workbench.records.length < transcript.expected.length) {
    for (let i = workbench.records.length; i < transcript.expected.length; i++) {
      failures.push({
        where: `record[${i}]`,
        message: `missing expected ${transcript.expected[i]!.kind} record`,
        expected: transcript.expected[i],
      });
    }
  } else if (workbench.records.length > transcript.expected.length) {
    for (let i = transcript.expected.length; i < workbench.records.length; i++) {
      failures.push({
        where: `record[${i}]`,
        message: `unexpected extra ${workbench.records[i]!.kind} record`,
        actual: workbench.records[i],
      });
    }
  }

  return {
    passed: failures.length === 0,
    transcript: transcript.name,
    failures,
    records: workbench.records,
  };
}

/** Run `checkDriver` and throw a formatted Error if any check fails. */
export async function assertDriverConforms(
  factory: AgentDriverFactory,
  transcript: DriverTranscript,
): Promise<ConformanceResult> {
  const result = await checkDriver(factory, transcript);
  if (!result.passed) {
    const lines = result.failures.map((f) => `  - [${f.where}] ${f.message}`);
    throw new Error(`Driver failed transcript "${result.transcript}":\n${lines.join('\n')}`);
  }
  return result;
}
