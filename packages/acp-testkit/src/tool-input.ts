/**
 * Tool-call argument robustness: how often an agent's model sends tool
 * arguments that are wrong, and how often the agent repairs them.
 *
 * Some agents validate each tool call's arguments and repair safe
 * near-misses (an optional field sent as `null`, a JSON array sent as a
 * string, a path wrapped in a markdown link). An agent that does can report
 * the outcome on the tool call's `rawOutput.toolInput`:
 *
 *   { "status": "repaired", "tool": "read_file", "backend": "openai", "model": "gpt-oss-20b",
 *     "repairs": [{ "path": "path", "kind": "unwrap_markdown_link" }] }
 *
 * `status` is `valid`, `repaired` or `invalid`; an invalid outcome lists
 * `issues` (`path`, `kind`, ...). Values are never included, only shapes and
 * paths. Agents that report nothing are not failing: their calls are just
 * not checked.
 *
 * A high repair rate is a compatibility signal (the model needs help), not a
 * failure. Only unrepaired invalid calls are gated by default.
 */
import type { ToolCall } from '@deft-subspace/acp';

export type ToolInputStatus = 'valid' | 'repaired' | 'invalid';

export interface ToolInputCounts {
  /** Tool calls whose argument outcome the agent reported. */
  checked: number;
  valid: number;
  repaired: number;
  invalid: number;
}

export interface ToolInputSummary extends ToolInputCounts {
  /** All tool calls seen, reported or not. */
  toolCalls: number;
  /** `repaired / checked`, or null when nothing was checked. */
  repairRate: number | null;
  /** `invalid / checked`, or null when nothing was checked. */
  invalidRate: number | null;
  /** Repairs applied, by kind (e.g. `omit_optional_null`). */
  repairKinds: Record<string, number>;
  /** Unrepaired issues, by `tool:path`. */
  invalidArguments: Record<string, number>;
  byBackend: Record<string, ToolInputCounts>;
  byModel: Record<string, ToolInputCounts>;
  byTool: Record<string, ToolInputCounts>;
}

/** Limits for a turn or a run (the scenario expectation `toolInput`). */
export interface ToolInputThresholds {
  /** Highest allowed `invalid / checked`. Default 0: every invalid call must be repaired. */
  maxInvalidRate?: number;
  /** Highest allowed `repaired / checked`. Default: not gated. */
  maxRepairRate?: number;
  /**
   * Fewest checked calls required; fewer is a failure. Unset: an agent that
   * reports no outcomes passes (it is not checked, not failing).
   */
  minChecked?: number;
}

export interface ToolInputOutcome {
  status: ToolInputStatus;
  tool: string;
  backend?: string;
  model?: string;
  repairKinds: string[];
  issuePaths: string[];
}

const STATUSES = new Set<string>(['valid', 'repaired', 'invalid']);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: Record<string, unknown> | undefined, key: string): string | undefined => {
  const field = value?.[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
};

/** The outcome a tool call reports in `rawOutput.toolInput`, if any. */
export function toolInputOf(call: Pick<ToolCall, 'title' | 'rawOutput'>): ToolInputOutcome | undefined {
  const input = record(record(call.rawOutput)?.toolInput);
  const status = input?.status;
  if (typeof status !== 'string' || !STATUSES.has(status)) return undefined;
  const list = (key: string, field: string): string[] =>
    (Array.isArray(input![key]) ? (input![key] as unknown[]) : [])
      .map((item) => text(record(item), field))
      .filter((item): item is string => item !== undefined);
  const backend = text(input, 'backend');
  const model = text(input, 'model');
  return {
    status: status as ToolInputStatus,
    tool: text(input, 'tool') ?? (call.title || 'unknown'),
    ...(backend ? { backend } : {}),
    ...(model ? { model } : {}),
    repairKinds: list('repairs', 'kind'),
    issuePaths: list('issues', 'path'),
  };
}

const emptyCounts = (): ToolInputCounts => ({ checked: 0, valid: 0, repaired: 0, invalid: 0 });

/** Names come from the agent: `__proto__` must become an own key, never reach Object.prototype. */
function own<T>(map: Record<string, T>, key: string, create: () => T): T {
  if (!Object.hasOwn(map, key)) Object.defineProperty(map, key, { value: create(), enumerable: true, writable: true, configurable: true });
  return map[key]!;
}

const bump = (map: Record<string, number>, key: string) => {
  own(map, key, () => 0);
  map[key]! += 1;
};

const add = (counts: ToolInputCounts, status: ToolInputStatus) => {
  counts.checked += 1;
  counts[status] += 1;
};

/** Count the outcomes of tool calls (each call once, by id: its latest state). */
export function summarizeToolInput(calls: Iterable<Pick<ToolCall, 'id' | 'title' | 'rawOutput'>>): ToolInputSummary {
  const latest = new Map<string, Pick<ToolCall, 'id' | 'title' | 'rawOutput'>>();
  let anonymous = 0;
  for (const call of calls) latest.set(call.id || `#${anonymous++}`, call);
  const summary: ToolInputSummary = {
    toolCalls: latest.size,
    ...emptyCounts(),
    repairRate: null,
    invalidRate: null,
    repairKinds: {},
    invalidArguments: {},
    byBackend: {},
    byModel: {},
    byTool: {},
  };
  for (const call of latest.values()) {
    const outcome = toolInputOf(call);
    if (!outcome) continue;
    add(summary, outcome.status);
    add(own(summary.byTool, outcome.tool, emptyCounts), outcome.status);
    if (outcome.backend) add(own(summary.byBackend, outcome.backend, emptyCounts), outcome.status);
    if (outcome.model) add(own(summary.byModel, outcome.model, emptyCounts), outcome.status);
    for (const kind of outcome.repairKinds) bump(summary.repairKinds, kind);
    if (outcome.status === 'invalid') {
      for (const path of outcome.issuePaths.length ? outcome.issuePaths : ['(arguments)']) bump(summary.invalidArguments, `${outcome.tool}:${path}`);
    }
  }
  if (summary.checked) {
    summary.repairRate = summary.repaired / summary.checked;
    summary.invalidRate = summary.invalid / summary.checked;
  }
  return summary;
}

/** Add summaries (e.g. a run's turns) together; rates are recomputed. */
export function mergeToolInput(summaries: Iterable<ToolInputSummary>): ToolInputSummary {
  const out = summarizeToolInput([]);
  const addCounts = (into: ToolInputCounts, from: ToolInputCounts) => {
    into.checked += from.checked;
    into.valid += from.valid;
    into.repaired += from.repaired;
    into.invalid += from.invalid;
  };
  const addMap = (into: Record<string, ToolInputCounts>, from: Record<string, ToolInputCounts>) => {
    for (const [key, counts] of Object.entries(from)) addCounts(own(into, key, emptyCounts), counts);
  };
  const addNumbers = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [key, n] of Object.entries(from)) {
      own(into, key, () => 0);
      into[key]! += n;
    }
  };
  for (const s of summaries) {
    out.toolCalls += s.toolCalls;
    addCounts(out, s);
    addNumbers(out.repairKinds, s.repairKinds);
    addNumbers(out.invalidArguments, s.invalidArguments);
    addMap(out.byBackend, s.byBackend);
    addMap(out.byModel, s.byModel);
    addMap(out.byTool, s.byTool);
  }
  if (out.checked) {
    out.repairRate = out.repaired / out.checked;
    out.invalidRate = out.invalid / out.checked;
  }
  return out;
}

const rate = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`toolInput.${name} must be a number from 0 to 1, got ${JSON.stringify(value)}`);
  }
  return value;
};

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/**
 * What is wrong with a summary, given the limits; empty when it passes.
 * Mistyped limits (a rate as a string, outside 0..1, `minChecked` below 1)
 * throw rather than silently turning the check off.
 */
export function checkToolInput(summary: ToolInputSummary, thresholds: ToolInputThresholds = {}): string[] {
  const maxInvalidRate = rate(thresholds.maxInvalidRate, 'maxInvalidRate') ?? 0;
  const maxRepairRate = rate(thresholds.maxRepairRate, 'maxRepairRate');
  const minChecked = thresholds.minChecked;
  if (minChecked !== undefined && (typeof minChecked !== 'number' || !Number.isInteger(minChecked) || minChecked < 1)) {
    throw new Error(`toolInput.minChecked must be a whole number of at least 1, got ${JSON.stringify(minChecked)}`);
  }
  if (!summary.checked && minChecked === undefined) return [];
  if (minChecked !== undefined && summary.checked < minChecked) {
    return [
      summary.toolCalls && !summary.checked
        ? `${summary.toolCalls} tool calls, none reported a tool-input outcome (rawOutput.toolInput)`
        : `${summary.checked} tool calls with a tool-input outcome, expected at least ${minChecked}`,
    ];
  }
  const failures: string[] = [];
  const worst = (field: 'invalid' | 'repaired') =>
    Object.entries(summary.byBackend)
      .filter(([, c]) => c[field] > 0)
      .sort(([, a], [, b]) => b[field] / b.checked - a[field] / a.checked)
      .slice(0, 3)
      .map(([name, c]) => `${name} ${percent(c[field] / c.checked)}`);
  if (summary.invalidRate! > maxInvalidRate) {
    const where = Object.keys(summary.invalidArguments).slice(0, 5).join(', ');
    const backends = worst('invalid');
    failures.push(
      `tool-input invalid rate ${percent(summary.invalidRate!)} (${summary.invalid}/${summary.checked}), expected at most ${percent(maxInvalidRate)}` +
        (where ? `; unrepaired: ${where}` : '') +
        (backends.length ? `; worst: ${backends.join(', ')}` : '')
    );
  }
  if (maxRepairRate !== undefined && summary.repairRate! > maxRepairRate) {
    const backends = worst('repaired');
    failures.push(
      `tool-input repair rate ${percent(summary.repairRate!)} (${summary.repaired}/${summary.checked}), expected at most ${percent(maxRepairRate)}` +
        (backends.length ? `; worst: ${backends.join(', ')}` : '')
    );
  }
  return failures;
}
