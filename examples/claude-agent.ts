/**
 * A whole ACP agent backed by Claude, with two tools. Any ACP client can use
 * it: Zed, Toad, or `subspace run "What is in src?" -- node --conditions=subspace-source examples/claude-agent.ts`.
 * Needs Claude API credentials (ANTHROPIC_API_KEY, or `ant auth login`).
 * @typecheck-only (it waits for a client on stdin, and calls the Claude API)
 */
import { readdir, readFile } from 'node:fs/promises';
import { modelAgent, tool } from '@deft-subspace/acp';
import { serveStdio } from '@deft-subspace/acp/node';
import { claude } from '@deft-subspace/claude';

const listFiles = tool({
  description: 'List the files in a folder (relative to the working directory)',
  input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  kind: 'read',
  title: ({ path }: { path: string }) => `List ${path}`,
  run: ({ path }: { path: string }) => readdir(path),
});

const readText = tool({
  description: 'Read a text file',
  input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  kind: 'read',
  title: ({ path }: { path: string }) => `Read ${path}`,
  run: ({ path }: { path: string }) => readFile(path, 'utf8'),
});

serveStdio(
  modelAgent({
    name: 'claude-helper',
    model: claude(), // Claude Opus 5.5, adaptive thinking, refusal fallbacks on
    system: ({ cwd }) => `You help with the project in ${cwd}. Look before you answer. Be brief.`,
    tools: { listFiles, readText },
  })
);
