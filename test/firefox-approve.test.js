// Real, headless Firefox with the Firefox build of the extension, a private daemon and FAI_HOME (issue #36 item 1):
// approving a request whose page opened by itself, on every surface, never waits silently or approves late.
//
// - Native site-access requests start only inside explicit Use/Act button gestures. Unanswered prompts are bounded,
//   logged, and a late native grant cannot revive the expired FAI approval.
// - Opening the toolbar on a blank or streaming task exposes choices and never approves by itself.
// - Use keeps one task tab; Act enables guarded actions and multiple task tabs. Both retain exact-host permissions
//   through navigation and remove only permissions FAI itself acquired when the task ends.
//
// The site-access wait is shortened for the test (storage.local siteAccessWaitMs). Skipped without a Firefox binary
// (FIREFOX_PATH, else `firefox` on PATH). Marionette drives only this throwaway browser. Run it in a memory cap:
// systemd-run --user --scope -p MemoryMax=2500M ... node --test test/firefox-approve.test.js
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
const WAIT_MS = 6000;

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

async function setup(t, extraLocal = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-ff-approve-'));
  const home = join(scratch, 'home');
  const faiHome = join(scratch, 'fai');
  const profile = join(scratch, 'profile');
  const addon = join(scratch, 'addon');
  let firefox = null;
  let marionette = null;
  let client = null;
  // `/held`: no answer until the test calls release(). `/trickle`: the page commits at once, then its body streams
  // until release().
  const held = [];
  const release = () => { for (const done of held.splice(0)) done(); };
  // Every path the browser asked for, in order (a form's submission is a GET of its action).
  const hits = [];
  const site = http.createServer((req, res) => {
    hits.push(req.url);
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SITE_PAGES[new URL(req.url, 'http://site').pathname] ?? '<!doctype html><title>Portal</title><h1>Portal</h1>');
    };
    if (req.url.startsWith('/held')) held.push(reply);
    else if (req.url.startsWith('/trickle')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write(`<!doctype html><title>Loading</title><h1>Loading</h1>${' '.repeat(4096)}`);
      held.push(() => res.end('<p>done</p>'));
    } else reply();
  });
  t.after(async () => {
    try { await marionette?.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch { /* gone */ }
    marionette?.close();
    if (firefox && firefox.exitCode === null) {
      await Promise.race([new Promise(done => firefox.once('exit', done)), sleep(5000)]);
      if (firefox.exitCode === null) firefox.kill('SIGKILL');
    }
    try { await client?.shutdown(); } catch { /* not running */ }
    release();
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
  // The shortened site-access wait, set in the add-on's own storage from one of its pages.
  await marionette.setContext('chrome');
  const uuid = await marionette.execute(`return WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)})?.mozExtensionHostname ?? null;`);
  await marionette.setContext('content');
  await marionette.navigate(`moz-extension://${uuid}/offscreen.html`);
  await marionette.execute(`const done = arguments[arguments.length - 1];
    chrome.storage.local.set({ siteAccessWaitMs: arguments[0], ...arguments[1] }).then(() => done(true), error => done(error.message));`,
  [WAIT_MS, extraLocal], { async: true });
  await marionette.navigate('about:blank');

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
  return { origin, client, marionette, chrome, handles, armWindow, approvals, stateOf, release, hits };
}

// Pages the site serves besides the portal: a note form whose Enter sends it (GET /sent).
const SITE_PAGES = {
  '/compose': '<!doctype html><title>Compose</title><h1>Compose</h1><form action="/sent"><label>Message '
    + '<input name="message" value="See you at six"></label><button>Send</button></form>',
  '/sent': '<!doctype html><title>Sent</title><h1>Sent</h1><p>message sent</p>',
};

// The modal's own page: its status line and Approve button (Marionette in the arm window's content).
async function modal(ctx, handle) {
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle, focus: false });
  return ctx.marionette.execute(`const approve = document.getElementById('approve');
    return { disabled: approve.disabled, text: approve.textContent, status: document.getElementById('status').textContent };`);
}

async function clickApprove(ctx, handle, level = 'read-only') {
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle, focus: false });
  const found = await ctx.marionette.send('WebDriver:FindElement', { using: 'css selector', value: level === 'full' ? '#act' : '#approve' });
  await ctx.marionette.send('WebDriver:ElementClick', { id: Object.values(found.value ?? found)[0] });
}

// The Firefox site-access prompt, answered (Allow) or only looked at.
const allowPrompt = ctx => ctx.chrome(`const found = permissionNote(); if (!found) return false;
  found.note.mainAction.callback({ source: 'button' }); found.win.PopupNotifications.remove(found.note); return true;`);
const promptOpen = ctx => ctx.chrome('return Boolean(permissionNote());');

// The toolbar icon opens the popup on every task tab; only an explicit Use/Act button approves.
async function clickIcon(ctx, match) {
  const [first] = await ctx.handles();
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle: first, focus: false });
  return ctx.chrome(`return (async () => {
    // ':loading': the tab still loading its first page (its address is about:blank until it commits).
    const wanted = t => arguments[0] === ':loading' ? t.hasAttribute('busy') : t.linkedBrowser.currentURI.spec.includes(arguments[0]);
    const win = browserWindows().find(w => w.gBrowser.tabs.some(wanted)) ?? taskWindow();
    const tab = win.gBrowser.tabs.find(wanted) ?? win.gBrowser.selectedTab;
    win.gBrowser.selectedTab = tab;
    win.focus();
    for (let i = 0; i < 20 && Services.focus.activeWindow !== win; i++) await new Promise(done => win.setTimeout(done, 100));
    const action = ExtensionParent.apiManager.global.browserActionFor(extension);
    const data = action.action?.getContextData?.(tab) ?? null;
    const info = { loading: tab.hasAttribute('busy'), popup: data?.popup ?? null, uri: tab.linkedBrowser.currentURI.spec };
    action.triggerAction(win);
    return info; })();`, [match]);
}

const steps = async (ctx, requestId, surface) => (await ctx.approvals(requestId))
  .filter(line => !surface || line.surface === surface).map(line => `${line.step}:${line.reason}`);

test('Firefox: Approve in a modal window that is not active shows the prompt, never hangs silently, never fires late', { skip, timeout: 120_000 }, async t => {
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

  // Nobody answers the prompt: the modal says where else to approve, then gives the click up; daemon.log has each step.
  const hint = await until(async () => /click the FAI Browser icon on the 127\.0\.0\.1:\d+ tab instead/.test((await modal(ctx, arm)).status), WAIT_MS);
  assert.ok(hint, `the modal says where else to approve: ${(await modal(ctx, arm)).status}`);
  const gaveUp = await until(async () => /nothing\s+was approved/.test((await modal(ctx, arm)).status), WAIT_MS + 5000);
  assert.ok(gaveUp, `the click is given up: ${(await modal(ctx, arm)).status}`);
  assert.deepEqual(await steps(ctx, created.requestId),
    ['shown:null', 'attempt:null', 'waiting:site_access_pending', 'failed:site_access_timeout']);
  const waiting = await ctx.stateOf(created.requestId);
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.approval, 'toolbar', 'the agent is told to use the toolbar icon');

  // The prompt is allowed late (Firefox shows it once its window is active): the given-up click approves nothing.
  await ctx.chrome('const win = browserWindows().find(isArm); win?.focus(); return true;');
  assert.ok(await until(() => allowPrompt(ctx), 5000), 'the pending prompt is still there to allow');
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

test('Firefox: the icon on a blank task opens choices; explicit Use waits for the page and never approves early', { skip, timeout: 90_000 }, async t => {
  const ctx = await setup(t);
  const created = await ctx.client.requestTab({ origins: [ctx.origin], mode: 'interactive', reason: 'Check the slow portal',
    url: `${ctx.origin}/held#view/deep/link` });
  const arm = await ctx.armWindow();
  assert.ok(arm, 'the request modal opened');
  const clicked = await clickIcon(ctx, ':loading');
  assert.equal(clicked.loading, true);
  assert.ok(clicked.popup?.endsWith('/popup.html'), 'the icon exposes approval choices even while the page is blank');
  assert.equal(await promptOpen(ctx), false, 'opening the toolbar never requests site permission');
  assert.equal((await ctx.stateOf(created.requestId)).state, 'pending');
  await clickApprove(ctx, arm);
  assert.ok(await until(() => allowPrompt(ctx), 5000), 'the explicit Use click requests site access');
  await sleep(500);
  assert.equal((await ctx.stateOf(created.requestId)).state, 'pending', 'no grant before the page commits');
  ctx.release();
  const outcome = await ctx.client.wait({ requestId: created.requestId, maxMs: 20_000 });
  assert.equal(outcome.state, 'active');
  assert.equal((await ctx.stateOf(created.requestId)).grant.level, 'read-only');
  assert.equal((await ctx.stateOf(created.requestId)).grant.tabMode, 'single');
});

test('Firefox: a streaming task keeps toolbar choices; explicit Act grants actions and multiple tabs', { skip, timeout: 90_000 }, async t => {
  const ctx = await setup(t);
  const created = await ctx.client.requestTab({ origins: [ctx.origin], mode: 'interactive', reason: 'Check the streaming portal',
    url: `${ctx.origin}/trickle` });
  assert.ok(await ctx.armWindow());
  assert.ok(await until(() => ctx.chrome(`return browserWindows().some(w => w.gBrowser.tabs.some(t =>
    t.linkedBrowser.currentURI.spec.includes('/trickle') && t.hasAttribute('busy')));`), 10_000));
  const clicked = await clickIcon(ctx, '/trickle');
  assert.equal(clicked.loading, true);
  assert.ok(clicked.popup?.endsWith('/popup.html'));
  assert.equal(await promptOpen(ctx), false);
  assert.equal((await ctx.stateOf(created.requestId)).state, 'pending');
  assert.ok(await clickPopup(ctx, created.requestId, 'full'), 'Act requested native site permission');
  assert.ok(await allowPrompt(ctx));
  const outcome = await ctx.client.wait({ requestId: created.requestId, maxMs: 15_000 });
  assert.equal(outcome.state, 'active');
  assert.equal((await ctx.stateOf(created.requestId)).grant.level, 'full');
  assert.equal((await ctx.stateOf(created.requestId)).grant.tabMode, 'multiple');
});

test('Firefox: toolbar Act permission waits are bounded, and a late answer cannot approve', { skip, timeout: 90_000 }, async t => {
  const ctx = await setup(t);
  const created = await ctx.client.requestTab({ origins: [ctx.origin], mode: 'interactive', reason: 'Check the portal',
    url: `${ctx.origin}/start` });
  assert.ok(await ctx.armWindow());
  assert.ok(await until(() => ctx.chrome(`return browserWindows().some(w => w.gBrowser.tabs.some(t =>
    t.linkedBrowser.currentURI.spec.includes('/start') && !t.hasAttribute('busy')));`), 10_000));
  await clickIcon(ctx, '/start');
  assert.equal(await promptOpen(ctx), false, 'the icon alone grants nothing and asks for nothing');
  assert.ok(await clickPopup(ctx, created.requestId, 'full'));
  assert.ok(await until(async () => (await steps(ctx, created.requestId, 'popup')).includes('failed:popup_no_outcome'), WAIT_MS + 8000));
  assert.equal((await ctx.stateOf(created.requestId)).state, 'pending');
  assert.ok(await allowPrompt(ctx));
  await sleep(2000);
  assert.equal((await ctx.stateOf(created.requestId)).state, 'pending', 'late native consent grants no lease');
  const arm = await ctx.armWindow();
  await clickApprove(ctx, arm, 'full');
  const outcome = await ctx.client.wait({ requestId: created.requestId, maxMs: 10_000 });
  assert.equal(outcome.state, 'active');
  assert.equal((await ctx.stateOf(created.requestId)).grant.level, 'full');
  assert.equal((await ctx.stateOf(created.requestId)).grant.tabMode, 'multiple');
});

// The toolbar popup's content runs in its own process: a frame script reads and clicks in it (with user input, so the
// popup's permissions.request counts as a click).
async function popupScript(ctx, code) {
  return ctx.chrome(`const browser = browserWindows().flatMap(w => [...w.document.querySelectorAll('browser[webextension-view-type="popup"]')])[0];
    if (!browser) return false;
    browser.messageManager.loadFrameScript('data:,' + encodeURIComponent(arguments[0]), false);
    return true;`, [code]);
}

test('Firefox: the popup\'s Approve whose site-access prompt is not answered is logged, bounded, and approves nothing late', { skip, timeout: 90_000 }, async t => {
  const ctx = await setup(t);
  // The user's own tab already on the site, not armed: the icon there opens the popup with "Approve this tab".
  const [first] = await ctx.handles();
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle: first, focus: false });
  await ctx.marionette.navigate(`${ctx.origin}/mine`);
  const created = await ctx.client.requestTab({ origins: [ctx.origin], mode: 'interactive', reason: 'Check the portal',
    url: `${ctx.origin}/start` });
  assert.ok(await ctx.armWindow(), 'the request modal opened');
  const clicked = await clickIcon(ctx, '/mine');
  assert.notEqual(clicked.popup, '', 'an ordinary tab: the icon opens the popup');
  assert.ok(await until(() => popupScript(ctx, 'const b = content.document.querySelector(".approve-request[data-level=read-only]:not(:disabled)"); '
    + 'if (b && !content.faiClicked) { content.faiClicked = true; const h = content.windowUtils.setHandlingUserInput(true); try { b.click(); } finally { h.destruct(); } '
    + 'sendAsyncMessage("fai-test:clicked", true); }').then(async ok => ok && await promptOpen(ctx)), 15_000),
  'Approve this tab clicked in the popup; Firefox asked for site access');
  assert.ok(await until(async () => (await steps(ctx, created.requestId, 'popup')).includes('failed:popup_no_outcome'), WAIT_MS + 8000),
    `the click with no outcome is logged: ${await steps(ctx, created.requestId, 'popup')}`);
  assert.deepEqual((await steps(ctx, created.requestId, 'popup')).filter(step => step !== 'shown:null'),
    ['attempt:null', 'failed:popup_no_outcome']);
  assert.equal((await ctx.stateOf(created.requestId)).approval, 'toolbar');
  // Allowed late: the popup's start names the given-up click and is refused.
  assert.ok(await allowPrompt(ctx), 'the prompt is still there to allow');
  await sleep(2000);
  assert.equal((await ctx.stateOf(created.requestId)).state, 'pending', 'a late answer approves nothing');
});

// The add-on's host permissions as Firefox holds them now.
const heldOrigins = async ctx => {
  const [handle] = await ctx.handles();
  await ctx.marionette.send('WebDriver:SwitchToWindow', { handle, focus: false });
  return ctx.chrome('return [...extension.allowedOrigins.patterns].map(pattern => pattern.pattern);');
};

// Issue #36 review: a request with an exact origin and domain roots, approved from the popup's "Approve this tab"
// (Firefox asks for the roots and the exact origin in one prompt) or the toolbar icon (the exact origins): the session
// keeps the exact origin's host access. A request modal that prepared the same request had tracked it first, and the
// reconcile after the approval removed it, so the lease lost its page at the next navigation.
for (const surface of ['popup', 'modal']) {
  test(`Firefox: a ${surface} approval of a request with an exact origin and domain roots keeps the exact origin's access`, { skip, timeout: 90_000 }, async t => {
    const ctx = await setup(t);
    const [first] = await ctx.handles();
    await ctx.marionette.send('WebDriver:SwitchToWindow', { handle: first, focus: false });
    if (surface === 'popup') await ctx.marionette.navigate(`${ctx.origin}/mine`);
    const created = await ctx.client.requestTab({ origins: [ctx.origin, 'https://*.example.net', 'https://*.blade.example.net'],
      mode: 'interactive', reason: 'Check the portal', url: `${ctx.origin}/start` });
    const arm = await ctx.armWindow();
    assert.ok(arm, 'the request modal opened');
    // The modal prepares its approval (and tracks the exact origin) before anyone clicks.
    assert.ok(await until(async () => !(await modal(ctx, arm)).disabled), 'the modal is ready');
    assert.ok(await until(() => ctx.chrome(`return browserWindows().some(w => w.gBrowser.tabs.some(t =>
      t.linkedBrowser.currentURI.spec.includes('/start') && !t.hasAttribute('busy')));`), 10_000), 'the task page loaded');
    if (surface === 'popup') {
      await clickIcon(ctx, '/mine');
      assert.ok(await until(() => popupScript(ctx, 'const b = content.document.querySelector(".approve-request[data-level=read-only]:not(:disabled)"); '
        + 'if (b && !content.faiClicked) { content.faiClicked = true; const h = content.windowUtils.setHandlingUserInput(true); try { b.click(); } finally { h.destruct(); } }')
        .then(async ok => ok && await promptOpen(ctx)), 15_000), 'Approve this tab asked for site access');
    } else {
      await clickApprove(ctx, arm, 'full');
      assert.ok(await until(() => promptOpen(ctx), 5000), 'Act in the modal asked for site access');
    }
    assert.ok(await allowPrompt(ctx), 'allowed');
    const outcome = await ctx.client.wait({ requestId: created.requestId, maxMs: 15_000 });
    assert.equal(outcome.state, 'active');
    await sleep(2000);
    const held = await heldOrigins(ctx);
    assert.ok(held.includes('http://127.0.0.1/*'), `the exact origin's access is kept: ${JSON.stringify(held)}`);
    // And the lease follows a same-origin navigation.
    const page = await ctx.client.observe({ requestId: created.requestId, allowedUrls: [`${ctx.origin}/next`] });
    const go = (page.result?.actions ?? page.actions ?? []).find(action => String(action.label ?? '').includes('/next')
      || action.type === 'navigate_allowed_url');
    assert.ok(go, `a navigate action to /next among ${JSON.stringify((page.result?.actions ?? page.actions ?? []).map(action => action.label)).slice(0, 300)}`);
    {
      const moved = await ctx.client.act({ requestId: created.requestId, revision: page.result?.revision ?? page.revision, actionId: go.id, waitMs: 15_000 });
      assert.notEqual(moved.result?.code ?? moved.code, 'origin_changed', JSON.stringify(moved).slice(0, 300));
      assert.equal((await ctx.stateOf(created.requestId)).state, 'active', 'still active after the navigation');
    }
  });
}

// Only access FAI itself added is ever removed: a site the user allowed by hand (about:addons) stays when a
// multiple-tab session approved by the toolbar icon (which asks for the task host inside the click) ends.
test('Firefox: a site the user allowed by hand keeps its access after a multiple-tab session on it ends', { skip, timeout: 90_000 }, async t => {
  const ctx = await setup(t);
  await ctx.marionette.setContext('chrome');
  await ctx.marionette.execute(`const done = arguments[arguments.length - 1];
    const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
    const extension = WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)}).extension;
    ExtensionPermissions.add(${JSON.stringify(GECKO_ID)}, { permissions: [], origins: ['http://127.0.0.1/*'] }, extension)
      .then(() => done(true), error => done(error.message));`, [], { async: true });
  await ctx.marionette.setContext('content');
  assert.ok((await heldOrigins(ctx)).includes('http://127.0.0.1/*'), 'allowed by hand');
  const created = await ctx.client.requestTab({ origins: [ctx.origin], mode: 'interactive', reason: 'Check the portal',
    url: `${ctx.origin}/start` });
  assert.ok(await ctx.armWindow(), 'the request modal opened');
  assert.ok(await until(() => ctx.chrome(`return browserWindows().some(w => w.gBrowser.tabs.some(t =>
    t.linkedBrowser.currentURI.spec.includes('/start') && !t.hasAttribute('busy')));`), 10_000), 'the page loaded');
  await clickIcon(ctx, '/start');
  assert.ok(await clickPopup(ctx, created.requestId, 'full'), 'explicit Act approves using held access');
  // Already held: Firefox shows no prompt; answer one if it does.
  await sleep(1000);
  await allowPrompt(ctx).catch(() => false);
  const outcome = await ctx.client.wait({ requestId: created.requestId, maxMs: 15_000 });
  assert.equal(outcome.state, 'active');
  await ctx.client.release(created.requestId, 'done');
  await until(async () => (await ctx.stateOf(created.requestId))?.state !== 'active', 5000);
  await sleep(3000);
  assert.ok((await heldOrigins(ctx)).includes('http://127.0.0.1/*'), `still allowed: ${JSON.stringify(await heldOrigins(ctx))}`);
});

// Select a real approval button in the toolbar's extension document. The frame's user-input scope is the
// same native permission gesture as a physical button click; opening the toolbar alone never calls it.
async function clickPopup(ctx, requestId, level) {
  const selector = `.approve-request[data-level="${level}"]:not(:disabled)`;
  return until(async () => {
    await popupScript(ctx, `const b = content.document.querySelector(${JSON.stringify(selector)});
      if (b && !content.faiClicked) { content.faiClicked = true;
        const h = content.windowUtils.setHandlingUserInput(true); try { b.click(); } finally { h.destruct(); } }`);
    return await promptOpen(ctx) || (await ctx.stateOf(requestId))?.state === 'active';
  }, 15_000);
}

// The user's click on a waiting action approval (the Approve gate): in the approval window (approve.html), or on the
// toolbar popup's card when the browser opened the popup instead. Returns the surface used, or null.
async function decideAction(ctx, decision, beforeClick = () => {}) {
  return until(async () => {
    for (const handle of await ctx.handles()) {
      await ctx.marionette.send('WebDriver:SwitchToWindow', { handle, focus: false });
      const url = await ctx.marionette.send('WebDriver:GetCurrentURL');
      if (!String(url.value ?? url).includes('/approve.html')) continue;
      // render() runs after an async storage read; until it fills #detail, #headline still holds the static default.
      const headline = await ctx.marionette.execute(`return document.getElementById("detail").textContent
        ? document.getElementById("headline").textContent : null;`);
      if (headline === null) continue;
      beforeClick();
      const found = await ctx.marionette.send('WebDriver:FindElement', { using: 'css selector', value: decision === 'approve' ? '#approve' : '#deny' });
      await ctx.marionette.send('WebDriver:ElementClick', { id: Object.values(found.value ?? found)[0] });
      return { surface: 'window', headline };
    }
    const onCard = code => ctx.chrome(`const browser = browserWindows().flatMap(w => [...w.document.querySelectorAll('browser[webextension-view-type="popup"]')])[0];
      const card = browser?.contentDocument?.querySelector('.approval-card');
      if (!card) return null;
      ${code}`, [decision]).catch(() => null);
    const headline = await onCard("return card.querySelector('.approval-label')?.textContent ?? '';");
    if (headline === null) return null;
    beforeClick();
    await onCard("card.querySelector(arguments[0] === 'approve' ? '.primary-button' : '.secondary-button').click(); return true;");
    return { surface: 'popup', headline };
  }, 30_000);
}

test('Firefox: a committing Enter (commits: true) asks once, runs only after Approve once, and Deny refuses it', { skip, timeout: 150_000 }, async t => {
  const ctx = await setup(t);
  // The site allowed by hand, so Act needs no site-access prompt here (the prompt flows are tested above).
  await ctx.marionette.setContext('chrome');
  await ctx.marionette.execute(`const done = arguments[arguments.length - 1];
    const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
    const extension = WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)}).extension;
    ExtensionPermissions.add(${JSON.stringify(GECKO_ID)}, { permissions: [], origins: ['http://127.0.0.1/*'] }, extension)
      .then(() => done(true), error => done(error.message));`, [], { async: true });
  await ctx.marionette.setContext('content');
  const created = await ctx.client.requestTab({ origins: [ctx.origin], mode: 'full', reason: 'Send the note', url: `${ctx.origin}/compose` });
  const { requestId } = created;
  assert.ok(await ctx.armWindow(), 'the request modal opened');
  assert.ok(await until(() => ctx.chrome(`return browserWindows().some(w => w.gBrowser.tabs.some(t =>
    t.linkedBrowser.currentURI.spec.includes('/compose') && !t.hasAttribute('busy')));`), 10_000), 'the page loaded');
  await clickIcon(ctx, '/compose');
  assert.ok(await clickPopup(ctx, requestId, 'full'), 'Act approves the task');
  await sleep(1000);
  await allowPrompt(ctx).catch(() => false);
  assert.equal((await ctx.client.wait({ requestId, maxMs: 15_000 })).state, 'active');
  const sent = () => ctx.hits.filter(url => url.startsWith('/sent')).length;
  const enterOn = async () => {
    const page = await ctx.client.observe({ requestId });
    return { page, enter: page.actions.find(action => action.type === 'submit_field') };
  };

  // Approve once: asked once, nothing sent before the click, one submission after it.
  let { page, enter } = await enterOn();
  assert.ok(enter, JSON.stringify(page.actions));
  const missing = await ctx.client.act({ requestId, actionId: enter.id, revision: page.revision }).catch(error => error);
  assert.match(String(missing?.message), /Enter needs commits/, 'an Enter without commits never reaches the page');
  const approving = ctx.client.act({ requestId, actionId: enter.id, revision: page.revision, commits: true,
    reason: 'Sends your note', waitMs: 90_000 });
  let sentBeforeClick = null;
  const approved = await decideAction(ctx, 'approve', () => { sentBeforeClick = sent(); });
  assert.ok(approved, 'the approval was shown and clicked');
  t.diagnostic(`approval surface: ${approved.surface}`);
  assert.equal(sentBeforeClick ?? 0, 0, 'nothing was sent while the approval waited');
  assert.match(approved.headline, /^Press Enter in "Message" on 127\.0\.0\.1:\d+\?$/);
  const done = await approving;
  assert.equal(done.state, 'done', JSON.stringify(done).slice(0, 400));
  assert.notEqual(done.result.code, 'approval_pending', JSON.stringify(done.result).slice(0, 400));
  assert.equal(done.result.page?.url?.includes('/sent') ?? true, true);
  assert.ok(await until(async () => sent() === 1, 10_000), `one submission: ${JSON.stringify(ctx.hits)}`);

  // Deny: refused_action, nothing sent.
  await ctx.client.act({ requestId, nav: 'back', waitMs: 30_000 });
  ({ page, enter } = await enterOn());
  assert.ok(enter, JSON.stringify(page.actions));
  const denying = ctx.client.act({ requestId, actionId: enter.id, revision: page.revision, commits: true, waitMs: 90_000 });
  assert.ok(await decideAction(ctx, 'deny'), 'the second ask was shown and denied');
  const denied = await denying;
  assert.equal(denied.result.code, 'refused_action', JSON.stringify(denied.result).slice(0, 400));
  await sleep(1000);
  assert.equal(sent(), 1, 'a denied Enter sends nothing');
});
