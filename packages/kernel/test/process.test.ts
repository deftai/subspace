import assert from 'node:assert/strict';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { ndjson, RpcPeer } from '@deft-subspace/kernel';
import { cmdExeArgs, cmdLine, notFoundHint, spawnProcess, SpawnError, windowsFind, windowsLaunch } from '@deft-subspace/kernel/node';

const node = process.execPath;

test('a missing program is a SpawnError with a hint', async () => {
  await assert.rejects(spawnProcess('definitely-not-a-real-agent-binary'), (e) => {
    assert.ok(e instanceof SpawnError);
    assert.equal(e.code, 'ENOENT');
    assert.match(e.message, /installed and on PATH/);
    return true;
  });
});

test('a reply written just before exit is not lost', async () => {
  const child = await spawnProcess(node, {
    args: ['-e', `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'hello',params:{last:true}})+'\\n'); process.exit(0)`],
  });
  const peer = new RpcPeer(ndjson(child.channel));
  let got: unknown;
  peer.onNotification('hello', (p) => (got = p)).start();
  await child.ended;
  await peer.closed;
  assert.deepEqual(got, { last: true });
});

test('stop() then closing the channel does not throw (Node 22 Writable.toWeb() bug)', async () => {
  // On Node 22, Writable.toWeb() threw an uncaught TypeError when its stream was closed
  // after the Node stream had already been ended, as stop() does.
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => void uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    for (let i = 0; i < 5; i++) {
      const child = await spawnProcess(node, { args: ['-e', 'setTimeout(() => {}, 5000)'], killGraceMs: 200 });
      const writer = child.channel.writable.getWriter();
      const stopping = child.stop();
      await writer.close().catch(() => {});
      await stopping;
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught, []);
});

test('writing to a process that died rejects the write', async () => {
  const child = await spawnProcess(node, { args: ['-e', 'process.exit(1)'] });
  await child.exited;
  const writer = child.channel.writable.getWriter();
  const big = new Uint8Array(1024 * 1024);
  await assert.rejects(async () => {
    for (let i = 0; i < 8; i++) await writer.write(big);
  });
});

test('stop() ends the whole process group, even a child that ignores SIGTERM', async () => {
  // The leader starts a grandchild that ignores SIGTERM, like `npx some-agent`.
  // Both ignore SIGTERM before they report ready, so a quick stop() can't catch one without its handler.
  const script = `
    process.on('SIGTERM', () => {});
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    g.stdout.once('data', () => process.stdout.write(String(g.pid) + '\\n'));
    setInterval(() => {}, 1000);
  `;
  const child = await spawnProcess(node, { args: ['-e', script], killGraceMs: 300 });
  const reader = child.channel.readable.getReader();
  const { value } = await reader.read();
  const grandchild = Number(new TextDecoder().decode(value).trim());
  reader.releaseLock();
  assert.ok(grandchild > 0);

  const started = Date.now();
  const info = await child.stop();
  assert.equal(info.signal, 'SIGKILL');
  assert.ok(Date.now() - started < 3000);
  // A killed process lingers until it is reaped, longer on a busy machine: poll.
  const gone = async () => {
    for (let waited = 0; waited < 2000; waited += 20) {
      try {
        process.kill(grandchild, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  assert.ok(await gone(), 'grandchild is gone');
});

test('keeps the last stderr output for error messages', async () => {
  const child = await spawnProcess(node, {
    args: ['-e', `console.error('x'.repeat(100)); console.error('fatal: no API key'); process.exit(3)`],
    stderrTailBytes: 64,
  });
  const info = await child.ended;
  assert.equal(info.code, 3);
  assert.match(child.stderrTail(), /fatal: no API key$/);
  assert.ok(child.stderrTail().length <= 64);
});

test('the stderr tail counts bytes', async () => {
  const child = await spawnProcess(node, {
    args: ['-e', `process.stderr.write('\u00e9'.repeat(100) + '\\nend'); process.exit(0)`],
    stderrTailBytes: 63,
  });
  await child.ended;
  const tail = child.stderrTail();
  assert.match(tail, /end$/);
  assert.ok(Buffer.byteLength(tail) <= 63, `${Buffer.byteLength(tail)} bytes`);
  assert.ok(!tail.includes('\ufffd'), 'a character cut in half is dropped, not shown as garbage');
});

const posix = process.platform !== 'win32';
const kernelDir = new URL('..', import.meta.url);

/** Run a Node program that imports the kernel; returns it and the first line it prints. */
async function runApp(source: string): Promise<{ app: ChildProcess; line: string; lines: AsyncIterator<string> }> {
  const app = spawnChild(node, ['--conditions=subspace-source', '--input-type=module', '-e', source], {
    cwd: kernelDir,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: app.stdout! })[Symbol.asyncIterator]();
  const first = await lines.next();
  return { app, line: String(first.value), lines };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

// Starts a supervised child (which starts a grandchild), prints both pids, and waits.
const supervisor = (setup: string) => `
  import { spawnProcess } from '@deft-subspace/kernel/node';
  ${setup}
  const child = await spawnProcess(process.execPath, { args: ['-e', \`
    const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    console.log(g.pid);
    setTimeout(() => {}, 60000);
  \`] });
  const reader = child.channel.readable.getReader();
  const grandchild = new TextDecoder().decode((await reader.read()).value).trim();
  console.log(child.pid, grandchild);
  setTimeout(() => {}, 60000);
`;

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
  test(`${signal} stops the supervised groups and still kills the app`, { skip: !posix }, async () => {
    const { app, line } = await runApp(supervisor(''));
    const pids = line.split(' ').map(Number);
    try {
      const exited = new Promise<NodeJS.Signals | null>((resolve) => app.once('exit', (_code, sig) => resolve(sig)));
      app.kill(signal);
      assert.equal(await exited, signal);
      for (const pid of pids) assert.ok(await gone(pid), `${pid} outlived the app`);
    } finally {
      killAll([app.pid!, ...pids]);
    }
  });
}

test("an app's own signal handler is left alone", { skip: !posix }, async () => {
  const { app, line, lines } = await runApp(supervisor(`process.on('SIGTERM', () => console.log('handled'));`));
  const pids = line.split(' ').map(Number);
  try {
    app.kill('SIGTERM');
    assert.equal((await lines.next()).value, 'handled');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(app.exitCode, null);
    assert.equal(app.signalCode, null);
    for (const pid of pids) assert.ok(alive(pid), `${pid} was killed`);
  } finally {
    killAll([app.pid!, ...pids]);
  }
});

test('a group is forgotten once its last member is gone', { skip: !posix }, async () => {
  // The leader exits at once; a grandchild keeps the group alive a little longer. The
  // signal hook is there only while some group is remembered, so it shows when it is dropped.
  const { app, line, lines } = await runApp(`
    import { spawnProcess } from '@deft-subspace/kernel/node';
    const child = await spawnProcess(process.execPath, { args: ['-e', \`
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { stdio: 'ignore' }).unref();
    \`] });
    await child.ended;
    console.log(process.listenerCount('SIGTERM'));
    const deadline = Date.now() + 5000;
    while (process.listenerCount('SIGTERM') > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    console.log(process.listenerCount('SIGTERM'));
  `);
  try {
    assert.equal(line, '1', 'remembered while the grandchild runs');
    assert.equal((await lines.next()).value, '0', 'forgotten once it is gone');
  } finally {
    killAll([app.pid!]);
  }
});

// Windows command resolution runs anywhere: the environment and the file system are passed in.
const winEnv = { Path: 'C:\\bin;C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const files =
  (...paths: string[]) =>
  (path: string) =>
    paths.some((p) => p.toLowerCase() === path.toLowerCase());

test('Windows: a .cmd shim found through PATHEXT runs via cmd.exe', () => {
  const launch = windowsLaunch('npx', ['-y', 'some agent'], winEnv, files('C:\\nodejs\\npx.cmd'));
  assert.equal(launch, '"C:\\nodejs\\npx.CMD" -y "some agent"');
  assert.deepEqual(cmdExeArgs(launch!), ['/d', '/e:ON', '/v:OFF', '/s', '/c', `"${launch}"`]);
});

test('Windows: an .exe, or a command not found, runs as given', () => {
  assert.equal(windowsLaunch('node', ['x'], winEnv, files('C:\\nodejs\\node.exe', 'C:\\nodejs\\node.cmd')), undefined);
  assert.equal(windowsLaunch('missing', [], winEnv, files()), undefined);
});

test('Windows: PATH order, then PATHEXT order', () => {
  assert.equal(windowsFind('tool', winEnv, files('C:\\nodejs\\tool.exe', 'C:\\bin\\tool.cmd')), 'C:\\bin\\tool.CMD');
  assert.equal(windowsFind('tool', winEnv, files('C:\\bin\\tool.cmd', 'C:\\bin\\tool.exe')), 'C:\\bin\\tool.EXE');
  assert.equal(windowsFind('tool.cmd', winEnv, files('C:\\nodejs\\tool.cmd')), 'C:\\nodejs\\tool.cmd');
  assert.equal(windowsFind('D:\\x\\run', winEnv, files('D:\\x\\run.bat')), 'D:\\x\\run.BAT');
  assert.equal(windowsFind('./run', winEnv, files('./run.cmd', 'C:\\bin\\run.cmd')), './run.CMD');
  assert.equal(windowsFind('tool', { PATH: 'C:\\bin' }, files('C:\\bin\\tool.cmd')), 'C:\\bin\\tool.CMD'); // default PATHEXT
});

test('Windows: cmd.exe metacharacters in arguments are quoted', () => {
  assert.equal(
    cmdLine('C:\\Program Files\\nodejs\\npx.cmd', ['a&b|c"d', '100%', 'end\\', '', 'plain-1.0/x:y@z', 'a\\"b']),
    '"C:\\Program Files\\nodejs\\npx.cmd" "a&b|c""d" "100%%cd:~,%" "end\\\\" "" plain-1.0/x:y@z "a\\\\""b"',
  );
});

/**
 * How cmd.exe reads a line, as far as quoting goes: the metacharacters it would act on
 * (outside quotes, not ^-escaped), and the line as it hands it on (escaping carets gone).
 */
function cmdRead(line: string): { meta: string; next: string } {
  let quoted = false;
  let meta = '';
  let next = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '^') {
      next += line[++i] ?? '';
      continue;
    } else if (!quoted && '&|<>()'.includes(c)) meta += c;
    next += c;
  }
  return { meta, next };
}

test('Windows: no argument escapes the quoting, wherever the shim is (BatBadBut)', () => {
  // A shim like C:\Program Files\nodejs\npx.cmd or %APPDATA%\npm\agent.cmd hands %* to
  // cmd.exe a second time, so the arguments must stay inert when read again, not only once.
  const attacks = ['a"&calc&"b', '"&calc', 'x\\"&calc&\\"', '"^&calc', '""&calc&""', 'a" | calc | "b', ')&calc&(', '^"&calc'];
  for (const script of ['C:\\Program Files\\nodejs\\npx.cmd', 'C:\\Users\\u\\AppData\\Roaming\\npm\\agent.cmd', 'C:\\p\\node_modules\\.bin\\agent.cmd']) {
    for (const attack of attacks) {
      const line = cmdLine(script, ['-y', attack]);
      const first = cmdRead(line);
      const second = cmdRead(first.next);
      assert.equal(first.meta + second.meta, '', `${attack} through ${script}: ${line}`);
    }
  }
});

test('Windows: an argument with CR, LF or NUL is refused for a .cmd file', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\0b']) {
    assert.throws(
      () => windowsLaunch('npx', ['-y', bad], winEnv, files('C:\\nodejs\\npx.cmd')),
      (e) => e instanceof SpawnError && e.code === 'EINVAL' && e.command === 'npx',
    );
  }
  // Not for a program that runs as given: it gets its arguments without cmd.exe.
  assert.equal(windowsLaunch('node', ['a\nb'], winEnv, files('C:\\nodejs\\node.exe')), undefined);
});

test('the not-found hint names .cmd shims on Windows', () => {
  assert.match(notFoundHint('npx', undefined, true), /\.cmd shims/);
  assert.doesNotMatch(notFoundHint('npx', undefined, false), /\.cmd/);
});
