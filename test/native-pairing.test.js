// Per-user directories (src/paths.js), the move from a checkout-local install (src/migrate.js), the native messaging
// host (src/native-host.js) and its browser manifests (src/native.js). Every path is under a temporary directory:
// nothing here touches the real home or a real browser profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { customHome, dataDir, defaultDirs, faiHome } from '../src/paths.js';
import { homePaths } from '../src/home.js';
import { migrateLegacyHome } from '../src/migrate.js';
import { GECKO_ID, GECKO_IDS, NATIVE_HOST_ENTRY, NATIVE_HOST_NAME, applyNativeInstall, nativeManifest, planNativeInstall,
  uninstallNative } from '../src/native.js';
import { callerAllowed, decodeMessages, encodeMessage, handleMessage, serve } from '../src/native-host.js';
import { PINNED_EXTENSION_ID } from '../src/bridge.js';

const CHROME_ORIGIN = `chrome-extension://${PINNED_EXTENSION_ID}/`;
// File modes are POSIX: on Windows a file's access comes from the user profile's ACL and stat reports 0o666.
const POSIX_MODES = process.platform !== 'win32';

async function scratch(t, prefix = 'fai-native-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('default directories per platform; FAI_HOME keeps everything in one place', () => {
  assert.deepEqual(defaultDirs({ HOME: '/h' }, 'linux'),
    { config: '/h/.config/fai-browser', state: '/h/.local/state/fai-browser' });
  assert.deepEqual(defaultDirs({ HOME: '/h', XDG_CONFIG_HOME: '/x/c', XDG_STATE_HOME: '/x/s' }, 'linux'),
    { config: '/x/c/fai-browser', state: '/x/s/fai-browser' });
  const mac = '/h/Library/Application Support/fai-browser';
  assert.deepEqual(defaultDirs({ HOME: '/h' }, 'darwin'), { config: mac, state: mac });
  assert.equal(faiHome({ HOME: '/h' }, 'linux'), '/h/.config/fai-browser');
  assert.equal(faiHome({ HOME: '/h', FAI_HOME: '/custom' }, 'linux'), '/custom');
  assert.equal(dataDir('/h/.config/fai-browser', { HOME: '/h' }, 'linux'), '/h/.local/state/fai-browser');
  assert.equal(dataDir('/custom', { HOME: '/h' }, 'linux'), '/custom');
  assert.equal(customHome('/custom', { HOME: '/h' }, 'linux'), true);
  // Under node --test without FAI_HOME a temporary directory stands in for the real settings.
  assert.ok(faiHome({ HOME: '/h', NODE_TEST_CONTEXT: 'child' }).startsWith(tmpdir()));
  assert.ok(faiHome(process.env).startsWith(process.env.FAI_HOME ?? tmpdir()));
});

test('homePaths: default home splits settings and state; FAI_HOME is one directory', {
  skip: process.platform === 'win32' ? 'POSIX paths (path.join writes backslashes on Windows)' : false }, () => {
  const paths = homePaths({ env: { HOME: '/h' }, platform: 'linux' });
  assert.equal(paths.custom, false);
  assert.equal(paths.envFile, '/h/.config/fai-browser/.env.local');
  assert.equal(paths.config, '/h/.config/fai-browser/config.json');
  assert.equal(paths.clientToken, '/h/.local/state/fai-browser/client-token');
  assert.equal(paths.logFile, '/h/.local/state/fai-browser/logs/daemon.log');
  assert.equal(paths.artifacts, '/h/.local/state/fai-browser/artifacts');
  const custom = homePaths({ env: { HOME: '/h', FAI_HOME: '/c' }, platform: 'linux' });
  assert.equal(custom.custom, true);
  for (const key of ['envFile', 'clientToken', 'logFile', 'artifacts']) assert.ok(custom[key].startsWith('/c/'), key);
  assert.equal(homePaths({ env: { HOME: '/h', FAI_HOME: '/c', FAI_DAEMON_DIR: '/d' }, platform: 'linux' }).clientToken, '/d/client-token');
  const mac = homePaths({ env: { HOME: '/Users/u' }, platform: 'darwin' });
  assert.equal(mac.envFile, '/Users/u/Library/Application Support/fai-browser/.env.local');
  assert.equal(mac.clientToken, '/Users/u/Library/Application Support/fai-browser/client-token');
});

test('migration moves settings out of a checkout, stops nothing that is not running and never overwrites', async t => {
  const dir = await scratch(t);
  const legacy = join(dir, 'checkout');
  await mkdir(legacy);
  await writeFile(join(legacy, '.env.local'), 'FAI_BRIDGE_SECRET="x"\n', { mode: 0o600 });
  await writeFile(join(legacy, 'config.json'), '{"driver":"agent"}\n');
  await writeFile(join(legacy, 'client-token'), 'f'.repeat(64));
  await mkdir(join(legacy, 'logs'));
  const env = { HOME: join(dir, 'home') };
  const paths = homePaths({ env });
  const result = await migrateLegacyHome(paths, { legacy });
  assert.deepEqual(result.moved, ['.env.local', 'config.json']);
  assert.equal(result.stopped, false);
  assert.deepEqual(result.left, [join(legacy, 'logs')]);
  assert.equal(await readFile(paths.envFile, 'utf8'), 'FAI_BRIDGE_SECRET="x"\n');
  if (POSIX_MODES) assert.equal((await stat(paths.envFile)).mode & 0o777, 0o600);
  assert.equal(existsSync(join(legacy, '.env.local')), false);
  assert.equal(existsSync(join(legacy, 'client-token')), false);
  // A second checkout file never replaces the moved one.
  await writeFile(join(legacy, '.env.local'), 'FAI_BRIDGE_SECRET="old"\n');
  const again = await migrateLegacyHome(paths, { legacy });
  assert.deepEqual(again.moved, []);
  assert.ok(again.left.includes(join(legacy, '.env.local')));
  assert.equal(await readFile(paths.envFile, 'utf8'), 'FAI_BRIDGE_SECRET="x"\n');
  // A custom home (FAI_HOME) is never migrated into.
  assert.deepEqual(await migrateLegacyHome(homePaths({ env: { ...env, FAI_HOME: join(dir, 'c') } }), { legacy }),
    { moved: [], stopped: false, left: [] });
});

test('manifests: Chromium browsers by allowed_origins, Firefox by allowed_extensions', () => {
  assert.deepEqual(nativeManifest('chromium', { path: '/l' }).allowed_origins, [CHROME_ORIGIN]);
  assert.equal(nativeManifest('chromium', { path: '/l' }).allowed_extensions, undefined);
  assert.deepEqual(nativeManifest('firefox', { path: '/l' }).allowed_extensions, ['fai-browser@jedbjorn.github.io', 'fai-browser@local']);
  assert.deepEqual(GECKO_IDS, [GECKO_ID, 'fai-browser@local']);
  assert.equal(nativeManifest('firefox', { path: '/l' }).name, NATIVE_HOST_NAME);
  assert.match(NATIVE_HOST_NAME, /^[a-z0-9_.]+$/);
});

test('install-native writes only for detected browsers in a temporary HOME; uninstall removes them', async t => {
  const home = await scratch(t);
  await mkdir(join(home, '.config', 'google-chrome'), { recursive: true });
  await mkdir(join(home, '.config', 'BraveSoftware', 'Brave-Browser'), { recursive: true });
  await mkdir(join(home, '.mozilla'), { recursive: true });
  const env = { HOME: home };
  const plan = planNativeInstall({ env, platform: 'linux', execPath: '/opt/node/bin/node' });
  assert.deepEqual(plan.browsers.map(browser => browser.id), ['chrome', 'brave', 'firefox']);
  assert.ok(plan.missing.includes('edge'));
  const written = await applyNativeInstall(plan);
  assert.equal(written.launcher, join(home, '.config', 'fai-browser', 'native-host'));
  const launcher = await readFile(written.launcher, 'utf8');
  assert.match(launcher, /^#!\/bin\/sh\n/);
  assert.ok(launcher.includes(`exec '/opt/node/bin/node' '${NATIVE_HOST_ENTRY}' "$@"`));
  if (POSIX_MODES) assert.equal((await stat(written.launcher)).mode & 0o111, 0o100);
  const chrome = JSON.parse(await readFile(join(home, '.config', 'google-chrome', 'NativeMessagingHosts', 'fai_browser.json'), 'utf8'));
  assert.deepEqual(chrome, nativeManifest('chromium', { path: written.launcher }));
  const firefox = JSON.parse(await readFile(join(home, '.mozilla', 'native-messaging-hosts', 'fai_browser.json'), 'utf8'));
  assert.deepEqual(firefox.allowed_extensions, [...GECKO_IDS]);
  assert.equal(existsSync(join(home, '.config', 'microsoft-edge')), false, 'no directory for a browser that is not there');
  // A FAI_HOME install bakes it into the launcher.
  const custom = planNativeInstall({ env: { ...env, FAI_HOME: join(home, 'fh') }, platform: 'linux', execPath: '/n' });
  assert.match(custom.launcher.content, /FAI_HOME='.*fh' exec/);
  // Windows: one manifest per kind next to the launcher, registered in HKCU.
  const windows = planNativeInstall({ env, platform: 'win32', all: true, execPath: 'C:\\node.exe' });
  assert.ok(windows.launcher.path.endsWith('native-host.bat'));
  assert.equal(windows.browsers.find(browser => browser.id === 'edge').registry,
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\fai_browser');
  const removed = await uninstallNative({ env, platform: 'linux' });
  assert.equal(removed.removed.length, 4);
  assert.equal(existsSync(written.launcher), false);
  assert.equal(existsSync(join(home, '.mozilla', 'native-messaging-hosts', 'fai_browser.json')), false);
});

test('uninstall leaves a manifest of another host alone', async t => {
  const home = await scratch(t);
  const dir = join(home, '.config', 'chromium', 'NativeMessagingHosts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'fai_browser.json'), JSON.stringify({ name: 'something_else' }));
  const { removed } = await uninstallNative({ env: { HOME: home }, platform: 'linux' });
  assert.deepEqual(removed, []);
  assert.equal(existsSync(join(dir, 'fai_browser.json')), true);
});

test('native host frames, caller check and replies; the secret only reaches the paired extension', async t => {
  const frame = encodeMessage({ type: 'ping' });
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.deepEqual(decodeMessages(Buffer.concat([frame, frame.subarray(0, 3)])).messages, [{ type: 'ping' }]);
  assert.throws(() => decodeMessages(Buffer.from([0xff, 0xff, 0xff, 0x7f])), /message_too_large/);
  assert.equal(callerAllowed([CHROME_ORIGIN]), true);
  assert.equal(callerAllowed([`chrome-extension://${'b'.repeat(32)}/`]), false);
  assert.equal(callerAllowed(['/path/manifest.json', GECKO_ID]), true);
  assert.equal(callerAllowed(['/path/manifest.json', 'other@addon']), false);
  assert.equal(callerAllowed([]), false);

  const home = await scratch(t);
  const env = { HOME: home, FAI_HOME: home };
  await writeFile(join(home, '.env.local'), `FAI_BRIDGE_SECRET="${'c'.repeat(64)}"\n`);
  let started = 0;
  const ensure = async () => {
    started++;
    return { port: 4999 };
  };
  assert.deepEqual(await handleMessage({ type: 'pair' }, { env, ensure }),
    { ok: true, endpoint: 'http://127.0.0.1:4999', secret: 'c'.repeat(64), version: (await handleMessage({ type: 'ping' })).version });
  assert.equal(started, 1);
  assert.equal((await handleMessage({ type: 'nope' }, { env, ensure })).error, 'unsupported');
  const down = await handleMessage({ type: 'pair' }, { env, ensure: async () => { throw new Error('x'); } });
  assert.equal(down.ok, false);
  assert.equal(down.error, 'service_unavailable');

  async function exchange(args, message) {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    const done = serve({ args, env, input, output, ensure });
    input.end(encodeMessage(message));
    await done;
    return decodeMessages(Buffer.concat(chunks)).messages;
  }
  const [paired] = await exchange([CHROME_ORIGIN], { type: 'pair' });
  assert.equal(paired.secret, 'c'.repeat(64));
  const [refused] = await exchange([`chrome-extension://${'b'.repeat(32)}/`], { type: 'pair' });
  assert.deepEqual(refused, { ok: false, error: 'forbidden', message: 'This host answers the FAI Browser extension only' });
  assert.ok(!JSON.stringify(refused).includes('c'.repeat(64)));
});

test('the native host process answers ping over stdio and exits when stdin closes', async t => {
  const home = await scratch(t);
  const child = spawn(process.execPath, [NATIVE_HOST_ENTRY, CHROME_ORIGIN], {
    env: { PATH: process.env.PATH, HOME: home, FAI_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(encodeMessage({ type: 'ping' }));
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  const [reply] = decodeMessages(Buffer.concat(chunks)).messages;
  assert.equal(reply.ok, true);
  assert.match(reply.version, /^\d+\.\d+\.\d+/);
});
