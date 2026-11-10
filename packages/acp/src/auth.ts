/**
 * Logging in to an agent, one shape for v1 and v2.
 *
 * The agent lists its ways to log in (`authMethods`) in `initialize`. v1
 * calls `authenticate` and `logout`; v2 calls `auth/login` and `auth/logout`.
 * Kinds of method:
 *
 * - `agent`: the agent does it itself (opens a browser, reads a cached token,
 *   asks for an API key in its own way). `client.authenticate(id)` is all it takes.
 * - `terminal`: the agent wants to be run again, interactively, with `args`
 *   and `env` added, so the user can log in there. Only listed when the client
 *   says it can (`terminalAuth`); running it is the app's job.
 *
 *   if (client.authMethods.length && !loggedIn) await client.authenticate(client.authMethods[0].id);
 */
import type { ProtocolVersion } from './model.ts';

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  /** `agent`, `terminal`, or another kind the agent names (sent as is). */
  type: string;
  /** For `terminal`: arguments to add when running the agent again. */
  args?: string[];
  /** For `terminal`: environment variables to set when running the agent again. */
  env?: Record<string, string>;
  /** The agent's `_meta` for this method (Codex: which API key provider). */
  meta?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function env(raw: unknown): Record<string, string> | undefined {
  // v1: { NAME: value }; v2: [{ name, value }].
  if (Array.isArray(raw)) {
    const entries = raw.filter(isRecord).filter((e) => typeof e.name === 'string');
    return Object.fromEntries(entries.map((e) => [e.name as string, String(e.value ?? '')]));
  }
  if (isRecord(raw)) return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  return undefined;
}

/** The login methods in an `initialize` answer. v1 methods without a type are `agent` ones. */
export function authMethodsFrom(init: Record<string, unknown>): AuthMethod[] {
  const raw = Array.isArray(init.authMethods) ? init.authMethods.filter(isRecord) : [];
  const methods: AuthMethod[] = [];
  for (const m of raw) {
    const id = typeof m.methodId === 'string' ? m.methodId : typeof m.id === 'string' ? m.id : undefined;
    if (!id) continue;
    const args = Array.isArray(m.args) ? m.args.map(String) : undefined;
    const vars = env(m.env);
    methods.push({
      id,
      name: typeof m.name === 'string' ? m.name : id,
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      type: typeof m.type === 'string' ? m.type : 'agent',
      ...(args ? { args } : {}),
      ...(vars ? { env: vars } : {}),
      ...(isRecord(m._meta) ? { meta: m._meta } : {}),
    });
  }
  return methods;
}

/** The method names for logging in and out. */
export function authMethodNames(protocol: ProtocolVersion): { login: string; logout: string } {
  return protocol === 2 ? { login: 'auth/login', logout: 'auth/logout' } : { login: 'authenticate', logout: 'logout' };
}

/**
 * Whether the agent can log out. v1 says so in `agentCapabilities.auth.logout`;
 * v2 agents must support `auth/logout` whenever they list login methods.
 */
export function canLogout(protocol: ProtocolVersion, capabilities: Record<string, unknown>, methods: AuthMethod[]): boolean {
  if (protocol === 2) return methods.length > 0;
  const auth = capabilities.auth;
  return isRecord(auth) && (auth.logout === true || isRecord(auth.logout));
}
