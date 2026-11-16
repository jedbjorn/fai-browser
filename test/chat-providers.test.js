// FAI chats' provider adapters (spec #84): the output parsers on the scrubbed discovery fixtures (D5, acceptance 2),
// finding each program without a shell (D1), the version and sign-in checks (D2), and the exact argument lists of
// shared/f7/chat-discovery.md (D3, D4, D6, D7, D9). Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE_CONFIG_ARGS, createOutputParser, findProgram, modelsCommand, opencodeEnv, opencodeServers, parseModels, parseVersion,
  signedIn, turnCommand, versionSupported } from '../src/chat-providers.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'chat-output');

function parse(provider, file) {
  const parser = createOutputParser(provider);
  return readFileSync(join(FIXTURES, file), 'utf8').split('\n').filter(Boolean).flatMap(line => parser.line(line));
}

const messages = events => events.filter(event => event.type === 'message').map(event => event.text);
const ofType = (events, type) => events.filter(event => event.type === type);

test('parsers: each fixture gives its conversation id, the completed agent messages in order and the turn end', () => {
  const cases = [
    ['claude', 'linux-claude-turn.jsonl', ['<string len=418>'], true],
    ['claude', 'linux-claude-resume.jsonl', ['<string len=7>'], true],
    ['claude', 'macos-claude-turn.jsonl', ['<string len=656>'], true],
    ['claude', 'windows-claude-turn.jsonl', ['<string len=905>'], true],
    ['codex', 'linux-codex-turn.jsonl', ['<string len=108>', '<string len=698>'], true],
    ['codex', 'linux-codex-resume.jsonl', ['<string len=7>'], true],
    ['codex', 'macos-codex-turn.jsonl', ['<string len=90>', '<string len=436>'], true],
    ['codex', 'windows-codex-turn.jsonl', ['<string len=114>', '<string len=341>'], true],
    ['opencode', 'linux-opencode-turn.jsonl', ['<string len=282>'], null],
    ['opencode', 'macos-opencode-turn.jsonl', ['<string len=480>'], null],
    ['opencode', 'windows-opencode-turn.jsonl', ['<string len=565>'], null],
  ];
  for (const [provider, file, expected, end] of cases) {
    const events = parse(provider, file);
    assert.deepEqual(messages(events), expected, file);
    const conversations = ofType(events, 'conversation');
    assert.equal(conversations.length, 1, `${file}: the id once`);
    assert.ok(conversations[0].id, file);
    assert.deepEqual(ofType(events, 'end').map(event => event.ok), end === null ? [] : [end], `${file}: turn end`);
    assert.equal(ofType(events, 'error').length, 0, file);
  }
  // Only Claude reports the model it chose (D5): shown when the user picked none.
  assert.deepEqual(ofType(parse('claude', 'linux-claude-turn.jsonl'), 'model'), [{ type: 'model', name: 'claude-sonnet-5-5' }]);
});

test('parsers: a failed turn gives the program\'s own error and no message made of it', () => {
  const signedOut = parse('claude', 'windows-claude-signed-out.jsonl');
  assert.deepEqual(messages(signedOut), [], 'the assistant line that carries `error` is not an agent message');
  assert.deepEqual(ofType(signedOut, 'error'), [{ type: 'error', message: '<string len=33>' }]);
  assert.deepEqual(ofType(signedOut, 'end'), [{ type: 'end', ok: false }]);

  const refused = parse('codex', 'linux-codex-model-refused.jsonl');
  assert.deepEqual(messages(refused), [], 'a configuration warning (item type error) is neither message nor failure');
  assert.deepEqual(ofType(refused, 'error').map(event => event.message), ['<string len=73>', '<string len=73>']);
  assert.deepEqual(ofType(refused, 'end'), [{ type: 'end', ok: false }]);

  const providerError = parse('opencode', 'linux-opencode-provider-error.jsonl');
  assert.equal(ofType(providerError, 'error').length, 1);
  const binary = parse('opencode', 'windows-opencode-binary-refused.jsonl');
  assert.deepEqual(ofType(binary, 'error'), [{ type: 'error', message: '<string len=74>' }]);
  assert.deepEqual(messages(binary), ['<string len=181>'], 'the agent still answers after OpenCode\'s error');
});

test('parsers: tool calls, thinking, tool results and unknown output give nothing', () => {
  for (const provider of ['claude', 'codex', 'opencode']) {
    const parser = createOutputParser(provider);
    for (const raw of ['', 'not json', '[1,2]', 'null', '42', '{"type":"mystery","text":"x"}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"t"},{"type":"tool_use","name":"Bash"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"secret"}]}}',
      '{"type":"item.completed","item":{"type":"mcp_tool_call","result":{"content":[{"type":"text","text":"r"}]}}}',
      '{"type":"item.started","item":{"type":"agent_message","text":"partial"}}',
      '{"type":"tool_use","part":{"tool":"fai_x","state":{"output":"o"}}}']) {
      assert.deepEqual(parser.line(raw), [], `${provider}: ${raw}`);
    }
  }
  // Claude: every text part of one assistant message, in order.
  const parser = createOutputParser('claude');
  assert.deepEqual(parser.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' },
    { type: 'tool_use' }, { type: 'text', text: 'b' }] } })).map(event => event.text), ['a', 'b']);
});

test('versions: parsed from each program\'s --version; discovery\'s versions or newer; OpenCode below 2', () => {
  assert.deepEqual(parseVersion('2.1.325 (Claude Code)'), [2, 1, 325]);
  assert.deepEqual(parseVersion('codex-cli 0.169.0'), [0, 169, 0]);
  assert.equal(parseVersion('no version'), null);
  assert.equal(versionSupported('claude', [2, 1, 325]), true);
  assert.equal(versionSupported('claude', [2, 1, 324]), false);
  assert.equal(versionSupported('claude', [3, 0, 0]), true);
  assert.equal(versionSupported('codex', [0, 169, 0]), true);
  assert.equal(versionSupported('codex', [0, 168, 99]), false);
  assert.equal(versionSupported('opencode', [1, 19, 5]), true);
  assert.equal(versionSupported('opencode', [1, 20, 0]), true);
  assert.equal(versionSupported('opencode', [1, 19, 4]), false);
  assert.equal(versionSupported('opencode', [2, 3, 0]), false, 'OpenCode 2.x is feature #9');
  assert.equal(versionSupported('claude', null), false);
});

test('sign-in: the program\'s own status command and its exit status (D2)', () => {
  assert.equal(signedIn('claude', { code: 0, stdout: '{"loggedIn":true}' }), true);
  assert.equal(signedIn('claude', { code: 1, stdout: '{"loggedIn":false}' }), false);
  assert.equal(signedIn('claude', { code: 0, stdout: '{"loggedIn":false}' }), false);
  assert.equal(signedIn('codex', { code: 0, stdout: 'Logged in using ChatGPT' }), true);
  assert.equal(signedIn('codex', { code: 1, stdout: 'Not logged in' }), false);
});

async function exe(path, content = '\x7fELF') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

test('finding the program (D1): PATH, then where installers put it; never a relative PATH entry', { skip: process.platform === 'win32' }, async t => {
  // Resolved: findProgram returns real paths, and macOS's temporary folder is behind a symlink.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fai-chat-find-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  await exe(join(dir, 'bin', 'claude'));
  await writeFile(join(dir, 'bin', 'codex'), 'not executable');
  const env = { PATH: `relative-dir:${join(dir, 'bin')}`, HOME: home };
  assert.equal(findProgram('claude', { env, platform: 'linux', home }), join(dir, 'bin', 'claude'));
  // OpenCode's installer puts it in ~/.opencode/bin, which a browser-started daemon may not have on PATH.
  await exe(join(home, '.opencode', 'bin', 'opencode'));
  assert.equal(findProgram('opencode', { env, platform: 'linux', home }), join(home, '.opencode', 'bin', 'opencode'));
  assert.equal(findProgram('nope', { env, platform: 'linux', home }), null);
  // Too short to be a launcher script: the program itself (only its first two bytes are read).
  await exe(join(dir, 'bin2', 'codex'), '#');
  assert.equal(findProgram('codex', { env: { PATH: join(dir, 'bin2'), HOME: home }, platform: 'linux', home }),
    join(dir, 'bin2', 'codex'));
});

test('finding the program (D1): npm\'s node launcher is replaced by the platform binary beside it', { skip: process.platform === 'win32' }, async t => {
  // Resolved: findProgram returns real paths, and macOS's temporary folder is behind a symlink.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fai-chat-npm-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'lib', 'node_modules', '@openai', 'codex');
  await exe(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
  const vendor = join(pkg, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  await exe(vendor);
  await mkdir(join(dir, 'bin'));
  await symlink(join(pkg, 'bin', 'codex.js'), join(dir, 'bin', 'codex'));
  const env = { PATH: join(dir, 'bin') };
  assert.equal(findProgram('codex', { env, platform: 'darwin', arch: 'arm64', home: join(dir, 'home') }), vendor);
});

test('finding the program (D1) on Windows: a real .exe only, the npm platform package, never a shim or WindowsApps', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fai-chat-win-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const npm = join(dir, 'npm');
  await exe(join(npm, 'codex.cmd'));
  await exe(join(npm, 'claude.cmd'));
  await exe(join(npm, 'opencode.cmd'));
  const codex = join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor',
    'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const opencode = join(npm, 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe');
  await exe(codex);
  await exe(opencode);
  const apps = join(dir, 'WindowsApps');
  await exe(join(apps, 'claude.exe'));
  const profile = join(dir, 'profile');
  const env = { PATH: [apps, npm].join(';'), USERPROFILE: profile, APPDATA: join(dir, 'roaming') };
  const options = { env, platform: 'win32', arch: 'x64', home: profile };
  assert.equal(findProgram('codex', options), codex);
  assert.equal(findProgram('opencode', options), opencode);
  assert.equal(findProgram('claude', options), null, 'claude.cmd and a WindowsApps claude.exe are refused');
  // Claude's standalone installer: %USERPROFILE%\.local\bin\claude.exe, found even when not on PATH.
  await exe(join(profile, '.local', 'bin', 'claude.exe'));
  assert.equal(findProgram('claude', options), join(profile, '.local', 'bin', 'claude.exe'));
});

const SERVER = { command: '/usr/bin/node', args: ['/fai/src/mcp-main.js'] };
const TOOLS = ['fai_browser_open', 'fai_browser_act'];
const BASE = { text: '[FAI Browser] hi', filesDir: '/home/u/FAI-Local-Chats/chats/c1/files', root: '/home/u/FAI-Local-Chats',
  server: SERVER, tools: TOOLS };

test('Claude: the exact argument list; a model only when picked; --resume by id', () => {
  const config = '{"mcpServers":{"fai":{"command":"/usr/bin/node","args":["/fai/src/mcp-main.js"]}}}';
  const tail = ['--strict-mcp-config', '--mcp-config', config, '--tools', 'Read', '--allowedTools',
    'mcp__fai__fai_browser_open', 'mcp__fai__fai_browser_act', '--permission-mode', 'dontAsk'];
  assert.deepEqual(turnCommand('claude', { ...BASE, platform: 'linux' }),
    { args: ['-p', '[FAI Browser] hi', '--output-format', 'stream-json', '--verbose', ...tail], env: {} });
  assert.deepEqual(turnCommand('claude', { ...BASE, model: 'sonnet', conversationId: 'sess-1', platform: 'win32' }).args,
    ['-p', '[FAI Browser] hi', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', ...tail, '--resume', 'sess-1']);
});

const CODEX_FLAGS = ['--json', '--ignore-user-config', '--skip-git-repo-check'];
const CODEX_FEATURES = ['--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'plugins',
  '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'computer_use', '--disable',
  'image_generation', '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'goals', '--disable',
  'sleep_tool', '--disable', 'tool_suggest', '--disable', 'skill_search', '-c', 'web_search="disabled"',
  // FAI-Local-Chats is the project root, so Codex loads its AGENTS.md; no request_user_input tools.
  '-c', 'project_root_markers=["AGENTS.md"]', '-c', 'tools.experimental_request_user_input.enabled=false',
  '-c', 'mcp_servers.fai.command="/usr/bin/node"', '-c', 'mcp_servers.fai.args=["/fai/src/mcp-main.js"]',
  '-c', 'mcp_servers.fai.default_tools_approval_mode="approve"'];

test('Codex: the exact argument list per OS; env_vars carries the turn token (D7); resume by thread id', () => {
  const profile = ['-c', 'permissions.fai.filesystem={":minimal"="read","/home/u/FAI-Local-Chats/chats/c1/files"="read",'
    + '"/home/u/FAI-Local-Chats/AGENTS.md"="read"}', '-c', 'default_permissions="fai"'];
  const tokenOnly = ['-c', 'mcp_servers.fai.env_vars=["FAI_CHAT_TURN_TOKEN"]'];
  assert.deepEqual(turnCommand('codex', { ...BASE, platform: 'linux' }),
    { args: ['exec', ...CODEX_FLAGS, ...CODEX_FEATURES, ...tokenOnly, ...profile, '--', '[FAI Browser] hi'], env: {} });
  assert.deepEqual(turnCommand('codex', { ...BASE, platform: 'darwin', model: 'gpt-6.1-sol', conversationId: 'thread-1' }).args,
    ['exec', 'resume', ...CODEX_FLAGS, '-m', 'gpt-6.1-sol', ...CODEX_FEATURES, ...tokenOnly, ...profile, 'thread-1',
      '[FAI Browser] hi']);
  assert.deepEqual(turnCommand('codex', { ...BASE, platform: 'win32' }).args,
    ['exec', ...CODEX_FLAGS, ...CODEX_FEATURES, ...tokenOnly, '--sandbox', 'read-only', '--', '[FAI Browser] hi']);
  // resume has no --sandbox (D4).
  assert.deepEqual(turnCommand('codex', { ...BASE, platform: 'win32', conversationId: 'thread-1', env: { FAI_HOME: '/fai-home' } }).args,
    ['exec', 'resume', ...CODEX_FLAGS, ...CODEX_FEATURES, '-c', 'mcp_servers.fai.env_vars=["FAI_CHAT_TURN_TOKEN","FAI_HOME"]',
      '-c', 'sandbox_mode="read-only"', 'thread-1', '[FAI Browser] hi']);
  // Every daemon location variable that is set, so the turn's server reaches the daemon that started it.
  assert.ok(turnCommand('codex', { ...BASE, platform: 'linux', env: { FAI_DAEMON_DIR: '/d', FAI_BRIDGE_PORT: '2' } }).args
    .includes('mcp_servers.fai.env_vars=["FAI_CHAT_TURN_TOKEN","FAI_DAEMON_DIR","FAI_BRIDGE_PORT"]'));
});

test('a header value that would read as an option or carries control characters never reaches the command line', () => {
  for (const provider of ['claude', 'codex', 'opencode']) {
    assert.throws(() => turnCommand(provider, { ...BASE, platform: 'linux', model: 'p/m', conversationId: '--help' }));
    assert.throws(() => turnCommand(provider, { ...BASE, platform: 'linux', model: '-x' }));
    assert.throws(() => turnCommand(provider, { ...BASE, platform: 'linux', model: 'p/m', conversationId: 'a\nb' }));
  }
  assert.ok(turnCommand('codex', { ...BASE, platform: 'linux', model: 'gpt-6.1-sol', conversationId: 'thread-1' }));
});

test('OpenCode: the exact argument list, its isolation settings (decision #43), and --session by id', () => {
  const linux = turnCommand('opencode', { ...BASE, platform: 'linux', model: 'ollama-cloud/deepseek-v4.1-flash:1017',
    opencodeServers: ['dev_browser', 'fai-browser', '__proto__'] });
  assert.deepEqual(linux.args, ['run', '--pure', '--format', 'json', '--agent', 'fai-browser-chat',
    '-m', 'ollama-cloud/deepseek-v4.1-flash:1017', '--', '[FAI Browser] hi']);
  assert.equal(linux.env.XDG_CONFIG_HOME, undefined, 'the user\'s own config folder stays: their providers are kept');
  assert.equal(linux.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  const only = { tools: { '*': false, 'fai_*': true }, permission: { '*': 'deny', 'fai_*': 'allow' } };
  const config = JSON.parse(linux.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config, {
    $schema: 'https://opencode.ai/config.json',
    // Every MCP server of the user's is switched off by name; FAI's own is the one left on.
    mcp: { dev_browser: { enabled: false }, 'fai-browser': { enabled: false }, ['__proto__']: { enabled: false },
      fai: { type: 'local', command: ['/usr/bin/node', '/fai/src/mcp-main.js'], enabled: true } },
    ...only, instructions: ['/home/u/FAI-Local-Chats/AGENTS.md'],
    agent: { 'fai-browser-chat': { mode: 'primary', description: 'FAI Browser chat', ...only } } });
  assert.ok(Object.hasOwn(config.mcp, '__proto__'), 'a server named __proto__ is switched off too');
  const windows = turnCommand('opencode', { ...BASE, platform: 'win32', model: 'p/m', conversationId: 'ses_1' });
  assert.deepEqual(windows.args, ['run', '--pure', '--format', 'json', '--agent', 'fai-browser-chat', '-m', 'p/m',
    '--session', 'ses_1', '--', '[FAI Browser] hi']);
  assert.deepEqual(Object.keys(JSON.parse(windows.env.OPENCODE_CONFIG_CONTENT).mcp), ['fai']);
  assert.deepEqual(JSON.parse(turnCommand('opencode', { ...BASE, root: 'C:\\Users\\u\\FAI-Local-Chats', platform: 'win32',
    model: 'p/m' }).env.OPENCODE_CONFIG_CONTENT).instructions, ['C:\\Users\\u\\FAI-Local-Chats\\AGENTS.md'],
  'FAI-Local-Chats/AGENTS.md by its absolute path: OpenCode does not look above the working folder for it');
  // A model list or config read carries no instructions.
  assert.equal(JSON.parse(opencodeEnv({ server: SERVER }).OPENCODE_CONFIG_CONTENT).instructions, undefined);
});

test('OpenCode: the user\'s MCP server names come from its resolved config, FAI\'s own excepted; only names are kept', () => {
  assert.deepEqual(opencodeServers(JSON.stringify({ provider: { x: { options: { apiKey: 'k' } } },
    mcp: { dev_browser: { type: 'local' }, fai: { type: 'local' }, remote: { type: 'remote' } } })), ['dev_browser', 'remote']);
  assert.deepEqual(opencodeServers('{"$schema":"x"}'), []);
  assert.deepEqual(OPENCODE_CONFIG_ARGS, ['debug', 'config', '--pure']);
  for (const bad of ['', 'not json', '[]', '{"mcp":[]}', 'null']) assert.throws(() => opencodeServers(bad));
});

test('attached files reach the program by its own route (D10): Codex -i, OpenCode -f, Claude reads the named path', () => {
  const files = ['/home/u/FAI-Local-Chats/chats/c1/files/a.png', '/home/u/FAI-Local-Chats/chats/c1/files/b (2).pdf'];
  const claude = turnCommand('claude', { ...BASE, platform: 'linux', files });
  assert.deepEqual(claude, turnCommand('claude', { ...BASE, platform: 'linux' }), 'Claude: no extra argument, Read finds them');
  // -i takes several values: it comes right after exec (or exec resume), and --json ends it, so a thread id is not one.
  assert.deepEqual(turnCommand('codex', { ...BASE, platform: 'linux', files }).args.slice(0, 6),
    ['exec', '-i', files[0], '-i', files[1], '--json']);
  const resumed = turnCommand('codex', { ...BASE, platform: 'linux', files, conversationId: 'thread-1' }).args;
  assert.deepEqual(resumed.slice(0, 7), ['exec', 'resume', '-i', files[0], '-i', files[1], '--json']);
  assert.deepEqual(resumed.slice(-2), ['thread-1', '[FAI Browser] hi']);
  assert.deepEqual(turnCommand('opencode', { ...BASE, platform: 'linux', model: 'p/m', conversationId: 's1', files }).args.slice(-8),
    ['--session', 's1', '-f', files[0], '-f', files[1], '--', '[FAI Browser] hi']);
  assert.throws(() => turnCommand('codex', { ...BASE, platform: 'linux', files: ['-x'] }));
});

test('model lists (decision #30): Codex\'s visible catalogue in its order, Claude\'s help aliases, OpenCode\'s list', () => {
  assert.deepEqual(modelsCommand('codex', { server: SERVER }), { args: ['debug', 'models'], env: {} });
  assert.deepEqual(modelsCommand('claude', { server: SERVER }), { args: ['--help'], env: {} });
  const opencode = modelsCommand('opencode', { server: SERVER });
  assert.deepEqual(opencode.args, ['models', '--pure'], 'listed under the settings a turn uses');
  assert.equal(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT).agent['fai-browser-chat'].permission['*'], 'deny');

  assert.deepEqual(parseModels('codex', JSON.stringify({ models: [
    { slug: 'gpt-6-astra', visibility: 'list', priority: 2 }, { slug: 'gpt-reserve', visibility: 'hide', priority: 5 },
    { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 }, { slug: '-bad', visibility: 'list', priority: 3 }] })),
  ['gpt-6.1-sol', 'gpt-6-astra']);
  const help = ['Options:', '  --mcp-config <configs...>     Load MCP servers (\'a\')',
    '  --model <model>                       Model for the current session. Provide',
    '                                        an alias for the latest model (e.g.',
    '                                        \'fable\', \'opus\', or \'sonnet\') or a',
    '                                        model\'s full name.',
    '  --permission-mode <mode>              Permission mode (\'default\')'].join('\n');
  assert.deepEqual(parseModels('claude', help), ['fable', 'opus', 'sonnet'], 'Claude 2.1.325\'s help, read live');
  assert.deepEqual(parseModels('opencode', 'opencode/big-pickle\nollama-cloud/deepseek-v4.1-flash:1017\nnot a model\n\nopencode/big-pickle\n'),
    ['opencode/big-pickle', 'ollama-cloud/deepseek-v4.1-flash:1017']);
  for (const [provider, output] of [['codex', 'not json'], ['codex', '{"models":[]}'], ['claude', 'Usage: claude'],
    ['opencode', '']]) {
    assert.throws(() => parseModels(provider, output), undefined, `${provider}: nothing listed, so the picker takes a typed name`);
  }
});
