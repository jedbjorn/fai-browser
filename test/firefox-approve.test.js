// Real, headless Firefox with the Firefox build of the extension, a private daemon and FAI_HOME (issue #36 item 1):
// approving a request whose page opened by itself.
//
// - Firefox shows the site-access prompt of a permissions.request() only in the active window, and the request modal
//   (arm.html) is a small window of its own that the desktop may not have activated. Clicked there, Approve used to
//   wait for a prompt nobody could see, with nothing in daemon.log, and approved the request much later when the
//   window became active and the prompt was allowed. Now the click brings the modal's window forward (the prompt
//   shows), says where else to approve after a few seconds, gives the click up after a bound (a late answer approves
//   nothing), and every step is logged.
// - The toolbar icon clicked on the task tab while it is still blank (its first page loading): it used to open the
//   popup, which offered to open the page again; now the tab is armed at once and the click approves once the page
//   has loaded.
//
// Skipped without a Firefox binary (FIREFOX_PATH, else `firefox` on PATH). Marionette drives only this throwaway
// browser. Run it in a memory cap: systemd-run --user --scope -p MemoryMax=2500M ... node --test test/firefox-approve.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFirefox, GECKO_ID } from '../scripts/build-firefox.mjs';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { Marionette } from '../scripts/marionette.mjs';
import { FaiBrowserClient } from '../src/client.js';
import { applyNativeInstall, planNativeInstall } from '../src/native.js';
import { saveSettings } from '../src/settings.js';
import { homePaths } from '../src/home.js';

const ROOT = resolve(import.meta.dirname, '..');
const FIREFOX = process.env.FIREFOX_PATH || 'firefox';
const hasFirefox = spawnSync(FIREFOX, ['--version'], { stdio: 'ignore', env: headlessEnv() }).status === 0;
const skip = hasFirefox ? false : 'no Firefox binary (set FIREFOX_PATH)';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const SLOW_MS = 4000;

async function freePort() {
  const server = net.createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

async function until(probe, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

const CHROME_HELPERS = `
  const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
  const extension = WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)})?.extension;
  const browserWindows = () => [...Services.wm.getEnumerator('navigator:browser')];
  const isArm = win => win.gBrowser?.selectedBrowser?.currentURI?.spec?.includes('/arm.html');
  const taskWindow = () => browserWindows().find(win => !isArm(win));
  const permissionNote = () => {
    for (const win of browserWindows()) {
      const note = win.PopupNotifications?.getNotification?.('addon-webext-permissions');
      if (note) return { win, note };
    }
    return null;
  };
`;

async function setup(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-ff-approve-'));
  const home = join(scratch, 'home');
  const faiHome = join(scratch, 'fai');
  const profile = join(scratch, 'profile');
  const addon = join(scratch, 'addon');
  let firefox = null;
  let marionette = null;
  let client = null;
  const site = http.createServer((req, res) => {
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Portal</title><h1>Portal</h1>');
    };
    if (req.url.startsWith('/slow')) setTimeout(reply, SLOW_MS);
    else reply();
  });
  t.after(async () => {
    try { await marionette?.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch { /* gone */ }
    marionette?.close();
    if (firefox && firefox.exitCode === null) {
      await Promise.race([new Promise(done => firefox.once('exit', done)), sleep(5000)]);
      if (firefox.exitCode === null) firefox.kill('SIGKILL');
    }
    try { await client?.shutdown(); } catch { /* not running */ }
    site.closeAllConnections?.();
    await new Promise(done => site.close(() => done()));
    await rm(scratch, { recursive: true, force: true });
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${site.address().port}`;

  await mkdir(join(home, '.config', 'mozilla'), { recursive: true });
  const env = { ...headlessEnv(), HOME: home, FAI_HOME: faiHome, FAI_DAEMON_PORT: String(await freePort()),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), MOZ_HEADLESS: '1', MOZ_CRASHREPORTER_DISABLE: '1',
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' };
  const paths = homePaths({ env });
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await saveSettings({ FAI_BRIDGE_SECRET: randomBytes(32).toString('hex') }, paths.envFile);
  await applyNativeInstall(planNativeInstall({ env, platform: process.platform, home, only: ['firefox'] }));
  client = await FaiBrowserClient.connect({ home: faiHome, env, autoStart: true, clientName: 'firefox-approve' });

  await buildFirefox({ root: ROOT, out: addon });
  const marionettePort = await freePort();
  await mkdir(profile, { recursive: true });
  const prefs = {
    'marionette.port': marionettePort, 'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore', 'browser.startup.page': 0, 'browser.aboutwelcome.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.update.disabledForTesting': true, 'extensions.autoDisableScopes': 0, 'extensions.update.enabled': false,
    'browser.tabs.warnOnClose': false, 'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false, 'browser.newtabpage.enabled': false,
  };
  await writeFile(join(profile, 'user.js'),
    Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n'));
  firefox = spawn(FIREFOX, ['-headless', '-no-remote', '-profile', profile, '-marionette', 'about:blank'],
    { env, stdio: ['ignore', 'ignore', 'ignore'] });
  marionette = await Marionette.connect(marionettePort, { timeoutMs: 60_000 });
  await marionette.newSession();
  await marionette.installAddon(addon, { temporary: true });
  assert.ok(await until(async () => (await client.status()).extension?.connected, 30_000), 'the add-on paired and connected');

  const chrome = async (body, args = []) => {
    await marionette.setContext('chrome');
    try {
      return await marionette.execute(`${CHROME_HELPERS}\n${body}`, args);
    } finally {
      await marionette.setContext('content');
    }
  };
  const handles = async () => {
    const value = await marionette.send('WebDriver:GetWindowHandles');
    return value.value ?? value;
  };
  // The request modal's window handle, once it has opened.
  const armWindow = () => until(async () => {
    for (const handle of await handles()) {
      await marionette.send('WebDriver:SwitchToWindow', { handle, focus: false });
      const url = await marionette.send('WebDriver:GetCurrentURL');
      if (String(url.value ?? url).includes('/arm.html')) return handle;
    }
    return null;
  }, 20_000);
  const approvals = async requestId => (await readFile(paths.logFile, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(line => line.event === 'approval' && line.requestId === requestId);
  const stateOf = async requestId => (await client.status()).requests.find(item => item.requestId === requestId);
  return { origin, client, marionette, chrome, handles, armWindow, approvals, stateOf };
}

// The modal's own page: its status line and Approve button (Marionette in the arm window's content).
async function modal(ctx, handle) {
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle, focus: false });
  return ctx.marionette.execute(`const approve = document.getElementById('approve');
    return { disabled: approve.disabled, text: approve.textContent, status: document.getElementById('status').textContent };`);
}

async function clickApprove(ctx, handle) {
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle, focus: false });
  const found = await ctx.marionette.send('WebDriver:FindElement', { using: 'css selector', value: '#approve' });
  await ctx.marionette.send('WebDriver:ElementClick', { id: Object.values(found.value ?? found)[0] });
}

test('Firefox: Approve in a modal window that is not active shows the prompt, never hangs silently, never fires late', { skip, timeout: 180_000 }, async t => {
  const ctx = await setup(t);
  const created = await ctx.client.requestTab({ origins: [ctx.origin, 'https://*.example.net', 'https://*.blade.example.net'],
    mode: 'interactive', reason: 'Check the portal', url: `${ctx.origin}/portal#view/deep/link` });
  const arm = await ctx.armWindow();
  assert.ok(arm, 'the request modal opened');
  assert.ok(await until(async () => !(await modal(ctx, arm)).disabled), 'Approve is enabled');
  // The desktop left the task page's window active (focus-stealing prevention): the click lands in an inactive window.
  await ctx.chrome('taskWindow().focus(); return true;');
  assert.ok(await until(() => ctx.chrome('return !isArm({ gBrowser: { selectedBrowser: Services.focus.activeWindow?.gBrowser?.selectedBrowser } });')),
    'the task window is the active one');
  await clickApprove(ctx, arm);

  // The prompt shows (the click brought its window forward); before the fix it waited, unseen, in the background.
  const shown = await until(() => ctx.chrome('const found = permissionNote(); return found && found.win.PopupNotifications.panel.state === "open";'), 4000);
  assert.ok(shown, 'Firefox shows the site-access prompt');

  // Nobody answers it: a few seconds later the modal says where else to approve, and daemon.log has it.
  const hint = await until(async () => /click the FAI Browser icon on the 127\.0\.0\.1:\d+ tab instead/.test((await modal(ctx, arm)).status), 9000);
  assert.ok(hint, `the modal says where else to approve: ${(await modal(ctx, arm)).status}`);
  // After the bound the click is given up: nothing approved, and the toolbar icon named.
  const gaveUp = await until(async () => /nothing\s+was approved/.test((await modal(ctx, arm)).status), 50_000);
  assert.ok(gaveUp, `the click is given up: ${(await modal(ctx, arm)).status}`);
  assert.deepEqual((await ctx.approvals(created.requestId)).map(line => `${line.surface}:${line.step}:${line.reason}`), [
    'page_modal:shown:null', 'page_modal:attempt:null', 'page_modal:waiting:site_access_pending',
    'page_modal:failed:site_access_timeout']);
  const waiting = await ctx.stateOf(created.requestId);
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.approval, 'toolbar', 'the agent is told to use the toolbar icon');

  // The prompt is allowed late: the given-up click approves nothing.
  assert.equal(await ctx.chrome(`const found = permissionNote(); if (!found) return false;
    found.note.mainAction.callback({ source: 'button' }); found.win.PopupNotifications.remove(found.note); return true;`), true);
  await sleep(1500);
  assert.equal((await ctx.stateOf(created.requestId)).state, 'pending', 'a late answer approves nothing');
  assert.match((await modal(ctx, arm)).status, /allowed after this approval was given up/);

  // Approve again: the browser already holds the site access, so the click approves at once.
  await clickApprove(ctx, arm);
  const outcome = await ctx.client.wait({ requestId: created.requestId, maxMs: 10_000 });
  assert.equal(outcome.state, 'active');
  assert.ok(await until(async () => (await ctx.approvals(created.requestId)).at(-1)?.step === 'approved', 5000),
    'the approval is logged');
});

test('Firefox: the toolbar icon on the blank, still-loading task tab approves once the page has loaded', { skip, timeout: 120_000 }, async t => {
  const ctx = await setup(t);
  const created = await ctx.client.requestTab({ origins: [ctx.origin], mode: 'interactive', reason: 'Check the slow portal',
    url: `${ctx.origin}/slow#view/deep/link` });
  assert.ok(await ctx.armWindow(), 'the request modal opened');
  // Back to the task tab's window (the modal closes once approved), then the icon click while the page is still blank.
  const [first] = await ctx.handles();
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle: first, focus: false });
  const clicked = await ctx.chrome(`const win = taskWindow(); win.focus();
    const loading = win.gBrowser.selectedTab.hasAttribute('busy');
    ExtensionParent.apiManager.global.browserActionFor(extension).triggerAction(win);
    return { loading, uri: win.gBrowser.selectedBrowser.currentURI.spec };`);
  assert.equal(clicked.loading, true, `the page was still loading at the click: ${JSON.stringify(clicked)}`);
  // Firefox asks for the request's exact origin inside the click (compat.js): allowed.
  const allowed = await until(() => ctx.chrome(`const found = permissionNote(); if (!found) return false;
    found.note.mainAction.callback({ source: 'button' }); found.win.PopupNotifications.remove(found.note); return true;`), 5000);
  assert.ok(allowed, 'the icon click asked for site access (it reached the armed tab, not the popup)');
  const outcome = await ctx.client.wait({ requestId: created.requestId, maxMs: SLOW_MS + 15_000 });
  assert.equal(outcome.state, 'active', `approved once the page loaded: ${JSON.stringify(await ctx.approvals(created.requestId))}`);
  const toolbar = async () => (await ctx.approvals(created.requestId)).filter(line => line.surface === 'toolbar').map(line => line.step);
  await until(async () => (await toolbar()).includes('approved'), 5000);
  assert.deepEqual(await toolbar(), ['attempt', 'approved']);
});
