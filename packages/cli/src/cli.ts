/**
 * subspace: ACP agents from the command line.
 *
 *   subspace run claude "Summarize README.md"
 *   subspace chat codex
 *   subspace agents
 *   subspace check grok
 *   subspace trace run.jsonl
 *
 * An agent is a known name (claude, codex, grok, gemini, opencode) or a
 * command after `--` (the prompt comes before it):  subspace run "hello" -- node my-agent.js
 */
import { accessSync, constants, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import {
  AGENT_PRESETS,
  askInTerminal,
  firstOf,
  readOnly,
  start,
  terminal,
  turnEnd,
  type AgentName,
  type AgentPreset,
  type PermissionHandler,
  type StartedAgent,
  type StartOptions,
} from '@deft-subspace/acp/node';
import { failures, formatReport, KNOWN_QUIRKS } from '@deft-subspace/acp-testkit';
import { checkAgentProcess, formatJUnit, formatScenarios, loadScenarios, runScenario, type ScenarioReport } from '@deft-subspace/acp-testkit/node';
import { main as traceMain } from '@deft-subspace/devtools/cli';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) };

const USAGE = `Usage: subspace <command> [options]

Commands:
  run <agent> <prompt>   Run one prompt and print the reply
  chat <agent>           Talk to an agent, turn after turn (Ctrl-C cancels a turn; again to quit)
  agents                 List the known agents and whether they are installed
  check <agent>          Run the conformance checks against an agent (known quirks waived; --strict to not)
  test <file...>         Run scenario files (--update snapshots, --junit <file>, --artifacts <dir>, --json)
  trace <file>           Write an HTML viewer for a trace (--summary for text)

<agent> is one of ${Object.keys(AGENT_PRESETS).join(', ')}, or a command after -- (the prompt goes before it):
  subspace run "hello" -- node my-agent.js

Options for run and chat:
  --cwd <dir>            The agent's folder (default: here)
  --mode <mode>          A session mode (default: the agent's ask-first mode); --mode none keeps its own
  --yes                  Allow everything the agent asks
  --read-only            Allow reads, refuse everything else
                         (default: allow reads, ask about the rest in the terminal)
  --trace <file>         Record the connection
  --json                 run: print the result as JSON
  --quiet                No thoughts, tool lines or notices
`;

interface Parsed {
  command?: string;
  positional: string[];
  flags: Record<string, string | true>;
  /** The agent command after `--`. */
  custom?: { command: string; args: string[] };
}

const VALUED = new Set(['cwd', 'mode', 'trace', 'only', 'o', 'out', 'title', 'junit', 'artifacts']);

export function parse(argv: string[]): Parsed {
  const dash = argv.indexOf('--');
  const head = dash >= 0 ? argv.slice(0, dash) : argv;
  const tail = dash >= 0 ? argv.slice(dash + 1) : [];
  const parsed: Parsed = { positional: [], flags: {} };
  for (let i = 0; i < head.length; i++) {
    const arg = head[i]!;
    if (arg.startsWith('-') && arg !== '-') {
      const name = arg.replace(/^--?/, '');
      if (VALUED.has(name)) parsed.flags[name] = head[++i] ?? '';
      else parsed.flags[name] = true;
    } else if (!parsed.command) parsed.command = arg;
    else parsed.positional.push(arg);
  }
  // Everything after -- is the agent's command line.
  if (tail.length) parsed.custom = { command: tail[0]!, args: tail.slice(1) };
  return parsed;
}

function agentOf(parsed: Parsed): AgentName | { command: string; args: string[] } {
  if (parsed.custom) return parsed.custom;
  const name = parsed.positional.shift();
  if (!name) throw new UsageError('Which agent? Give a name or a command after --.');
  if (!(name in AGENT_PRESETS)) throw new UsageError(`Unknown agent "${name}". Known: ${Object.keys(AGENT_PRESETS).join(', ')}, or a command after --.`);
  return name as AgentName;
}

class UsageError extends Error {}

function permissionsOf(parsed: Parsed): PermissionHandler | 'allow' {
  if (parsed.flags.yes) return 'allow';
  if (parsed.flags['read-only']) return readOnly;
  return firstOf(readOnly, askInTerminal());
}

function startOptions(parsed: Parsed, io: Io, onPermission: PermissionHandler | 'allow'): StartOptions {
  const quiet = !!parsed.flags.quiet;
  const mode = parsed.flags.mode;
  return {
    ...(typeof parsed.flags.cwd === 'string' ? { cwd: parsed.flags.cwd } : {}),
    ...(mode === 'none' ? { mode: false as const } : typeof mode === 'string' ? { mode } : {}),
    ...(typeof parsed.flags.trace === 'string' ? { trace: parsed.flags.trace } : {}),
    ...(onPermission === 'allow' ? { permissions: 'allow' as const } : { onPermission }),
    ...(parsed.flags.json ? {} : terminal({ out: { write: io.out, isTTY: process.stdout.isTTY }, thoughts: !quiet, tools: !quiet, plans: !quiet })),
    quiet,
  };
}

/** Whether a command can be found (an absolute path, or on PATH). */
export function installed(command: string): boolean {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function runCommand(parsed: Parsed, io: Io): Promise<number> {
  const agent = agentOf(parsed);
  const prompt = parsed.positional.join(' ').trim();
  if (!prompt) throw new UsageError('What should the agent do? Give a prompt.');
  const started = await start(agent, startOptions(parsed, io, permissionsOf(parsed)));
  try {
    if (started.modeWarning && !parsed.flags.quiet) io.err(`${started.modeWarning}\n`);
    const result = await started.run(prompt);
    if (parsed.flags.json) io.out(`${JSON.stringify({ end: turnEnd(result), ...result }, null, 2)}\n`);
    else io.out('\n');
    const end = turnEnd(result);
    return end === 'completed' ? 0 : end === 'refused' ? 3 : end === 'cancelled' || end === 'limit' ? 130 : 1;
  } finally {
    await started.close();
  }
}

async function chatCommand(parsed: Parsed, io: Io): Promise<number> {
  const agent = agentOf(parsed);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  // Permission questions go through the same line reader as the chat, one at a time.
  const ask = askVia(rl);
  const onPermission: PermissionHandler | 'allow' = parsed.flags.yes ? 'allow' : parsed.flags['read-only'] ? readOnly : firstOf(readOnly, ask);
  let started: StartedAgent | undefined;
  let running: { cancel(): Promise<void> } | undefined;
  rl.on('SIGINT', () => {
    if (running) {
      void running.cancel();
      io.err('\n(cancelling; Ctrl-C again to quit)\n');
      running = undefined;
    } else rl.close();
  });
  try {
    started = await start(agent, { ...startOptions(parsed, io, onPermission), handleSignals: false });
    io.err(`${started.client.agent.name ?? 'agent'} ready. /exit to quit.\n`);
    rl.prompt();
    for await (const line of rl) {
      const text = line.trim();
      if (text === '/exit' || text === '/quit') break;
      if (text) {
        const turn = started.prompt(text);
        running = turn;
        await turn.done.catch((error: unknown) => io.err(`\n${error instanceof Error ? error.message : String(error)}\n`));
        running = undefined;
        io.out('\n');
      }
      rl.prompt();
    }
    return 0;
  } finally {
    rl.close();
    await started?.close();
  }
}

/** A y / n / always question through an existing line reader. */
function askVia(rl: Interface): PermissionHandler {
  const always = new Set<string>();
  return (request) => {
    const kind = request.toolCall?.kind ?? 'other';
    if (always.has(kind)) return 'allow';
    return new Promise((resolve) =>
      rl.question(`? Allow ${request.title}? [y]es / [n]o / [a]lways for ${kind} tools: `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === 'a' || a === 'always') {
          always.add(kind);
          resolve('allow_always');
        } else resolve(a === 'y' || a === 'yes' ? 'allow' : 'reject');
      })
    );
  };
}

function agentsCommand(io: Io): number {
  const rows = Object.entries(AGENT_PRESETS).map(([name, preset]) => {
    const p: AgentPreset = preset;
    const ok = installed(p.command);
    return { name, ok, line: `${ok ? '✓' : '·'} ${name.padEnd(9)} ${p.description}${ok ? '' : `  (${p.install ?? `needs ${p.command}`})`}` };
  });
  io.out(`${rows.map((r) => r.line).join('\n')}\n`);
  io.out(`\n✓ = its command is installed. Logins are checked when it starts.\n`);
  return 0;
}

async function checkCommand(parsed: Parsed, io: Io): Promise<number> {
  const agent = agentOf(parsed);
  const preset: { command: string; args: readonly string[]; mode?: string } = typeof agent === 'string' ? AGENT_PRESETS[agent] : agent;
  const cwd = typeof parsed.flags.cwd === 'string' ? parsed.flags.cwd : await mkdtemp(join(tmpdir(), 'subspace-check-'));
  const mode = typeof parsed.flags.mode === 'string' ? (parsed.flags.mode === 'none' ? undefined : parsed.flags.mode) : preset.mode;
  const report = await checkAgentProcess(preset.command, {
    args: [...preset.args],
    cwd,
    ...(mode ? { mode } : {}),
    ...(typeof parsed.flags.only === 'string' ? { only: parsed.flags.only.split(',') } : {}),
    // Known quirks of this agent are waived, unless --strict.
    ...(typeof agent === 'string' && KNOWN_QUIRKS[agent] && !parsed.flags.strict ? { waive: KNOWN_QUIRKS[agent] } : {}),
  });
  io.out(`${formatReport(report)}\n`);
  return failures(report).length ? 1 : 0;
}

async function testCommand(parsed: Parsed, io: Io): Promise<number> {
  const files = parsed.positional;
  if (!files.length) throw new UsageError('Which scenario files? subspace test <file...>');
  const reports: ScenarioReport[] = [];
  for (const file of files) {
    for (const scenario of await loadScenarios(file)) {
      if (!parsed.flags.json) io.err(`running ${scenario.name}...\n`);
      reports.push(
        await runScenario(scenario, {
          baseDir: dirname(resolve(file)),
          updateSnapshots: !!parsed.flags.update,
          ...(typeof parsed.flags.artifacts === 'string' ? { artifacts: parsed.flags.artifacts } : {}),
        })
      );
    }
  }
  if (typeof parsed.flags.junit === 'string') writeFileSync(parsed.flags.junit, formatJUnit(reports));
  io.out(parsed.flags.json ? `${JSON.stringify(reports, null, 2)}\n` : `${formatScenarios(reports)}\n`);
  return reports.every((r) => r.pass) ? 0 : 1;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const parsed = parse(argv);
  try {
    switch (parsed.command) {
      case 'run':
        return await runCommand(parsed, io);
      case 'chat':
        return await chatCommand(parsed, io);
      case 'agents':
        return agentsCommand(io);
      case 'check':
        return await checkCommand(parsed, io);
      case 'test':
        return await testCommand(parsed, io);
      case 'trace':
        return await traceMain(argv.slice(1), io);
      case undefined:
      case 'help':
        io.out(USAGE);
        return parsed.command ? 0 : 2;
      default:
        throw new UsageError(`Unknown command "${parsed.command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
