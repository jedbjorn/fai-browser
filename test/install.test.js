import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MCP_ENTRY, OPENCODE_PLUGIN_SOURCE, SKILL_SOURCE, TASKS_SOURCE, claudeAddCommandWindows, refreshUserSkills,
  taskGuides } from '../src/install.js';
import { ALWAYS_LOAD_META, TOOLS } from '../src/mcp.js';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');
const NODE = process.execPath;

async function sandbox(t) {
  // realpath: macOS's tmpdir is a symlink (/var -> /private/var), and the CLI reports real paths.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'fai-install-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  const install = (args, env = {}) => {
    const child = spawnSync(NODE, [CLI, 'install', ...args], {
      cwd: project,
      encoding: 'utf8',
      // USERPROFILE: Node's homedir() on Windows (HOME elsewhere); SystemRoot: what node itself needs there.
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
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
  const { root, project, install } = await sandbox(t);
  const path = join(project, '.mcp.json');
  await writeFile(path, JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: true }));
  const fai = join(root, 'fai home');
  const result = install(['--host', 'claude'], { FAI_HOME: fai });
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(read(path));
  assert.deepEqual(config.mcpServers.other, { command: 'x' });
  assert.equal(config.extra, true);
  assert.deepEqual(config.mcpServers['fai-browser'].env, { FAI_HOME: fai });
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
  if (process.platform === 'win32') {
    // A Windows terminal gets plain `claude mcp add` lines (PowerShell 5.1 drops the quotes inside a JSON argument).
    assert.equal(result.json.command, claudeAddCommandWindows({ command: NODE, args: [MCP_ENTRY] }).trimEnd());
  } else {
    assert.equal(result.json.command, 'claude mcp remove --scope user fai-browser 2>/dev/null; '
      + `claude mcp add-json --scope user fai-browser '${entry}'`);
    assert.match(result.stderr, /claude mcp remove --scope user fai-browser 2>\/dev\/null; claude mcp add-json/);
  }
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

test('opencode installs FAI\'s wake plugin beside its config (project and user), marker-guarded, idempotent', async t => {
  const { home, project, install } = await sandbox(t);
  const source = read(OPENCODE_PLUGIN_SOURCE);
  assert.match(source, /^\/\/ fai-browser-opencode-plugin v1\n/);
  const pluginAt = join(project, '.opencode', 'plugins', 'fai-browser.js');

  const dry = install(['--host', 'opencode', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(dry.json.writes.some(write => write.path === pluginAt && write.action === 'create'));
  assert.equal(existsSync(pluginAt), false);

  const first = install(['--host', 'opencode']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(read(pluginAt), source);
  const again = install(['--host', 'opencode']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.writes.find(write => write.path === pluginAt).action, 'unchanged');

  // An older FAI plugin is updated; a foreign file is refused without --force (and backed up with it).
  await writeFile(pluginAt, '// fai-browser-opencode-plugin v0\nexport const Old = async () => ({});\n');
  assert.equal(install(['--host', 'opencode']).json.writes.find(write => write.path === pluginAt).action, 'update');
  assert.equal(read(pluginAt), source);
  await writeFile(pluginAt, 'export const Mine = async () => ({});\n');
  const refused = install(['--host', 'opencode']);
  assert.equal(refused.code, 2);
  assert.match(refused.json.error.message, /not FAI Browser's OpenCode plugin/);
  assert.equal(read(pluginAt), 'export const Mine = async () => ({});\n');
  const forced = install(['--host', 'opencode', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(read(pluginAt), source);
  assert.equal(backups(join(project, '.opencode', 'plugins')).length, 1);

  // --link: a relative symlink to the checkout's plugin.
  const linked = install(['--host', 'opencode', '--link']);
  assert.equal(linked.code, 0, linked.stderr);
  assert.ok(lstatSync(pluginAt).isSymbolicLink());
  assert.equal(realpathSync(pluginAt), realpathSync(OPENCODE_PLUGIN_SOURCE));
  assert.equal(install(['--host', 'opencode', '--link']).json.writes.find(write => write.path === pluginAt).action, 'unchanged');

  // User scope: ~/.config/opencode/plugins/, the directory of the opencode.json it registers in; the updater refreshes it.
  const userPlugin = join(home, '.config', 'opencode', 'plugins', 'fai-browser.js');
  const user = install(['--host', 'opencode', '--scope', 'user']);
  assert.equal(user.code, 0, user.stderr);
  assert.equal(read(userPlugin), source);
  await writeFile(userPlugin, '// fai-browser-opencode-plugin v0\n');
  const refreshed = await refreshUserSkills({ home });
  assert.deepEqual(refreshed.find(item => item.path === userPlugin), { host: 'opencode', path: userPlugin, writes: 1 });
  assert.equal(read(userPlugin), source);
  await writeFile(userPlugin, '// mine\n');
  await refreshUserSkills({ home });
  assert.equal(read(userPlugin), '// mine\n', 'a foreign plugin file is never refreshed');
});

test('--dry-run lists writes without touching disk; --link symlinks the skill', async t => {
  const { project, install } = await sandbox(t);
  const dry = install(['--host', 'claude', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.json.writes.map(write => write.action), ['create', 'create', 'create', 'create']);
  assert.equal(dry.json.writes[2].path, join(project, '.claude', 'skills', 'fai-browser', 'tasks', 'flights', 'SKILL.md'));
  assert.equal(dry.json.writes[3].path, join(project, '.claude', 'skills', 'fai-browser', 'tasks', 'hotels', 'SKILL.md'));
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
  const again = install(['--host', 'claude']);
  assert.ok(again.json.writes.every(write => write.action === 'unchanged'), 'a link to the source is left alone');
  const bad = install(['--host', 'cursor']);
  assert.equal(bad.code, 1);
});
