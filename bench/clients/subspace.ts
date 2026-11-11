// The benchmark client on Subspace (TypeScript).
import { AcpClient } from '@deft-subspace/acp';
import { ndjson } from '@deft-subspace/kernel';
import { spawnProcess } from '@deft-subspace/kernel/node';
import { parseArgs, run } from './common.ts';

const args = parseArgs();
await run(args, async () => {
  const [command, ...rest] = args.agent;
  const child = await spawnProcess(command!, { args: rest });
  const client = await AcpClient.connect(ndjson(child.channel), { name: 'bench', permissions: 'allow', protocol: process.env.BENCH_PROTOCOL === '2' ? 2 : 1 });
  const sessions = new Map<string, Awaited<ReturnType<AcpClient['newSession']>>>();
  return {
    async newSession() {
      const session = await client.newSession({ cwd: process.cwd() });
      sessions.set(session.id, session);
      return session.id;
    },
    async prompt(id, text) {
      return (await sessions.get(id)!.prompt(text).done).text;
    },
    async close() {
      await client.close();
      await child.ended;
    },
  };
});
