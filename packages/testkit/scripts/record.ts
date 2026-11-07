/**
 * Record one turn against a real agent into the quirks corpus.
 *
 *   node --conditions=source scripts/record.ts <name> <command> [args...]
 *
 *   node --conditions=source scripts/record.ts grok-plain grok --permission-mode default agent stdio
 *   PROMPT="Create hello.txt containing hi" node --conditions=source scripts/record.ts grok-write-rejected grok --permission-mode default agent stdio
 *   PROMPT="Count to 300" CANCEL_AFTER_MS=300 node --conditions=source scripts/record.ts grok-cancel grok --permission-mode default agent stdio
 *   node --conditions=source scripts/record.ts claude-plain npx -y @agentclientprotocol/claude-agent-acp
 *
 * Environment: PROMPT, PERMISSIONS (allow or reject, default reject),
 * CANCEL_AFTER_MS (cancel that long after the first agent message), OUT
 * (directory, default corpus/). The temp workspace and home directory are
 * replaced with /workspace and ~ in the trace, and host and agent ids are
 * redacted. The header's meta keeps the prompt, the policy and the
 * normalized TurnResult the corpus test expects.
 */
import { mkdtemp, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeTurn, redactKeys, replaceStrings } from '@deft-subspace/acp-testkit';
import { recordAgent, saveTrace } from '@deft-subspace/acp-testkit/node';

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command) throw new Error('usage: record.ts <name> <command> [args...]');
const prompt = process.env.PROMPT ?? 'Reply with exactly SUBSPACE_OK and nothing else. Do not use any tools.';
const permissions = process.env.PERMISSIONS === 'allow' ? 'allow' : 'reject';
const cancelAfterMs = process.env.CANCEL_AFTER_MS ? Number(process.env.CANCEL_AFTER_MS) : undefined;
const out = resolve(process.env.OUT ?? join(import.meta.dirname, '..', 'corpus'));

const cwd = await mkdtemp(join(tmpdir(), 'deft-testkit-'));
const paths = replaceStrings([
  [await realpath(cwd), '/workspace'],
  [cwd, '/workspace'],
  [homedir(), '~'],
]);
// Machine identity some agents send (Grok: in initialize's _meta).
const identity = redactKeys(['hostname', 'agentId', 'agentInstanceId']);
const redact = (message: unknown) => identity(paths(message));

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
