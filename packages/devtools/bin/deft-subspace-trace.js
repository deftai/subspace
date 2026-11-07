#!/usr/bin/env node
// Runs the built CLI; in a checkout without a build, runs the TypeScript source.
let cli;
try {
  cli = await import('../dist/cli.js');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  cli = await import('../src/cli.ts');
}
process.exitCode = await cli.main(process.argv.slice(2));
