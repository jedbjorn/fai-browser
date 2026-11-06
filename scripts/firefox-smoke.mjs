#!/usr/bin/env node
// End-to-end check of the Firefox build in a real, headless Firefox, with nothing of the user's touched: a temporary
// HOME (so the native messaging manifest, ~/.mozilla or ~/.config/mozilla, is a throwaway one), a temporary profile,
// a temporary FAI_HOME and its own daemon port.
//   npm run smoke:firefox            (FIREFOX_PATH overrides `firefox` on PATH; FAI_SMOKE_KEEP=1 keeps the temp dir)
// Run it inside a memory cap on small machines:
//   systemd-run --user --scope --quiet -p MemoryMax=2500M -p MemorySwapMax=256M timeout 300 npm run smoke:firefox
//
// What it proves, in order: the add-on installs (Marionette Addon:Install, temporary); it pairs by itself through
// the native host (the manifest setup writes, in the temporary HOME) and connects over the WebSocket with its
// moz-extension origin; an agent request opens the page in its own window and arms it; a click on the toolbar button
// (Firefox's own browser-action code path, which grants activeTab) approves it; observe returns the page and an
// annotated screenshot (captureVisibleTab under activeTab, drawn in the offscreen frame); one act clicks a button
// and the next observe shows its effect; a same-origin navigation keeps the session usable (the exact-origin
// permission Firefox asked for at approval); a screenshot after it needs the all-sites opt-in, and with it the secret
// boxes of a page full of fake keys are drawn by the same offscreen.js, running in the background page's frame. Marionette drives only
// this throwaway browser: the user's real profile never runs with a remote protocol.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFirefox, GECKO_ID } from './build-firefox.mjs';
import { headlessEnv } from './headless-env.mjs';
import { Marionette } from './marionette.mjs';
import { FaiBrowserClient } from '../src/client.js';
import { applyNativeInstall, planNativeInstall } from '../src/native.js';
import { saveSettings } from '../src/settings.js';
import { homePaths } from '../src/home.js';

const root = resolve(import.meta.dirname, '..');
const firefoxPath = process.env.FIREFOX_PATH || 'firefox';
const scratch = await mkdtemp(join(tmpdir(), 'fai-firefox-smoke-'));
const home = join(scratch, 'home');
const faiHome = join(scratch, 'fai');
const profile = join(scratch, 'profile');
const addon = join(scratch, 'addon');
const checks = [];
const timings = {};
const sleep = ms => new Promise(done => setTimeout(done, ms));
let firefox = null;
let marionette = null;
let client = null;
let site = null;

function check(name, detail = '') {
  checks.push(name);
  console.log(`ok - ${name}${detail ? ` (${detail})` : ''}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

async function until(what, probe, { timeoutMs = 20_000, everyMs = 200 } = {}) {
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

// Privileged (chrome-context) helpers, run through Marionette in the throwaway browser.
const CHROME_HELPERS = `
  const ID = ${JSON.stringify(GECKO_ID)};
  const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
  const policy = WebExtensionPolicy.getByID(ID);
  const extension = policy?.extension;
  const browserWindows = () => [...Services.wm.getEnumerator('navigator:browser')];
`;

async function chromeScript(body, args = [], options = {}) {
  await marionette.setContext('chrome');
  try {
    return await marionette.execute(`${CHROME_HELPERS}\n${body}`, args, options);
  } finally {
    await marionette.setContext('content');
  }
}

// Runs `script` (async, Marionette style) in an extension page of the add-on, opened in the first window's tab.
async function extensionPageScript(script, args, uuid) {
  await marionette.navigate(`moz-extension://${uuid}/offscreen.html`);
  return marionette.execute(script, args, { async: true }).catch(error => `failed: ${error.message}`);
}

async function main() {
  // --- the FAI side: settings, native host, daemon, fixture site --------------------------------------------
  await mkdir(join(home, '.config', 'mozilla'), { recursive: true });
  const daemonPort = await freePort();
  const env = { ...headlessEnv(), HOME: home, FAI_HOME: faiHome, FAI_DAEMON_PORT: String(daemonPort),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), MOZ_HEADLESS: '1', MOZ_CRASHREPORTER_DISABLE: '1',
    // Marionette's chrome context (the toolbar click, the add-on's internals) needs this since Firefox 138.
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' };
  const paths = homePaths({ env });
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await saveSettings({ FAI_BRIDGE_SECRET: randomBytes(32).toString('hex') }, paths.envFile);
  const plan = planNativeInstall({ env, platform: process.platform, home, only: ['firefox'] });
  const installed = await applyNativeInstall(plan);
  const manifestPath = installed.browsers[0]?.path;
  assert.ok(manifestPath?.startsWith(home), `the native manifest goes under the temporary HOME (${manifestPath})`);
  check('native host manifest written for Firefox', manifestPath.slice(home.length + 1));

  client = await FaiBrowserClient.connect({ home: faiHome, env, autoStart: true, clientName: 'firefox-smoke' });
  check('FAI service started', `port ${daemonPort}`);

  const fixtures = new Map([['/index.html', 'index.html'], ['/about.html', 'about.html'],
    ['/keys.html', 'secrets/keys.html'], ['/fakes.js', 'secrets/fakes.js']]);
  site = http.createServer(async (req, res) => {
    const name = fixtures.get(req.url === '/' ? '/index.html' : req.url);
    if (!name) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(join(root, 'fixtures', name)));
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${site.address().port}`;

  // --- Firefox: build, temporary profile, Marionette -----------------------------------------------------------
  await buildFirefox({ root, out: addon });
  const marionettePort = await freePort();
  await mkdir(profile, { recursive: true });
  const prefs = {
    'marionette.port': marionettePort,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.startup.page': 0,
    'browser.aboutwelcome.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.update.disabledForTesting': true,
    'extensions.autoDisableScopes': 0,
    'extensions.update.enabled': false,
    'browser.tabs.warnOnClose': false,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    'browser.newtabpage.enabled': false,
  };
  await writeFile(join(profile, 'user.js'),
    Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n'));
  const started = Date.now();
  firefox = spawn(firefoxPath, ['-headless', '-no-remote', '-profile', profile, '-marionette', 'about:blank'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  firefox.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  firefox.on('exit', code => { if (code) console.error(`firefox exited ${code}: ${stderr}`); });
  marionette = await Marionette.connect(marionettePort, { timeoutMs: 60_000 });
  const session = await marionette.newSession();
  timings.firefoxStartMs = Date.now() - started;
  check('Firefox started headless', `${session.capabilities.browserName} ${session.capabilities.browserVersion}`);

  const install = await marionette.installAddon(addon, { temporary: true });
  assert.equal(install.value ?? install, GECKO_ID);
  check('add-on installed (temporary)');
  const uuid = await chromeScript('return policy?.mozExtensionHostname ?? null;');
  assert.match(uuid, /^[0-9a-f-]{36}$/);

  // --- pairing through the native host, then the WebSocket -----------------------------------------------------
  const status = await until('the extension to connect', async () => {
    const value = await client.status();
    return value.extension?.connected ? value : null;
  }, { timeoutMs: 30_000 });
  check('paired through native messaging and connected', `transport ${status.extension.transport}`);
  const socket = await until('the WebSocket transport', async () => {
    const value = await client.status();
    return value.extension?.transport === 'websocket' ? value : null;
  }, { timeoutMs: 15_000 }).catch(error => ({ error }));
  if (socket.error) console.log(`warning: no WebSocket (${socket.error.message}); extension ${JSON.stringify((await client.status()).extension)}`);
  else check('WebSocket transport with the moz-extension origin');

  // --- an agent request: opens in its own window, armed; the toolbar click approves ---------------------------
  const created = await client.requestTab({ origins: [origin], mode: 'reversible', reason: 'Firefox smoke',
    url: `${origin}/index.html` });
  const armed = await until('the page to open and be armed', () => chromeScript(`
    for (const win of browserWindows()) {
      const tab = win.gBrowser?.selectedBrowser;
      if (tab?.currentURI?.spec === arguments[0]) return { title: win.document.title };
    }
    return null;`, [`${origin}/index.html`]), { timeoutMs: 20_000 });
  check('request opened its page in a new window', armed.title);
  if (process.env.FAI_SMOKE_DEBUG) console.log(`armed windows ${JSON.stringify(await windowsState())}`);
  // The armed tab: badge '?' and no popup, so the click fires action.onClicked (Firefox grants activeTab first).
  await sleep(500);
  const clicked = await chromeScript(`
    const win = browserWindows().find(item => item.gBrowser?.selectedBrowser?.currentURI?.spec === arguments[0]);
    if (!win) return 'no window';
    win.focus();
    const { browserActionFor } = ExtensionParent.apiManager.global;
    const action = browserActionFor(extension);
    const badge = action.getContextData?.(win.gBrowser.selectedTab)?.badgeText ?? null;
    action.triggerAction(win);
    return badge;`, [`${origin}/index.html`]);
  check('toolbar button clicked on the armed tab', `badge ${JSON.stringify(clicked)}`);
  if (process.env.FAI_SMOKE_DEBUG) {
    for (let i = 0; i < 4; i++) {
      console.log(`after click ${i} ${JSON.stringify(await windowsState())}`);
      await sleep(400);
    }
  }
  // Firefox's permission prompt for the request's exact origin (compat.js asks inside the click): Allow it the way a
  // user would, through the doorhanger's main action.
  const prompt = await until('the site permission prompt', () => chromeScript(`
    for (const win of browserWindows()) {
      const note = win.PopupNotifications?.getNotification?.('addon-webext-permissions');
      if (note) {
        const text = win.document.getElementById('addon-webext-perm-header')?.textContent ?? note.message ?? '';
        note.mainAction.callback({ source: 'button' });
        win.PopupNotifications.remove(note);
        return { text: String(text).slice(0, 120) || 'shown' };
      }
    }
    return null;`), { timeoutMs: 10_000 });
  check('Firefox asked for the exact origin and the prompt was allowed', prompt.text);
  const granted = await client.waitForTab(created.requestId, { timeoutMs: 20_000 });
  assert.equal(granted.state, 'active', JSON.stringify(granted).slice(0, 400));
  check('request approved by the toolbar click', `level ${granted.level ?? granted.lease?.level ?? '?'}`);

  // Firefox suspends an idle event page after 30 s (extensions.background.idle.timeout); the session lives in it.
  const idleMs = Number(process.env.FAI_SMOKE_IDLE_MS ?? 0);
  if (idleMs > 0) {
    await sleep(idleMs);
    check(`idle ${idleMs} ms`);
  }

  // --- observe with a screenshot, act once, observe again ----------------------------------------------------
  let at = Date.now();
  const first = await client.observe({ requestId: created.requestId, capture: true });
  timings.observeMs = Date.now() - at;
  assert.equal(first.state, 'ok', JSON.stringify(first).slice(0, 400));
  const text = JSON.stringify(first.observation ?? first);
  assert.match(text, /Project overview/);
  check('observe read the page', `${timings.observeMs} ms`);
  const shot = first.screenshot;
  assert.ok(shot && !shot.error, `screenshot: ${JSON.stringify(shot).slice(0, 300)}`);
  check('annotated screenshot captured', JSON.stringify(shot).slice(0, 200));

  const actions = first.actions ?? first.offer?.actions ?? [];
  const show = actions.find(action => /Show plan/.test(action.label ?? action.text ?? ''));
  assert.ok(show, `a Show plan action among ${actions.length}`);
  at = Date.now();
  const acted = await client.act({ requestId: created.requestId, revision: first.revision, actionId: show.id, waitMs: 20_000 });
  timings.actMs = Date.now() - at;
  assert.ok(!acted.error, JSON.stringify(acted).slice(0, 400));
  check('act clicked Show plan', `${timings.actMs} ms`);
  const second = await client.observe({ requestId: created.requestId, capture: false });
  assert.match(JSON.stringify(second), /Selected plan: basic/);
  check('the next observe shows the click\'s effect');

  // --- a same-origin navigation keeps the session: the exact-origin permission asked for at approval --------------
  const about = (second.actions ?? []).find(action => /About project/.test(action.label ?? ''));
  assert.ok(about, 'an About project link');
  const moved = await client.act({ requestId: created.requestId, revision: second.revision, actionId: about.id, waitMs: 20_000 });
  assert.ok(!moved.error, JSON.stringify(moved).slice(0, 400));
  const third = await client.observe({ requestId: created.requestId, capture: true });
  assert.equal(third.state, 'ok', JSON.stringify(third).slice(0, 400));
  assert.match(JSON.stringify(third.page ?? third), /Members: Ada/);
  check('same-origin navigation: the session stays active and observe reads the new page');
  // Firefox lets captureVisibleTab run only under activeTab (gone after that navigation) or <all_urls>: a site
  // permission is not enough. So without the opt-in below the image is missing, never wrong.
  const probe = await extensionPageScript(`
    const done = arguments[arguments.length - 1];
    chrome.tabs.query({}).then(tabs => chrome.tabs.captureVisibleTab(tabs.find(tab => tab.url === arguments[0])?.windowId))
      .then(url => done('captured ' + url.length), error => done(error.message));`, [`${origin}/about.html`], uuid);
  assert.equal(third.screenshot ?? null, null, 'no screenshot after a navigation without <all_urls>');
  check('known Firefox gap: no screenshot after a navigation without the all-sites opt-in', probe);

  // --- the opt-in: "Access your data for all websites" in about:addons (here granted the way that switch does) ---
  await chromeScript(`
    const done = arguments[arguments.length - 1];
    const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
    ExtensionPermissions.add(ID, { permissions: [], origins: ['<all_urls>'] }, extension).then(() => done(true), error => done(error.message));`,
  [], { async: true });
  // Screenshot redaction on a page full of (fake) secrets, reached by an allowed-URL navigation.
  const keysUrl = `${origin}/keys.html`;
  const fourth = await client.observe({ requestId: created.requestId, allowedUrls: [keysUrl] });
  const go = (fourth.actions ?? []).find(action => action.type === 'navigate_allowed_url' || String(action.label ?? '').includes('keys.html'));
  assert.ok(go, `a navigate action to keys.html among ${JSON.stringify((fourth.actions ?? []).map(a => a.label)).slice(0, 300)}`);
  const landed = await client.act({ requestId: created.requestId, revision: fourth.revision, actionId: go.id, waitMs: 20_000 });
  assert.ok(!landed.error, JSON.stringify(landed).slice(0, 400));
  const keys = await client.observe({ requestId: created.requestId, capture: true });
  assert.equal(keys.state, 'ok', JSON.stringify(keys).slice(0, 400));
  assert.ok(keys.screenshot, `a screenshot with <all_urls>: ${JSON.stringify({ ...keys, page: undefined, actions: undefined }).slice(0, 600)}`);
  const trace = JSON.parse(await readFile(keys.trace, 'utf8'));
  const redactions = trace.screenshot?.redactions ?? JSON.stringify(trace).match(/"redactions":\s*(\d+)/)?.[1];
  assert.ok(Number(redactions) >= 1, `secret boxes drawn: ${redactions}`);
  assert.doesNotMatch(JSON.stringify(keys.page ?? {}), /AKIAFAKE/);
  check('with the opt-in: screenshot after navigation, secrets boxed in the offscreen frame', `${redactions} boxes`);

  // --- what this Firefox offers (compat.js feature report, read in an extension page) ----------------------------
  const features = await extensionPageScript(`
    const done = arguments[arguments.length - 1];
    chrome.runtime.getBackgroundPage().then(page => done(page.faiCompat.features()), error => done(error.message));`, [], uuid);
  console.log(`features ${JSON.stringify(features)}`);
  console.log(`timings ${JSON.stringify(timings)}`);
  await client.release(created.requestId, 'firefox smoke done').catch(() => null);
  console.log(`\n${checks.length} checks passed`);
}

async function cleanup() {
  try { await marionette?.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch { /* already gone */ }
  marionette?.close();
  if (firefox && firefox.exitCode === null) {
    await Promise.race([new Promise(done => firefox.once('exit', done)), sleep(5_000)]);
    if (firefox.exitCode === null) firefox.kill('SIGKILL');
  }
  try { await client?.shutdown(); } catch { /* not running */ }
  site?.close();
  if (process.env.FAI_SMOKE_KEEP !== '1') await rm(scratch, { recursive: true, force: true }).catch(() => {});
  else console.log(`kept ${scratch}`);
}

// On failure: the add-on's console messages and the FAI service log's transport lines, for the report.
const WINDOWS_SCRIPT = `
    return [...Services.wm.getEnumerator(null)].map(win => ({
      type: win.document.documentElement.getAttribute('windowtype'),
      url: win.location.href.slice(0, 80),
      tabs: win.gBrowser ? win.gBrowser.tabs.map(tab => ({ url: tab.linkedBrowser.currentURI.spec.slice(0, 80),
        selected: tab.selected, group: tab.group?.label ?? null })) : null,
    }));`;
const windowsState = () => chromeScript(WINDOWS_SCRIPT).catch(error => error.message);

async function diagnostics() {
  console.error(`windows ${JSON.stringify(await windowsState())}`);
  const background = await chromeScript(`
    const out = { views: [] };
    for (const view of extension?.views ?? []) out.views.push(view.viewType);
    return out;`).catch(error => error.message);
  console.error(`background ${JSON.stringify(background)}`);
  const messages = await chromeScript(`
    return Services.console.getMessageArray()
      .map(item => item.message ?? String(item))
      .filter(text => /moz-extension|fai/i.test(text)).slice(-25);`).catch(error => [`(console unavailable: ${error.message})`]);
  console.error(`console:\n  ${messages.join('\n  ')}`);
  try {
    const log = await readFile(homePaths({ env: { FAI_HOME: faiHome } }).logFile, 'utf8');
    console.error(`service log:\n  ${log.split('\n').filter(line => /extension|lease|session|ws/.test(line)).slice(-25).join('\n  ')}`);
  } catch {
    // No log.
  }
}

try {
  await main();
} catch (error) {
  console.error(`not ok - ${error.stack ?? error}`);
  process.exitCode = 1;
  if (marionette) await diagnostics().catch(() => {});
} finally {
  await cleanup();
}
