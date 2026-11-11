import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

test('loadCatalog reads agents.toml, the nearest subspace.toml, $SUBSPACE_AGENTS; the registry cache wins when newer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subspace-catalog-'));
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  const project = join(root, 'project');
  await mkdir(join(config, 'subspace'), { recursive: true });
  await mkdir(join(project, 'deep', 'er'), { recursive: true });
  await writeFile(join(config, 'subspace', 'agents.toml'), '[agents.one]\ncommand = "one"\n');
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
