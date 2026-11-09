import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MCP_ENTRY, SKILL_SOURCE, TASKS_SOURCE, taskGuides } from '../src/install.js';
import { ALWAYS_LOAD_META, JEV_TOOLS, TOOLS } from '../src/mcp.js';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');
const NODE = process.execPath;

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'fai-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  const install = (args, env = {}) => {
    const child = spawnSync(NODE, [CLI, 'install', ...args], {
      cwd: project,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
    const lines = child.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `one JSON line expected: ${child.stdout}${child.stderr}`);
    return { code: child.status, json: JSON.parse(lines[0]), stderr: child.stderr };
  };
  return { root, home, project, install };
}

const read = path => readFileSync(path, 'utf8');
const backups = dir => readdirSync(dir).filter(name => name.includes('.bak-'));

test('claude project install writes .mcp.json and copies the stamped skill; a rerun changes nothing', async t => {
  const { project, install } = await sandbox(t);
  const first = install(['--host', 'claude']);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(read(join(project, '.mcp.json'))), {
    mcpServers: { 'fai-browser': { type: 'stdio', command: NODE, args: [MCP_ENTRY] } },
  });
  const skill = read(join(project, '.claude', 'skills', 'fai-browser', 'SKILL.md'));
  const lines = skill.split('\n');
  const close = lines.indexOf('---', 1);
  assert.match(lines[close + 1], /^<!-- fai-browser \d+\.\d+\.\d+: re-run "fai-browser install" to update -->$/);
  assert.equal(skill.replace(`${lines[close + 1]}\n`, ''), read(join(SKILL_SOURCE, 'SKILL.md')));
  // The task guides the skill points at are installed beside it, at the same relative path, unstamped.
  assert.deepEqual(taskGuides(), ['tasks/flights/SKILL.md', 'tasks/hotels/SKILL.md']);
  for (const guide of taskGuides()) {
    assert.equal(read(join(project, '.claude', 'skills', 'fai-browser', guide)), read(join(TASKS_SOURCE, '..', guide)), guide);
    assert.ok(skill.includes(`\`${guide}\``), `the main skill points at ${guide}`);
  }

  const second = install(['--host', 'claude']);
  assert.equal(second.code, 0);
  assert.ok(second.json.writes.every(write => write.action === 'unchanged'), JSON.stringify(second.json.writes));
  assert.deepEqual(backups(project), []);
});

test('claude install merges an existing .mcp.json, backs it up and adds FAI_HOME', async t => {
  const { project, install } = await sandbox(t);
  const path = join(project, '.mcp.json');
  await writeFile(path, JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: true }));
  const result = install(['--host', 'claude'], { FAI_HOME: '/data/fai' });
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(read(path));
  assert.deepEqual(config.mcpServers.other, { command: 'x' });
  assert.equal(config.extra, true);
  assert.deepEqual(config.mcpServers['fai-browser'].env, { FAI_HOME: '/data/fai' });
  const [backup] = backups(project);
  assert.match(backup, /^\.mcp\.json\.bak-\d{8}T\d{6}Z$/);
  assert.deepEqual(JSON.parse(read(join(project, backup))).mcpServers, { other: { command: 'x' } });
  assert.equal(result.json.writes[0].backup, join(project, backup));
});

test('claude refuses JSONC and prints the snippet with exit 2', async t => {
  const { project, install } = await sandbox(t);
  const original = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  await writeFile(join(project, '.mcp.json'), original);
  const result = install(['--host', 'claude']);
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, 'manual_edit_required');
  assert.match(result.json.snippet, /"fai-browser"/);
  assert.match(result.stderr, /"mcpServers"/);
  assert.equal(read(join(project, '.mcp.json')), original);
});

test('claude user scope prints remove then add-json and installs the skill in ~/.claude', async t => {
  const { home, project, install } = await sandbox(t);
  const result = install(['--host', 'claude', '--scope', 'user']);
  assert.equal(result.code, 0, result.stderr);
  const entry = JSON.stringify({ type: 'stdio', command: NODE, args: [MCP_ENTRY] });
  assert.equal(result.json.command, 'claude mcp remove --scope user fai-browser 2>/dev/null; '
    + `claude mcp add-json --scope user fai-browser '${entry}'`);
  assert.match(result.stderr, /claude mcp remove --scope user fai-browser 2>\/dev\/null; claude mcp add-json/);
  assert.ok(read(join(home, '.claude', 'skills', 'fai-browser', 'SKILL.md')).includes('name: fai-browser'));
  assert.deepEqual(readdirSync(project), []);
});

test('claude user scope re-install: the skill is unchanged and the command still removes the old entry first', async t => {
  const { home, install } = await sandbox(t);
  const first = install(['--host', 'claude', '--scope', 'user']);
  assert.equal(first.code, 0, first.stderr);
  // add-json refuses an existing name, so every printed command must remove first, including after --always-load.
  const again = install(['--host', 'claude', '--scope', 'user', '--always-load']);
  assert.equal(again.code, 0, again.stderr);
  const entry = JSON.stringify({ type: 'stdio', command: NODE, args: [MCP_ENTRY], alwaysLoad: true });
  assert.equal(again.json.command, 'claude mcp remove --scope user fai-browser 2>/dev/null; '
    + `claude mcp add-json --scope user fai-browser '${entry}'`);
  assert.ok(again.json.writes.every(write => write.action === 'unchanged'), JSON.stringify(again.json.writes));
  assert.deepEqual(backups(join(home, '.claude', 'skills', 'fai-browser')), []);
});

test('claude: --always-load writes alwaysLoad with a backup; the default leaves the key out again', async t => {
  const { project, install } = await sandbox(t);
  const path = join(project, '.mcp.json');
  const plain = { type: 'stdio', command: NODE, args: [MCP_ENTRY] };
  await writeFile(path, JSON.stringify({ mcpServers: { 'fai-browser': plain } }));
  const unchanged = install(['--host', 'claude']);
  assert.equal(unchanged.json.writes[0].action, 'unchanged');
  const eager = install(['--host', 'claude', '--always-load']);
  assert.equal(eager.code, 0, eager.stderr);
  assert.equal(eager.json.writes[0].action, 'update');
  assert.equal(JSON.parse(read(path)).mcpServers['fai-browser'].alwaysLoad, true);
  assert.deepEqual(JSON.parse(read(join(project, backups(project)[0]))).mcpServers['fai-browser'], plain);
  const back = install(['--host', 'claude']);
  assert.equal(back.code, 0, back.stderr);
  assert.deepEqual(JSON.parse(read(path)).mcpServers['fai-browser'], plain);
});

test('--always-load is refused for codex and opencode, whose configs have no per-server loading option', async t => {
  const { home, project, install } = await sandbox(t);
  for (const host of ['codex', 'opencode']) {
    const result = install(['--host', host, '--always-load']);
    assert.equal(result.code, 1);
    assert.equal(result.json.error.code, 'invalid_options');
    assert.match(result.json.error.message, /--host claude only/);
  }
  assert.deepEqual(readdirSync(project), []);
  assert.deepEqual(readdirSync(home), []);
});

test('the server marks only its loop to load eagerly (Claude Code _meta anthropic/alwaysLoad)', () => {
  const eager = TOOLS.filter(tool => tool._meta?.[ALWAYS_LOAD_META] === true).map(tool => tool.name);
  assert.deepEqual(eager, ['fai_browser_open', 'fai_browser_act', 'fai_browser_observe']);
  const jevEager = JEV_TOOLS.filter(tool => tool._meta?.[ALWAYS_LOAD_META] === true).map(tool => tool.name);
  assert.deepEqual(jevEager, ['fai_browser_run']);
  assert.equal(ALWAYS_LOAD_META, 'anthropic/alwaysLoad');
});

test('codex install appends one managed block, is idempotent and refuses a foreign entry without --force', async t => {
  const { home, project, install } = await sandbox(t);
  const config = join(home, '.codex', 'config.toml');
  await mkdir(join(home, '.codex'));
  await writeFile(config, 'model = "gpt-5"\n');
  const result = install(['--host', 'codex']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(config), [
    'model = "gpt-5"',
    '',
    '# fai-browser (managed by `fai-browser install --host codex`)',
    '[mcp_servers.fai-browser]',
    `command = ${JSON.stringify(NODE)}`,
    `args = [${JSON.stringify(MCP_ENTRY)}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
    '# Required for `codex exec`, which cannot answer approval prompts:',
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n'));
  assert.ok(read(join(project, '.agents', 'skills', 'fai-browser', 'SKILL.md')).includes('fai_browser_open'));
  assert.ok(read(join(project, '.agents', 'skills', 'fai-browser', 'tasks', 'flights', 'SKILL.md')).includes('Top flights'));
  assert.equal(backups(join(home, '.codex')).length, 1);

  const again = install(['--host', 'codex']);
  assert.ok(again.json.writes.every(write => write.action === 'unchanged'));
  assert.equal(backups(join(home, '.codex')).length, 1);

  await writeFile(config, 'model = "gpt-5"\n\n[mcp_servers.fai-browser]\ncommand = "old"\n\n[profiles.x]\na = 1\n');
  const refused = install(['--host', 'codex']);
  assert.equal(refused.code, 2);
  assert.match(refused.json.snippet, /\[mcp_servers\.fai-browser\]/);
  const forced = install(['--host', 'codex', '--force', '--scope', 'user']);
  assert.equal(forced.code, 0, forced.stderr);
  const text = read(config);
  assert.doesNotMatch(text, /command = "old"/);
  assert.match(text, /\[profiles\.x\]\na = 1/);
  assert.equal(text.match(/\[mcp_servers\.fai-browser\]/g).length, 1);
  assert.ok(read(join(home, '.agents', 'skills', 'fai-browser', 'SKILL.md')).length > 100);
});

test('codex honours CODEX_HOME', async t => {
  const { root, install } = await sandbox(t);
  const codexHome = join(root, 'codex-home');
  const result = install(['--host', 'codex'], { CODEX_HOME: codexHome });
  assert.equal(result.code, 0, result.stderr);
  assert.match(read(join(codexHome, 'config.toml')), /^# fai-browser/);
});

test('opencode project and user installs write the local MCP entry', async t => {
  const { home, project, install } = await sandbox(t);
  const result = install(['--host', 'opencode']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(read(join(project, 'opencode.json'))), {
    $schema: 'https://opencode.ai/config.json',
    mcp: { 'fai-browser': { type: 'local', command: [NODE, MCP_ENTRY], enabled: true } },
  });
  assert.ok(read(join(project, '.agents', 'skills', 'fai-browser', 'SKILL.md')).length > 100);
  assert.ok(read(join(project, '.agents', 'skills', 'fai-browser', 'tasks', 'flights', 'SKILL.md')).length > 100);
  const user = install(['--host', 'opencode', '--scope', 'user', '--command-name']);
  assert.equal(user.code, 0, user.stderr);
  const config = JSON.parse(read(join(home, '.config', 'opencode', 'opencode.json')));
  assert.deepEqual(config.mcp['fai-browser'].command, ['fai-browser-mcp']);

  await writeFile(join(project, 'opencode.jsonc'), '{}');
  const refused = install(['--host', 'opencode']);
  assert.equal(refused.code, 2);
});

test('--dry-run lists writes without touching disk; --link symlinks the skill', async t => {
  const { project, install } = await sandbox(t);
  const dry = install(['--host', 'claude', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.json.writes.map(write => write.action), ['create', 'create', 'create', 'create', 'create']);
  assert.equal(dry.json.writes[2].path, join(project, '.claude', 'skills', 'fai-browser', 'jev.md'));
  assert.equal(dry.json.writes[3].path, join(project, '.claude', 'skills', 'fai-browser', 'tasks', 'flights', 'SKILL.md'));
  assert.equal(dry.json.writes[4].path, join(project, '.claude', 'skills', 'fai-browser', 'tasks', 'hotels', 'SKILL.md'));
  assert.equal(dry.json.writes[0].path, join(project, '.mcp.json'));
  assert.match(dry.json.writes[0].content, /"fai-browser"/);
  assert.deepEqual(readdirSync(project), []);

  const linked = install(['--host', 'claude', '--link']);
  assert.equal(linked.code, 0, linked.stderr);
  const target = join(project, '.claude', 'skills', 'fai-browser');
  assert.ok(lstatSync(target).isSymbolicLink());
  assert.equal(realpathSync(target), realpathSync(SKILL_SOURCE));
  assert.ok(!readlinkSync(target).startsWith('/'), 'relative link');
  assert.ok(existsSync(join(target, 'tasks', 'flights', 'SKILL.md')), 'the guide resolves through the linked skill');
  assert.ok(existsSync(join(target, 'tasks', 'hotels', 'SKILL.md')), 'the hotels guide too');
  assert.ok(existsSync(join(target, 'jev.md')), 'the Jev autopilot guide too');
  const again = install(['--host', 'claude']);
  assert.ok(again.json.writes.every(write => write.action === 'unchanged'), 'a link to the source is left alone');
  const bad = install(['--host', 'cursor']);
  assert.equal(bad.code, 1);
});

// --- pi: a managed loader for the FAI pi extension (integrations/pi/fai-browser.js) ---------------------------------

const PI_EXTENSION_PATH = resolve(import.meta.dirname, '..', 'integrations', 'pi', 'fai-browser.js');

test('pi project install writes the stamped loader and the shared skill; a rerun changes nothing', async t => {
  const { project, install } = await sandbox(t);
  const first = install(['--host', 'pi']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /restart pi \(or run \/reload\)/);
  assert.match(first.stderr, /trust the project/);
  const loader = read(join(project, '.pi', 'extensions', 'fai-browser.js'));
  const lines = loader.trimEnd().split('\n');
  assert.match(lines[0], /^\/\/ fai-browser \d+\.\d+\.\d+ \(managed by `fai-browser install --host pi`\): re-run install to update$/);
  assert.equal(lines[1], `import activate from ${JSON.stringify(PI_EXTENSION_PATH)};`);
  const options = JSON.parse(/^export default pi => activate\(pi, (\{.*\})\);$/.exec(lines[2])[1]);
  assert.deepEqual(options, { command: NODE, args: [MCP_ENTRY] });
  assert.ok(existsSync(join(project, '.agents', 'skills', 'fai-browser', 'SKILL.md')));
  const second = install(['--host', 'pi']);
  assert.ok(second.json.writes.every(write => write.action === 'unchanged'), JSON.stringify(second.json.writes));
  assert.deepEqual(backups(join(project, '.pi', 'extensions')), []);
});

test('pi user install honours PI_CODING_AGENT_DIR and FAI_HOME; --command-name; --always-load is refused', async t => {
  const { root, home, install } = await sandbox(t);
  const user = install(['--host', 'pi', '--scope', 'user']);
  assert.equal(user.code, 0, user.stderr);
  assert.ok(existsSync(join(home, '.pi', 'agent', 'extensions', 'fai-browser.js')));
  assert.ok(existsSync(join(home, '.agents', 'skills', 'fai-browser', 'SKILL.md')));

  const agentDir = join(root, 'pi-agent');
  const custom = install(['--host', 'pi', '--scope', 'user', '--command-name'], { PI_CODING_AGENT_DIR: agentDir,
    FAI_HOME: '/data/fai' });
  assert.equal(custom.code, 0, custom.stderr);
  const loader = read(join(agentDir, 'extensions', 'fai-browser.js'));
  assert.match(loader, /activate\(pi, \{"command":"fai-browser-mcp","args":\[\],"env":\{"FAI_HOME":"\/data\/fai"\}\}\);/);

  const always = install(['--host', 'pi', '--always-load']);
  assert.equal(always.code, 1);
  assert.match(always.json.error.message, /--always-load applies to --host claude only/);
});

test('pi: a loader fai-browser did not write is refused without --force; a stamped one is updated with a backup', async t => {
  const { project, install } = await sandbox(t);
  const dir = join(project, '.pi', 'extensions');
  const path = join(dir, 'fai-browser.js');
  await mkdir(dir, { recursive: true });
  await writeFile(path, 'export default () => {};\n');
  const refused = install(['--host', 'pi']);
  assert.equal(refused.code, 2);
  assert.equal(read(path), 'export default () => {};\n');
  const forced = install(['--host', 'pi', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(read(path), /managed by `fai-browser install --host pi`/);
  assert.equal(backups(dir).length, 1);

  await writeFile(path, read(path).replace(JSON.stringify(NODE), JSON.stringify('/old/node')));
  const updated = install(['--host', 'pi']);
  assert.equal(updated.code, 0);
  assert.equal(updated.json.writes[0].action, 'update');
  assert.ok(read(path).includes(JSON.stringify(NODE)));
});

test('pi: a path pi would interpolate is refused with the snippet', async () => {
  const { planInstall, InstallError } = await import('../src/install.js');
  const refusedWith = pattern => error => error instanceof InstallError && error.exitCode === 2
    && pattern.test(error.message) && error.snippet.includes('activate');
  assert.throws(() => planInstall({ host: 'pi', cwd: '/tmp/x', home: '/tmp/h', env: {}, execPath: '/opt/$weird/node' }),
    refusedWith(/interpolate/));
  assert.throws(() => planInstall({ host: 'pi', cwd: '/tmp/x', home: '/tmp/h', env: { FAI_HOME: '/data/${X}' },
    execPath: '/usr/bin/node' }), refusedWith(/interpolate/), 'FAI_HOME is checked too');
});

test('detectHosts: pi needs its agent directory as well as a pi on PATH (Debian ships an unrelated pi)', async t => {
  const { detectHosts } = await import('../src/install.js');
  const root = await mkdtemp(join(tmpdir(), 'fai-detect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const home = join(root, 'home');
  await mkdir(home);
  const env = { PATH: bin };
  assert.deepEqual(detectHosts({ env, home }).map(item => item.host), [], 'a bare pi on PATH is not the coding agent');
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  assert.deepEqual(detectHosts({ env, home }).map(item => item.host), ['pi']);
  assert.deepEqual(detectHosts({ env: { PATH: bin, PI_CODING_AGENT_DIR: join(root, 'nope') }, home }), []);
});

test('refreshUserSkills rewrites a stamped user pi loader with the new node path and keeps its options', async t => {
  const { refreshUserSkills, piLoader } = await import('../src/install.js');
  const root = await mkdtemp(join(tmpdir(), 'fai-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const path = join(home, '.pi', 'agent', 'extensions', 'fai-browser.js');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, piLoader({ command: '/old/node', args: [MCP_ENTRY], env: { FAI_HOME: '/data/fai' } }));
  const refreshed = await refreshUserSkills({ home, env: {}, execPath: '/new/node' });
  assert.deepEqual(refreshed.filter(item => item.host === 'pi'), [{ host: 'pi', path, writes: 1 }]);
  assert.match(read(path), /\{"command":"\/new\/node","args":\[[^\]]+\],"env":\{"FAI_HOME":"\/data\/fai"\}\}/);

  // A foreign file at the same path is never touched.
  await writeFile(path, 'export default () => {};\n');
  const again = await refreshUserSkills({ home, env: {}, execPath: '/new/node' });
  assert.deepEqual(again.filter(item => item.host === 'pi'), []);
  assert.equal(read(path), 'export default () => {};\n');
});
