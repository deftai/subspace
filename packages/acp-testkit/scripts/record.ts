/**
 * Record one turn against a real agent into the quirks corpus.
 *
 *   node --conditions=subspace-source scripts/record.ts <name> <command> [args...]
 *
 *   node --conditions=subspace-source scripts/record.ts grok-plain grok --permission-mode default agent stdio
 *   PROMPT="Create hello.txt containing hi" node --conditions=subspace-source scripts/record.ts grok-write-rejected grok --permission-mode default agent stdio
 *   PROMPT="Count to 300" CANCEL_AFTER_MS=300 node --conditions=subspace-source scripts/record.ts grok-cancel grok --permission-mode default agent stdio
 *   node --conditions=subspace-source scripts/record.ts claude-plain npx -y @agentclientprotocol/claude-agent-acp
 *
 * Environment: PROMPT, PERMISSIONS (allow or reject, default reject), MODE
 * (a session mode to switch to first, e.g. Claude's "default" or Codex's
 * "read-only", the ask-first modes),
 * CANCEL_AFTER_MS (cancel that long after the first agent message), OUT
 * (directory, default corpus/). The temp workspace and home directory are
 * replaced with /workspace and ~ in the trace, and host and agent ids are
 * redacted. The header's meta keeps the prompt, the policy and the
 * normalized TurnResult the corpus test expects.
 */
import { mkdtemp, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { normalizeTurn, redactKeys, replaceStrings } from '@deft-subspace/acp-testkit';
import { recordAgent, saveTrace } from '@deft-subspace/acp-testkit/node';

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command) throw new Error('usage: record.ts <name> <command> [args...]');
const prompt = process.env.PROMPT ?? 'Reply with exactly SUBSPACE_OK and nothing else. Do not use any tools.';
const permissions = process.env.PERMISSIONS === 'allow' ? 'allow' : 'reject';
const mode = process.env.MODE;
const cancelAfterMs = process.env.CANCEL_AFTER_MS ? Number(process.env.CANCEL_AFTER_MS) : undefined;
const out = resolve(process.env.OUT ?? join(import.meta.dirname, '..', 'corpus'));

const cwd = await mkdtemp(join(tmpdir(), 'deft-testkit-'));
const paths = replaceStrings([
  [await realpath(cwd), '/workspace'],
  [cwd, '/workspace'],
  [homedir(), '~'],
  // Agents also name the workspace by its folder alone (Claude: "allow all edits in deft-testkit-XXXXXX/").
  [basename(cwd), 'workspace'],
]);
// Machine identity some agents send (Grok: in initialize's _meta).
const identity = redactKeys(['hostname', 'agentId', 'agentInstanceId']);
const redact = (message: unknown) => redactSetup(redactCommands(redactAuthStatus(identity(paths(message)))));

/**
 * Grok Build: the subscription tier (`subscription_*` settings) and the user's
 * own hook runs (`runs[].name`, `runs[].status.error`).
 */
function redactSetup(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSetup);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key.startsWith('subscription') && v !== null) out[key] = '<redacted>';
    else if (key === 'runs' && Array.isArray(v)) {
      out[key] = v.map((run) => {
        if (!run || typeof run !== 'object') return run;
        const r = { ...(run as Record<string, unknown>) };
        if ('name' in r) r.name = '<redacted>';
        const status = r.status as Record<string, unknown> | undefined;
        if (status && typeof status === 'object' && 'error' in status) r.status = { ...status, error: '<redacted>' };
        return redactSetup(r);
      });
    } else out[key] = redactSetup(v);
  }
  return out;
}

/**
 * The agent's available commands list the user's own skills and plugins (a
 * fingerprint of their setup), so every `availableCommands` list is emptied
 * and only its length kept, as `availableCommandsRedacted`.
 */
function redactCommands(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCommands);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'availableCommands' && Array.isArray(v)) {
      out[key] = [];
      out.availableCommandsRedacted = v.length;
    } else {
      out[key] = redactCommands(v);
    }
  }
  return out;
}

/**
 * Account details agents send in auth status updates (Claude and Codex:
 * `_auth/status_update` with `authStatus.account` email, organization and
 * plan, and a plan `label`). Replaced with "<redacted>"; the shape is kept.
 */
function redactAuthStatus(message: unknown): unknown {
  const params = (message as { params?: { authStatus?: Record<string, unknown> } } | null)?.params;
  const status = params?.authStatus;
  if (!status || typeof status !== 'object') return message;
  const account = status.account && typeof status.account === 'object' ? (status.account as Record<string, unknown>) : undefined;
  const redacted: Record<string, unknown> = { ...status };
  if (typeof status.label === 'string') redacted.label = '<redacted>';
  if (account) redacted.account = Object.fromEntries(Object.keys(account).map((k) => [k, '<redacted>']));
  return { ...(message as object), params: { ...params, authStatus: redacted } };
}

const agent = await recordAgent(command, {
  args,
  cwd,
  workspace: cwd,
  name: 'deft-testkit-record',
  permissions,
  label: name,
  redact,
});
try {
  const session = await agent.client.newSession({ cwd });
  if (mode) await session.setMode(mode);
  const turn = session.prompt(prompt);
  let scheduled = false;
  for await (const event of turn) {
    if (event.type === 'message' && cancelAfterMs !== undefined && !scheduled) {
      scheduled = true;
      setTimeout(() => {
        agent.recorder.note('cancel');
        void turn.cancel();
      }, cancelAfterMs);
    }
  }
  const result = normalizeTurn(await turn.done);
  const header = agent.recorder.records[0]!;
  if (header.kind === 'header') {
    header.meta = {
      ...header.meta,
      agent: agent.client.agent,
      protocol: agent.client.protocol,
      prompt,
      permissions,
      ...(mode ? { mode } : {}),
      ...(cancelAfterMs !== undefined ? { cancelAfterMs } : {}),
      expected: redact(result),
    };
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await agent.close();
}
const file = join(out, `${name}.trace.jsonl`);
await saveTrace(file, agent.recorder.records);
console.log(`saved ${file} (${agent.recorder.records.length} records)`);
