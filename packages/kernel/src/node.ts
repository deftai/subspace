/**
 * Node-only: run another program as a supervised child and talk to it over
 * stdio.
 *
 * - The child gets its own process group, so stopping it also stops whatever
 *   it started (`npx foo` runs `foo` as a grandchild).
 * - stop() sends SIGTERM, then SIGKILL after a grace period.
 * - The last stderr output is kept for error messages.
 * - `ended` settles only after the process has exited *and* its stdout has
 *   been read to the end, so a final reply written just before exit is not
 *   lost.
 * - A missing program becomes a SpawnError with a hint, not an uncaught error.
 * - On Windows, a command found through PATH and PATHEXT as a `.cmd` or `.bat`
 *   file (like `npx.cmd`) is run through cmd.exe (without AutoRun commands)
 *   with its arguments escaped as Rust's std escapes them ("BatBadBut",
 *   CVE-2024-24576): quoted, quotes doubled, `%` defused, so that neither
 *   cmd.exe nor a shim that hands `%*` to cmd.exe again can be made to run
 *   anything else. An argument containing CR, LF or NUL cannot be passed safely
 *   and is refused with a SpawnError (code `EINVAL`).
 * - On Windows, which has no process groups to signal, stop() ends the child
 *   and every process it started with `taskkill /T` (run directly, no shell):
 *   without /F first, then with /F after the grace period; if taskkill cannot
 *   run, the child alone is killed. This matters for `.cmd` launches, where the
 *   program is a child of cmd.exe and would otherwise keep stdout open.
 *
 * Process groups outlive this process unless it stops them, so the live ones
 * are killed when it exits: on 'exit', and, on POSIX, on SIGINT, SIGTERM and
 * SIGHUP, which end Node without 'exit'. Those signal listeners are added only
 * while supervised groups are alive and only for signals the app has no
 * listener for: an app that handles a signal itself decides what happens, and
 * then stopping the children is up to it. After killing the groups the
 * listener removes itself and re-sends the signal, so the process still dies
 * of it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Channel } from './channel.ts';

export interface SpawnOptions {
  args?: readonly string[];
  cwd?: string;
  /** Added to (not replacing) the parent's environment. */
  env?: Record<string, string>;
  /** Bytes of stderr to keep. Default 16 KiB. */
  stderrTailBytes?: number;
  /** How long stop() waits after SIGTERM before SIGKILL. Default 2000 ms. */
  killGraceMs?: number;
  /** Also forward stderr here as it arrives. */
  onStderr?: (text: string) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class SpawnError extends Error {
  readonly command: string;
  readonly code: string | undefined;
  readonly hint: string;

  constructor(command: string, code: string | undefined, hint: string, options?: { cause?: unknown }) {
    super(`Could not start ${command}${code ? ` (${code})` : ''}. ${hint}`, options);
    this.name = 'SpawnError';
    this.command = command;
    this.code = code;
    this.hint = hint;
  }
}

export interface SupervisedProcess {
  readonly command: string;
  readonly pid: number | undefined;
  /** stdin and stdout as a byte channel. */
  readonly channel: Channel<Uint8Array>;
  /** Settles when the process exits. */
  readonly exited: Promise<ExitInfo>;
  /** Settles when the process has exited and stdout has ended. */
  readonly ended: Promise<ExitInfo>;
  /** The last stderr output (at most `stderrTailBytes` bytes), trimmed. */
  stderrTail(): string;
  /**
   * Stop the process and its process group: end stdin, SIGTERM, then SIGKILL
   * after `graceMs` (default: the `killGraceMs` spawn option). Idempotent.
   */
  stop(graceMs?: number): Promise<ExitInfo>;
}

// -- Killing live groups when this process ends -----------------------------------------

/** How to kill each process group that may still be alive. */
const live = new Set<() => void>();
let exitHookInstalled = false;

const killLive = (): void => {
  for (const kill of live) kill();
};

function track(kill: () => void): void {
  live.add(kill);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', killLive);
  }
  installSignalHooks();
}

function untrack(kill: () => void): void {
  live.delete(kill);
  if (live.size === 0) removeSignalHooks();
}

/** Signals that end Node by default without emitting 'exit'. */
const fatalSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const signalHooks = new Map<NodeJS.Signals, () => void>();

/** POSIX: on a fatal signal nobody else handles, kill the live groups and die of it anyway. */
function installSignalHooks(): void {
  if (process.platform === 'win32') return;
  for (const signal of fatalSignals) {
    if (signalHooks.has(signal) || process.listenerCount(signal) > 0) continue;
    const hook = (): void => {
      if (process.listenerCount(signal) > 1) return; // the app listens too now: its call
      killLive();
      removeSignalHooks();
      process.kill(process.pid, signal); // no listeners left, so the default action: die of it
    };
    process.on(signal, hook);
    signalHooks.set(signal, hook);
  }
}

function removeSignalHooks(): void {
  for (const [signal, hook] of signalHooks) process.off(signal, hook);
  signalHooks.clear();
}

/** How often to check whether an exited leader's group is gone: from this, doubling, up to the max. */
const pollFirstMs = 50;
const pollMaxMs = 1000;

// -- Windows command resolution -------------------------------------------------------------

const defaultPathext = '.COM;.EXE;.BAT;.CMD';

/** Windows environment names are case-insensitive (`Path`, `PATH`). */
function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name) return value;
  return undefined;
}

/**
 * @internal Where Windows would find `command`, trying each PATHEXT extension.
 * A bare name is looked up in PATH; a name with a directory is used as is. A
 * name that already ends in a PATHEXT extension, or in one of the default ones
 * (`tool.cmd` with a PATHEXT that leaves out .CMD), is looked for as it is.
 */
export function windowsFind(
  command: string,
  env: Record<string, string | undefined>,
  isFile: (path: string) => boolean,
): string | undefined {
  const win = path.win32;
  const exts = (envGet(env, 'PATHEXT') || defaultPathext).split(';').filter(Boolean);
  const ext = win.extname(command).toUpperCase();
  const known = [...exts, ...defaultPathext.split(';')].some((e) => e.toUpperCase() === ext);
  const names = ext && known ? [command] : exts.map((e) => command + e);
  const hasDir = /[\\/:]/.test(command);
  const pathDirs = (envGet(env, 'PATH') ?? '').split(';').filter(Boolean);
  const dirs = hasDir ? [''] : pathDirs.map((d) => d.replace(/^"|"$/g, ''));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? win.join(dir, name) : name;
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** What an argument to a batch file cannot carry: cmd.exe ends the command at CR or LF, and NUL ends the string. */
const batUnsafe = /[\r\n\0]/;
/** What may stay unquoted, as in Rust's std; any other ASCII character, or a control character, is quoted. */
const batPlain = /^[A-Za-z0-9#$*+\-./:?@\\_ -￿]*$/;

function batArgument(command: string, arg: string): string {
  if (batUnsafe.test(arg)) {
    throw new SpawnError(command, 'EINVAL', 'An argument to a .cmd or .bat file cannot contain a line break or NUL.');
  }
  const quote = arg === '' || arg.endsWith('\\') || !batPlain.test(arg);
  let out = quote ? '"' : '';
  let backslashes = 0;
  for (const c of arg) {
    if (c === '\\') {
      backslashes++;
    } else {
      // A quote is doubled, so cmd.exe never sees the quoting end inside the argument; the
      // program reads `""` within quotes as one `"`. Backslashes before it are doubled too.
      if (c === '"') out += '\\'.repeat(backslashes) + '"';
      // `%` becomes `%%cd:~,%`: cmd.exe expands `%cd:~,%` to nothing instead of a %VAR%.
      else if (c === '%') out += '%%cd:~,';
      backslashes = 0;
    }
    out += c;
  }
  return quote ? out + '\\'.repeat(backslashes) + '"' : out;
}

/**
 * @internal The cmd.exe command line that runs the `.cmd`/`.bat` file `script` with `args`,
 * escaped as Rust's std escapes them since CVE-2024-24576 ("BatBadBut"): an argument with
 * anything but plain characters is quoted, its quotes doubled and each `%` defused, so
 * cmd.exe finds nothing to interpret in it however often it reads it. That covers shims
 * that hand `%*` to cmd.exe again (npx.cmd, npm's node_modules\.bin shims), wherever they
 * are. An argument that cannot be passed safely (CR, LF or NUL) is a SpawnError.
 */
export function cmdLine(script: string, args: readonly string[], command = script): string {
  const file = path.win32.normalize(script);
  if (file.includes('"') || file.endsWith('\\')) {
    throw new SpawnError(command, 'EINVAL', `${JSON.stringify(file)} is not a valid file name.`);
  }
  return [`"${file}"`, ...args.map((a) => batArgument(command, a))].join(' ');
}

/**
 * @internal cmd.exe's arguments to run `line`: no AutoRun commands (/d; they could write
 * to stdout), command extensions on (the `%` escape needs them), no delayed `!` expansion,
 * and only the outer quotes stripped (/s).
 */
export function cmdExeArgs(line: string): string[] {
  return ['/d', '/e:ON', '/v:OFF', '/s', '/c', `"${line}"`];
}

/**
 * @internal Windows can only start a `.cmd`/`.bat` file through cmd.exe (Node refuses
 * to without a shell since CVE-2024-27980): the command line to run, or undefined
 * when `command` is not one (and runs as given). Throws a SpawnError for an argument
 * that cannot be passed safely.
 */
export function windowsLaunch(
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  isFile: (path: string) => boolean,
): string | undefined {
  const found = windowsFind(command, env, isFile);
  if (!found || !['.cmd', '.bat'].includes(path.win32.extname(found).toLowerCase())) return undefined;
  return cmdLine(found, args, command);
}

/**
 * @internal The taskkill.exe command that ends process `pid` and every process it started
 * (/T): asking them to close, or forcing it (/F). Run directly, not through a shell.
 */
export function taskkillCommand(pid: number, force: boolean, env: Record<string, string | undefined>): [string, string[]] {
  const root = envGet(env, 'SYSTEMROOT') || 'C:\\Windows';
  return [path.win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])]];
}

/** @internal */
export function notFoundHint(command: string, cwd: string | undefined, windows: boolean): string {
  const where = cwd ? ` (cwd: ${cwd})` : '';
  const shims = windows ? ' On Windows it is looked up with PATHEXT, so .cmd shims such as npx.cmd are found too.' : '';
  return `Is "${command}" installed and on PATH?${where}${shims}`;
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// -- The supervised process -----------------------------------------------------------------

export async function spawnProcess(command: string, options: SpawnOptions = {}): Promise<SupervisedProcess> {
  const windows = process.platform === 'win32';
  const groups = !windows;
  const env = { ...process.env, ...(options.env ?? {}) };
  const args = [...(options.args ?? [])];
  // The child resolves a relative command against its own folder, so look for it there.
  const inCwd = (file: string): boolean =>
    isFile(options.cwd && !path.win32.isAbsolute(file) ? path.win32.resolve(options.cwd, file) : file);
  const line = windows ? windowsLaunch(command, args, env, inCwd) : undefined;
  const child: ChildProcess =
    line === undefined
      ? spawn(command, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: groups })
      : spawn(envGet(env, 'COMSPEC') || 'cmd.exe', cmdExeArgs(line), {
          cwd: options.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsVerbatimArguments: true,
        });

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === 'ENOENT'
          ? notFoundHint(command, options.cwd, windows)
          : error.code === 'EACCES'
            ? `"${command}" is not executable.`
            : error.message;
      reject(new SpawnError(command, error.code, hint, { cause: error }));
    });
  });

  const tailBytes = Math.max(0, options.stderrTailBytes ?? 16 * 1024);
  let stderr = Buffer.alloc(0);
  const decoder = new StringDecoder('utf8');
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = tailBytes > 0 ? Buffer.concat([stderr, chunk]).subarray(-tailBytes) : stderr;
    if (options.onStderr) {
      const text = decoder.write(chunk);
      if (text) options.onStderr(text);
    }
  });
  const stderrTail = (): string => {
    let start = 0;
    if (stderr.length >= tailBytes) while (start < stderr.length && (stderr[start]! & 0xc0) === 0x80) start++; // a character cut in half
    return stderr.subarray(start).toString('utf8').trim();
  };
  // EPIPE after the child exits surfaces as a failed write, not a crash.
  child.stdin!.on('error', () => {});

  const exited = new Promise<ExitInfo>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
    } else {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }
  });
  const stdoutEnded = new Promise<void>((resolve) => {
    if (child.stdout!.readableEnded) resolve();
    else child.stdout!.once('close', () => resolve());
  });
  const ended = Promise.all([exited, stdoutEnded]).then(([info]) => info);

  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      if (groups && pid !== undefined) process.kill(-pid, signal);
      else child.kill(signal);
      return true;
    } catch {
      return false; // already gone
    }
  };
  const groupAlive = (): boolean => {
    if (!groups || pid === undefined) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Windows has no process groups to signal, and killing cmd.exe would leave the program a
  // .cmd file started (and its hold on stdout) running: end the tree with taskkill instead.
  const treeKill = windows && pid !== undefined;
  const killTree = (force: boolean): Promise<void> =>
    new Promise((resolve) => {
      // When taskkill cannot run or fails, a forced kill at least ends the child itself.
      const fallback = (): void => {
        if (force) signalGroup('SIGKILL');
        resolve();
      };
      const [file, killArgs] = taskkillCommand(pid!, force, env);
      let killer: ChildProcess;
      try {
        killer = spawn(file, killArgs, { stdio: 'ignore', windowsHide: true });
      } catch {
        return fallback();
      }
      killer.once('error', fallback);
      killer.once('exit', (code) => (code === 0 ? resolve() : fallback()));
    });

  const killNow = (): void => {
    if (treeKill) void killTree(true);
    else signalGroup('SIGKILL');
  };
  track(killNow);
  // Once the leader has exited, drop the group as soon as its last member is gone, so
  // the exit-time kill never hits a group id the system has since given to someone else.
  void exited.then(() => {
    let delay = pollFirstMs;
    const check = (): void => {
      if (!live.has(killNow)) return;
      if (!groupAlive()) return untrack(killNow);
      setTimeout(check, delay).unref();
      delay = Math.min(delay * 2, pollMaxMs);
    };
    check();
  });

  let stopping: Promise<ExitInfo> | undefined;
  const stop = (graceMs?: number): Promise<ExitInfo> => {
    stopping ??= (async () => {
      child.stdin!.end();
      if (groupAlive()) {
        if (treeKill) await killTree(false);
        else signalGroup('SIGTERM');
        const grace = graceMs ?? options.killGraceMs ?? 2000;
        const deadline = Date.now() + grace;
        while (groupAlive() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (groupAlive()) {
          if (treeKill) await killTree(true);
          else signalGroup('SIGKILL');
        }
      }
      untrack(killNow);
      return exited;
    })();
    return stopping;
  };

  const channel: Channel<Uint8Array> = {
    readable: Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    writable: webWritable(child.stdin!),
  };

  return {
    command,
    pid,
    channel,
    exited,
    ended,
    stderrTail,
    stop,
  };
}

/**
 * A Node writable as a web WritableStream, without `Writable.toWeb()`: on
 * Node 22 its end-of-stream callback can run twice when the other side dies
 * (an error, then the close) and throw an uncaught TypeError the second time.
 * Here each write settles through its own callback, so a broken pipe rejects
 * the write and nothing throws. Keep an 'error' listener on `stream`.
 */
export function webWritable(stream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (stream.writableEnded) resolve();
        else stream.end(() => resolve());
      }),
    abort: (reason) => {
      stream.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}
