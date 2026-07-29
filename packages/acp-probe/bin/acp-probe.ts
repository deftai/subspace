#!/usr/bin/env node
/**
 * acp-probe CLI entry — stdio spawn → defineAcpClientProduct → create → prompt.
 *
 * Owns: process argv → exit codes only (0 ok, 1 usage, 2 agent fail, 3 timeout).
 * Does not own: probe logic (../src); streams JSON events on stdout, status on stderr.
 */
import {
  HELP_TEXT,
  formatEventLine,
  parseArgv,
  runProbe,
} from "../src/index.ts";

const argv = process.argv.slice(2);
const parsed = parseArgv(argv);

// Usage errors: show message + help, non-zero exit for scripts
if ("error" in parsed) {
  console.error(`acp-probe: ${parsed.error}`);
  console.error(HELP_TEXT);
  process.exit(1);
}

if (parsed.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

// Stream demuxed events as NDJSON lines for piping into other tools
const result = await runProbe({
  command: parsed.command,
  args: parsed.args,
  prompt: parsed.prompt,
  permissionPolicy: parsed.permissionPolicy,
  timeoutMs: parsed.timeoutMs,
  cwd: parsed.cwd,
  onEvent: (event) => {
    process.stdout.write(formatEventLine(event) + "\n");
  },
});

if (result.ok) {
  // Success summary on stderr so stdout stays pure event stream
  process.stderr.write(
    `acp-probe: ok session=${result.acpSessionId} local=${result.localId} events=${result.events.length}\n`,
  );
  process.exit(0);
}

console.error(`acp-probe: fail: ${result.error}`);
// Distinct exit code so automation can treat timeout differently from agent errors
if (result.error.startsWith("timeout after")) {
  process.exit(3);
}
process.exit(2);
