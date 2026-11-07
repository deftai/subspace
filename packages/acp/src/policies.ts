/**
 * Ready-made permission answers, so nobody hand-writes `onPermission`.
 *
 *   start('claude', { onPermission: readOnly })                                   // reads yes, the rest no
 *   start('claude', { onPermission: firstOf(allowInside(repo), askInTerminal()) }) // edits in the repo yes, ask about the rest
 *   start('claude', { onPermission: firstOf(allow({ kinds: ['read', 'search'] }), reject({ commands: /rm -rf/ }), 'allow') })
 *
 * A rule returns a decision, or `undefined` for "no opinion". `firstOf()`
 * turns rules into a handler: the first decision wins, and a fixed decision
 * ('allow', 'reject') can end the list. With no decision it rejects.
 */
import type { PermissionRequest } from './model.ts';
import type { PermissionDecision, PermissionHandler } from './permissions.ts';

export type PermissionRule = (
  request: PermissionRequest,
  signal: AbortSignal
) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;

/** What a request must match (all that are given). */
export interface PermissionMatch {
  /** Tool kinds: read, edit, delete, move, search, execute, think, fetch, other. */
  kinds?: string[];
  /** The request's title (a string matches if it is contained). */
  titles?: RegExp | string;
  /** The command to run (v2 command requests, or a tool call's input). */
  commands?: RegExp | string;
  /** Every path the request touches is inside this folder (and there is at least one). */
  inside?: string;
}

/** Tool kinds that only look. */
export const READ_KINDS = ['read', 'search', 'fetch', 'think'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `a/./b/../c` to `a/c`; POSIX paths. */
function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

/** The paths a request touches: its tool call's locations and the usual input fields. */
export function requestPaths(request: PermissionRequest): string[] {
  const paths = new Set<string>();
  for (const location of request.toolCall?.locations ?? []) if (isRecord(location) && typeof location.path === 'string') paths.add(location.path);
  const input = request.toolCall?.rawInput;
  if (isRecord(input)) {
    for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'destination', 'source']) {
      if (typeof input[key] === 'string') paths.add(input[key] as string);
    }
    if (Array.isArray(input.paths)) for (const p of input.paths) if (typeof p === 'string') paths.add(p);
  }
  for (const content of request.toolCall?.content ?? []) {
    const path = (content as { path?: unknown }).path;
    if (typeof path === 'string') paths.add(path);
  }
  return [...paths];
}

/** The command a request would run, if it is one. */
export function requestCommand(request: PermissionRequest): string | undefined {
  if (request.command) return request.command.command;
  const input = request.toolCall?.rawInput;
  if (isRecord(input)) {
    if (typeof input.command === 'string') return input.command;
    if (Array.isArray(input.command)) return input.command.map(String).join(' ');
    if (typeof input.cmd === 'string') return input.cmd;
  }
  return undefined;
}

const textMatches = (pattern: RegExp | string, text: string | undefined) =>
  text !== undefined && (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text));

/** Whether every path is inside `root` (relative paths are taken as relative to it). */
export function inside(root: string, paths: readonly string[]): boolean {
  const base = normalize(root).replace(/\/$/, '');
  return paths.length > 0 && paths.every((p) => {
    const full = normalize(p.startsWith('/') ? p : `${base}/${p}`);
    return full === base || full.startsWith(`${base}/`);
  });
}

function matches(match: PermissionMatch, request: PermissionRequest): boolean {
  if (match.kinds && !match.kinds.includes(request.toolCall?.kind ?? '')) return false;
  if (match.titles !== undefined && !textMatches(match.titles, request.title)) return false;
  if (match.commands !== undefined && !textMatches(match.commands, requestCommand(request))) return false;
  if (match.inside !== undefined && !inside(match.inside, requestPaths(request))) return false;
  return true;
}

/** Allow requests that match; no opinion on the rest. */
export function allow(match: PermissionMatch): PermissionRule {
  return (request) => (matches(match, request) ? 'allow' : undefined);
}

/** Reject requests that match; no opinion on the rest. */
export function reject(match: PermissionMatch): PermissionRule {
  return (request) => (matches(match, request) ? 'reject' : undefined);
}

/** Allow requests whose every path is inside `root`; no opinion on the rest (including requests with no path). */
export function allowInside(root: string): PermissionRule {
  return allow({ inside: root });
}

/** The first rule with a decision wins; a fixed decision may end the list. No decision at all rejects. */
export function firstOf(...rules: Array<PermissionRule | PermissionDecision>): PermissionHandler {
  return async (request, signal) => {
    for (const rule of rules) {
      const decision = typeof rule === 'function' ? await rule(request, signal) : rule;
      if (decision !== undefined) return decision;
    }
    return 'reject';
  };
}

/**
 * Reads, searches and fetches yes; no opinion on the rest. On its own (as
 * `onPermission`) the rest is rejected; first in `firstOf(readOnly, ask)` the
 * rest goes on to `ask`.
 */
export const readOnly: PermissionRule = allow({ kinds: READ_KINDS });
