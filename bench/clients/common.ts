// What every TypeScript benchmark client shares: arguments, timing and the result line.
export type Args = { scenario: string; n: number; size: number; agent: string[] };

export function parseArgs(argv = process.argv.slice(2)): Args {
  const split = argv.indexOf('--');
  const [scenario = 'turns', n = '1000', size = '100'] = argv.slice(0, split);
  return { scenario, n: Number(n), size: Number(size), agent: argv.slice(split + 1) };
}

export const now = () => performance.now();

export function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
}

/** One driver per library: open a session, run one prompt to its end and return the text it streamed. */
export interface Driver {
  newSession(): Promise<string>;
  prompt(session: string, text: string): Promise<string>;
  close(): Promise<void>;
}

export async function run(args: Args, connect: () => Promise<Driver>): Promise<void> {
  const t0 = now();
  const driver = await connect();
  const session = await driver.newSession();
  await driver.prompt(session, 'noop');
  const startupMs = now() - t0;
  const out: Record<string, unknown> = { scenario: args.scenario, startupMs };
  const warm = async (text: string, times: number) => {
    for (let i = 0; i < times; i++) await driver.prompt(session, text);
  };
  if (args.scenario === 'turns') {
    await warm('noop', 100);
    const lat: number[] = [];
    const start = now();
    for (let i = 0; i < args.n; i++) {
      const t = now();
      await driver.prompt(session, 'noop');
      lat.push(now() - t);
    }
    out.ms = now() - start;
    lat.sort((a, b) => a - b);
    Object.assign(out, { ops: args.n, p50: percentile(lat, 50), p99: percentile(lat, 99) });
  } else if (args.scenario === 'stream') {
    await warm(`stream 200 ${Math.min(args.size, 1000)}`, 3);
    const start = now();
    const text = await driver.prompt(session, `stream ${args.n} ${args.size}`);
    out.ms = now() - start;
    if (text.length !== args.n * args.size) throw new Error(`got ${text.length} characters, expected ${args.n * args.size}`);
    Object.assign(out, { ops: args.n, bytes: args.n * args.size });
  } else if (args.scenario === 'ask') {
    await warm('ask 50', 2);
    const start = now();
    await driver.prompt(session, `ask ${args.n}`);
    out.ms = now() - start;
    out.ops = args.n;
  } else if (args.scenario === 'concurrent') {
    // n sessions, each running `size` turns, all at once.
    await warm('noop', 100);
    const sessions = await Promise.all(Array.from({ length: args.n }, () => driver.newSession()));
    const start = now();
    await Promise.all(sessions.map(async (s) => {
      for (let i = 0; i < args.size; i++) await driver.prompt(s, 'noop');
    }));
    out.ms = now() - start;
    out.ops = args.n * args.size;
  } else if (args.scenario !== 'startup') {
    throw new Error(`unknown scenario ${args.scenario}`);
  }
  out.clientRss = process.resourceUsage().maxRSS * 1024;
  await driver.close();
  process.stdout.write(JSON.stringify(out) + '\n');
}
