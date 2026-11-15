import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHosts, InstallError, MCP_ENTRY, OPENCODE_PLUGIN_SOURCE, registerHost, registrationSummary } from '../src/install.js';
import { wakeReason } from '../src/wake.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'fai desktop 100% '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const local = join(home, 'AppData', 'Local');
  const env = { LOCALAPPDATA: local, PATH: '', PATHEXT: '.exe;.cmd' };
  const file = (...parts) => {
    const path = join(...parts);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'fixture');
    return path;
  };
  return { home, local, env, file,
    detect: (overrides = {}) => detectHosts({ home, env, platform: 'win32', exec: () => '', ...overrides }) };
}

test('Windows desktop-only installs are detected in discovery locations without a command on PATH', t => {
  const { local, file, detect } = fixture(t);
  file(local, 'AnthropicClaude', 'claude.exe');
  file(local, 'Programs', '@opencode-aidesktop', 'OpenCode.exe');
  assert.deepEqual(detect({ exec: () => 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_version_family\r\n' }), [
    { host: 'claude', name: 'Claude (Code tab)', path: null, desktop: 'Claude (Code tab)' },
    { host: 'codex', name: 'ChatGPT (Codex)', path: null, desktop: 'ChatGPT (Codex)' },
    { host: 'opencode', name: 'OpenCode Desktop', path: null, desktop: 'OpenCode Desktop' },
  ]);
  assert.deepEqual(detect({ platform: 'linux' }), [], 'desktop detection is Windows-only');
});

test('ChatGPT local install and LOCALAPPDATA fallback; unrelated Store packages are ignored', t => {
  const { home, local, env, detect } = fixture(t);
  mkdirSync(join(local, 'Packages', 'OpenAI.ChatGPT-Desktop_other'), { recursive: true });
  assert.deepEqual(detect(), []);
  mkdirSync(join(local, 'OpenAI', 'Codex'), { recursive: true });
  assert.equal(detect({ env: { ...env, LOCALAPPDATA: undefined }, home })[0].name, 'ChatGPT (Codex)');
});

test('Store discovery queries the current user without a shell and works before the app is launched', t => {
  const { local, env, detect } = fixture(t);
  assert.equal(existsSync(local), false);
  const found = detect({ exec: (file, args, options) => {
    assert.ok(file.endsWith('powershell.exe'));
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command',
      'Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation']);
    assert.equal(options.shell, undefined);
    assert.equal(options.env, env);
    assert.equal(options.timeout, 5000);
    return 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_version_family\r\n';
  } });
  assert.equal(found[0].name, 'ChatGPT (Codex)');
  assert.equal(found[0].path, null);
});

test('a failed Store query still detects local apps and does not invent a ChatGPT install', t => {
  const { local, file, detect } = fixture(t);
  const exec = () => { throw new Error('Store service unavailable'); };
  file(local, 'AnthropicClaude', 'claude.exe');
  assert.deepEqual(detect({ exec }).map(host => host.host), ['claude']);
  mkdirSync(join(local, 'OpenAI', 'Codex'), { recursive: true });
  assert.deepEqual(detect({ exec }).map(host => host.host), ['claude', 'codex']);
});

test('desktop and CLI detection produce one registration per shared config, preserving CLI-only behavior', t => {
  const { home, local, env, file, detect } = fixture(t);
  const bin = join(home, 'bin');
  const claude = file(bin, 'claude.exe');
  const codex = file(bin, 'codex.cmd');
  env.PATH = bin;
  assert.deepEqual(detect(), [
    { host: 'claude', name: 'Claude Code', path: claude },
    { host: 'codex', name: 'Codex', path: codex },
  ]);
  file(local, 'AnthropicClaude', 'claude.exe');
  mkdirSync(join(local, 'OpenAI', 'Codex'), { recursive: true });
  const found = detect();
  assert.equal(found.length, 2);
  assert.equal(found[0].path, claude, 'the desktop launcher must never be run as the CLI');
  assert.equal(found[0].name, 'Claude Code and Claude (Code tab)');
  assert.equal(found[1].name, 'Codex and ChatGPT (Codex)');
});

test('Claude desktop uses its downloaded Code CLI without PATH and prefers the newest complete version', async t => {
  const { home, local, env, file, detect } = fixture(t);
  file(local, 'AnthropicClaude', 'claude.exe');
  const root = join(home, 'AppData', 'Roaming', 'Claude', 'claude-code');
  file(root, '2.9.0', 'abc123', 'claude.exe');
  const cli = file(root, '2.10.0', 'def456', 'claude.exe');
  mkdirSync(join(root, '2.11.0', 'abc123'), { recursive: true }); // interrupted download
  file(root, 'unrelated', 'abc123', 'claude.exe');
  file(root, '2.12.0', 'unrelated', 'claude.exe');
  assert.deepEqual(detect(), [{ host: 'claude', name: 'Claude (Code tab)', path: cli, desktop: 'Claude (Code tab)' }]);
  const calls = [];
  await registerHost('claude', { home, cwd: home, env, platform: 'win32', run: (path, args) => calls.push([path, args]) });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([path]) => path === cli), 'registration runs the Code CLI, never the desktop launcher');
  assert.equal(calls[1][1][1], 'add-json');
  assert.equal(existsSync(join(home, '.claude.json')), false, 'FAI does not directly write the user config');
  env.PATH = join(home, 'bin');
  const standalone = file(env.PATH, 'claude.exe');
  assert.equal(detect()[0].path, standalone, 'a standalone CLI on PATH still takes precedence');
});

test('Claude downloaded Code CLI honours APPDATA and is ignored on non-Windows systems', t => {
  const { home, env, file, detect } = fixture(t);
  env.APPDATA = join(home, 'custom roaming');
  const cli = file(env.APPDATA, 'Claude', 'claude-code', '2.1.325', '806e0a45e6f5', 'claude.exe');
  assert.equal(detect()[0].path, cli);
  assert.deepEqual(detect({ platform: 'linux' }), []);
});

test('desktop-only ChatGPT and OpenCode get user config, skills and plugin, with an idempotent rerun', async t => {
  const { home, local, env, file, detect } = fixture(t);
  mkdirSync(join(local, 'OpenAI', 'Codex'), { recursive: true });
  file(local, 'Programs', '@opencode-aidesktop', 'OpenCode.exe');
  const oc = join(home, '.config', 'opencode', 'opencode.json');
  file(home, '.config', 'opencode', 'opencode.json');
  writeFileSync(oc, JSON.stringify({ model: 'keep-me', mcp: { existing: { type: 'remote', url: 'https://example.com' } } }));
  for (const found of detect()) {
    const options = { home, cwd: home, env, platform: 'win32', claudePath: found.path,
      run: () => assert.fail('desktop config registration must not execute the app') };
    await registerHost(found.host, options);
    const rerun = await registerHost(found.host, options);
    assert.ok(rerun.writes.every(write => write.action === 'unchanged'));
  }
  const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /\[mcp_servers.fai-browser\]/);
  assert.ok(codex.includes(JSON.stringify(MCP_ENTRY)));
  const config = JSON.parse(readFileSync(oc, 'utf8'));
  assert.equal(config.model, 'keep-me');
  assert.equal(config.mcp.existing.url, 'https://example.com');
  assert.deepEqual(config.mcp['fai-browser'].command, [process.execPath, MCP_ENTRY]);
  assert.ok(existsSync(join(home, '.config', 'opencode', 'plugins', 'fai-browser.js')));
  assert.ok(existsSync(join(home, '.agents', 'skills', 'fai-browser', 'SKILL.md')));
  assert.equal(readdirSync(join(home, '.config', 'opencode')).filter(name => name.includes('.bak-')).length, 1);
});

test('OpenCode JSONC refusal preserves config and explains the manual snippet and wake plugin step', async t => {
  const { home, env, file } = fixture(t);
  const config = file(home, '.config', 'opencode', 'opencode.jsonc');
  const original = '// Keep provider and model configuration\n{"model":"keep-me"}\n';
  writeFileSync(config, original);
  await assert.rejects(registerHost('opencode', { home, env, platform: 'win32' }), error => {
    assert.ok(error instanceof InstallError);
    assert.equal(error.path, config);
    assert.match(error.message, /ask your agent to add the printed snippet/);
    assert.ok(error.message.includes(OPENCODE_PLUGIN_SOURCE));
    assert.ok(error.message.includes(join(home, '.config', 'opencode', 'plugins', 'fai-browser.js')));
    assert.ok(JSON.parse(error.snippet).mcp['fai-browser']);
    return true;
  });
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.equal(existsSync(join(home, '.config', 'opencode', 'opencode.json')), false);
  assert.equal(existsSync(join(home, '.config', 'opencode', 'plugins', 'fai-browser.js')), false);
  assert.equal(wakeReason({ host: 'opencode', env: {}, platform: 'win32' }), 'opencode_no_plugin');
  for (const names of [[], ['Claude (Code tab)', 'ChatGPT (Codex)']]) {
    const summary = registrationSummary(names, { opencodeManual: true });
    assert.ok(summary.startsWith(registrationSummary(names)));
    assert.match(summary, /OpenCode was not auto-registered because opencode\.jsonc exists/);
    assert.match(summary, /OpenCode needs one manual step:.*printed snippet and wake-plugin instructions/);
  }
});

test('Claude desktop without the CLI prints manual registration and never edits live Claude config or runs the launcher', async t => {
  const { home, local, env, file, detect } = fixture(t);
  file(local, 'AnthropicClaude', 'claude.exe');
  const config = file(home, '.claude.json');
  const original = '{"runningSession":"leave intact","mcpServers":{"other":{}}}\n';
  writeFileSync(config, original);
  await assert.rejects(registerHost('claude', { home, cwd: home, env, platform: 'win32', claudePath: detect()[0].path,
    run: () => assert.fail('no CLI is available') }), error => {
    assert.ok(error instanceof InstallError);
    assert.match(error.message, /install the Claude Code CLI/);
    assert.match(error.snippet, /claude mcp add --scope user fai-browser/);
    return true;
  });
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.equal(existsSync(join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')), false,
    'plain Claude Desktop chat is excluded');
});

test('Claude command failure is a registration failure, with a manual command and untouched config', async t => {
  const { home, env, file } = fixture(t);
  const cli = file(home, 'bin', 'claude.exe');
  const config = file(home, '.claude.json');
  const calls = [];
  await assert.rejects(registerHost('claude', { home, cwd: home, env, platform: 'win32', claudePath: cli,
    run: (path, args) => { calls.push([path, args]); throw new Error('host command failed'); } }), error => {
    assert.match(error.message, /add-json failed/);
    assert.match(error.snippet, /claude mcp add --scope user/);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(readFileSync(config, 'utf8'), 'fixture');
});

test('closing summary names registered apps and gives a distinct result when none registered', () => {
  assert.equal(registrationSummary(['ChatGPT (Codex)', 'OpenCode Desktop']),
    'Registered apps: ChatGPT (Codex), OpenCode Desktop. Restart them so they load FAI Browser.');
  assert.equal(registrationSummary([]),
    'Registered apps: none. Connect your coding agent using the setup instructions above.');
});
