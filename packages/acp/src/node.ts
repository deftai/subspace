/**
 * Node-only helpers: start an agent program and connect to it, and serve its
 * file requests from inside a workspace.
 *
 *   const client = await connectAgent('npx', {
 *     args: ['-y', '@agentclientprotocol/claude-agent-acp'],
 *     cwd: repo,
 *     workspace: repo,
 *   });
 */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ndjson, RpcError, type FramingDiagnostic } from '@deft-subspace/kernel';
import { spawnProcess, type ExitInfo, type SpawnOptions, type SupervisedProcess } from '@deft-subspace/kernel/node';
import { AcpClient, type ClientOptions, type FileHandlers, type TerminalHandlers } from './client.ts';

export interface ConnectAgentOptions extends ClientOptions, Omit<SpawnOptions, 'onStderr'> {
  /** Serve fs requests from this directory (and nothing outside it). */
  workspace?: string;
  onStderr?: (text: string) => void;
  onFramingDiagnostic?: (diagnostic: FramingDiagnostic) => void;
}

export interface ConnectedAgent {
  client: AcpClient;
  process: SupervisedProcess;
  /** Close the connection and stop the agent's process group. */
  close(): Promise<void>;
}

/** Start an agent program and connect to it. Startup failures include the agent's stderr. */
export async function connectAgent(command: string, options: ConnectAgentOptions = {}): Promise<ConnectedAgent> {
  const child = await spawnProcess(command, options);
  const channel = ndjson(child.channel, { onDiagnostic: options.onFramingDiagnostic });
  try {
    const client = await AcpClient.connect(channel, {
      ...options,
      files: options.files ?? (options.workspace ? workspaceFiles(options.workspace) : undefined),
    });
    return {
      client,
      process: child,
      close: async () => {
        await client.close();
        await child.stop();
      },
    };
  } catch (error) {
    await child.stop();
    const tail = child.stderrTail();
    if (tail && error instanceof Error) error.message += `\nAgent stderr: ${tail.slice(-1000)}`;
    throw error;
  }
}

/**
 * File access confined to `root`. Paths are resolved against it, `..` cannot
 * leave it, and symbolic links are followed to check where they really lead.
 */
export function workspaceFiles(root: string): FileHandlers {
  return {
    async readTextFile({ path, line, limit }) {
      const content = await readFile(await insideWorkspace(root, path), 'utf8');
      if (line == null && limit == null) return content;
      const lines = content.split('\n');
      const start = Math.max(0, (line ?? 1) - 1);
      return lines.slice(start, limit == null ? undefined : start + limit).join('\n');
    },
    async writeTextFile({ path, content }) {
      const target = await insideWorkspace(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    },
  };
}

export async function insideWorkspace(root: string, path: string): Promise<string> {
  if (typeof path !== 'string' || !path) throw new Error('Path is required');
  const base = resolve(root);
  const target = resolve(base, path);
  if (!isInside(base, target)) throw new Error(`Path is outside the workspace: ${path}`);
  if (!isInside(await realpath(base), await realLocation(target))) {
    throw new Error(`Path leads outside the workspace through a symbolic link: ${path}`);
  }
  return target;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function realLocation(path: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  return join(await realpath(existing), ...rest);
}

export interface WorkspaceTerminalOptions {
  /** Refuse commands you do not want run. Return false (or throw) to refuse. Default: allow. */
  allow?: (request: { command: string; args: string[]; cwd: string; sessionId: string }) => boolean | Promise<boolean>;
  /** Output kept per terminal when the agent sets no `outputByteLimit`. Default 1 MiB. */
  defaultOutputByteLimit?: number;
  /** How long `kill` waits after SIGTERM before SIGKILL. Default 2000 ms. */
  killGraceMs?: number;
}

interface TerminalState {
  sessionId: string;
  process: SupervisedProcess;
  output: string;
  bytes: number;
  limit: number;
  truncated: boolean;
  exit?: ExitInfo;
  ended: Promise<ExitInfo>;
}

/** Code for a command the client refused to run. */
const COMMAND_REFUSED = -32001;

/**
 * Terminals that run inside `root` (v1 `terminal/*`). Each command runs in its
 * own process group, so `kill` stops whatever it started too. stdout and
 * stderr are merged, and only the newest `outputByteLimit` bytes are kept.
 * Call `dispose()` to stop every terminal still running.
 */
export function workspaceTerminals(
  root: string,
  options: WorkspaceTerminalOptions = {}
): TerminalHandlers & { dispose(): Promise<void> } {
  const terminals = new Map<string, TerminalState>();
  let next = 0;

  const get = (request: { sessionId: string; terminalId: string }): TerminalState => {
    const terminal = terminals.get(request.terminalId);
    if (!terminal || terminal.sessionId !== request.sessionId) throw RpcError.notFound(`Unknown terminal ${request.terminalId}`);
    return terminal;
  };

  const append = (terminal: TerminalState, text: string) => {
    terminal.output += text;
    terminal.bytes += Buffer.byteLength(text);
    if (terminal.bytes <= terminal.limit) return;
    // Keep the newest bytes, cut at a character boundary.
    const kept = Buffer.from(terminal.output).subarray(-terminal.limit).toString('utf8').replace(/^\uFFFD+/, '');
    terminal.output = kept;
    terminal.bytes = Buffer.byteLength(kept);
    terminal.truncated = true;
  };

  const exitStatus = (info: ExitInfo) => ({ exitCode: info.code, signal: info.signal });

  return {
    async create(request) {
      const cwd = request.cwd ? await insideWorkspace(root, request.cwd) : resolve(root);
      const args = request.args ?? [];
      const allowed = await Promise.resolve(options.allow?.({ command: request.command, args, cwd, sessionId: request.sessionId }) ?? true).catch(
        () => false
      );
      if (!allowed) throw new RpcError(COMMAND_REFUSED, `The client refused to run ${request.command}`);
      const env = Object.fromEntries((request.env ?? []).map((v) => [v.name, v.value]));
      const terminal = {
        sessionId: request.sessionId,
        output: '',
        bytes: 0,
        limit: request.outputByteLimit ?? options.defaultOutputByteLimit ?? 1024 * 1024,
        truncated: false,
      } as TerminalState;
      terminal.process = await spawnProcess(request.command, {
        args,
        cwd,
        env,
        killGraceMs: options.killGraceMs ?? 2000,
        stderrTailBytes: 1,
        onStderr: (text) => append(terminal, text),
      });
      // No input: close stdin so commands that read it do not wait.
      void terminal.process.channel.writable.close().catch(() => {});
      const decoder = new TextDecoder();
      const reader = terminal.process.channel.readable.getReader();
      const drained = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            append(terminal, decoder.decode(value, { stream: true }));
          }
        } catch {
          // The process went away; its exit is reported below.
        }
      })();
      // Exited, and all of its output read.
      terminal.ended = Promise.all([terminal.process.ended, drained]).then(([info]) => (terminal.exit = info));
      const terminalId = `term-${++next}`;
      terminals.set(terminalId, terminal);
      return { terminalId };
    },
    async output(request) {
      const terminal = get(request);
      return {
        output: terminal.output,
        truncated: terminal.truncated,
        ...(terminal.exit ? { exitStatus: exitStatus(terminal.exit) } : {}),
      };
    },
    async waitForExit(request) {
      return exitStatus(await get(request).ended);
    },
    async kill(request) {
      const terminal = get(request);
      if (!terminal.exit) await terminal.process.stop(options.killGraceMs);
      await terminal.ended;
    },
    async release(request) {
      const terminal = get(request);
      terminals.delete(request.terminalId);
      if (!terminal.exit) await terminal.process.stop(options.killGraceMs);
    },
    async dispose() {
      const all = [...terminals.values()];
      terminals.clear();
      await Promise.all(all.map((t) => (t.exit ? undefined : t.process.stop(options.killGraceMs))));
    },
  };
}

export { file, image } from './content.ts';
export { askInTerminal, terminal, type AskOptions, type TerminalOptions } from './terminal-ui.ts';
export { agentByName, run, serveStdio, start, type AgentCommand, type AgentName, type StartedAgent, type StartOptions } from './start.ts';
export { AgentFileError, agentFiles, loadCatalog, loadRegistry, parseAgentFile, parseAgentTable, refreshRegistry, registryCachePath, type CatalogOptions } from './catalog.ts';

// Everything in @deft-subspace/acp too, so a Node program needs one import.
export * from './index.ts';
