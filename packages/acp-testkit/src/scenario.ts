/**
 * Scenarios: describe what an agent should do, run it, and check.
 *
 *   {
 *     "name": "writes a greeting",
 *     "agent": "claude",
 *     "workspace": { "from": "fixtures/empty" },
 *     "permissions": "allow",
 *     "turns": [
 *       { "prompt": "Create hello.txt containing hi",
 *         "expect": { "end": "completed", "files": { "hello.txt": { "contains": "hi" } }, "toolCalls": { "min": 1 } } }
 *     ]
 *   }
 *
 * Each scenario runs in a fresh temporary workspace (empty, or a copy of a
 * fixture folder), through `start()`, with the connection recorded. A
 * failing scenario leaves a failure bundle: the trace, the results, and the
 * workspace's files; a passing one removes its workspace and trace. Regression
 * snapshots (`snapshot`) record each turn's outcome once and compare later
 * runs to it. In CI (`requireSnapshots`, on when the CI variable is set) a
 * missing snapshot fails instead of being written.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  allow,
  firstOf,
  loadCatalog,
  readOnly,
  reject,
  start,
  turnEnd,
  type AgentName,
  type PermissionPolicy,
  type TurnEnd,
  type TurnEvent,
  type TurnResult,
} from '@deft-subspace/acp/node';
import { checkToolInput, mergeToolInput, summarizeToolInput, type ToolInputSummary, type ToolInputThresholds } from './tool-input.ts';

type OneOrMore<T> = T | T[];

export interface Expectations {
  /** How the turn ended (`turnEnd`): completed, refused, cancelled, limit, error. */
  end?: OneOrMore<TurnEnd>;
  /** The raw stop reason. */
  stopReason?: OneOrMore<string>;
  text?: { contains?: OneOrMore<string>; notContains?: OneOrMore<string>; matches?: string };
  toolCalls?: {
    min?: number;
    max?: number;
    /** Each must be (part of) some tool call's title. */
    titles?: string[];
    /** Each kind must appear. */
    kinds?: string[];
    /** Every tool call ended completed. */
    allCompleted?: boolean;
  };
  permissions?: { min?: number; max?: number; titles?: string[] };
  /** Paths relative to the workspace, checked after the turn. */
  files?: Record<string, { exists?: boolean; contains?: string; equals?: string; matches?: string; sameAs?: string }>;
  /** Session updates in the turn. */
  updates?: { min?: number; max?: number };
  /**
   * Tool-call argument robustness, from the outcomes the agent reports in
   * `rawOutput.toolInput` (see tool-input.ts). Unrepaired invalid calls fail
   * by default (`maxInvalidRate` 0); repairs are gated only if asked.
   */
  toolInput?: ToolInputThresholds;
}

export interface ScenarioTurn {
  prompt: string;
  expect?: Expectations;
  timeoutMs?: number;
}

/** A permission answer in a file: a fixed one, read-only, or kinds to allow and reject (the rest rejected). */
export type ScenarioPermissions = 'allow' | 'reject' | 'read-only' | { allow?: string[]; reject?: string[] };

export interface Scenario {
  name: string;
  /**
   * A known agent, or a command (args, env, an optional mode). The agent
   * runs in the workspace; arguments starting with ./ or ../ are paths
   * relative to the scenario file.
   */
  agent: AgentName | { command: string; args?: string[]; env?: Record<string, string>; mode?: string };
  /** Session mode; false keeps the agent's own. Default: the preset's ask-first mode. */
  mode?: string | false;
  workspace?: {
    /** A folder to copy into the workspace (relative to the scenario file). */
    from?: string;
  };
  permissions?: ScenarioPermissions;
  /** Per turn, unless the turn sets its own. Default 120 s. */
  timeoutMs?: number;
  /** At least one: a scenario with none fails. */
  turns: ScenarioTurn[];
  /** A snapshot file (relative to the scenario file) to compare each turn's outcome with. */
  snapshot?: string;
}

/** A scenario in TypeScript (an identity function that keeps the types). */
export function defineScenario(scenario: Scenario): Scenario {
  return scenario;
}

/** What a regression snapshot keeps of a turn: what should not change from run to run. */
export interface TurnOutcome {
  end: TurnEnd;
  stopReason: string;
  text: string;
  toolCalls: Array<{ title: string; kind?: string; status: string }>;
}

export interface TurnReport {
  prompt: string;
  pass: boolean;
  failures: string[];
  outcome: TurnOutcome;
  updates: number;
  permissions: string[];
  /** Tool-call argument outcomes, when the agent reported any. */
  toolInput?: ToolInputSummary;
  durationMs: number;
}

export interface ScenarioReport {
  name: string;
  pass: boolean;
  /** Set when the scenario could not run (it has no turns, the agent did not start, a turn threw). */
  error?: string;
  turns: TurnReport[];
  /** The temporary workspace; removed after a pass unless `keep`. */
  workspace: string;
  /** The connection trace; removed after a pass unless `keep`. */
  trace: string;
  /** Where the failure bundle is, when it failed. */
  bundle?: string;
  /** The turns' tool-call argument outcomes together, when the agent reported any. */
  toolInput?: ToolInputSummary;
  /**
   * Snapshot status: written (new or --update), matched, differed, missing
   * (with `requireSnapshots`), or unreadable (not valid JSON; left as it is).
   * Only written and matched pass.
   */
  snapshot?: SnapshotStatus;
  /** How the run differs from the snapshot beyond single turns (a different number of turns, a missing or unreadable file). */
  snapshotFailures?: string[];
  durationMs: number;
}

export type SnapshotStatus = 'written' | 'matched' | 'differed' | 'missing' | 'unreadable';

export interface RunOptions {
  /** Resolve `workspace.from` and `snapshot` against this folder (the scenario file's). Default: cwd. */
  baseDir?: string;
  /** Where failure bundles go. Default `<tmp>/subspace-scenarios`. */
  artifacts?: string;
  /** Write snapshots instead of comparing with them. */
  updateSnapshots?: boolean;
  /** A missing snapshot fails instead of being written. Default: on when the CI environment variable is set (not "false" or "0"). */
  requireSnapshots?: boolean;
  /** Keep the workspace and trace of a passing scenario. Default false (a failing one's are always kept). */
  keep?: boolean;
  /** Each event of each turn, for progress output. */
  onEvent?: (event: TurnEvent, scenario: string) => void;
}

const list = <T>(value: OneOrMore<T> | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

export function permissionPolicy(permissions: ScenarioPermissions | undefined): PermissionPolicy {
  if (permissions === undefined || permissions === 'reject') return 'reject';
  if (permissions === 'allow') return 'allow';
  if (permissions === 'read-only') return readOnly;
  return firstOf(
    ...(permissions.reject ? [reject({ kinds: permissions.reject })] : []),
    ...(permissions.allow ? [allow({ kinds: permissions.allow })] : []),
    'reject'
  );
}

export function outcomeOf(result: TurnResult): TurnOutcome {
  return {
    end: turnEnd(result),
    stopReason: String(result.stopReason),
    text: result.text,
    toolCalls: result.toolCalls.map((c) => ({ title: c.title, ...(c.kind ? { kind: c.kind } : {}), status: String(c.status) })),
  };
}

/** What is wrong with a turn, given what was expected; empty when it passes. */
export async function check(expect: Expectations, turn: { result: TurnResult; updates: number; permissions: string[]; workspace: string }): Promise<string[]> {
  const failures: string[] = [];
  const { result } = turn;
  const end = turnEnd(result);
  if (expect.end && !list(expect.end).includes(end)) failures.push(`ended ${end}, expected ${list(expect.end).join(' or ')}`);
  if (expect.stopReason && !list(expect.stopReason).includes(String(result.stopReason))) {
    failures.push(`stop reason ${result.stopReason}, expected ${list(expect.stopReason).join(' or ')}`);
  }
  const text = result.text;
  for (const want of list(expect.text?.contains)) if (!text.includes(want)) failures.push(`text does not contain ${JSON.stringify(want)}`);
  for (const not of list(expect.text?.notContains)) if (text.includes(not)) failures.push(`text contains ${JSON.stringify(not)}`);
  if (expect.text?.matches && !new RegExp(expect.text.matches).test(text)) failures.push(`text does not match /${expect.text.matches}/`);
  const calls = result.toolCalls;
  const t = expect.toolCalls;
  if (t) {
    if (t.min !== undefined && calls.length < t.min) failures.push(`${calls.length} tool calls, expected at least ${t.min}`);
    if (t.max !== undefined && calls.length > t.max) failures.push(`${calls.length} tool calls, expected at most ${t.max}`);
    for (const title of t.titles ?? []) if (!calls.some((c) => c.title.includes(title))) failures.push(`no tool call titled like ${JSON.stringify(title)}`);
    for (const kind of t.kinds ?? []) if (!calls.some((c) => c.kind === kind)) failures.push(`no ${kind} tool call`);
    if (t.allCompleted) for (const c of calls) if (c.status !== 'completed') failures.push(`tool call ${JSON.stringify(c.title)} ended ${c.status}`);
  }
  const p = expect.permissions;
  if (p) {
    if (p.min !== undefined && turn.permissions.length < p.min) failures.push(`${turn.permissions.length} permission questions, expected at least ${p.min}`);
    if (p.max !== undefined && turn.permissions.length > p.max) failures.push(`${turn.permissions.length} permission questions, expected at most ${p.max}`);
    for (const title of p.titles ?? []) if (!turn.permissions.some((q) => q.includes(title))) failures.push(`no permission question like ${JSON.stringify(title)}`);
  }
  for (const [path, want] of Object.entries(expect.files ?? {})) {
    const full = join(turn.workspace, path);
    const content = await readFile(full, 'utf8').catch(() => undefined);
    if (want.exists === false) {
      if (content !== undefined) failures.push(`${path} exists`);
      continue;
    }
    if (content === undefined) {
      failures.push(`${path} does not exist`);
      continue;
    }
    if (want.contains !== undefined && !content.includes(want.contains)) failures.push(`${path} does not contain ${JSON.stringify(want.contains)}`);
    if (want.equals !== undefined && content !== want.equals) failures.push(`${path} is not ${JSON.stringify(want.equals)}`);
    if (want.matches !== undefined && !new RegExp(want.matches).test(content)) failures.push(`${path} does not match /${want.matches}/`);
    if (want.sameAs !== undefined) {
      const other = await readFile(join(turn.workspace, want.sameAs), 'utf8').catch(() => undefined);
      if (other === undefined) failures.push(`${want.sameAs} does not exist`);
      else if (other !== content) failures.push(`${path} differs from ${want.sameAs}`);
    }
  }
  const u = expect.updates;
  if (u?.min !== undefined && turn.updates < u.min) failures.push(`${turn.updates} updates, expected at least ${u.min}`);
  if (u?.max !== undefined && turn.updates > u.max) failures.push(`${turn.updates} updates, expected at most ${u.max}`);
  if (expect.toolInput) failures.push(...checkToolInput(summarizeToolInput(result.toolCalls), expect.toolInput));
  return failures;
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(root, full)));
    else out.push(relative(root, full));
  }
  return out;
}

/** Run one scenario. Never throws for the agent's failures: they are in the report. */
export async function runScenario(scenario: Scenario, options: RunOptions = {}): Promise<ScenarioReport> {
  const started = Date.now();
  const baseDir = options.baseDir ?? process.cwd();
  const workspace = await mkdtemp(join(tmpdir(), 'subspace-scenario-'));
  if (scenario.workspace?.from) await cp(resolve(baseDir, scenario.workspace.from), workspace, { recursive: true });
  const tracePath = join(await mkdtemp(join(tmpdir(), 'subspace-trace-')), 'trace.jsonl');
  const report: ScenarioReport = { name: scenario.name, pass: false, turns: [], workspace, trace: tracePath, durationMs: 0 };

  // ./ and ../ arguments are relative to the scenario file (the agent itself runs in the workspace).
  const local = (arg: string) => (arg.startsWith('./') || arg.startsWith('../') ? resolve(baseDir, arg) : arg);
  const target =
    typeof scenario.agent === 'string'
      ? scenario.agent
      : { command: local(scenario.agent.command), args: (scenario.agent.args ?? []).map(local), ...(scenario.agent.mode ? { mode: scenario.agent.mode } : {}) };
  const env = typeof scenario.agent === 'string' ? undefined : scenario.agent.env;
  let agent: Awaited<ReturnType<typeof start>> | undefined;
  try {
    // Without turns nothing is checked: that is not a pass.
    if (!scenario.turns?.length) throw new Error('the scenario has no turns');
    agent = await start(target, {
      cwd: workspace,
      // A named agent is looked up from the scenario's project (its subspace.toml), not the temporary workspace.
      ...(typeof target === 'string' ? { catalog: loadCatalog({ cwd: baseDir }) } : {}),
      permissions: permissionPolicy(scenario.permissions),
      trace: tracePath,
      quiet: true,
      handleSignals: false,
      ...(scenario.mode !== undefined ? { mode: scenario.mode } : {}),
      ...(env ? { env: { ...(process.env as Record<string, string>), ...env } } : {}),
    });
    for (const step of scenario.turns) {
      const turnStarted = Date.now();
      let updates = 0;
      const permissions: string[] = [];
      const result = await agent.run(step.prompt, {
        timeoutMs: step.timeoutMs ?? scenario.timeoutMs ?? 120_000,
        onEvent: (event) => {
          if (event.type !== 'state') updates++;
          if (event.type === 'permission') permissions.push(event.request.title);
          options.onEvent?.(event, scenario.name);
        },
      });
      const failures = step.expect ? await check(step.expect, { result, updates, permissions, workspace }) : [];
      const toolInput = summarizeToolInput(result.toolCalls);
      report.turns.push({
        prompt: step.prompt,
        pass: !failures.length,
        failures,
        outcome: outcomeOf(result),
        updates,
        permissions,
        ...(toolInput.checked ? { toolInput } : {}),
        durationMs: Date.now() - turnStarted,
      });
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await agent?.close().catch(() => {});
  }

  const reported = report.turns.flatMap((t) => (t.toolInput ? [t.toolInput] : []));
  if (reported.length) report.toolInput = mergeToolInput(reported);
  if (scenario.snapshot && !report.error) {
    const require = options.requireSnapshots ?? inCI();
    report.snapshot = await compareSnapshot(resolve(baseDir, scenario.snapshot), report, options.updateSnapshots ?? false, require);
  }
  report.pass = !report.error && report.turns.every((t) => t.pass) && (report.snapshot === undefined || report.snapshot === 'written' || report.snapshot === 'matched');
  report.durationMs = Date.now() - started;
  if (!report.pass) report.bundle = await writeBundle(report, options.artifacts ?? join(tmpdir(), 'subspace-scenarios'));
  else if (!options.keep) {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(dirname(tracePath), { recursive: true, force: true }).catch(() => {});
  }
  return report;
}

function inCI(): boolean {
  const ci = process.env.CI;
  return !!ci && ci !== 'false' && ci !== '0';
}

async function compareSnapshot(path: string, report: ScenarioReport, update: boolean, require: boolean): Promise<SnapshotStatus> {
  const outcomes = report.turns.map((t) => t.outcome);
  const write = async () => {
    await mkdir(dirname(path), { recursive: true });
    // Written beside it, then renamed over it: a run reading it at the same time sees the old file or the new one, never half of one.
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(outcomes, null, 2)}\n`);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return 'written' as const;
  };
  if (update) return write();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      report.snapshotFailures = [`cannot read ${path}: ${(error as Error).message}`];
      return 'unreadable';
    }
    if (!require) return write();
    report.snapshotFailures = [`no snapshot at ${path} (snapshots are not written in CI; run without CI, or with --update, and commit it)`];
    return 'missing';
  }
  let existing: TurnOutcome[];
  try {
    existing = JSON.parse(text) as TurnOutcome[];
    if (!Array.isArray(existing)) throw new Error('not a list of turns');
  } catch (error) {
    // Kept as it is: overwriting would hide a bad merge or a hand edit.
    report.snapshotFailures = [`${path} is not a valid snapshot (${(error as Error).message}); fix it or rerun with --update`];
    return 'unreadable';
  }
  const differences: string[] = [];
  outcomes.forEach((outcome, i) => {
    if (JSON.stringify(outcome) !== JSON.stringify(existing[i])) differences.push(`turn ${i + 1} differs from the snapshot`);
  });
  if (existing.length !== outcomes.length) differences.push(`${outcomes.length} turns, the snapshot has ${existing.length}`);
  if (!differences.length) return 'matched';
  report.turns.forEach((t, i) => {
    if (!differences.some((d) => d.startsWith(`turn ${i + 1} `))) return;
    t.failures.push('differs from the snapshot (rerun with --update to accept)');
    t.pass = false;
  });
  if (existing.length !== outcomes.length) {
    report.snapshotFailures = [`${outcomes.length} turns, the snapshot has ${existing.length} (rerun with --update to accept)`];
  }
  return 'differed';
}

/** The trace, the report and the workspace's files, in one folder. */
async function writeBundle(report: ScenarioReport, artifacts: string): Promise<string> {
  // One folder per run, inside the artifacts folder whatever the scenario is called.
  const safe = report.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'scenario';
  await mkdir(artifacts, { recursive: true });
  const dir = await mkdtemp(join(artifacts, `${safe}-`));
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await cp(report.trace, join(dir, 'trace.jsonl')).catch(() => {});
  const files = await listFiles(report.workspace);
  await writeFile(join(dir, 'workspace-files.txt'), `${files.join('\n')}\n`);
  return dir;
}

/** Scenarios from a file: JSON (one, a list, or `{ scenarios }`), or a module exporting them as default. */
export async function loadScenarios(path: string): Promise<Scenario[]> {
  const full = isAbsolute(path) ? path : resolve(path);
  let value: unknown;
  if (full.endsWith('.json')) value = JSON.parse(await readFile(full, 'utf8'));
  else value = ((await import(pathToFileURL(full).href)) as { default?: unknown }).default;
  const scenarios = Array.isArray(value) ? value : (value as { scenarios?: unknown })?.scenarios ?? [value];
  if (!Array.isArray(scenarios) || !scenarios.every((s) => s && typeof s === 'object' && typeof (s as Scenario).name === 'string' && Array.isArray((s as Scenario).turns))) {
    throw new Error(`${path}: not a scenario file (each scenario needs a name, an agent and turns)`);
  }
  return scenarios as Scenario[];
}

/** A text summary of reports: one line per turn, failures indented. */
export function formatScenarios(reports: ScenarioReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.durationMs} ms${r.snapshot ? `, snapshot ${r.snapshot}` : ''})`);
    if (r.error) lines.push(`        could not run: ${r.error}`);
    r.turns.forEach((t, i) => {
      lines.push(`  ${t.pass ? 'ok ' : 'no '} ${i + 1}. ${JSON.stringify(t.prompt.length > 60 ? `${t.prompt.slice(0, 57)}...` : t.prompt)}  ${t.outcome.end}, ${t.outcome.toolCalls.length} tool calls`);
      for (const f of t.failures) lines.push(`        - ${f}`);
    });
    for (const f of r.snapshotFailures ?? []) lines.push(`        snapshot: ${f}`);
    if (r.bundle) lines.push(`        failure bundle: ${r.bundle}`);
  }
  const failed = reports.filter((r) => !r.pass).length;
  lines.push('', failed ? `${failed} of ${reports.length} scenarios failed` : `All ${reports.length} scenarios passed`);
  return lines.join('\n');
}

// Control characters (other than tab and newlines) and lone surrogates are not allowed in XML at all: dropped.
const xml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** JUnit XML for CI: a test case per turn, grouped by scenario. */
export function formatJUnit(reports: ScenarioReport[]): string {
  const suites = reports.map((r) => {
    const cases = r.turns.map((t, i) => {
      const name = xml(`${i + 1}. ${t.prompt.slice(0, 80)}`);
      const failure = t.failures.length ? `<failure message="${xml(t.failures[0]!)}">${xml(t.failures.join('\n'))}</failure>` : '';
      return `    <testcase classname="${xml(r.name)}" name="${name}" time="${(t.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
    });
    if (r.error) cases.push(`    <testcase classname="${xml(r.name)}" name="start"><error message="${xml(r.error)}"/></testcase>`);
    const snapshot = r.snapshotFailures ?? [];
    if (snapshot.length) {
      cases.push(`    <testcase classname="${xml(r.name)}" name="snapshot"><failure message="${xml(snapshot[0]!)}">${xml(snapshot.join('\n'))}</failure></testcase>`);
    }
    const failures = r.turns.filter((t) => !t.pass).length + (snapshot.length ? 1 : 0);
    return `  <testsuite name="${xml(r.name)}" tests="${cases.length}" failures="${failures}" errors="${r.error ? 1 : 0}" time="${(r.durationMs / 1000).toFixed(3)}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`;
}

