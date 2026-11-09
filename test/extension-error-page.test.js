// Real Chromium and the real extension worker, through the harness companion: Chrome's own error page
// (chrome-error://chromewebdata/, committed for an HTTP error sent without a page body and for a dropped connection)
// on the approved origin. tab.url keeps the URL Chrome tried, and executeScript fails there ("Frame with ID 0 is
// showing error page" on Chromium 156). The session must stay active: the worker reports the page as a
// browserErrorPage observation, and a reload or another approved URL works once the site is back. A genuine origin
// change still pauses as origin_changed.
//
// Two browser runs, one after the other (never two Chromiums at once):
// - host access: the temporary manifest grants http://127.0.0.1/* (the exact host, as the request modal's site access
//   does), so the worker can read the tab after the error page;
// - toolbar access: no host permission, activeTab granted by a toolbar action (CDP Extensions.triggerAction). Chrome
//   withdraws activeTab when its own error page commits (an opaque origin), so tab.url is withheld and nothing can be
//   read: the session pauses as origin_changed, as for leaving the site. This case documents that browser behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { createCompanion } from '../bench/companion.js';

const ROOT = resolve(import.meta.dirname, '..');
const SECRET = 'disposable-error-page-pairing-token-123456789';
const sleep = ms => new Promise(done => setTimeout(done, ms));

// The approved site: "/" links to "/down", which answers 500 with no body while `state.down` is set; "/drop" closes
// the connection without an answer (ERR_EMPTY_RESPONSE). Both make Chrome show its own error page.
function startSite(state) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/drop') {
      req.socket.destroy();
      return;
    }
    if (path === '/down' && state.down) {
      res.writeHead(500);
      res.end();
      return;
    }
    const title = path === '/down' ? 'Recovered' : 'Home';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>The ${title.toLowerCase()} page.</p>`
      + '<a href="/down">Down page</a>');
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}

// Launches Chromium with a copy of the extension whose manifest has `hostPermissions`, pairs it with a companion for
// `origin` and leases the active tab at `level` (startSession with the tab, as the toolbar click does).
async function launch(t, { hostPermissions, origin, startUrl, toolbar = false }) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-error-page-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const extension = join(scratch, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = hostPermissions;
  // The toolbar action must reach chrome.action.onClicked (no popup) for Extensions.triggerAction to grant activeTab.
  if (toolbar) delete manifest.action.default_popup;
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox', ...(toolbar ? ['--enable-unsafe-extension-debugging'] : []),
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const companion = createCompanion({ port: 0, extensionId, secret: SECRET, allowedOrigins: [origin] });
  const { port } = await companion.listen();
  t.after(() => companion.close());
  const page = context.pages()[0];
  await page.goto(startUrl);
  if (toolbar) {
    const cdp = await context.browser().newBrowserCDPSession();
    const tabs = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tabs[0].targetId });
    await cdp.detach();
  }
  const leased = companion.waitForLease({ timeoutMs: 10_000 });
  const started = await worker.evaluate(async ({ endpoint, secret }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    try {
      await startSession({ endpoint, secret, level: 'read-only' }, tab);
      return 'ok';
    } catch (error) {
      return String(error?.message || error);
    }
  }, { endpoint: `http://127.0.0.1:${port}`, secret: SECRET });
  assert.equal(started, 'ok');
  assert.equal((await leased).status, 'active');
  return { page, companion };
}

// The bridge call's BridgeError code, or 'ok'.
const codeOf = promise => promise.then(() => 'ok', error => String(error?.code ?? error?.message));

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

test('host access: the browser error page on the approved origin is observed, the session stays active, reload recovers', async t => {
  const state = { down: true };
  const site = await startSite(state);
  t.after(() => new Promise(done => { site.closeAllConnections?.(); site.close(done); }));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const { page, companion } = await launch(t, { hostPermissions: ['http://127.0.0.1/*'], origin, startUrl: `${origin}/` });
  const { bridge } = companion;

  // The link to the failing page, followed by the extension: the landing is Chrome's error page.
  const home = await bridge.observe();
  assert.equal(home.title, 'Home');
  const link = home.controls.find(control => control.label === 'Down page');
  assert.ok(link, JSON.stringify(home.controls.map(control => control.label)));
  const clicked = await bridge.execute({ type: 'click', target: link.id }, home.revision, { capture: false });
  const landed = clicked.observation;
  assert.equal(landed.url, `${origin}/down`);
  assert.equal(landed.browserErrorPage, true);
  assert.equal(landed.controls.length, 0);
  assert.ok(landed.warnings.includes('browser_error_page'));
  assert.equal(companion.status().status, 'active');

  // An observe of it again: the same page, still active.
  const again = await bridge.observe();
  assert.equal(again.browserErrorPage, true);
  assert.equal(again.revision, landed.revision);
  // A page action there fails that command only.
  assert.equal(await codeOf(bridge.execute({ type: 'scroll', direction: 'down' }, again.revision, { capture: false })),
    'target_unavailable');
  assert.equal(companion.status().status, 'active');

  // The site is back: a reload from the error page reads it, in the same session.
  state.down = false;
  const reloaded = await bridge.execute({ type: 'history', move: 'reload' }, again.revision, { capture: false });
  assert.equal(reloaded.observation.title, 'Recovered');
  assert.equal(reloaded.observation.browserErrorPage, undefined);

  // A dropped connection shows the same browser error page; another approved URL opens from it.
  const dropped = await bridge.execute({ type: 'navigate_allowed_url', url: `${origin}/drop` }, reloaded.observation.revision,
    { capture: false });
  assert.equal(dropped.observation.browserErrorPage, true);
  assert.equal(dropped.observation.url, `${origin}/drop`);
  const back = await bridge.execute({ type: 'navigate_allowed_url', url: `${origin}/` }, dropped.observation.revision,
    { capture: false });
  assert.equal(back.observation.title, 'Home');
  assert.equal(companion.status().status, 'active');

  // A genuine origin change (another host the grant does not cover) still pauses the session as origin_changed.
  const elsewhere = origin.replace('127.0.0.1', 'localhost');
  await page.goto(`${elsewhere}/`);
  await until(() => companion.status().status !== 'active', 1000);
  if (companion.status().status === 'active') assert.equal(await codeOf(bridge.observe()), 'origin_changed');
  assert.ok(await until(() => companion.status().status === 'paused'), JSON.stringify(companion.status()));
  assert.equal(companion.status().reason, 'origin_changed');
});

test('toolbar access only: Chrome withdraws activeTab at its own error page, so the session pauses as origin_changed', async t => {
  const state = { down: true };
  const site = await startSite(state);
  t.after(() => new Promise(done => { site.closeAllConnections?.(); site.close(done); }));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const { companion } = await launch(t, { hostPermissions: [], origin, startUrl: `${origin}/`, toolbar: true });
  const { bridge } = companion;
  const home = await bridge.observe();
  const link = home.controls.find(control => control.label === 'Down page');
  assert.ok(link);
  const code = await codeOf(bridge.execute({ type: 'click', target: link.id }, home.revision, { capture: false }));
  assert.equal(code, 'origin_changed');
  assert.ok(await until(() => companion.status().status === 'paused'), JSON.stringify(companion.status()));
  assert.equal(companion.status().reason, 'origin_changed');
});
