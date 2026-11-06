#!/usr/bin/env node
// Real-browser check of `fai-browser launch` (src/launcher/launch.js) with nothing of the user's touched: a temporary
// HOME (so the profile, the native messaging manifest, the settings and the menu entry are throwaway ones), its own
// FAI service port, headless Firefox from PATH (FIREFOX_PATH overrides). FAI_SMOKE_KEEP=1 keeps the temp directory.
//   node scripts/launcher-smoke.mjs --xpi dist/fai-browser-firefox-<v>.xpi   a Mozilla-signed add-on: it must install
//        from the profile by itself (no temporary load), be active and signed, and pair through the native host
//   node scripts/launcher-smoke.mjs                                         no signed file yet: the launcher places an
//        unsigned build (with a dummy signature, test only), Firefox must list it in the profile and refuse to enable it;
//        the same build is then loaded as a temporary add-on to check the pairing
// Run it memory-capped on small machines:
//   systemd-run --user --scope --quiet -p MemoryMax=2500M -p MemorySwapMax=256M timeout 300 node scripts/launcher-smoke.mjs
//
// Test-only additions, never made by the launcher itself: MOZ_HEADLESS, --marionette with a marionette.port pref
// appended to the temporary profile's user.js after the launcher wrote it, and MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, so this
// script can read the add-on manager's state. The launcher's own command line and user.js are checked first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildFirefox, GECKO_ID } from './build-firefox.mjs';
import { collectFiles } from './package.mjs';
import { headlessEnv } from './headless-env.mjs';
import { Marionette } from './marionette.mjs';
import { FaiBrowserClient } from '../src/client.js';
import { createZip } from '../src/zip.js';
import { launcherPaths } from '../src/launcher/dirs.js';
import { defaultDeps, launch } from '../src/launcher/launch.js';
import { userJs } from '../src/launcher/profile.js';

const { values } = parseArgs({ options: { xpi: { type: 'string' } } });
const signedXpi = values.xpi ? resolve(values.xpi) : null;
const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'fai-launcher-smoke-'));
const home = join(scratch, 'home');
const sleep = ms => new Promise(done => setTimeout(done, ms));
let firefox = null;
let marionette = null;
let client = null;
let smokeEnv = null;
let count = 0;

function check(name, detail = '') {
  count++;
  console.log(`ok - ${name}${detail ? ` (${detail})` : ''}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

async function until(what, probe, { timeoutMs = 30_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${last?.message ?? JSON.stringify(last)}`);
    await sleep(everyMs);
  }
}

async function chrome(body, args = []) {
  await marionette.setContext('chrome');
  try {
    return await marionette.execute(body, args, { async: true });
  } finally {
    await marionette.setContext('content');
  }
}

const ADDON_STATE = `
  const done = arguments[arguments.length - 1];
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  AddonManager.getAddonByID(arguments[0]).then(addon => done(addon && {
    version: addon.version, isActive: addon.isActive, userDisabled: addon.userDisabled, appDisabled: addon.appDisabled,
    signedState: addon.signedState, scope: addon.scope, temporarilyInstalled: addon.temporarilyInstalled,
    seen: addon.seen, profileScope: AddonManager.SCOPE_PROFILE, signedMin: AddonManager.SIGNEDSTATE_SIGNED,
  }), error => done({ error: String(error) }));`;

async function unsignedXpi() {
  const build = join(scratch, 'build');
  await buildFirefox({ root, out: build });
  const files = await collectFiles(build);
  // A dummy signature file: it passes the launcher's "looks signed" check so the profile placement can be tested
  // before a real signature exists; Firefox must reject it.
  files.push({ name: 'META-INF/cose.sig', data: 'not a signature' });
  const path = join(scratch, 'unsigned.xpi');
  await writeFile(path, createZip(files));
  return { path, build };
}

async function main() {
  await mkdir(home, { recursive: true });
  const port = await freePort();
  const env = { ...headlessEnv(), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'), FAI_DAEMON_PORT: String(port) };
  delete env.FAI_HOME;
  delete env.NODE_TEST_CONTEXT;
  smokeEnv = env;
  const marionettePort = await freePort();
  const paths = launcherPaths({ env });
  assert.ok(paths.profile.startsWith(home), paths.profile);
  const unsigned = signedXpi ? null : await unsignedXpi();
  let launched;

  const deps = defaultDeps({
    env,
    home,
    interactive: false,
    out: line => console.log(`  launcher: ${line}`),
    spawnBrowser(command, { env: launchEnv }) {
      launched = command;
      // The launcher's own command and profile, checked before the test-only additions.
      assert.deepEqual(command.slice(1, 4), ['--profile', paths.profile, '--no-remote']);
      assert.doesNotMatch(command.join(' '), /marionette|remote-debugging|headless/i);
      return (async () => {
        assert.equal(await readFile(join(paths.profile, 'user.js'), 'utf8'), userJs());
        await appendFile(join(paths.profile, 'user.js'), `user_pref("marionette.port", ${marionettePort});\n`);
        firefox = spawn(command[0], [...command.slice(1), '--marionette'], {
          env: { ...launchEnv, MOZ_HEADLESS: '1', MOZ_CRASHREPORTER_DISABLE: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
          stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        firefox.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
        firefox.on('exit', code => { if (code) console.error(`firefox exited ${code}: ${stderr}`); });
        return { pid: firefox.pid };
      })();
    },
  });
  if (process.env.FIREFOX_PATH) deps.env.FIREFOX_PATH = process.env.FIREFOX_PATH;
  const result = await launch({ xpi: signedXpi ?? unsigned.path, desktop: false, wait: false }, deps);
  assert.equal(result.status, 'started');
  check('launch ran', `Firefox ${result.firefox.version?.version} at ${result.firefox.binary}`);
  check('the launcher command has --profile and --no-remote and no remote-control flag', launched.slice(1, 4).join(' '));

  await until('Firefox to start', () => firefox?.pid);
  marionette = await Marionette.connect(marionettePort, { timeoutMs: 60_000 });
  await marionette.newSession();
  check('Firefox started headless with the FAI profile');

  const prefs = await chrome(`
    const done = arguments[arguments.length - 1];
    done({ scopes: Services.prefs.getIntPref('extensions.autoDisableScopes'),
      defaultBrowser: Services.prefs.getBoolPref('browser.shell.checkDefaultBrowser'),
      telemetry: Services.prefs.getBoolPref('toolkit.telemetry.enabled', false),
      httpsOnly: Services.prefs.getBoolPref('dom.security.https_only_mode'),
      profile: Services.dirsvc.get('ProfD', Ci.nsIFile).path });`);
  assert.deepEqual(prefs, { scopes: 14, defaultBrowser: false, telemetry: false, httpsOnly: true, profile: paths.profile });
  check('user.js applied in the FAI profile', JSON.stringify(prefs));

  if (signedXpi) {
    const placed = await until('the add-on manager to list the add-on', () => chrome(ADDON_STATE, [GECKO_ID]), { timeoutMs: 20_000 });
    assert.equal(placed.scope, placed.profileScope, `installed from the profile: ${JSON.stringify(placed)}`);
    assert.equal(placed.temporarilyInstalled, false);
    assert.equal(placed.isActive, true, JSON.stringify(placed));
    assert.equal(placed.userDisabled, false);
    assert.ok(placed.signedState >= placed.signedMin, `signed: ${JSON.stringify(placed)}`);
    check('signed add-on installed from the profile and active, no temporary load', JSON.stringify(placed));
  } else {
    await sleep(3_000);
    const placed = await chrome(ADDON_STATE, [GECKO_ID]);
    // Release Firefox drops a profile add-on whose signature does not verify (or lists it disabled).
    assert.ok(!placed || placed.isActive === false, JSON.stringify(placed));
    check('an add-on without a valid Mozilla signature is refused by Firefox', placed ? JSON.stringify(placed) : 'not installed');
    const installed = await marionette.installAddon(unsigned.build, { temporary: true });
    assert.equal(installed.value ?? installed, GECKO_ID);
    check('the build loaded as a temporary add-on for the pairing check');
  }

  client = await FaiBrowserClient.connect({ env, autoStart: false, clientName: 'launcher-smoke' });
  const status = await until('the add-on to pair and connect', async () => {
    const value = await client.status();
    return value.extension?.connected ? value : null;
  }, { timeoutMs: 45_000 });
  check('paired through the native host and connected', `transport ${status.extension.transport}`);

  const welcome = await until('the welcome page', async () => {
    const title = (await marionette.send('WebDriver:GetTitle')).value;
    return title === 'FAI Browser is ready' ? title : null;
  }, { timeoutMs: 15_000 }).catch(() => null);
  if (welcome) {
    const checks = await marionette.execute('return document.getElementById("checks").innerText;');
    assert.match(checks, /FAI Browser add-on/);
    check('welcome page open with the launcher checks', checks.replace(/\s+/g, ' ').slice(0, 160));
  } else {
    console.log('note - the first tab is not the welcome page (Firefox may show its own page first)');
  }

  // The profile is not registered anywhere: no profiles.ini under the temporary HOME names it.
  const found = [];
  for (const dir of [join(home, '.mozilla', 'firefox'), join(home, '.config', 'mozilla', 'firefox')]) {
    const names = await readdir(dir).catch(() => []);
    if (names.includes('profiles.ini')) found.push(await readFile(join(dir, 'profiles.ini'), 'utf8'));
  }
  assert.ok(found.every(text => !text.includes(paths.profile)), 'the FAI profile is not in profiles.ini');
  check('the FAI profile is not registered in profiles.ini', `${found.length} profiles.ini file(s) under the temp HOME`);
  console.log(`\n${count} checks passed`);
}

async function cleanup() {
  try { await marionette?.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch { /* gone */ }
  marionette?.close();
  if (firefox && firefox.exitCode === null) {
    await Promise.race([new Promise(done => firefox.once('exit', done)), sleep(5_000)]);
    if (firefox.exitCode === null) firefox.kill('SIGKILL');
  }
  try {
    client ??= smokeEnv && await FaiBrowserClient.connect({ env: smokeEnv, autoStart: false, clientName: 'launcher-smoke' });
    await client?.shutdown();
  } catch { /* not running */ }
  if (process.env.FAI_SMOKE_KEEP !== '1') await rm(scratch, { recursive: true, force: true }).catch(() => {});
  else console.log(`kept ${scratch}`);
}

try {
  await main();
} catch (error) {
  console.error(`not ok - ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
