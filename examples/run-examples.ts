/**
 * Runs every example that needs no outside agent (each must exit 0 within
 * 30 s). The others are only typechecked. Used as this package's test.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const files = readdirSync(import.meta.dirname).filter((f) => f.endsWith('.ts') && f !== 'run-examples.ts');
let failed = 0;
for (const file of files) {
  // An example that needs a real agent, or serves stdio, says @typecheck-only in its first lines.
  if (readFileSync(new URL(file, import.meta.url), 'utf8').slice(0, 600).includes('@typecheck-only')) {
    console.log(`skip  ${file} (typecheck only)`);
    continue;
  }
  const run = spawnSync(process.execPath, ['--conditions=subspace-source', file], { cwd: import.meta.dirname, encoding: 'utf8', timeout: 30_000 });
  if (run.status === 0) console.log(`ok    ${file}`);
  else {
    failed++;
    console.log(`FAIL  ${file} (exit ${run.status})\n${run.stdout}${run.stderr}`);
  }
}
if (failed) process.exitCode = 1;
