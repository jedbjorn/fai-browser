// FAI chats (spec #84): the three provider programs a chat turn starts. Each adapter knows how to find its program
// without a shell (D1), which version FAI supports, how the program itself says it is signed in (D2), the exact
// argument list of one turn and of a resumed one (D3, D4, D6, D7, D9; shared/f7/chat-discovery.md), and how to read
// its machine-readable output (D5). Nothing here starts a turn: src/chat-runner.js does.
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { CARRIED_ENV } from './resume.js';

/** Provider order: the first available is the default (decision #30). */
export const PROVIDERS = Object.freeze(['codex', 'claude', 'opencode']);
export const PROVIDER_NAMES = Object.freeze({ codex: 'ChatGPT (Codex)', claude: 'Claude', opencode: 'OpenCode' });
/** The versions discovery ran on (task #8); older ones are refused. OpenCode 2.x is a different product (feature #9). */
export const MIN_VERSIONS = Object.freeze({ claude: '2.1.325', codex: '0.169.0', opencode: '1.19.5' });
const OPENCODE_BEFORE = 2;
/** The name of FAI's MCP server inside a turn: Claude's tools are then mcp__fai__<tool> (D6). */
export const SERVER_KEY = 'fai';
/** The variable that carries the turn token to FAI's MCP server (D7). */
export const TURN_TOKEN_ENV = 'FAI_CHAT_TURN_TOKEN';

// Codex features switched off for a chat turn (D6). code_mode_host stays on: FAI's tools are reached through it.
const CODEX_DISABLED = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external',
  'computer_use', 'image_generation', 'multi_agent', 'multi_agent_v2', 'goals', 'sleep_tool', 'tool_suggest',
  'skill_search'];

const WINDOWS_APPS = /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i;

// --- finding the program (D1) ------------------------------------------------------------------------------------

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executable(path, platform) {
  if (!isFile(path)) return false;
  if (platform === 'win32') return /\.exe$/i.test(path) && !WINDOWS_APPS.test(path);
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// PATH, then the places the installers put these programs, which a daemon started by the browser may not have on its
// PATH. Relative entries never count: they would resolve against whatever folder the daemon runs in.
function searchDirs(env, platform, home) {
  const path = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter);
  const extra = platform === 'win32'
    ? [join(env.USERPROFILE || home, '.local', 'bin'), join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm')]
    : [join(home, '.local', 'bin'), join(home, '.opencode', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set([...path, ...extra])].filter(dir => dir && isAbsolute(dir) && !WINDOWS_APPS.test(dir));
}

const ARCH = { x64: 'x64', arm64: 'arm64' };
const CODEX_TRIPLE = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
};

// npm installs a launcher script; the real program is in the platform package inside the package (D1: on Windows only
// an .exe starts without a shell, and on macOS /opt/homebrew/bin/codex is a node script). `root`: the package folder.
function vendorPaths(provider, root, platform, arch) {
  const os = platform === 'win32' ? 'windows' : platform;
  const exe = platform === 'win32' ? '.exe' : '';
  if (provider === 'codex') {
    const triple = CODEX_TRIPLE[`${platform}-${arch}`];
    return triple ? [join(root, 'node_modules', '@openai', `codex-${platform}-${arch}`, 'vendor', triple, 'bin', `codex${exe}`)] : [];
  }
  if (provider === 'opencode') {
    return [join(root, 'node_modules', `opencode-${os}-${arch}`, 'bin', `opencode${exe}`), join(root, 'bin', `opencode${exe}`)];
  }
  return [];
}

// The package folder under a global npm prefix (Windows puts the shims in the prefix itself).
const NPM_PACKAGE = { codex: ['@openai', 'codex'], opencode: ['opencode-ai'] };

// Reads two bytes only: the programs themselves are hundreds of megabytes, and this runs on the daemon's event loop.
function startsWithShebang(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The absolute path of the provider's program, or null (D1). Windows: a real .exe, never a .cmd, .bat, .ps1 or a
 * WindowsApps entry. macOS and Linux: the program a PATH entry resolves to; a node launcher script is replaced by the
 * platform binary npm installed beside it when there is one.
 */
export function findProgram(provider, { env = process.env, platform = process.platform, arch = process.arch,
  home = env.HOME || env.USERPROFILE || homedir() } = {}) {
  if (!PROVIDERS.includes(provider)) return null;
  const cpu = ARCH[arch];
  for (const dir of searchDirs(env, platform, home)) {
    const direct = join(dir, platform === 'win32' ? `${provider}.exe` : provider);
    if (executable(direct, platform)) {
      const real = platform === 'win32' ? direct : realPath(direct);
      if (platform === 'win32' || !startsWithShebang(real)) return real;
      // <package>/bin/<launcher>: the package is two levels up.
      const native = cpu && vendorPaths(provider, dirname(dirname(real)), platform, cpu)
        .find(path => executable(path, platform));
      return native ?? real;
    }
    if (platform === 'win32' && cpu && NPM_PACKAGE[provider]) {
      const root = join(dir, 'node_modules', ...NPM_PACKAGE[provider]);
      const native = vendorPaths(provider, root, platform, cpu).find(path => executable(path, platform));
      if (native) return native;
    }
  }
  return null;
}

// --- version and sign-in (D2) ------------------------------------------------------------------------------------

/** The first x.y.z in a program's --version output, or null. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** True when `version` ([x, y, z]) is one discovery ran on or newer (and, for OpenCode, below 2). */
export function versionSupported(provider, version) {
  if (!version || !MIN_VERSIONS[provider]) return false;
  if (compare(version, parseVersion(MIN_VERSIONS[provider])) < 0) return false;
  return provider !== 'opencode' || version[0] < OPENCODE_BEFORE;
}

/**
 * The program's own sign-in check (D2), or null for OpenCode: `opencode auth list` exits 0 whether or not anyone is
 * signed in, so FAI does not ask it, and a signed-out turn fails with OpenCode's own error.
 */
export function statusArgs(provider) {
  if (provider === 'claude') return ['auth', 'status'];
  if (provider === 'codex') return ['login', 'status'];
  return null;
}

/** Signed in, from the status command's exit code (and Claude's JSON, which says loggedIn false on exit 1). */
export function signedIn(provider, { code, stdout }) {
  if (code !== 0) return false;
  if (provider !== 'claude') return true;
  try {
    return JSON.parse(stdout)?.loggedIn !== false;
  } catch {
    return true;
  }
}

// --- the turn's command line (exact lists from shared/f7/chat-discovery.md) --------------------------------------

const toml = value => JSON.stringify(String(value));
const tomlArray = values => `[${values.map(toml).join(',')}]`;

/** A header value that may go on a command line: a non-empty string, no leading -, no control characters. */
export function argumentSafe(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('-') && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

// OpenCode (spec #84 "Tools and files", decision #43): the user's own config folder stays, so their providers, models
// and sign-ins are reachable. --pure leaves out every external plugin (FAI's mode 1 plugin too), project config is
// off, and the turn runs a FAI agent whose tool switches and permission rules come last: FAI's tools only. Each MCP
// server the user's config names is switched off by name; the names come from `opencode debug config` run under the
// same settings just before the turn (opencodeServers).
export const OPENCODE_AGENT = 'fai-browser-chat';

/** The environment OpenCode runs a turn, a model list or a config read under. `disable`: the user's MCP server names. */
export function opencodeEnv({ server, disable = [] }) {
  const only = { tools: { '*': false, [`${SERVER_KEY}_*`]: true }, permission: { '*': 'deny', [`${SERVER_KEY}_*`]: 'allow' } };
  // fromEntries defines own properties, so a server named __proto__ is switched off like any other.
  const mcp = Object.fromEntries([...disable.filter(name => name !== SERVER_KEY).map(name => [name, { enabled: false }]),
    [SERVER_KEY, { type: 'local', command: [server.command, ...server.args], enabled: true }]]);
  const config = { $schema: 'https://opencode.ai/config.json', mcp, ...only,
    agent: { [OPENCODE_AGENT]: { mode: 'primary', description: 'FAI Browser chat', ...only } } };
  return { OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

/** The resolved-config read that names the user's MCP servers. */
export const OPENCODE_CONFIG_ARGS = Object.freeze(['debug', 'config', '--pure']);

/** The MCP server names in `opencode debug config` output, FAI's own excepted. Throws when it is not that output. */
export function opencodeServers(stdout) {
  const config = JSON.parse(stdout);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Not an OpenCode config');
  const mcp = config.mcp ?? {};
  if (typeof mcp !== 'object' || Array.isArray(mcp)) throw new Error('Not an OpenCode config');
  return Object.keys(mcp).filter(name => name !== SERVER_KEY);
}

/**
 * The argument list and extra environment for one turn. `text`: the turn's text (always a FAI template, so it never
 * starts with "-"). `model`: only when the user picked one (D9). `conversationId`: the provider's id to continue (D4).
 * `files`: absolute paths of this message's attached files, handed over by the program's own route (D10): Codex `-i`,
 * OpenCode `-f`; Claude reads them with Read (the turn's text names them). `filesDir`: the chat's files folder (the
 * working folder). `root`: FAI-Local-Chats. `server`: FAI's MCP server {command, args}. `tools`: FAI's tool names.
 * `opencodeServers`: the user's OpenCode MCP server names, switched off. Returns { args, env }: env holds only the
 * variables to add.
 */
export function turnCommand(provider, { text, model = null, conversationId = null, files = [], filesDir, root, server,
  tools, opencodeServers: disable = [], env = {}, platform = process.platform }) {
  // Both come from the chat's header; Codex resume takes the id as a bare positional, where a leading - is an option.
  for (const value of [model, conversationId]) {
    if (value !== null && !argumentSafe(value)) throw new Error('A model or conversation id is not a plain name.');
  }
  // FAI's own absolute paths in the chat's files folder, but checked like any other value on a command line.
  if (files.some(file => !argumentSafe(file))) throw new Error('A file path is not plain.');
  // Paths follow the target platform's rules (the same as this machine's outside tests).
  const pathJoin = (platform === 'win32' ? win32 : posix).join;
  if (provider === 'claude') {
    const config = JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: server.command, args: server.args } } });
    return {
      args: ['-p', text, '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : []),
        '--strict-mcp-config', '--mcp-config', config,
        '--tools', 'Read', '--allowedTools', ...tools.map(tool => `mcp__${SERVER_KEY}__${tool}`),
        '--permission-mode', 'dontAsk', ...(conversationId ? ['--resume', conversationId] : [])],
      env: {},
    };
  }
  if (provider === 'codex') {
    // Codex hands its MCP server only a few variables plus those named here (D7). The daemon location variables too
    // when set (FAI_HOME, FAI_DAEMON_DIR, ...), so the server finds the daemon that started the turn.
    const passed = [TURN_TOKEN_ENV, ...CARRIED_ENV.filter(name => env[name])];
    const sandbox = platform === 'win32'
      ? (conversationId ? ['-c', 'sandbox_mode="read-only"'] : ['--sandbox', 'read-only'])
      : ['-c', `permissions.fai.filesystem={${toml(':minimal')}="read",${toml(filesDir)}="read",`
        + `${toml(pathJoin(root, 'AGENTS.md'))}="read"}`, '-c', 'default_permissions="fai"'];
    // -i takes several values: each one comes right after exec, so the next option (--json) ends the list and a
    // resumed turn's id is never read as an image.
    return {
      args: ['exec', ...(conversationId ? ['resume'] : []), ...files.flatMap(file => ['-i', file]), '--json',
        '--ignore-user-config', '--skip-git-repo-check',
        ...(model ? ['-m', model] : []), ...CODEX_DISABLED.flatMap(feature => ['--disable', feature]),
        '-c', 'web_search="disabled"',
        '-c', `mcp_servers.${SERVER_KEY}.command=${toml(server.command)}`,
        '-c', `mcp_servers.${SERVER_KEY}.args=${tomlArray(server.args)}`,
        '-c', `mcp_servers.${SERVER_KEY}.default_tools_approval_mode="approve"`,
        '-c', `mcp_servers.${SERVER_KEY}.env_vars=${tomlArray(passed)}`,
        ...sandbox,
        ...(conversationId ? [conversationId, text] : ['--', text])],
      env: {},
    };
  }
  if (provider === 'opencode') {
    return {
      args: ['run', '--pure', '--format', 'json', '--agent', OPENCODE_AGENT, '-m', model,
        ...(conversationId ? ['--session', conversationId] : []), ...files.flatMap(file => ['-f', file]), '--', text],
      env: opencodeEnv({ server, disable }),
    };
  }
  throw new Error(`Unknown provider ${provider}`);
}

// --- model lists (D9, decision #30) ------------------------------------------------------------------------------

export const MODEL_LIST_LIMIT = 1000;

/** How a program lists its models: Codex's catalogue, Claude's help (it has no list), OpenCode's list. */
export function modelsCommand(provider, { server }) {
  if (provider === 'codex') return { args: ['debug', 'models'], env: {} };
  if (provider === 'claude') return { args: ['--help'], env: {} };
  if (provider === 'opencode') return { args: ['models', '--pure'], env: opencodeEnv({ server }) };
  throw new Error(`Unknown provider ${provider}`);
}

// Claude's help: the quoted aliases in the --model option's description, up to the next option.
function claudeAliases(stdout) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*--model\b/.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^\s*-/.test(line));
  const block = lines.slice(start, end < 0 ? undefined : end).join(' ');
  return [...block.matchAll(/'([A-Za-z0-9][A-Za-z0-9._-]*)'/g)].map(match => match[1]);
}

// Codex's catalogue: the entries it lists (visibility "list"), in its own order.
function codexModels(stdout) {
  const models = JSON.parse(stdout)?.models;
  if (!Array.isArray(models)) return [];
  return models.filter(model => model?.visibility === 'list' && typeof model.slug === 'string')
    .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : Infinity) - (Number.isFinite(b.priority) ? b.priority : Infinity))
    .map(model => model.slug);
}

// OpenCode: one provider/model per line.
const opencodeModels = stdout => stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[^\s/]+\/\S+$/.test(line));

/**
 * The model names a program's list output gives, as the picker shows them: plain names only, no repeats, at most
 * MODEL_LIST_LIMIT. Throws when there are none (the picker then takes a typed name).
 */
export function parseModels(provider, stdout) {
  const read = { codex: codexModels, claude: claudeAliases, opencode: opencodeModels }[provider];
  if (!read) throw new Error(`Unknown provider ${provider}`);
  const names = [...new Set(read(String(stdout ?? '')))].filter(name => argumentSafe(name) && name.length <= 200);
  if (!names.length) throw new Error('No models listed');
  return names.slice(0, MODEL_LIST_LIMIT);
}

// --- output (D5) -------------------------------------------------------------------------------------------------

const text = value => (typeof value === 'string' ? value : '');

function claudeEvents(line) {
  if (line.type === 'system' && line.subtype === 'init') {
    return [{ type: 'conversation', id: text(line.session_id) }, { type: 'model', name: text(line.model) }];
  }
  if (line.type === 'assistant') {
    // An assistant message that carries `error` is the program's own error (signed out, say), reported by `result`.
    if (line.error) return [];
    const content = Array.isArray(line.message?.content) ? line.message.content : [];
    return content.filter(part => part?.type === 'text' && text(part.text)).map(part => ({ type: 'message', text: part.text }));
  }
  if (line.type === 'result') {
    const events = [{ type: 'conversation', id: text(line.session_id) }];
    if (line.is_error) events.push({ type: 'error', message: text(line.result) || text(line.terminal_reason) });
    return [...events, { type: 'end', ok: !line.is_error }];
  }
  return [];
}

function codexEvents(line) {
  if (line.type === 'thread.started') return [{ type: 'conversation', id: text(line.thread_id) }];
  // item.completed with item.type "error" is a configuration warning, not a failure (D5).
  if (line.type === 'item.completed' && line.item?.type === 'agent_message' && text(line.item.text)) {
    return [{ type: 'message', text: line.item.text }];
  }
  if (line.type === 'error') return [{ type: 'error', message: text(line.message) }];
  if (line.type === 'turn.failed') return [{ type: 'error', message: text(line.error?.message) }, { type: 'end', ok: false }];
  if (line.type === 'turn.completed') return [{ type: 'end', ok: true }];
  return [];
}

function opencodeEvents(line) {
  const events = text(line.sessionID) ? [{ type: 'conversation', id: line.sessionID }] : [];
  if (line.type === 'text' && text(line.part?.text)) events.push({ type: 'message', text: line.part.text });
  if (line.type === 'error') {
    const message = text(line.error?.data?.message) || text(line.error?.name);
    if (message) events.push({ type: 'error', message });
  }
  // OpenCode has no end-of-turn event: the turn ends when the process exits.
  return events;
}

const READERS = { claude: claudeEvents, codex: codexEvents, opencode: opencodeEvents };

/**
 * Reads a provider's output one line at a time. `line(raw)` returns events: {type: 'conversation', id},
 * {type: 'model', name}, {type: 'message', text} (a completed agent message), {type: 'error', message} (the program's
 * own words), {type: 'end', ok}. A conversation or model event is given only when it changes. Tool calls, thinking,
 * partial text and anything not recognised give nothing.
 */
export function createOutputParser(provider) {
  const read = READERS[provider];
  if (!read) throw new Error(`Unknown provider ${provider}`);
  let conversation = null;
  let model = null;
  return {
    line(raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      return read(parsed).filter(event => {
        if (event.type === 'conversation') {
          if (!event.id || event.id === conversation) return false;
          conversation = event.id;
        }
        if (event.type === 'model') {
          if (!event.name || event.name === model) return false;
          model = event.name;
        }
        return true;
      });
    },
  };
}
