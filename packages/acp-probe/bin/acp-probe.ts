#!/usr/bin/env node
/**
 * acp-probe CLI entry — stdio spawn → defineAcpClientProduct → create → prompt.
 */
import {
  HELP_TEXT,
  formatEventLine,
  parseArgv,
  runProbe,
} from "../src/index.ts";

const argv = process.argv.slice(2);
const parsed = parseArgv(argv);

if ("error" in parsed) {
  console.error(`acp-probe: ${parsed.error}`);
  console.error(HELP_TEXT);
  process.exit(1);
}

if (parsed.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

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
  process.stderr.write(
    `acp-probe: ok session=${result.acpSessionId} local=${result.localId} events=${result.events.length}\n`,
  );
  process.exit(0);
}

console.error(`acp-probe: fail: ${result.error}`);
if (result.error.startsWith("timeout after")) {
  process.exit(3);
}
process.exit(2);
