/**
 * create-subspace: start a Subspace project.
 *
 *   npm create subspace@latest my-app                       # asks nothing: the script template
 *   npm create subspace@latest my-agent -- --template agent
 *   pnpm dlx create-subspace my-agent --template claude-agent --subspace ../subspace   # link a local checkout (pnpm only)
 *
 * Templates:
 *   script        a program that uses an agent (start() + terminal())
 *   agent         an ACP agent of your own (serveStdio() + turn.tool())
 *   claude-agent  an ACP agent backed by Claude (modelAgent() + claude())
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Where npm_config_user_agent is read from. Default process.env. */
  env?: Record<string, string | undefined>;
}
const defaultIo: Io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) };

export const TEMPLATES = ['script', 'agent', 'claude-agent'] as const;
export type Template = (typeof TEMPLATES)[number];

const VERSION = '0.0.0-experiment';

const SCRIPT = `/**
 * Use an agent from a script: npm start -- "What does this project do?"
 * Change the agent (claude, codex, grok, gemini, opencode) and the permission rules below.
 */
import { askInTerminal, firstOf, readOnly, start, terminal } from '@deft-subspace/acp/node';

const prompt = process.argv.slice(2).join(' ') || 'What does this project do? Two sentences.';

const agent = await start('claude', {
  ...terminal(), // streamed text, tool calls, permission answers
  onPermission: firstOf(readOnly, askInTerminal()), // reads yes; ask about the rest
});
try {
  await agent.run(prompt);
  console.log();
} finally {
  await agent.close();
}
`;

const AGENT = `/**
 * An ACP agent of your own. Any ACP client can start it:
 *   npx subspace run "tidy up" -- node src/agent.ts
 * or an editor (see README.md).
 */
import { readdir, rm } from 'node:fs/promises';
import { serveStdio } from '@deft-subspace/acp/node';

serveStdio({
  name: '__NAME__',
  version: '0.1.0',
  async prompt(turn) {
    const files = await turn.tool({ title: 'List files', kind: 'read' }, () => readdir('.'));
    const logs = files.filter((f) => f.endsWith('.log'));
    if (!logs.length) {
      await turn.say('Nothing to tidy.');
      return;
    }
    // ask: the user is asked first; a refusal ends the turn normally.
    await turn.tool({ title: \`Delete \${logs.length} log files\`, kind: 'delete', ask: true }, async (call) => {
      for (const log of logs) if (!call.signal.aborted) await rm(log);
    });
    await turn.say(\`Deleted \${logs.length} log files.\`);
  },
});
`;

const CLAUDE_AGENT = `/**
 * An ACP agent backed by Claude, with tools. Needs Claude API credentials
 * (ANTHROPIC_API_KEY, or \`ant auth login\`). Try it:
 *   npx subspace run "What is in src?" -- node src/agent.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { modelAgent, tool } from '@deft-subspace/acp';
import { serveStdio } from '@deft-subspace/acp/node';
import { claude } from '@deft-subspace/claude';

const path = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

// The tools stay inside the folder the agent was started in.
const root = process.cwd();
function inside(path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === '..' || rel.startsWith(\`..\${sep}\`) || isAbsolute(rel)) throw new Error(\`\${path} is outside \${root}\`);
  return full;
}

serveStdio(
  modelAgent({
    name: '__NAME__',
    model: claude(), // Claude Opus 5.5, adaptive thinking, refusal fallbacks on
    system: ({ cwd }) => \`You help with the project in \${cwd}. Look before you answer. Be brief.\`,
    tools: {
      listFiles: tool({ description: 'List a folder', input: path, kind: 'read', run: ({ path }: { path: string }) => readdir(inside(path)) }),
      readText: tool({ description: 'Read a text file', input: path, kind: 'read', run: ({ path }: { path: string }) => readFile(inside(path), 'utf8') }),
    },
  })
);
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "ESNext.Disposable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
`;

function readme(name: string, template: Template, linked: boolean): string {
  const run =
    template === 'script'
      ? '```sh\nnpm start -- "What does this project do?"\n```'
      : '```sh\nnpx subspace run "hello" -- node src/agent.ts\n```\n\nTo use it from an editor that speaks ACP, register `node /absolute/path/to/' +
        name +
        '/src/agent.ts` as an agent server (in Zed, under `agent_servers` in settings; see your editor\'s documentation for the exact format).';
  return `# ${name}

A [Subspace](https://github.com/deftai/subspace) ${template === 'script' ? 'script that uses an ACP agent' : template === 'agent' ? 'ACP agent' : 'ACP agent backed by Claude'}.

${run}

Node 22.19 or later runs the TypeScript directly.${
    linked ? '\n\nThe Subspace packages are linked from a local checkout; run `pnpm run build` there after pulling.' : ''
  }
`;
}

/** A valid npm package name from a folder name; `subspace-project` if nothing is left. */
function packageName(dir: string): string {
  return (
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'subspace-project'
  );
}

/** A path as a shell would need it typed. */
function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The files of a new project, by path. */
export function files(name: string, template: Template, subspace?: { root: string; from: string }): Record<string, string> {
  // Absolute: relative links break where the project's path goes through a symbolic link (macOS /var).
  const spec = (pkg: string) => (subspace ? `link:${join(subspace.root, 'packages', pkg)}` : VERSION);
  const dependencies: Record<string, string> = { '@deft-subspace/acp': spec('acp') };
  if (template === 'claude-agent') dependencies['@deft-subspace/claude'] = spec('claude');
  const devDependencies: Record<string, string> = { '@deft-subspace/cli': spec('cli'), '@types/node': '^22.19.0', typescript: '^5.9.3' };
  const main = template === 'script' ? 'src/index.ts' : 'src/agent.ts';
  const pkg = {
    name: packageName(name),
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=22.19' },
    scripts: { start: `node ${main}`, typecheck: 'tsc' },
    dependencies,
    devDependencies,
  };
  const source = template === 'script' ? SCRIPT : (template === 'agent' ? AGENT : CLAUDE_AGENT).replaceAll('__NAME__', pkg.name);
  return {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'tsconfig.json': TSCONFIG,
    [main]: source,
    'README.md': readme(basename(name), template, !!subspace),
    '.gitignore': 'node_modules/\n',
  };
}

const FLAGS = ['--template', '-t', '--subspace', '--help', '-h'];

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let dir: string | undefined;
  let template: Template = 'script';
  let subspace: string | undefined;
  const usage = `Usage: create-subspace <dir> [--template ${TEMPLATES.join('|')}] [--subspace <checkout>]\n`;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inline: string | undefined;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) [arg, inline] = [arg.slice(0, eq), arg.slice(eq + 1)];
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) return undefined;
      i++;
      return next;
    };
    if (arg === '--template' || arg === '-t' || arg === '--subspace') {
      const v = value();
      if (v === undefined) {
        io.err(`${arg} needs a value.\n${usage}`);
        return 2;
      }
      if (arg === '--subspace') subspace = v;
      else template = v as Template;
    } else if (arg === '--help' || arg === '-h') {
      io.out(usage);
      return 0;
    } else if (arg.startsWith('-') && arg !== '-') {
      const near = FLAGS.find((f) => f.startsWith('--') && (f.startsWith(arg) || arg.startsWith(f.slice(0, 5))));
      io.err(`Unknown option ${arg}.${near ? ` Did you mean ${near}?` : ''}\n${usage}`);
      return 2;
    } else if (!dir) dir = arg;
    else {
      io.err(`One folder only (got ${dir} and ${arg}).\n${usage}`);
      return 2;
    }
  }
  if (!dir) {
    io.err(`Where? create-subspace <dir> [--template ${TEMPLATES.join('|')}]\n`);
    return 2;
  }
  if (!TEMPLATES.includes(template)) {
    io.err(`No template "${template}". Templates: ${TEMPLATES.join(', ')}.\n`);
    return 2;
  }
  const target = resolve(dir);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) {
      io.err(`${dir} is not a folder; pick a new folder.\n`);
      return 1;
    }
    if (readdirSync(target).length) {
      io.err(`${dir} is not empty; pick a new folder.\n`);
      return 1;
    }
  }
  const checkout = subspace ? resolve(subspace) : undefined;
  if (checkout && !existsSync(join(checkout, 'packages', 'acp', 'package.json'))) {
    io.err(`${subspace} does not look like a Subspace checkout (no packages/acp).\n`);
    return 1;
  }
  for (const [path, text] of Object.entries(files(dir, template, checkout ? { root: checkout, from: target } : undefined))) {
    const full = join(target, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  // Linked packages use link: and workspace:* specifiers, which only pnpm installs.
  const pm = checkout ? 'pnpm' : 'npm';
  const runAgent = checkout ? 'pnpm exec subspace run "hello" -- node src/agent.ts' : 'npx subspace run "hello" -- node src/agent.ts';
  io.out(
    `Created ${dir} (${template}).\n\n  cd ${shellQuote(dir)}\n  ${pm} install\n  ${template === 'script' ? `${pm} start` : runAgent}\n` +
      (checkout ? '' : `\n(The @deft-subspace packages are not on npm yet: until they are, pass --subspace <path to a checkout>.)\n`)
  );
  const agent = (io.env ?? process.env).npm_config_user_agent ?? '';
  if (checkout && agent.startsWith('npm/'))
    io.err(`\nNote: npm cannot install the linked packages (link: dependencies to a pnpm workspace). Use pnpm (https://pnpm.io) in ${dir}.\n`);
  return 0;
}
