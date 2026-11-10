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
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
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
  /** The last stderr output, trimmed. */
  stderrTail(): string;
  /**
   * Stop the process and its process group: end stdin, SIGTERM, then SIGKILL
   * after `graceMs` (default: the `killGraceMs` spawn option). Idempotent.
   */
  stop(graceMs?: number): Promise<ExitInfo>;
}

const live = new Set<() => void>();
let exitHookInstalled = false;

/** Children in their own process group outlive us unless we stop them on exit. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const kill of live) kill();
  });
}

export async function spawnProcess(command: string, options: SpawnOptions = {}): Promise<SupervisedProcess> {
  const groups = process.platform !== 'win32';
  const child: ChildProcess = spawn(command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: groups,
  });

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === 'ENOENT'
          ? `Is "${command}" installed and on PATH?${options.cwd ? ` (cwd: ${options.cwd})` : ''}`
          : error.code === 'EACCES'
            ? `"${command}" is not executable.`
            : error.message;
      reject(new SpawnError(command, error.code, hint, { cause: error }));
    });
  });

  const tailBytes = options.stderrTailBytes ?? 16 * 1024;
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (text: string) => {
    stderr = (stderr + text).slice(-tailBytes);
    options.onStderr?.(text);
  });
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

  const killNow = () => signalGroup('SIGKILL');
  live.add(killNow);
  installExitHook();
  void ended.then(() => {
    if (!groupAlive()) live.delete(killNow);
  });

  let stopping: Promise<ExitInfo> | undefined;
  const stop = (graceMs?: number): Promise<ExitInfo> => {
    stopping ??= (async () => {
      child.stdin!.end();
      if (groupAlive()) {
        signalGroup('SIGTERM');
        const grace = graceMs ?? options.killGraceMs ?? 2000;
        const deadline = Date.now() + grace;
        while (groupAlive() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (groupAlive()) signalGroup('SIGKILL');
      }
      live.delete(killNow);
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
    stderrTail: () => stderr.trim(),
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
