#!/usr/bin/env node
// Runs the built CLI; in a checkout without a build, runs the TypeScript source.
// In a checkout, say so when the build is older than the source (it runs the build).
try {
  const { readdirSync, statSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const newest = (dir) => {
    const root = fileURLToPath(new URL(dir, import.meta.url));
    return Math.max(...readdirSync(root, { recursive: true }).map((f) => statSync(`${root}/${f}`).mtimeMs));
  };
  if (newest('../src') > newest('../dist')) process.stderr.write('note: this build is older than its source; run `pnpm run build` in the Subspace checkout\n');
} catch {
  // No build, or no source (an installed package): nothing to say.
}
let cli;
try {
  cli = await import('../dist/index.js');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  cli = await import('../src/index.ts');
}
process.exitCode = await cli.main(process.argv.slice(2));
