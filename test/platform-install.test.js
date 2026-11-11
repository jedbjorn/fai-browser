// The platform branches of setup, run for real on the system the test runs on (the Windows and macOS CI jobs run this
// file there): registering with Claude Code through its command (a Windows batch shim goes through cmd.exe), npm for
// the updater, the native messaging launcher a browser starts (pairing over its stdio, starting the FAI service), and
// on GitHub's Windows runner the real HKCU registry values. Every path is under a temporary directory with a space and
// a percent sign in its name; the daemon runs on a free port with its own FAI_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_EXTENSION_ID } from '../src/bridge.js';
import { FaiBrowserClient, probeHealth } from '../src/client.js';
import { MCP_ENTRY, SERVER_NAME, batchCommandLine, claudeAddArgs, claudeAddCommandWindows, commandRunner, hostEntry,
  isBatchFile, planInstall, registerHost, stampedSkill } from '../src/install.js';
import { applyNativeInstall, launcherFile, planNativeInstall, uninstallNative } from '../src/native.js';
import { decodeMessages, encodeMessage } from '../src/native-host.js';
import { saveSettings } from '../src/settings.js';
import { npmCommand } from '../src/update-install.js';

const WINDOWS = process.platform === 'win32';
const CHROME_ORIGIN = `chrome-extension://${PINNED_EXTENSION_ID}/`;

function scratch(t, prefix = 'fai platform 100% ') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// --- registering with Claude Code -------------------------------------------------------------------------------------

test('claude registration: add-json for a program, plain `mcp add` arguments for a Windows batch shim', async t => {
  const env = { FAI_HOME: 'C:\\Users\\Ada Lovelace\\fai home' };
  const server = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\fai browser\\src\\mcp-main.js'],
    env: { FAI_HOME: env.FAI_HOME } };
  assert.deepEqual(claudeAddArgs(server), ['mcp', 'add', '--scope', 'user', SERVER_NAME, '-e', `FAI_HOME=${env.FAI_HOME}`,
    '--', server.command, ...server.args]);
  assert.deepEqual(claudeAddArgs({ ...server, env: undefined }).slice(4), [SERVER_NAME, '--', server.command, ...server.args]);
  assert.equal(isBatchFile('C:\\npm\\claude.cmd', 'win32'), true);
  assert.equal(isBatchFile('C:\\npm\\CLAUDE.BAT', 'win32'), true);
  assert.equal(isBatchFile('C:\\Users\\a\\.local\\bin\\claude.exe', 'win32'), false);
  assert.equal(isBatchFile('/usr/local/bin/claude.cmd', 'linux'), false);
  // cmd.exe: every part quoted; a part with % (variable expansion) or " (ends the quoting) is refused, never escaped.
  assert.equal(batchCommandLine('C:\\npm dir\\claude.cmd', ['mcp', 'add', 'C:\\a b\\x.js']),
    '"C:\\npm dir\\claude.cmd" "mcp" "add" "C:\\a b\\x.js"');
  assert.throws(() => batchCommandLine('claude.cmd', ['100%']), /through cmd\.exe safely/);
  assert.throws(() => batchCommandLine('claude.cmd', ['{"a":1}']), /through cmd\.exe safely/);
  const calls = [];
  const exec = (file, args, options) => calls.push({ file, args, shell: options.shell ?? false });
  commandRunner({ platform: 'win32', exec })('C:\\npm\\claude.cmd', ['mcp', 'list']);
  commandRunner({ platform: 'win32', exec })('C:\\bin\\claude.exe', ['mcp', 'list']);
  assert.deepEqual(calls, [{ file: '"C:\\npm\\claude.cmd" "mcp" "list"', args: [], shell: true },
    { file: 'C:\\bin\\claude.exe', args: ['mcp', 'list'], shell: false }]);
  // The command printed for a Windows user is plain `claude mcp add` lines, quoted for PowerShell and cmd alike.
  const printed = claudeAddCommandWindows(server);
  assert.match(printed, /^claude mcp remove --scope user fai-browser\nclaude mcp add --scope user fai-browser -e "FAI_HOME=C:\\Users\\Ada Lovelace\\fai home" -- "C:\\Program Files\\nodejs\\node\.exe" "C:\\fai browser\\src\\mcp-main\.js"\n$/);
  const home = scratch(t);
  const windowsPlan = planInstall({ host: 'claude', scope: 'user', cwd: home, home, env, platform: 'win32' });
  assert.equal(windowsPlan.command, claudeAddCommandWindows(windowsPlan.server).trimEnd());
  const linuxPlan = planInstall({ host: 'claude', scope: 'user', cwd: home, home, env, platform: 'linux' });
  assert.match(linuxPlan.command, /2>\/dev\/null; claude mcp add-json/);
  // registerHost with a recorded runner: the batch shim gets `mcp add`, a program `mcp add-json`.
  for (const [claudePath, platform, expectJson] of [['C:\\npm\\claude.cmd', 'win32', false], ['/usr/bin/claude', 'linux', true]]) {
    const ran = [];
    await registerHost('claude', { env, home, cwd: home, claudePath, platform, run: (file, args) => ran.push([file, ...args]) });
    assert.deepEqual(ran[0], [claudePath, 'mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    assert.equal(ran[1][2], expectJson ? 'add-json' : 'add');
  }
});

test('claude registration runs the real command on this system (a batch shim through cmd.exe on Windows)', async t => {
  // No % here: cmd.exe would expand it, so registerHost refuses such a path (the unit test above covers that).
  const base = scratch(t, 'fai platform ');
  const bin = join(base, 'npm bin');
  mkdirSync(bin);
  const record = join(base, 'calls.jsonl');
  const dump = join(base, 'dump.cjs');
  writeFileSync(dump, `require('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  let claudePath;
  if (WINDOWS) {
    // What npm writes for a global package: a batch file that forwards %* to node.
    claudePath = join(bin, 'claude.cmd');
    writeFileSync(claudePath, `@ECHO off\r\n"${process.execPath}" "${dump}" %*\r\n`);
  } else {
    claudePath = join(bin, 'claude');
    writeFileSync(claudePath, `#!/bin/sh\nexec "${process.execPath}" "${dump}" "$@"\n`);
    chmodSync(claudePath, 0o755);
  }
  const fai = join(base, 'fai home');
  const env = { ...process.env, FAI_HOME: fai };
  const home = join(base, 'home');
  mkdirSync(home);
  await registerHost('claude', { env, home, cwd: base, claudePath });
  const calls = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls[0], ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
  const server = { command: process.execPath, args: [MCP_ENTRY], env: { FAI_HOME: fai } };
  if (WINDOWS) {
    assert.deepEqual(calls[1], claudeAddArgs(server), 'every argument arrives intact through cmd.exe');
  } else {
    assert.deepEqual(calls[1].slice(0, 4), ['mcp', 'add-json', '--scope', 'user']);
    assert.deepEqual(JSON.parse(calls[1][5]), hostEntry('claude', server));
  }
  assert.ok(existsSync(join(home, '.claude', 'skills', 'fai-browser', 'SKILL.md')), 'the skill is installed for the user');
});

test('the skill marker goes after the frontmatter in a CRLF checkout too (a Windows clone before .gitattributes)', () => {
  for (const eol of ['\n', '\r\n']) {
    const stamped = stampedSkill(['---', 'name: fai-browser', 'description: x', '---', '', '# FAI Browser', ''].join(eol));
    assert.ok(stamped.startsWith(`---${eol}name: fai-browser`), JSON.stringify(stamped.slice(0, 40)));
    assert.match(stamped, /---\r?\n<!-- fai-browser [^ ]+: re-run "fai-browser install" to update -->\n/);
  }
  // .gitattributes keeps every checkout LF, whatever core.autocrlf says.
  assert.match(readFileSync(join(import.meta.dirname, '..', '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', 'skills', 'fai-browser', 'SKILL.md'), 'utf8'), /\r/);
});

// --- npm for the updater ------------------------------------------------------------------------------------------------

test('npm runs without a shell: npm-cli.js beside node.exe on Windows, the npm next to node elsewhere', () => {
  const exists = path => path === 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(npmCommand('C:\\Program Files\\nodejs\\node.exe', { platform: 'win32', exists }), {
    file: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'], shell: false });
  assert.deepEqual(npmCommand('C:\\tools\\node.exe', { platform: 'win32', exists: () => false }), { file: 'npm', args: [], shell: true });
  assert.deepEqual(npmCommand('/opt/node/bin/node', { platform: 'linux', exists: path => path === '/opt/node/bin/npm' }),
    { file: '/opt/node/bin/npm', args: [], shell: false });
  assert.deepEqual(npmCommand('/x/node', { platform: 'darwin', exists: () => false }), { file: 'npm', args: [], shell: false });
  // For real, with the node running this test.
  const npm = npmCommand();
  const version = execFileSync(npm.file, [...npm.args, '--version'], { encoding: 'utf8', shell: npm.shell, windowsHide: true }).trim();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

// --- the native messaging launcher a browser starts ---------------------------------------------------------------------

test('native launcher: a .bat doubles % so cmd.exe keeps the path; the shell script quotes it', () => {
  const env = { FAI_HOME: 'C:\\Users\\a\\100% fai' };
  const bat = launcherFile({ platform: 'win32', dir: 'C:\\x', execPath: 'C:\\Program Files\\nodejs\\node.exe', env,
    entry: 'C:\\fai 100%\\src\\native-host.js' });
  assert.ok(bat.path.endsWith('native-host.bat'));
  assert.match(bat.content, /\r\nset "FAI_HOME=[^"\r\n]*100%% fai"\r\n/);
  assert.match(bat.content, /\r\n"C:\\Program Files\\nodejs\\node\.exe" "C:\\fai 100%%\\src\\native-host\.js" %\*\r\n$/);
  const script = launcherFile({ platform: 'linux', dir: '/x', execPath: "/opt/it's/node", env: { FAI_HOME: '/h' }, entry: '/e.js' });
  assert.match(script.content, /exec '\/opt\/it'\\''s\/node' '\/e\.js' "\$@"\n$/);
});

// Starts the launcher the way the browser does: Chrome on Windows runs `cmd.exe /d /c "<launcher>" <origin> ...`.
function startLauncher(path, env) {
  if (WINDOWS) {
    return spawn(`"${path}" ${CHROME_ORIGIN} --parent-window=0`, [], { env, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true });
  }
  return spawn(path, [CHROME_ORIGIN], { env, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function exchange(path, env, messages) {
  const child = startLauncher(path, env);
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => { stderr += chunk; });
  for (const message of messages) child.stdin.write(encodeMessage(message));
  const replies = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const decoded = decodeMessages(Buffer.concat(chunks));
    if (decoded.messages.length >= messages.length) {
      replies.push(...decoded.messages);
      break;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  child.stdin.end();
  const code = await new Promise(resolveExit => (child.exitCode !== null ? resolveExit(child.exitCode) : child.once('exit', resolveExit)));
  return { replies, code, stderr };
}

test('native launcher on this system: pairs over its stdio and starts the FAI service on a private port', { timeout: 90_000 }, async t => {
  const base = scratch(t);
  const fai = join(base, 'fai home');
  const port = await freePort();
  // What a browser gives a native host: a minimal environment. FAI_HOME is baked into the launcher; the port is not, so
  // it comes from here (a real install uses the default 4318).
  const env = { ...(WINDOWS ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATH: process.env.PATH }
    : { PATH: '/usr/bin:/bin' }), HOME: base, USERPROFILE: base, FAI_HOME: fai, FAI_DAEMON_PORT: String(port) };
  await saveSettings({ FAI_BRIDGE_SECRET: 'f'.repeat(64) }, join(fai, '.env.local'));
  const plan = planNativeInstall({ env, home: base, only: ['chrome'] });
  const registry = [];
  const written = await applyNativeInstall(plan, { reg: (key, value) => registry.push([key, value]) });
  assert.equal(written.launcher, join(fai, WINDOWS ? 'native-host.bat' : 'native-host'));
  const manifest = JSON.parse(readFileSync(written.browsers[0].path, 'utf8'));
  assert.equal(manifest.path, written.launcher);
  assert.deepEqual(manifest.allowed_origins, [CHROME_ORIGIN]);
  if (WINDOWS) assert.deepEqual(registry, [['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\fai_browser', written.browsers[0].path]]);
  try {
    const { replies, code, stderr } = await exchange(written.launcher, env, [{ type: 'ping' }, { type: 'pair' }]);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '', 'the host writes nothing but frames');
    assert.equal(replies[0].ok, true);
    assert.equal(replies[1].ok, true, JSON.stringify({ ...replies[1], secret: undefined }));
    assert.equal(replies[1].endpoint, `http://127.0.0.1:${port}`);
    assert.equal(replies[1].secret, 'f'.repeat(64));
    // The service the host started outlives the host (it exited above).
    const health = await probeHealth(port, 2000);
    assert.equal(health?.service, 'fai-browser');
  } finally {
    // Stop the service before the directory goes (Windows cannot delete files a running process holds open).
    try {
      const client = await FaiBrowserClient.connect({ home: fai, env, autoStart: false, clientName: 'platform-test' });
      await client.shutdown();
    } catch {
      // Not running.
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await probeHealth(port, 200)) await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
});

test('native messaging registry values on GitHub\'s Windows runner: written under HKCU, read back, removed', {
  skip: WINDOWS && process.env.GITHUB_ACTIONS === 'true' ? false
    : 'writes real HKCU values: only on a throwaway Windows CI runner (GITHUB_ACTIONS)' }, async t => {
  const base = scratch(t);
  const env = { ...process.env, FAI_HOME: join(base, 'fai home') };
  const plan = planNativeInstall({ env, home: base, all: true });
  const written = await applyNativeInstall(plan);
  t.after(() => uninstallNative({ env, home: base }));
  assert.deepEqual(written.browsers.map(browser => browser.id).sort(), ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'vivaldi']);
  for (const browser of written.browsers) {
    const out = execFileSync('reg', ['query', browser.registry, '/ve'], { encoding: 'utf8', windowsHide: true });
    assert.ok(out.includes(browser.path), `${browser.registry} names ${browser.path}`);
    assert.equal(JSON.parse(readFileSync(browser.path, 'utf8')).path, written.launcher);
  }
  const { removed } = await uninstallNative({ env, home: base });
  assert.ok(removed.includes(written.launcher));
  for (const browser of written.browsers) {
    assert.throws(() => execFileSync('reg', ['query', browser.registry, '/ve'], { stdio: 'ignore', windowsHide: true }),
      `${browser.registry} is gone`);
  }
});
