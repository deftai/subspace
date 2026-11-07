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
import { ndjson, type FramingDiagnostic } from '@deft-subspace/kernel';
import { spawnProcess, type SpawnOptions, type SupervisedProcess } from '@deft-subspace/kernel/node';
import { AcpClient, type ClientOptions, type FileHandlers } from './client.ts';

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
