/**
 * Run the agent conformance checks against a real agent program.
 *
 *   node --conditions=subspace-source scripts/check-agent.ts grok --permission-mode default agent stdio
 *   ONLY=initialize.version,session.new,session.unknown node --conditions=subspace-source scripts/check-agent.ts npx -y @agentclientprotocol/claude-agent-acp
 *
 * Each prompt check costs a real model turn; ONLY limits which run. MODE
 * switches every session to that mode first (e.g. Claude "default", Codex
 * "read-only", where they ask permission).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failures, formatReport } from '@deft-subspace/acp-testkit';
import { checkAgentProcess } from '@deft-subspace/acp-testkit/node';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('usage: check-agent.ts <command> [args...]');
const cwd = await mkdtemp(join(tmpdir(), 'deft-testkit-check-'));
const report = await checkAgentProcess(command, {
  args,
  cwd,
  ...(process.env.ONLY ? { only: process.env.ONLY.split(',') } : {}),
  ...(process.env.MODE ? { mode: process.env.MODE } : {}),
});
console.log(formatReport(report));
process.exitCode = failures(report).length ? 1 : 0;
