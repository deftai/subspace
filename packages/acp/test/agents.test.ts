import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinCatalog, listAgents, resolveAgent, type Registry } from '@deft-subspace/acp';
import { AgentFileError, agentFiles, agentFilesAsync, loadCatalog, loadCatalogAsync, parseAgentFile, refreshRegistry, start } from '@deft-subspace/acp/node';

const registry: Registry = {
  version: '1.0.0',
  agents: [
    { id: 'claude-acp', name: 'Claude Agent', version: '9.9.9', description: 'from the registry', distribution: { npx: { package: '@x/claude-acp@9.9.9' } } },
    { id: 'tool-bin', name: 'Tool', version: '1.0.0', description: 'a binary', distribution: { binary: { 'darwin-aarch64': { archive: 'https://e/x.zip', cmd: './bin/tool', args: ['acp'] }, 'linux-x86_64': { archive: 'https://e/y.zip', cmd: './tool', args: ['acp', '--linux'] } } } },
    { id: 'py', name: 'Py', version: '2', description: 'uvx', distribution: { uvx: { package: 'py-acp==2', args: ['-x'] } } },
  ],
};
const host = { platform: 'darwin', arch: 'arm64' };

test('built-ins take launch details from the registry and settings from their quirks', () => {
  const catalog = builtinCatalog(registry);
  const claude = resolveAgent(catalog, 'claude', host)!;
  assert.equal(claude.command, 'npx');
  assert.deepEqual(claude.args, ['-y', '@x/claude-acp@9.9.9']);
  assert.equal(claude.version, '9.9.9');
  assert.equal(claude.mode, 'default'); // from the starts-in-auto-mode quirk
  assert.deepEqual(claude.sources, ['registry', 'built-in']);
  assert.equal(resolveAgent(catalog, 'claude-code', host)?.id, 'claude'); // an alias
  // grok has a command of its own: the registry's arguments do not apply.
  const grok = resolveAgent(catalog, 'grok', host)!;
  assert.deepEqual([grok.command, ...grok.args], ['grok', '--permission-mode', 'default', 'agent', 'stdio']);
  assert.equal(grok.launch, 'command');
  assert.equal(grok.waivers['session.unknown'], grok.quirks['unknown-session-32602']!.summary);
});

test('registry ids resolve: npx, uvx, and binaries for this platform (expected on PATH)', () => {
  const catalog = builtinCatalog(registry);
  const bin = resolveAgent(catalog, 'tool-bin', host)!;
  assert.deepEqual([bin.command, ...bin.args], ['tool', 'acp']);
  assert.match(bin.install!, /https:\/\/e\/x\.zip/);
  assert.deepEqual(resolveAgent(catalog, 'tool-bin', { platform: 'linux', arch: 'x64' })!.args, ['acp', '--linux']);
  const py = resolveAgent(catalog, 'py', host)!;
  assert.deepEqual([py.command, ...py.args], ['uvx', 'py-acp==2', '-x']);
  assert.equal(resolveAgent(catalog, 'nope', host), undefined);
  // Not in this registry: a built-in falls back to its own command.
  const codex = resolveAgent(catalog, 'codex', host)!;
  assert.deepEqual([codex.command, ...codex.args, codex.mode], ['npx', '-y', '@agentclientprotocol/codex-acp', 'read-only']);
  assert.deepEqual(codex.sources, ['built-in']);
  // Listing: the defined agents first, then the registry's unclaimed ones (claude-acp is claimed by claude).
  const ids = listAgents(catalog).map((a) => a.id);
  assert.ok(ids.indexOf('claude') < ids.indexOf('tool-bin'));
  assert.ok(!ids.includes('claude-acp'));
});

test('files override field by field, add agents and quirks, and can turn quirks and agents off', () => {
  const catalog = builtinCatalog(registry);
  catalog.layers.push(
    parseAgentFile(
      `
[agents.claude]
extra_args = ["--verbose"]
env = { DEBUG = "1" }
[agents.claude.quirks.starts-in-auto-mode]
enabled = false
[agents.claude.quirks.mine]
summary = "Something we saw"
waives = ["prompt.cancel"]
apply = { args = ["--safe"], env = { SAFE = "1" } }

[agents.mine]
command = "node"
args = ["/a/agent.js"]
mode = false

[agents.gemini]
enabled = false
`,
      'user.toml'
    ),
    parseAgentFile('[agents.claude]\nmode = "plan"\n', 'project.toml')
  );
  const claude = resolveAgent(catalog, 'claude', host)!;
  assert.deepEqual(claude.args, ['-y', '@x/claude-acp@9.9.9', '--safe', '--verbose']);
  assert.deepEqual(claude.env, { SAFE: '1', DEBUG: '1' });
  assert.equal(claude.mode, 'plan'); // the project file's own field wins
  assert.ok(!claude.quirks['starts-in-auto-mode']);
  assert.equal(claude.waivers['prompt.cancel'], 'Something we saw');
  assert.deepEqual(claude.sources, ['registry', 'built-in', 'user.toml', 'project.toml']);
  const mine = resolveAgent(catalog, 'mine', host)!;
  assert.deepEqual([mine.command, ...mine.args, mine.mode], ['node', '/a/agent.js', undefined]);
  assert.equal(resolveAgent(catalog, 'gemini', host), undefined);
});

test('bad files say where and what', () => {
  const bad = (text: string, pattern: RegExp) => assert.throws(() => parseAgentFile(text, 'x.toml'), (e: Error) => e instanceof AgentFileError && pattern.test(e.message));
  bad('[agents.a]\ncomand = "x"', /x\.toml: agents\.a\.comand is not a known field \(known: .*command/);
  bad('[agents.a]\nargs = "x"', /agents\.a\.args should be a list of strings/);
  bad('[agents.a.quirks.q]\nsumary = "x"', /agents\.a\.quirks\.q\.sumary is not a known field/);
  bad('[agents.a.quirks.q]\napply = { mood = "x" }', /apply\.mood is not a known field/);
  bad('[agents\n', /x\.toml: /);
  assert.deepEqual(parseAgentFile('[other]\nx = 1\n', 'x.toml').agents, {}); // other tables are not ours
});

/** A user config and a project with a subspace.toml that redefines claude. */
async function untrustedProject() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'subspace-trust-')));
  const config = join(root, 'config');
  const project = join(root, 'project');
  await mkdir(join(config, 'subspace'), { recursive: true });
  await mkdir(join(project, 'sub'), { recursive: true });
  await writeFile(join(project, 'subspace.toml'), '[agents.claude]\ncommand = "planted"\n');
  await writeFile(join(root, 'extra.toml'), '[agents.extra]\ncommand = "extra"\n');
  const userFile = join(config, 'subspace', 'agents.toml');
  const trust = (...folders: string[]) => writeFile(userFile, `[agents.mine]\ncommand = "mine"\n\n[trust]\nfolders = [${folders.map((f) => JSON.stringify(f)).join(', ')}]\n`);
  const env = { XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, 'cache'), SUBSPACE_AGENTS: join(root, 'extra.toml') };
  const load = async (cwd: string, more: Record<string, unknown> = {}) => {
    const warnings: string[] = [];
    const catalog = loadCatalog({ cwd, env, onWarning: (m) => warnings.push(m), ...more });
    const viaAsync = await loadCatalogAsync({ cwd, env, onWarning: () => {}, ...more });
    assert.deepEqual(viaAsync.layers, catalog.layers);
    assert.deepEqual(await agentFilesAsync({ cwd, env, ...more }), agentFiles({ cwd, env, ...more }));
    return { sources: catalog.layers.map((l) => l.source), claude: resolveAgent(catalog, 'claude')!.command, catalog, warnings };
  };
  return { root, config, project, userFile, trust, env, load };
}

test('an untrusted subspace.toml is skipped with a warning; your agents.toml and $SUBSPACE_AGENTS still load', async () => {
  const { root, project, userFile, trust, env, load } = await untrustedProject();
  await trust();
  const got = await load(project);
  assert.deepEqual(got.sources, ['built-in', userFile, join(root, 'extra.toml')]);
  assert.notEqual(got.claude, 'planted');
  assert.ok(resolveAgent(got.catalog, 'mine') && resolveAgent(got.catalog, 'extra'));
  assert.deepEqual(got.warnings, [
    `subspace: skipped ${join(project, 'subspace.toml')}: its folder is not trusted, and a subspace.toml can choose the commands agents run.\n` +
      `To trust this folder (only this one, not the folders below it), add it to [trust] folders in ${userFile}:\n\n` +
      `  [trust]\n  folders = [${JSON.stringify(project)}]\n`,
  ]);
  assert.deepEqual(agentFiles({ cwd: project, env }).map((f) => f.trusted), [true, false, true]);
  // With no agents.toml at all, the same.
  const bare = { ...env, XDG_CONFIG_HOME: join(root, 'nowhere') };
  assert.equal(resolveAgent(loadCatalog({ cwd: project, env: bare, onWarning: () => {} }), 'claude')!.command === 'planted', false);
  // trustProject reads it for one call; so does naming it in $SUBSPACE_AGENTS or files.
  assert.equal((await load(project, { trustProject: true })).claude, 'planted');
  const named = await load(project, { files: [join(project, 'subspace.toml')] });
  assert.equal(named.claude, 'planted');
  assert.deepEqual(named.warnings, []);
});

test('the default warning goes to stderr, once per file', async () => {
  const { project, env } = await untrustedProject();
  const write = process.stderr.write;
  let err = '';
  process.stderr.write = ((chunk: string) => ((err += chunk), true)) as typeof process.stderr.write;
  try {
    loadCatalog({ cwd: project, env });
    await loadCatalogAsync({ cwd: project, env });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(err.match(/its folder is not trusted/g)?.length, 1);
});

test('a trusted folder: its subspace.toml loads; a subfolder of it is not trusted; symlinks resolve', async () => {
  const { root, project, userFile, trust, load } = await untrustedProject();
  await trust(project);
  const trusted = await load(join(project));
  assert.deepEqual(trusted.sources, ['built-in', userFile, join(project, 'subspace.toml'), join(root, 'extra.toml')]);
  assert.equal(trusted.claude, 'planted');
  assert.deepEqual(trusted.warnings, []);
  // From a subfolder the nearest subspace.toml is still the trusted folder's.
  assert.equal((await load(join(project, 'sub'))).claude, 'planted');
  // A subfolder's own subspace.toml is not trusted by its parent's entry.
  await writeFile(join(project, 'sub', 'subspace.toml'), '[agents.claude]\ncommand = "deeper"\n');
  const sub = await load(join(project, 'sub'));
  assert.notEqual(sub.claude, 'deeper');
  assert.equal(sub.warnings.length, 1);
  assert.match(sub.warnings[0]!, /skipped .*sub.subspace\.toml/);
  // A trailing slash is the same folder.
  await trust(`${project}/`);
  assert.equal((await load(project)).claude, 'planted');
  // A symlink to the project, trusted by its real path, and the real project trusted through a symlink.
  const link = join(root, 'link');
  await symlink(project, link, process.platform === 'win32' ? 'junction' : 'dir');
  await trust(project);
  assert.equal((await load(link)).claude, 'planted');
  await trust(link);
  assert.equal((await load(project)).claude, 'planted');
  // Relative paths and other [trust] keys are errors in agents.toml.
  await writeFile(userFile, '[trust]\nfolders = ["project"]\n');
  assert.throws(() => loadCatalog({ cwd: project, env: { XDG_CONFIG_HOME: join(root, 'config') } }), /trust\.folders should hold absolute paths or ~\/ paths, not "project"/);
  await writeFile(userFile, '[trust]\nfolder = ["/x"]\n');
  await assert.rejects(loadCatalogAsync({ cwd: project, env: { XDG_CONFIG_HOME: join(root, 'config') } }), /trust\.folder is not a known field \(known: folders\)/);
});

test('~/ in [trust] folders is your home folder', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'subspace-home-')));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    await mkdir(join(home, 'config', 'subspace'), { recursive: true });
    await mkdir(join(home, 'work', 'p'), { recursive: true });
    await writeFile(join(home, 'work', 'p', 'subspace.toml'), '[agents.claude]\ncommand = "mine"\n');
    await writeFile(join(home, 'config', 'subspace', 'agents.toml'), '[trust]\nfolders = ["~/work/p"]\n');
    const catalog = loadCatalog({ cwd: join(home, 'work', 'p'), env: { XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') }, onWarning: assert.fail });
    assert.equal(resolveAgent(catalog, 'claude')!.command, 'mine');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('loadCatalog reads agents.toml, the nearest subspace.toml, $SUBSPACE_AGENTS; the registry cache wins when newer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subspace-catalog-'));
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  const project = join(root, 'project');
  await mkdir(join(config, 'subspace'), { recursive: true });
  await mkdir(join(project, 'deep', 'er'), { recursive: true });
  await writeFile(join(config, 'subspace', 'agents.toml'), `[agents.one]\ncommand = "one"\n\n[trust]\nfolders = [${JSON.stringify(project)}]\n`);
  await writeFile(join(project, 'subspace.toml'), '[agents.two]\ncommand = "two"\n');
  await writeFile(join(root, 'extra.toml'), '[agents.three]\ncommand = "three"\n');
  const env = { XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, SUBSPACE_AGENTS: join(root, 'extra.toml') };
  const catalog = loadCatalog({ cwd: join(project, 'deep', 'er'), env });
  assert.deepEqual(catalog.layers.map((l) => l.source), ['built-in', join(config, 'subspace', 'agents.toml'), join(project, 'subspace.toml'), join(root, 'extra.toml')]);
  for (const name of ['one', 'two', 'three']) assert.ok(resolveAgent(catalog, name), name);
  assert.ok(agentFiles({ cwd: root, env }).some((f) => f.path.endsWith('agents.toml') && f.exists));
  assert.throws(() => loadCatalog({ env, files: [join(root, 'missing.toml')] }), /no such file/);
  assert.match(catalog.registrySource, /bundled snapshot/);
  // The async loader reads the same catalog without blocking.
  const viaAsync = await loadCatalogAsync({ cwd: join(project, 'deep', 'er'), env });
  assert.deepEqual(viaAsync.layers, catalog.layers);
  assert.deepEqual(viaAsync.registrySource, catalog.registrySource);
  assert.deepEqual(await agentFilesAsync({ cwd: join(project, 'deep', 'er'), env }), agentFiles({ cwd: join(project, 'deep', 'er'), env }));
  await assert.rejects(loadCatalogAsync({ env, files: [join(root, 'missing.toml')] }), /no such file/);

  const fake = (async () => new Response(JSON.stringify(registry))) as typeof fetch;
  const fetched = await refreshRegistry({ env, fetch: fake });
  assert.equal(fetched.agents, 3);
  const refreshed = loadCatalog({ env, builtinOnly: true });
  assert.match(refreshed.registrySource, /registry\.json/);
  assert.equal((await loadCatalogAsync({ env, builtinOnly: true })).registrySource, refreshed.registrySource);
  assert.equal(resolveAgent(refreshed, 'claude')!.version, '9.9.9');
  await assert.rejects(refreshRegistry({ env, fetch: (async () => new Response('{"agents":[]}')) as typeof fetch }), /no agents/);
});

test('start() by a name from a file, with its quirk settings; unknown names list the known ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subspace-start-'));
  const fixture = new URL('./fixtures/echo-agent.ts', import.meta.url).pathname;
  const catalog = builtinCatalog(registry);
  catalog.layers.push(
    parseAgentFile(`[agents.echo]\ncommand = "node"\nargs = ["--conditions=subspace-source", "${fixture}"]\n[agents.echo.quirks.needs-env]\nsummary = "Reads ECHO_PREFIX"\napply = { env = { ECHO_PREFIX = "q:" } }\n`, 'f.toml')
  );
  const agent = await start('echo', { catalog, cwd: root, permissions: 'reject', quiet: true, handleSignals: false });
  try {
    assert.equal(agent.agent?.id, 'echo');
    assert.equal(agent.agent?.env.ECHO_PREFIX, 'q:');
    assert.match((await agent.run('env ECHO_PREFIX')).text, /q:/);
  } finally {
    await agent.close();
  }
  await assert.rejects(start('nope', { catalog, permissions: 'reject' }), /Unknown agent "nope"\. Known: claude, codex, grok, gemini, opencode, echo/);
});
