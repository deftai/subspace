/**
 * Recipe: ask several agents the same question at once and compare.
 * @typecheck-only (starts Claude and Codex through npx)
 */
import { readOnly, run, type AgentName } from '@deft-subspace/acp/node';

const question = process.argv.slice(2).join(' ') || 'What is the riskiest part of this codebase? One paragraph.';
const agents: AgentName[] = ['claude', 'codex'];

const answers = await Promise.allSettled(agents.map((agent) => run(agent, question, { onPermission: readOnly, timeoutMs: 300_000, quiet: true, handleSignals: false })));
answers.forEach((answer, i) => {
  console.log(`\n## ${agents[i]}\n`);
  console.log(answer.status === 'fulfilled' ? answer.value.text : `failed: ${String(answer.reason)}`);
});
