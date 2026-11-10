/**
 * An agent program on stdio, ready for any ACP client (Zed, Toad, ...).
 * @typecheck-only (it waits for a client on stdin)
 */
import { readdir, rm } from 'node:fs/promises';
import { serveStdio } from '@deft-subspace/acp/node';

// console.log goes to stderr from here on, so it cannot corrupt the protocol on stdout.
serveStdio({
  name: 'tidy',
  version: '0.1.0',
  async prompt(turn) {
    // One step each: the tool call is shown, run, then completed (or failed if it throws).
    const files = await turn.tool({ title: 'List files', kind: 'read' }, () => readdir('.'));
    const logs = files.filter((f) => f.endsWith('.log'));
    if (!logs.length) {
      await turn.say('Nothing to tidy.');
      return;
    }
    // ask: the user is asked first. A refusal throws PermissionDenied, which ends the turn normally.
    await turn.tool({ title: `Delete ${logs.length} log files`, kind: 'delete', ask: true }, async (call) => {
      for (const log of logs) if (!call.signal.aborted) await rm(log);
    });
    await turn.say(`Deleted ${logs.length} log files.`);
  },
});
