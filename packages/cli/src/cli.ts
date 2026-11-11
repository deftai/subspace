/**
 * subspace: ACP agents from the command line.
 *
 *   subspace run claude "Summarize README.md"
 *   subspace chat codex
 *   subspace agents
 *   subspace check grok
 *   subspace trace run.jsonl
 *
 * An agent is a known name (built in, from agents.toml / subspace.toml, or an
 * ACP registry id) or a command after `--` (the prompt comes before it):
 *   subspace run "hello" -- node my-agent.js
 */
import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import {
  agentByName,
  agentFiles,
  AgentFileError,
  askInTerminal,
  BUILTIN_AGENTS,
  installAgent,
  InstallError,
  listAgents,
  resolveAgent,
  loadCatalog,
  refreshRegistry,
  type AgentCatalog,
  type ResolvedAgent,
  firstOf,
  readOnly,
  start,
  terminal,
  turnEnd,
  type PermissionHandler,
  type StartedAgent,
  type StartOptions,
  type TurnResult,
} from '@deft-subspace/acp/node';
import { failures, formatReport } from '@deft-subspace/acp-testkit';
import { checkAgentProcess, formatJUnit, formatScenarios, loadScenarios, runScenario, type ScenarioReport } from '@deft-subspace/acp-testkit/node';
import { main as traceMain } from '@deft-subspace/devtools/cli';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) };

const AGENTS_NOTE = `<agent> is a known agent (${Object.keys(BUILTIN_AGENTS).join(', ')}, any in subspace agents --all,
or one of your own in agents.toml), or a command after -- (the prompt goes before it):
  subspace run "hello" -- node my-agent.js`;

const SESSION_OPTIONS = `  --cwd <dir>            The agent's folder (default: here)
  --mode <mode>          A session mode (default: the agent's ask-first mode); --mode none keeps its own
  --yes                  Allow everything the agent asks
  --read-only            Allow reads, refuse everything else
                         (default: allow reads, ask about the rest in the terminal)
  --env KEY=VALUE        An environment variable for the agent (repeatable)
  --trace <file>         Record the connection (view it with subspace trace)
  --quiet                No thoughts, tool lines or notices
  --agents-file <file>   An agents file to read too (repeatable)
  --trust-project        Read the nearest subspace.toml even if its folder is not trusted`;

const USAGE = `Usage: subspace <command> [options]

Commands:
  run <agent> <prompt>   Run prompts and print the replies; quick checks with --expect-*
  chat <agent>           Talk to an agent, turn after turn (Ctrl-C cancels a turn; again to quit)
  test <file...>         Run scenario files: expectations, snapshots, CI reports
  check <agent>          Run the conformance checks against an agent
  agents                 List the known agents and whether they are installed
  trace <file>           Write an HTML viewer for a trace (--summary for text)
  help [command]         This help, or a command's

${AGENTS_NOTE}

Run subspace <command> --help for its options. --version prints the version.
`;

const HELP: Record<string, string> = {
  run: `Usage: subspace run <agent> [prompt] [options]

Runs prompts in one session, rendering the turn as it streams. Exit codes: 0 every
turn completed, 3 the agent stopped after a refusal, 130 cancelled or a limit, 4 an
--expect-* check failed, 1 an error (the worst turn decides; an error beats a failed check).

Prompts:
  --prompt <text>        A prompt (repeat for several, run in order)
  --prompts-file <file>  Prompts, one per line (blank lines and # comments skipped; - for stdin)
  --stdin                Prompts from stdin, one per line

Checks:
  --expect-contains <t>  Exit 4 unless the session's text contains this (repeatable)
  --expect-not-contains <t>  Exit 4 if it does (repeatable)
  --expect-end <end>     Exit 4 unless every turn ended so: completed, refused, cancelled, limit, error
  --expect-stop-reason <r>   Exit 4 unless every turn's stop reason is this

Output and limits:
  --json                 Print the result (or results) as JSON instead of rendering
  --raw                  Print every JSON-RPC message to stderr (-> sent, <- received)
  --timeout <seconds>    Cancel a turn that runs longer

Session:
${SESSION_OPTIONS}

${AGENTS_NOTE}

Examples:
  subspace run claude "Summarize README.md"
  subspace run grok --prompt "My name is Ada." --prompt "What is my name?" --expect-contains Ada
  subspace run "hello" --raw -- node my-agent.js
`,
  chat: `Usage: subspace chat <agent> [options]

Talk to an agent, turn after turn. /exit (or Ctrl-D) quits; Ctrl-C cancels the running
turn, and quits when nothing is running. Permission questions are asked inline.

Session:
${SESSION_OPTIONS}

${AGENTS_NOTE}
`,
  test: `Usage: subspace test <file...> [options]

Runs scenario files (JSON: one scenario, a list, or { "scenarios": [...] }; or modules
exporting them). Each scenario runs in a fresh temporary workspace. Exits 1 if any failed.

  --update               Write regression snapshots instead of comparing with them
  --ci                   A missing snapshot fails instead of being written
                         (the default when the CI environment variable is set)
  --keep                 Keep the workspaces and traces of passing scenarios too
  --junit <file>         Also write JUnit XML (a test case per turn)
  --artifacts <dir>      Where failure bundles go (default: the temp folder)
  --json                 Print the reports as JSON

The scenario format: the Testing page of the Subspace docs.
`,
  check: `Usage: subspace check <agent> [options]

Runs the ACP conformance checks against an agent. Known quirks of real agents are
waived (shown as WAIVE). Exits 1 if any check failed.

  --only <ids>           Only these checks (comma-separated)
  --mode <mode>          Switch each session to this mode first (default: the agent's ask-first mode)
  --cwd <dir>            The agent's folder (default: a temporary one)
  --strict               Do not waive known quirks
  --trust-project        Read the nearest subspace.toml even if its folder is not trusted

${AGENTS_NOTE.replace('subspace run "hello" -- node my-agent.js', 'subspace check -- node my-agent.js')}
`,
  agents: `Usage: subspace agents [name] [options]
       subspace agents install <name>

Lists the known agents and whether each one's command is installed (logins are
checked when it starts). With a name, shows how it starts and its quirks.

Agents come from layers, each later one changing the earlier field by field:
the ACP agent registry, Subspace's built-ins, ~/.config/subspace/agents.toml,
the nearest subspace.toml, and the files in $SUBSPACE_AGENTS or --agents-file.

A project's subspace.toml can choose the commands agents run, so it is only read
if your agents.toml trusts its folder (that folder only, not the ones below it):

  [trust]
  folders = ["~/work/my-project"]

Otherwise it is skipped with a warning. --trust-project reads it for one run.

  --all                  Also list the registry's other agents
  --refresh              Fetch the latest ACP registry into the cache
  --files                List the agents files read, and whether each exists
  --trust-project        Read the nearest subspace.toml even if its folder is not trusted
  --json                 Print as JSON

\`agents install <name>\` downloads a registry agent's binary for this machine
into ~/.cache/subspace/bin, and agents run it from there. Only on request, and
only when the registry lists a sha256 for it, which the download must match.

An agents file:

  [agents.claude]                     # change one field of a built-in agent
  extra_args = ["--verbose"]

  [agents.mine]                       # an agent of your own
  command = "node"
  args = ["/path/to/agent.js"]
  mode = "ask"                        # the session mode to switch to (false: its own)
  env = { LOG_LEVEL = "debug" }

  [agents.mine.quirks.unknown-session]  # something it does that it should not
  summary = "Answers an unknown session with -32603"
  waives = ["session.unknown"]        # conformance checks it explains
  fix = "None needed"
  # apply = { mode = "ask", args = [...], env = {...} }  settings used because of it
`,
  trace: `Usage: subspace trace <trace.jsonl> [options]

Writes a standalone HTML viewer for a trace (from --trace, start({ trace }) or a
scenario's failure bundle) and prints its path.

  -o, --out <file>       Where to write the viewer (default: next to the trace)
  --summary              Print a text summary instead
  --title <text>         The page title
  --otlp [url]           Send the trace's OpenTelemetry spans to a collector
                         instead (OTLP/HTTP; default: $OTEL_EXPORTER_OTLP_*,
                         else http://localhost:4318/v1/traces)
  --service <name>       service.name for --otlp (default: the trace's label)
  --titles               With --otlp, include tool call titles
`,
};
HELP.help = USAGE;

/** The version, from this package's package.json. */
function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}


interface Parsed {
  command?: string;
  positional: string[];
  flags: Record<string, string | true>;
  /** Flags that may repeat (--prompt, --env, --expect-contains, ...), every value. */
  lists: Record<string, string[]>;
  /** The agent command after `--`. */
  custom?: { command: string; args: string[] };
}

const VALUED = new Set(['cwd', 'mode', 'trace', 'only', 'o', 'out', 'title', 'service', 'junit', 'artifacts', 'prompts-file', 'timeout', 'expect-end', 'expect-stop-reason']);
/** Valued flags that may be given more than once. */
const REPEATED = new Set(['prompt', 'env', 'expect-contains', 'expect-not-contains', 'agents-file']);

const SESSION_FLAGS = ['cwd', 'mode', 'yes', 'read-only', 'env', 'trace', 'quiet', 'raw', 'agents-file', 'trust-project'];
/** The flags each command takes (besides --help and --version). `trace` checks its own. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  run: [...SESSION_FLAGS, 'prompt', 'prompts-file', 'stdin', 'expect-contains', 'expect-not-contains', 'expect-end', 'expect-stop-reason', 'json', 'timeout'],
  chat: SESSION_FLAGS,
  test: ['update', 'ci', 'keep', 'junit', 'artifacts', 'json'],
  check: ['only', 'mode', 'cwd', 'strict', 'agents-file', 'trust-project'],
  agents: ['all', 'refresh', 'files', 'json', 'cwd', 'agents-file', 'trust-project'],
  help: [],
};
const ALWAYS = ['help', 'h', 'version', 'v'];

interface ParseProblems {
  /** Flags given a value they do not take (--yes=1), or missing theirs. */
  problems: string[];
  /** Where the command is in argv. */
  commandAt: number;
  /** The flags as typed, in order. */
  typed: string[];
}

function parseArgs(argv: string[]): { parsed: Parsed } & ParseProblems {
  const dash = argv.indexOf('--');
  const head = dash >= 0 ? argv.slice(0, dash) : argv;
  const tail = dash >= 0 ? argv.slice(dash + 1) : [];
  const parsed: Parsed = { positional: [], flags: {}, lists: {} };
  const problems: string[] = [];
  const typed: string[] = [];
  let commandAt = -1;
  for (let i = 0; i < head.length; i++) {
    const arg = head[i]!;
    if (arg.startsWith('-') && arg !== '-') {
      // --name value, or --name=value.
      const eq = arg.indexOf('=');
      const name = (eq > 0 ? arg.slice(0, eq) : arg).replace(/^--?/, '');
      typed.push(name);
      const takes = REPEATED.has(name) || VALUED.has(name);
      let value: string | undefined;
      if (eq > 0) {
        value = arg.slice(eq + 1);
        if (!takes) {
          problems.push(`--${name} takes no value.`);
          continue;
        }
      } else if (takes) {
        value = head[++i];
        if (value === undefined) {
          problems.push(`--${name} needs a value.`);
          continue;
        }
      }
      if (REPEATED.has(name)) (parsed.lists[name] ??= []).push(value!);
      else if (VALUED.has(name)) parsed.flags[name] = value!;
      else parsed.flags[name] = true;
    } else if (!parsed.command) {
      parsed.command = arg;
      commandAt = i;
    } else parsed.positional.push(arg);
  }
  // Everything after -- is the agent's command line.
  if (tail.length) parsed.custom = { command: tail[0]!, args: tail.slice(1) };
  return { parsed, problems, commandAt, typed };
}

export function parse(argv: string[]): Parsed {
  return parseArgs(argv).parsed;
}

/** The nearest known flag, if one is close (a typo or a prefix). */
function nearest(name: string, known: readonly string[]): string | undefined {
  let best: { flag: string; d: number } | undefined;
  for (const flag of known) {
    const d = flag.startsWith(name) && name.length >= 2 ? 0 : distance(name, flag);
    if (d <= 2 && (!best || d < best.d)) best = { flag, d };
  }
  return best?.flag;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

const catalogs = new WeakMap<Parsed, AgentCatalog>();

/** The catalog for this command (read once, so a skipped subspace.toml is warned about once). */
function catalogOf(parsed: Parsed, io: Io): AgentCatalog {
  const known = catalogs.get(parsed);
  if (known) return known;
  try {
    const catalog = loadCatalog({
      ...catalogOptions(parsed),
      onWarning: (message) => io.err(`${message}Or run with --trust-project to use it this once.\n`),
    });
    catalogs.set(parsed, catalog);
    return catalog;
  } catch (error) {
    if (error instanceof AgentFileError) throw new UsageError(error.message);
    throw error;
  }
}

const catalogOptions = (parsed: Parsed) => ({ cwd: cwdOf(parsed), files: parsed.lists['agents-file'] ?? [], trustProject: parsed.flags['trust-project'] === true });

const cwdOf = (parsed: Parsed) => (typeof parsed.flags.cwd === 'string' ? resolve(parsed.flags.cwd) : process.cwd());

/** The agent: a command after --, or a name looked up in the catalog. */
function agentOf(parsed: Parsed, io: Io): { command: string; args: string[] } | ResolvedAgent {
  if (parsed.custom) return parsed.custom;
  const name = parsed.positional.shift();
  if (!name) throw new UsageError('Which agent? Give a name or a command after --.');
  try {
    return agentByName(name, catalogOf(parsed, io));
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(`${error.message.replace(', or pass { command, args }.', '')}, or a command after --.`);
    throw error;
  }
}

/** start() takes a resolved agent as its command, keeping its name for messages. */
const startTarget = (agent: ReturnType<typeof agentOf>) => ('id' in agent ? agent.id : agent);

class UsageError extends Error {}

function permissionsOf(parsed: Parsed): PermissionHandler | 'allow' {
  if (parsed.flags.yes) return 'allow';
  if (parsed.flags['read-only']) return readOnly;
  return firstOf(readOnly, askInTerminal());
}

function startOptions(parsed: Parsed, io: Io, onPermission: PermissionHandler | 'allow'): StartOptions {
  const quiet = !!parsed.flags.quiet;
  const mode = parsed.flags.mode;
  const env = Object.fromEntries(
    (parsed.lists.env ?? []).map((pair) => {
      const at = pair.indexOf('=');
      if (at < 1) throw new UsageError(`--env takes KEY=VALUE, got ${JSON.stringify(pair)}`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    })
  );
  return {
    ...(Object.keys(env).length ? { env: { ...(process.env as Record<string, string>), ...env } } : {}),
    // --raw: the wire, both ways, on stderr.
    ...(parsed.flags.raw ? { tap: (direction: 'in' | 'out', message: unknown) => io.err(`${direction === 'out' ? '->' : '<-'} ${JSON.stringify(message)}\n`) } : {}),
    ...(typeof parsed.flags.cwd === 'string' ? { cwd: parsed.flags.cwd } : {}),
    ...(mode === 'none' ? { mode: false as const } : typeof mode === 'string' ? { mode } : {}),
    ...(typeof parsed.flags.trace === 'string' ? { trace: parsed.flags.trace } : {}),
    ...(onPermission === 'allow' ? { permissions: 'allow' as const } : { onPermission }),
    quiet,
  };
}

/** How a turn is drawn: a fresh terminal view per turn, so one turn's line state does not leak into the next. */
function view(parsed: Parsed, io: Io) {
  const quiet = !!parsed.flags.quiet;
  return parsed.flags.json ? {} : terminal({ out: { write: io.out, isTTY: process.stdout.isTTY }, thoughts: !quiet, tools: !quiet, plans: !quiet });
}

/** Whether a command can be found (an absolute path, or on PATH; on Windows with the PATHEXT extensions). */
export function installed(command: string, env: Record<string, string | undefined> = process.env, platform: string = process.platform): boolean {
  const windows = platform === 'win32';
  // Windows runs "claude" as claude.exe, claude.cmd, ...: whichever PATHEXT lists.
  const extensions = windows ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [];
  const names = windows && !extensions.some((e) => command.toLowerCase().endsWith(e.toLowerCase())) ? extensions.map((e) => command + e) : [command];
  const dirs = isAbsolute(command) ? [''] : (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean);
  return dirs.some((dir) =>
    names.some((name) => {
      try {
        // Windows has no execute bit: there, being there is enough.
        accessSync(dir ? join(dir, name) : name, windows ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  );
}

/** Prompts, one per line: blank lines and # comments skipped. */
export function promptLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function promptsOf(parsed: Parsed): Promise<string[]> {
  const prompts: string[] = [];
  const inline = parsed.positional.join(' ').trim();
  if (inline) prompts.push(inline);
  prompts.push(...(parsed.lists.prompt ?? []));
  const file = parsed.flags['prompts-file'];
  if (typeof file === 'string') prompts.push(...promptLines(file === '-' ? await readStdin() : readFileSync(file, 'utf8')));
  if (parsed.flags.stdin) prompts.push(...promptLines(await readStdin()));
  return prompts;
}

/** The error an `error` stop carried, as one line (the agent's message, or the value itself). */
export function turnError(result: TurnResult): string | undefined {
  if (turnEnd(result) !== 'error') return undefined;
  const error = result.error as { message?: unknown } | string | undefined;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return error === undefined ? 'the agent ended the turn with an error' : JSON.stringify(error);
}

const exitFor = (end: string) => (end === 'completed' ? 0 : end === 'refused' ? 3 : end === 'cancelled' || end === 'limit' ? 130 : 1);

async function runCommand(parsed: Parsed, io: Io): Promise<number> {
  const agent = agentOf(parsed, io);
  const prompts = await promptsOf(parsed);
  if (!prompts.length) throw new UsageError('What should the agent do? Give a prompt (or --prompt, --prompts-file, --stdin).');
  let timeout: number | undefined;
  if (typeof parsed.flags.timeout === 'string') {
    const seconds = Number(parsed.flags.timeout);
    if (!parsed.flags.timeout.trim() || !Number.isFinite(seconds) || seconds <= 0) {
      throw new UsageError(`--timeout takes a number of seconds above 0, got ${JSON.stringify(parsed.flags.timeout)}.`);
    }
    timeout = seconds * 1000;
  }
  const started = await start(startTarget(agent), { ...startOptions(parsed, io, permissionsOf(parsed)), catalog: catalogOf(parsed, io) });
  const results: TurnResult[] = [];
  try {
    if (started.modeWarning && !parsed.flags.quiet) io.err(`${started.modeWarning}\n`);
    for (const [i, prompt] of prompts.entries()) {
      if (prompts.length > 1 && !parsed.flags.json && !parsed.flags.quiet) io.out(`${i ? '\n' : ''}> ${prompt}\n`);
      const result = await started.run(prompt, { ...view(parsed, io), ...(timeout ? { timeoutMs: timeout } : {}) });
      results.push(result);
      if (!parsed.flags.json) io.out('\n');
      const error = turnError(result);
      if (error && !parsed.flags.json) io.err(`error: ${error}\n`);
    }
  } finally {
    await started.close();
  }
  const turns = results.map((result) => ({ end: turnEnd(result), ...result }));
  if (parsed.flags.json) io.out(`${JSON.stringify(turns.length === 1 ? turns[0] : turns, null, 2)}\n`);
  const failed = expectationFailures(parsed, results);
  for (const failure of failed) io.err(`expectation failed: ${failure}\n`);
  // The worst turn decides; an agent error is not hidden behind a failed expectation.
  const worst = Math.max(...turns.map((t) => exitFor(t.end)));
  if (failed.length) return worst === 1 ? 1 : 4;
  return worst;
}

/** The --expect-* flags: text across the session, ends and stop reasons per turn. */
export function expectationFailures(parsed: Pick<Parsed, 'flags' | 'lists'>, results: TurnResult[]): string[] {
  const failures: string[] = [];
  const text = results.map((r) => r.text).join('\n\n');
  for (const want of parsed.lists['expect-contains'] ?? []) if (!text.includes(want)) failures.push(`the text does not contain ${JSON.stringify(want)}`);
  for (const not of parsed.lists['expect-not-contains'] ?? []) if (text.includes(not)) failures.push(`the text contains ${JSON.stringify(not)}`);
  const end = parsed.flags['expect-end'];
  const stop = parsed.flags['expect-stop-reason'];
  results.forEach((result, i) => {
    if (typeof end === 'string' && turnEnd(result) !== end) failures.push(`turn ${i + 1} ended ${turnEnd(result)}, not ${end}`);
    if (typeof stop === 'string' && String(result.stopReason) !== stop) failures.push(`turn ${i + 1} stop reason is ${result.stopReason}, not ${stop}`);
  });
  return failures;
}

async function chatCommand(parsed: Parsed, io: Io): Promise<number> {
  const agent = agentOf(parsed, io);
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
    } else {
      io.err('\n');
      rl.close();
    }
  });
  try {
    started = await start(startTarget(agent), { ...startOptions(parsed, io, onPermission), catalog: catalogOf(parsed, io), handleSignals: false });
    io.err(`${started.client.agent.name ?? 'agent'} ready. /exit to quit.\n`);
    rl.prompt();
    for await (const line of rl) {
      const text = line.trim();
      if (text === '/exit' || text === '/quit') break;
      if (text) {
        const turn = started.prompt(text, view(parsed, io));
        running = turn;
        await turn.done.then(
          (result) => {
            const error = turnError(result);
            if (error) io.err(`\nerror: ${error}\n`);
          },
          (error: unknown) => io.err(`\n${error instanceof Error ? error.message : String(error)}\n`)
        );
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
  return (request, signal) => {
    const kind = request.toolCall?.kind ?? 'other';
    if (always.has(kind)) return 'allow';
    return new Promise((resolve) => {
      // A cancelled turn takes its question back, so the next line goes to the chat.
      const onAbort = () => {
        rl.write(null, { ctrl: true, name: 'u' }); // clear what was typed
        resolve('cancelled');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      rl.question(`? Allow ${request.title}? [y]es / [n]o / [a]lways for ${kind} tools: `, { signal }, (answer) => {
        signal.removeEventListener('abort', onAbort);
        const a = answer.trim().toLowerCase();
        if (a === 'a' || a === 'always') {
          always.add(kind);
          resolve('allow_always');
        } else resolve(a === 'y' || a === 'yes' ? 'allow' : 'reject');
      });
    });
  };
}

const launchNote = (a: ResolvedAgent) => (a.launch === 'npx' || a.launch === 'uvx' ? `${a.launch} ${a.args.find((x) => !x.startsWith('-')) ?? ''}` : [a.command, ...a.args].join(' '));

/** Installed: its command is on PATH (npx and uvx fetch the package themselves). */
const ready = (a: ResolvedAgent) => installed(a.command);

/** `subspace agents install <name>`: a registry binary, checked, into the cache. */
async function installCommand(parsed: Parsed, io: Io): Promise<number> {
  const name = parsed.positional[1];
  if (!name) throw new UsageError('subspace agents install <name>');
  const catalog = catalogOf(parsed, io);
  const agent = resolveAgent(catalog, name);
  const entry = agent?.registry ? catalog.registry.agents.find((a) => a.id === agent.registry) : undefined;
  if (!agent) throw new UsageError(`Unknown agent ${JSON.stringify(name)}; \`subspace agents --all\` lists them`);
  if (!entry?.distribution.binary) {
    io.err(`${agent.id} is not installed from a registry binary (it starts with \`${agent.command}\`)${agent.install ? `; ${agent.install}` : ''}\n`);
    return 1;
  }
  try {
    const installed = await installAgent(entry);
    io.out(installed.reused ? `${entry.id} ${entry.version} is already installed: ${installed.command}\n` : `Installed ${entry.id} ${entry.version} (sha256 ${installed.sha256}): ${installed.command}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    io.err(`${error.message}\n`);
    return 1;
  }
}

async function agentsCommand(parsed: Parsed, io: Io): Promise<number> {
  if (parsed.positional[0] === 'install') return installCommand(parsed, io);
  if (parsed.flags.refresh) {
    const { agents, path } = await refreshRegistry();
    io.out(`Fetched the ACP registry: ${agents} agents -> ${path}\n`);
    if (!parsed.positional.length && !parsed.flags.all) return 0;
  }
  if (parsed.flags.files) {
    for (const f of agentFiles(catalogOptions(parsed))) io.out(`${!f.trusted ? '✗' : f.exists ? '✓' : '·'} ${f.path}${f.trusted ? '' : '   (not trusted: skipped)'}\n`);
    return 0;
  }
  const catalog = catalogOf(parsed, io);
  const name = parsed.positional[0];
  if (name) {
    const agent = agentOf(parsed, io);
    if (!('id' in agent)) throw new UsageError('subspace agents <name>');
    if (parsed.flags.json) {
      io.out(`${JSON.stringify(agent, null, 2)}\n`);
      return 0;
    }
    const lines = [
      `${agent.id}${agent.name !== agent.id ? ` (${agent.name})` : ''}${agent.version ? ` ${agent.version}` : ''}`,
      ...(agent.description ? [`  ${agent.description}`] : []),
      `  command   ${[agent.command, ...agent.args].join(' ')}${ready(agent) ? '' : '   (not installed)'}`,
      ...(Object.keys(agent.env).length ? [`  env       ${Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join(' ')}`] : []),
      `  mode      ${agent.mode ?? "(the agent's own)"}`,
      ...(agent.aliases.length ? [`  aliases   ${agent.aliases.join(', ')}`] : []),
      ...(agent.install ? [`  install   ${agent.install}`] : []),
      ...(agent.login ? [`  login     ${agent.login}`] : []),
      `  from      ${agent.sources.join(' < ')}`,
    ];
    const quirks = Object.entries(agent.quirks);
    if (quirks.length) {
      lines.push('', 'Quirks:');
      for (const [id, q] of quirks) {
        lines.push(`  ${id}: ${q.summary}`);
        if (q.fix) lines.push(`    fix: ${q.fix}`);
        const applied = [
          ...(q.apply?.mode !== undefined ? [`mode ${q.apply.mode === false ? "(the agent's own)" : q.apply.mode}`] : []),
          ...(q.apply?.args?.length ? [`args ${q.apply.args.join(' ')}`] : []),
          ...(q.apply?.env ? [`env ${Object.keys(q.apply.env).join(', ')}`] : []),
        ];
        if (applied.length) lines.push(`    applies: ${applied.join('; ')}`);
        if (q.waives?.length) lines.push(`    waives: ${q.waives.join(', ')}`);
        if (q.seen) lines.push(`    seen: ${q.seen}`);
        if (q.upstream) lines.push(`    upstream: ${q.upstream}`);
      }
    }
    io.out(`${lines.join('\n')}\n`);
    return 0;
  }
  const all = listAgents(catalog);
  const shown = parsed.flags.all ? all : all.filter((a) => a.sources.some((s) => s !== 'registry'));
  if (parsed.flags.json) {
    io.out(`${JSON.stringify(shown, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(...shown.map((a) => a.id.length)) + 1;
  for (const a of shown) {
    const ok = ready(a);
    const quirks = Object.keys(a.quirks).length;
    const mark = !ok ? '·' : a.launch === 'npx' || a.launch === 'uvx' ? '↓' : '✓';
    io.out(`${mark} ${a.id.padEnd(width)} ${a.description || a.name}${quirks ? `  [${quirks} quirk${quirks > 1 ? 's' : ''}]` : ''}${ok ? '' : `  (${a.install ?? `needs ${a.command}`})`}\n`);
  }
  const more = all.length - shown.length;
  io.out(`\n✓ installed   ↓ fetched by ${'npx/uvx'} on first start   · not installed. Logins are checked when it starts.\n`);
  io.out(`subspace agents <name> shows one${more ? `; --all lists ${more} more from the ACP registry (${catalog.registrySource})` : ''}.\n`);
  return 0;
}

async function checkCommand(parsed: Parsed, io: Io): Promise<number> {
  const agent = agentOf(parsed, io);
  const known = 'id' in agent ? agent : undefined;
  const cwd = typeof parsed.flags.cwd === 'string' ? parsed.flags.cwd : await mkdtemp(join(tmpdir(), 'subspace-check-'));
  const mode = typeof parsed.flags.mode === 'string' ? (parsed.flags.mode === 'none' ? undefined : parsed.flags.mode) : known?.mode;
  const report = await checkAgentProcess(agent.command, {
    args: [...agent.args],
    cwd,
    ...(known && Object.keys(known.env).length ? { env: { ...(process.env as Record<string, string>), ...known.env } } : {}),
    ...(mode ? { mode } : {}),
    ...(typeof parsed.flags.only === 'string' ? { only: parsed.flags.only.split(',') } : {}),
    // The agent's known quirks waive the checks they explain, unless --strict.
    ...(known && Object.keys(known.waivers).length && !parsed.flags.strict ? { waive: known.waivers } : {}),
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
          ...(parsed.flags.ci ? { requireSnapshots: true } : {}),
          ...(parsed.flags.keep ? { keep: true } : {}),
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
  const { parsed, problems, commandAt, typed } = parseArgs(argv);
  if (parsed.flags.version || parsed.flags.v) {
    io.out(`subspace ${version()}\n`);
    return 0;
  }
  // subspace --help, subspace <command> --help, subspace help [command]
  if (parsed.flags.help || parsed.flags.h || parsed.command === 'help') {
    const topic = parsed.command === 'help' ? parsed.positional[0] : parsed.command;
    if (topic && !HELP[topic]) {
      io.err(`Unknown command "${topic}".\n\n${USAGE}`);
      return 2;
    }
    io.out(topic ? HELP[topic]! : USAGE);
    return 0;
  }
  const known = parsed.command ? COMMAND_FLAGS[parsed.command] : undefined;
  if (known) {
    // A typo must not become part of the prompt, or be ignored.
    const unknown = typed.find((name) => !known.includes(name) && !ALWAYS.includes(name));
    if (unknown) {
      const near = nearest(unknown, known);
      io.err(`Unknown option --${unknown} for subspace ${parsed.command}.${near ? ` Did you mean --${near}?` : ''}\nRun subspace ${parsed.command} --help for its options.\n`);
      return 2;
    }
  }
  if (problems.length && parsed.command !== 'trace') {
    io.err(`${problems.join('\n')}\n${parsed.command && HELP[parsed.command] ? `Run subspace ${parsed.command} --help for its options.` : USAGE}\n`);
    return 2;
  }
  try {
    switch (parsed.command) {
      case 'run':
        return await runCommand(parsed, io);
      case 'chat':
        return await chatCommand(parsed, io);
      case 'agents':
        return await agentsCommand(parsed, io);
      case 'check':
        return await checkCommand(parsed, io);
      case 'test':
        return await testCommand(parsed, io);
      case 'trace':
        // Its own options, wherever they were given (before or after the word trace).
        return await traceMain([...argv.slice(0, commandAt), ...argv.slice(commandAt + 1)], io);
      case undefined:
        // No command at all: the usage, as an error (a script called it wrong).
        io.err(USAGE);
        return 2;
      default:
        throw new UsageError(`Unknown command "${parsed.command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      const help = parsed.command && HELP[parsed.command] ? `Run subspace ${parsed.command} --help for its options.` : USAGE;
      io.err(`${error.message}\n\n${help}\n`);
      return 2;
    }
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
