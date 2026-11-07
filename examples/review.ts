/**
 * Recipe: a code review as data. Ask an agent to review the staged diff and
 * get typed findings back.
 * @typecheck-only (starts Claude's ACP adapter through npx)
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { readOnly, start } from '@deft-subspace/acp/node';

const Findings = z.array(z.object({ file: z.string(), line: z.number().optional(), problem: z.string(), fix: z.string() }));

const diff = execFileSync('git', ['diff', '--staged'], { encoding: 'utf8' });
const agent = await start('claude', { onPermission: readOnly }); // it may read the repo, nothing else
try {
  const findings = await agent.json(`Review this diff for bugs. Ignore style.\n\n\`\`\`diff\n${diff}\n\`\`\``, {
    schema: Findings,
    shape: [{ file: 'src/a.ts', line: 12, problem: 'what is wrong', fix: 'what to do' }],
  });
  for (const f of findings) console.log(`${f.file}${f.line ? `:${f.line}` : ''}  ${f.problem}\n    -> ${f.fix}`);
  process.exitCode = findings.length ? 1 : 0;
} finally {
  await agent.close();
}
