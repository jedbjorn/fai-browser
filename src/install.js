// `fai-browser install --host claude|codex|opencode [--scope project|user] [--link] [--dry-run] [--force]
// [--command-name] [--always-load]`: registers the MCP server with a coding-agent host and installs the skill.
//
// JSON configs are merged and only the "fai-browser" entry is touched; the Codex TOML gets one managed block.
// An existing file is backed up to <file>.bak-<timestamp> before it changes. Running twice changes nothing.
// OpenCode also gets FAI's wake plugin (src/opencode-plugin.js) next to its config: <project>/.opencode/plugins/ or
// ~/.config/opencode/plugins/, as fai-browser.js (copied, or a symlink with --link). A file there without the plugin's
// version marker is left alone unless --force.
// A file that cannot be edited safely (JSONC, a hand-written Codex entry) is left alone: the snippet is printed
// and the command exits 2.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';

export const HOSTS = ['claude', 'codex', 'opencode'];
/** Display names, and the command each host installs on PATH. */
export const HOST_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' });
export const SERVER_NAME = 'fai-browser';
export const SKILL_SOURCE = join(PACKAGE_ROOT, 'skills', 'fai-browser');
/** The task sub-skills: tasks/<name>/SKILL.md, installed under the skill as tasks/<name>/SKILL.md. */
export const TASKS_SOURCE = join(PACKAGE_ROOT, 'tasks');
export const MCP_ENTRY = join(PACKAGE_ROOT, 'src', 'mcp-main.js');
const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
const CODEX_MARKER = '# fai-browser (managed by `fai-browser install --host codex`)';
const SKILL_MARKER = /^<!-- fai-browser [^ ]+: re-run "fai-browser install" to update -->$/m;
/** FAI's OpenCode wake plugin and the marker its first line carries (any version: an older one is updated). */
export const OPENCODE_PLUGIN_SOURCE = join(PACKAGE_ROOT, 'src', 'opencode-plugin.js');
export const OPENCODE_PLUGIN_FILE = 'fai-browser.js';
const PLUGIN_MARKER = /^\/\/ fai-browser-opencode-plugin v\d+\b/;

export class InstallError extends Error {
  constructor(message, { exitCode = 1, snippet, path } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.snippet = snippet;
    this.path = path;
  }
}

/** The command a host should run: absolute node plus the entry script, or the bare bin with --command-name. */
export function serverCommand({ commandName = false, execPath = process.execPath } = {}) {
  return commandName ? { command: 'fai-browser-mcp', args: [] } : { command: execPath, args: [MCP_ENTRY] };
}

function serverEnv(env) {
  return env.FAI_HOME ? { FAI_HOME: resolve(env.FAI_HOME) } : undefined;
}

function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * Exact per-host MCP entry (design section 5). Claude Code defers MCP tools behind tool search, which costs one extra
 * model round trip on a session's first browser task. By default the entry has no `alwaysLoad`: the server marks the
 * tools of its loop with `_meta["anthropic/alwaysLoad"]` (fai_browser_open, act and observe), so the loop is in the
 * first request and the
 * rarely used schemas (wait, status, release, evidence, guide) stay behind tool search. `alwaysLoad` (`--always-load`) puts all eight in
 * every request, and Claude Code waits for such a server at startup (up to about 5 s). Verified against Claude Code
 * 2.1.289: the stdio server schema accepts `alwaysLoad` ("all tools from this server are always included in the prompt
 * and never deferred behind tool search") and `claude mcp add-json` keeps it.
 */
export function hostEntry(host, { command, args, env }, { alwaysLoad = false } = {}) {
  if (host === 'claude') {
    const entry = { type: 'stdio', command, args };
    if (env) {
      entry.env = env;
    }
    if (alwaysLoad) {
      entry.alwaysLoad = true;
    }
    return entry;
  }
  if (host === 'opencode') {
    const entry = { type: 'local', command: [command, ...args], enabled: true };
    if (env) {
      entry.environment = env;
    }
    return entry;
  }
  throw new Error(`No JSON entry for host ${host}`);
}

/** The managed Codex block. `default_tools_approval_mode` lets `codex exec` call the tools without a prompt. */
export function codexBlock({ command, args, env }) {
  const lines = [
    CODEX_MARKER,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
  ];
  if (env) {
    const pairs = Object.entries(env).map(([key, value]) => `${key} = ${tomlString(value)}`);
    lines.push(`env = { ${pairs.join(', ')} }`);
  }
  lines.push('startup_timeout_sec = 20');
  lines.push('tool_timeout_sec = 120');
  lines.push('# Required for `codex exec`, which cannot answer approval prompts:');
  lines.push('default_tools_approval_mode = "approve"');
  return `${lines.join('\n')}\n`;
}

/**
 * User-scope registration. `claude mcp add` has no flag for `alwaysLoad`, so the entry goes through `add-json`, which
 * refuses an existing name ("MCP server already exists in user config"): remove any earlier entry first.
 */
export function claudeAddCommand(server, { alwaysLoad = false } = {}) {
  const entry = hostEntry('claude', server, { alwaysLoad });
  const remove = ['claude', 'mcp', 'remove', '--scope', 'user', SERVER_NAME].join(' ');
  const add = ['claude', 'mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify(entry)]
    .map(shellQuote).join(' ');
  return `${remove} 2>/dev/null; ${add}`;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Merge `entry` at object[section][SERVER_NAME] of a JSON config. Returns a planned write.
function planJsonConfig(path, section, entry, { defaults = {}, snippetFor }) {
  const text = readText(path);
  let config = {};
  if (text !== null && text.trim()) {
    try {
      config = JSON.parse(text);
    } catch {
      throw new InstallError(`${path} is not plain JSON (comments or trailing commas?); add this entry by hand`, {
        exitCode: 2,
        snippet: snippetFor(),
        path,
      });
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new InstallError(`${path} does not contain a JSON object`, { exitCode: 2, snippet: snippetFor(), path });
    }
  }
  const current = config[section]?.[SERVER_NAME];
  if (text !== null && sameJson(current, entry)) {
    return { path, action: 'unchanged', content: text };
  }
  const next = { ...defaults, ...config };
  if (next[section] !== undefined && (typeof next[section] !== 'object' || Array.isArray(next[section]))) {
    throw new InstallError(`${path}: "${section}" is not an object`, { exitCode: 2, snippet: snippetFor(), path });
  }
  next[section] = { ...(next[section] ?? {}), [SERVER_NAME]: entry };
  return { path, action: text === null ? 'create' : 'update', content: stableJson(next), backup: text !== null };
}

// Find the [mcp_servers.fai-browser] table (plus a preceding managed marker) in a TOML document.
function findCodexTable(text) {
  const lines = text.split('\n');
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:fai-browser|"fai-browser")\s*\]\s*(?:#.*)?$/;
  const anyHeader = /^\s*\[/;
  const sub = /^\s*\[\s*mcp_servers\s*\.\s*(?:fai-browser|"fai-browser")\s*\./;
  const start = lines.findIndex(line => header.test(line));
  if (start < 0) {
    return null;
  }
  let end = start + 1;
  while (end < lines.length && (!anyHeader.test(lines[end]) || sub.test(lines[end]))) {
    end += 1;
  }
  const managed = start > 0 && lines[start - 1].trim() === CODEX_MARKER;
  return { lines, start: managed ? start - 1 : start, end, managed };
}

function planCodexConfig(path, block, force) {
  const text = readText(path);
  if (text === null || !text.trim()) {
    return { path, action: 'create', content: block };
  }
  const table = findCodexTable(text);
  if (!table) {
    const separator = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { path, action: 'update', content: `${text}${separator}${block}`, backup: true };
  }
  // Compare the existing table without trailing blank lines against the block.
  const existing = table.lines.slice(table.start, table.end);
  while (existing.length && !existing.at(-1).trim()) {
    existing.pop();
  }
  if (`${existing.join('\n')}\n` === block) {
    return { path, action: 'unchanged', content: text };
  }
  if (!force) {
    throw new InstallError(`${path} already has [mcp_servers.${SERVER_NAME}]; rerun with --force to replace it`, {
      exitCode: 2,
      snippet: block,
      path,
    });
  }
  const trailing = table.lines.slice(table.end);
  const before = table.lines.slice(0, table.start);
  const blank = trailing.length && trailing[0].trim() ? [''] : [];
  const content = [...before, ...block.trimEnd().split('\n'), ...blank, ...trailing].join('\n');
  return { path, action: 'update', content, backup: true };
}

function skillFiles() {
  return readdirSync(SKILL_SOURCE, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
}

/** The shipped task guides as `tasks/<name>/SKILL.md` relative paths (a task directory without a guide is skipped). */
export function taskGuides() {
  let entries;
  try {
    entries = readdirSync(TASKS_SOURCE, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')
    && existsSync(join(TASKS_SOURCE, entry.name, 'SKILL.md')))
    .map(entry => join('tasks', entry.name, 'SKILL.md'))
    .sort();
}

/** SKILL.md with the version marker as the first line after the frontmatter. */
export function stampedSkill(text) {
  const marker = `<!-- fai-browser ${VERSION}: re-run "fai-browser install" to update -->`;
  // \r?: a Windows clone made before .gitattributes pinned LF has CRLF files; the marker still goes after the frontmatter.
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!match) {
    return `${marker}\n${text}`;
  }
  return `${match[0]}${marker}\n${text.slice(match[0].length)}`;
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function planSkill(target, { link, force }) {
  const info = lstatOrNull(target);
  if (info?.isSymbolicLink()) {
    if (samePath(target, SKILL_SOURCE)) {
      return [{ path: target, action: 'unchanged', content: `symlink -> ${readlinkSync(target)}` }];
    }
    if (!force) {
      throw new InstallError(`${target} is a symlink to somewhere else; rerun with --force to replace it`, {
        exitCode: 2,
        path: target,
      });
    }
  } else if (info && !info.isDirectory()) {
    throw new InstallError(`${target} exists and is not a directory`, { exitCode: 2, path: target });
  } else if (info && !force) {
    const current = readText(join(target, 'SKILL.md'));
    if (current !== null && !SKILL_MARKER.test(current)) {
      throw new InstallError(`${target} holds a skill not installed by fai-browser; rerun with --force to replace it`, {
        exitCode: 2,
        path: target,
      });
    }
  }
  if (link) {
    return [{ path: target, action: info ? 'replace' : 'create', kind: 'symlink', content: `symlink -> ${SKILL_SOURCE}`,
      replace: Boolean(info) }];
  }
  const writes = [];
  const replaceLink = info?.isSymbolicLink() ?? false;
  // The skill's own files, then the task guides the skill points at (tasks/<name>/SKILL.md, the same relative path
  // under the installed skill, so the pointer resolves wherever the skill is installed).
  const files = [...skillFiles().map(name => ({ source: join(SKILL_SOURCE, name), name })),
    ...taskGuides().map(name => ({ source: join(PACKAGE_ROOT, name), name }))];
  for (const { source, name } of files) {
    const text = readFileSync(source, 'utf8');
    const content = name === 'SKILL.md' ? stampedSkill(text) : text;
    const path = join(target, name);
    const current = replaceLink ? null : readText(path);
    if (current === content) {
      writes.push({ path, action: 'unchanged', content });
    } else {
      writes.push({ path, action: current === null ? 'create' : 'update', content, replaceLink });
    }
  }
  return writes;
}

/** The OpenCode plugin file at `target`: copied (or linked) from OPENCODE_PLUGIN_SOURCE; a foreign file needs --force. */
function planOpencodePlugin(target, { link, force }) {
  const info = lstatOrNull(target);
  const linked = info?.isSymbolicLink() && samePath(target, OPENCODE_PLUGIN_SOURCE);
  if (info?.isSymbolicLink() && !linked && !force) {
    throw new InstallError(`${target} is a symlink to somewhere else; rerun with --force to replace it`, { exitCode: 2, path: target });
  }
  if (info && !info.isSymbolicLink() && !info.isFile()) {
    throw new InstallError(`${target} exists and is not a file`, { exitCode: 2, path: target });
  }
  const current = info?.isFile() ? readText(target) : null;
  const foreign = current !== null && !PLUGIN_MARKER.test(current);
  if (foreign && !force) {
    throw new InstallError(`${target} is not FAI Browser's OpenCode plugin; rerun with --force to replace it`, {
      exitCode: 2, path: target });
  }
  if (link) {
    if (linked) return { path: target, action: 'unchanged', content: `symlink -> ${readlinkSync(target)}` };
    return { path: target, action: info ? 'replace' : 'create', kind: 'symlink', source: OPENCODE_PLUGIN_SOURCE,
      linkType: 'file', content: `symlink -> ${OPENCODE_PLUGIN_SOURCE}`, replace: Boolean(info), backup: foreign };
  }
  const content = readFileSync(OPENCODE_PLUGIN_SOURCE, 'utf8');
  if (current === content) return { path: target, action: 'unchanged', content };
  return { path: target, action: info ? 'update' : 'create', content, backup: foreign };
}

/**
 * Where `install --host opencode` puts the plugin: beside the opencode.json it registers the server in. Like that
 * config path, user scope is always ~/.config/opencode: XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR are not honoured.
 */
export function opencodePluginPath({ scope = 'project', cwd, home = homedir() }) {
  return scope === 'project' ? join(cwd, '.opencode', 'plugins', OPENCODE_PLUGIN_FILE)
    : join(home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE);
}

/** Plan every write for a host without touching the filesystem. */
export function planInstall({ host, scope = 'project', link = false, force = false, commandName = false, cwd,
  alwaysLoad = false, env = process.env, home = homedir(), execPath = process.execPath, platform = process.platform }) {
  if (!HOSTS.includes(host)) {
    throw new InstallError(`--host must be one of ${HOSTS.join(', ')}`);
  }
  if (!['project', 'user'].includes(scope)) {
    throw new InstallError('--scope must be project or user');
  }
  if (alwaysLoad && host !== 'claude') {
    throw new InstallError('--always-load applies to --host claude only');
  }
  const server = { ...serverCommand({ commandName, execPath }), env: serverEnv(env) };
  const plan = { host, scope, server, writes: [], notes: [] };
  let skillTarget;
  if (host === 'claude') {
    const loading = { alwaysLoad };
    if (scope === 'project') {
      const path = join(cwd, '.mcp.json');
      const entry = hostEntry('claude', server, loading);
      plan.writes.push(planJsonConfig(path, 'mcpServers', entry, {
        snippetFor: () => stableJson({ mcpServers: { [SERVER_NAME]: entry } }),
      }));
      skillTarget = join(cwd, '.claude', 'skills', 'fai-browser');
    } else {
      // Windows terminals (PowerShell 5.1 drops the quotes inside a JSON argument): plain `claude mcp add` lines.
      plan.command = platform === 'win32' && !alwaysLoad ? claudeAddCommandWindows(server).trimEnd()
        : claudeAddCommand(server, loading);
      plan.notes.push(`Register the MCP server for every project with: ${plan.command}`);
      skillTarget = join(home, '.claude', 'skills', 'fai-browser');
    }
  } else if (host === 'codex') {
    const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex');
    plan.writes.push(planCodexConfig(join(codexHome, 'config.toml'), codexBlock(server), force));
    plan.notes.push('Codex MCP servers are always user-level; the entry is in config.toml.');
    skillTarget = scope === 'project' ? join(cwd, '.agents', 'skills', 'fai-browser')
      : join(home, '.agents', 'skills', 'fai-browser');
  } else {
    const path = scope === 'project' ? join(cwd, 'opencode.json') : join(home, '.config', 'opencode', 'opencode.json');
    const jsonc = path.replace(/\.json$/, '.jsonc');
    const entry = hostEntry('opencode', server);
    const snippet = () => stableJson({ $schema: 'https://opencode.ai/config.json', mcp: { [SERVER_NAME]: entry } });
    if (existsSync(jsonc)) {
      throw new InstallError(`${jsonc} is JSONC; add this entry by hand`, { exitCode: 2, snippet: snippet(),
        path: jsonc });
    }
    plan.writes.push(planJsonConfig(path, 'mcp', entry, {
      defaults: { $schema: 'https://opencode.ai/config.json' },
      snippetFor: snippet,
    }));
    // The wake plugin (OpenCode 1.19+, below 2) loads from the plugins directory beside that config. Wakes need the
    // server started by OpenCode itself, which the entry above does (absolute node, no wrapper; not --command-name).
    plan.writes.push(planOpencodePlugin(opencodePluginPath({ scope, cwd, home }), { link, force }));
    plan.notes.push('OpenCode loads FAI\'s wake plugin (plugins/fai-browser.js) at startup; OpenCode 1.19 to 1.x, not with --pure.');
    skillTarget = scope === 'project' ? join(cwd, '.agents', 'skills', 'fai-browser')
      : join(home, '.agents', 'skills', 'fai-browser');
  }
  if (samePath(dirname(skillTarget), dirname(SKILL_SOURCE)) || samePath(skillTarget, SKILL_SOURCE)) {
    plan.writes.push({ path: skillTarget, action: 'unchanged', content: 'canonical skill directory' });
  } else {
    plan.writes.push(...planSkill(skillTarget, { link, force }));
  }
  return plan;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.fai-${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/** Apply a plan. Returns the writes with backup paths filled in. */
export async function applyPlan(plan) {
  const stamp = timestamp();
  const done = [];
  for (const write of plan.writes) {
    const record = { path: write.path, action: write.action };
    if (write.action === 'unchanged') {
      done.push(record);
      continue;
    }
    if (write.kind === 'symlink') {
      const source = write.source ?? SKILL_SOURCE;
      if (write.backup && existsSync(write.path)) {
        record.backup = `${write.path}.bak-${stamp}`;
        await copyFile(write.path, record.backup);
      }
      if (write.replace) {
        await rm(write.path, { recursive: true, force: true });
      }
      await mkdir(dirname(write.path), { recursive: true });
      await symlink(relative(dirname(write.path), source) || source, write.path, write.linkType ?? 'dir');
      done.push(record);
      continue;
    }
    if (write.replaceLink && lstatOrNull(dirname(write.path))?.isSymbolicLink()) {
      await rm(dirname(write.path), { force: true });
    }
    if (write.backup && existsSync(write.path)) {
      record.backup = `${write.path}.bak-${stamp}`;
      await copyFile(write.path, record.backup);
    }
    await atomicWrite(write.path, write.content);
    done.push(record);
  }
  return done;
}

/**
 * Run the install command. `flags` are the parsed CLI flags. Writes one JSON line to stdout and hints to
 * stderr; resolves the exit code (0 done, 2 refused with a printed snippet, 1 error).
 */
export async function runInstall(flags, { cwd = process.cwd(), env = process.env, home = homedir(),
  stdout = process.stdout, stderr = process.stderr, execPath = process.execPath } = {}) {
  const emit = value => stdout.write(`${JSON.stringify(value, null, flags.pretty ? 2 : undefined)}\n`);
  let plan;
  try {
    plan = planInstall({
      host: flags.host,
      scope: flags.scope ?? 'project',
      link: Boolean(flags.link),
      force: Boolean(flags.force),
      commandName: Boolean(flags['command-name']),
      alwaysLoad: Boolean(flags['always-load']),
      cwd: resolve(cwd),
      env,
      home,
      execPath,
    });
  } catch (error) {
    if (!(error instanceof InstallError)) {
      throw error;
    }
    if (error.snippet) {
      stderr.write(`fai-browser: ${error.message}:\n${error.snippet}`);
    }
    emit(Object.fromEntries(Object.entries({
      error: { code: error.exitCode === 2 ? 'manual_edit_required' : 'invalid_options', message: error.message },
      path: error.path,
      snippet: error.snippet,
    }).filter(([, value]) => value !== undefined)));
    return error.exitCode;
  }
  if (flags['dry-run']) {
    emit({
      host: plan.host,
      scope: plan.scope,
      writes: plan.writes.map(({ path, action, content }) => ({ path, action, content })),
      command: plan.command,
      notes: plan.notes,
    });
    return 0;
  }
  const writes = await applyPlan(plan);
  for (const note of plan.notes) {
    stderr.write(`fai-browser: ${note}\n`);
  }
  stderr.write(`fai-browser: restart ${plan.host === 'claude' ? 'Claude Code' : plan.host === 'codex' ? 'Codex'
    : 'OpenCode'} so it loads the fai-browser MCP server and skill.\n`);
  emit({ host: plan.host, scope: plan.scope, writes, command: plan.command, server: plan.server });
  return 0;
}

/** The absolute path of `name` on PATH (PATHEXT on Windows), or null. */
export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== 'win32') accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/** The coding agents installed on PATH, in HOSTS order: [{ host, name, path }]. */
export function detectHosts(options = {}) {
  return HOSTS.map(host => ({ host, name: HOST_NAMES[host], path: findOnPath(host, options) })).filter(item => item.path);
}

/**
 * Register FAI Browser with one host for every project (setup's question): the user-scope plan, applied, and for
 * Claude Code its `claude mcp remove` then `claude mcp add-json` run directly. Resolves `{ host, writes }`; throws an
 * InstallError (with the snippet or command to run by hand) when it cannot.
 */
export async function registerHost(host, { env = process.env, home = homedir(), cwd = process.cwd(), claudePath = 'claude',
  platform = process.platform, run = commandRunner({ env, platform }) } = {}) {
  const plan = planInstall({ host, scope: 'user', cwd, env, home, platform });
  const writes = await applyPlan(plan);
  if (host === 'claude') {
    // A Windows batch shim (npm's claude.cmd) runs through cmd.exe, which cannot pass the JSON of add-json intact:
    // the same entry goes through `claude mcp add` with plain arguments instead.
    const batch = isBatchFile(claudePath, platform);
    const entry = hostEntry('claude', plan.server);
    try {
      run(claudePath, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    } catch {
      // Not registered yet.
    }
    try {
      run(claudePath, batch ? claudeAddArgs(plan.server)
        : ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify(entry)]);
    } catch {
      throw new InstallError(`claude mcp ${batch ? 'add' : 'add-json'} failed; run it by hand`, {
        snippet: `${plan.command}\n` });
    }
  }
  return { host, writes };
}

/** True for a Windows batch file (`.cmd`, `.bat`), which Node starts only through cmd.exe. */
export function isBatchFile(file, platform = process.platform) {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(file));
}

/** `claude mcp add` arguments for the user-scope entry: plain argv, no JSON (`-e` for the environment). */
export function claudeAddArgs({ command, args, env }) {
  const pairs = Object.entries(env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, ...pairs, '--', command, ...args];
}

/** The two commands to run by hand in a Windows terminal (PowerShell or cmd). */
export function claudeAddCommandWindows(server) {
  const quote = value => (/^[\w@+=:,./\\-]+$/.test(value) ? value : `"${value}"`);
  return `claude mcp remove --scope user ${SERVER_NAME}\nclaude ${claudeAddArgs(server).map(quote).join(' ')}\n`;
}

/**
 * The argv for a batch file run through cmd.exe: every part in double quotes. cmd.exe expands `%NAME%` even inside
 * quotes and a `"` would end the quoting, so a part holding either (or a line break) is refused, never escaped.
 */
export function batchCommandLine(file, args) {
  const parts = [file, ...args].map(String);
  const unsafe = parts.find(part => /["%\r\n]/.test(part));
  if (unsafe !== undefined) {
    throw new InstallError(`Cannot pass ${JSON.stringify(unsafe)} through cmd.exe safely; run the command by hand`);
  }
  return parts.map(part => `"${part}"`).join(' ');
}

/**
 * Runs a host's command synchronously, without a shell; a Windows batch file through cmd.exe with every argument
 * quoted by batchCommandLine (Node refuses to start a .cmd or .bat without a shell).
 */
export function commandRunner({ env = process.env, platform = process.platform, exec = execFileSync } = {}) {
  return (file, args) => {
    if (isBatchFile(file, platform)) {
      return exec(batchCommandLine(file, args), [], { stdio: 'ignore', env, shell: true, windowsHide: true });
    }
    return exec(file, args, { stdio: 'ignore', env, windowsHide: true });
  };
}

/**
 * The updater's refresh (`fai-browser update --finish`): re-copy the skill into each user-level skill directory that an
 * earlier `install` or setup wrote (its SKILL.md carries the version marker). A symlinked skill, a foreign skill and a
 * host never registered are left alone; project-level installs are not discovered (their version marker says to re-run
 * install). Resolves `[{ host, path, writes }]` for the directories it refreshed.
 */
export async function refreshUserSkills({ home = homedir() } = {}) {
  const targets = new Map([
    [join(home, '.claude', 'skills', 'fai-browser'), 'claude'],
    [join(home, '.agents', 'skills', 'fai-browser'), 'codex/opencode'],
  ]);
  const refreshed = [];
  for (const [target, host] of targets) {
    const info = lstatOrNull(target);
    if (!info?.isDirectory() || !SKILL_MARKER.test(readText(join(target, 'SKILL.md')) ?? '')) continue;
    const writes = await applyPlan({ writes: planSkill(target, { link: false, force: false }) });
    refreshed.push({ host, path: target, writes: writes.filter(write => write.action !== 'unchanged').length });
  }
  // FAI's OpenCode plugin, when a user-level install copied it (a symlink follows the checkout by itself).
  const plugin = opencodePluginPath({ scope: 'user', home });
  if (lstatOrNull(plugin)?.isFile() && PLUGIN_MARKER.test(readText(plugin) ?? '')) {
    const writes = await applyPlan({ writes: [planOpencodePlugin(plugin, { link: false, force: false })] });
    refreshed.push({ host: 'opencode', path: plugin, writes: writes.filter(write => write.action !== 'unchanged').length });
  }
  return refreshed;
}
