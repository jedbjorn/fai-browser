// Issues #30 and #31 in real Chromium, with the real extension and a private daemon, on synthetic pages (no real site):
// - with Multiple task tabs, a tab the page opens on the approved origin joins the request and takes the commands;
// - a link to an origin the request does not cover is refused up front; the agent asks for it on the same request,
//   the user approves the ask in the FAI Browser window (its card, with site access asked in the click), and the same
//   request, tab and page continue onto the new origin;
// - a higher level asked on the same request keeps its request id, lease, page and tab mode;
// - a command for a lease whose approval is still finishing (the old session superseded, the new one not bound yet)
//   is never answered "the user stopped the tab" (#31).
//
// The temporary manifest grants http://127.0.0.1/* and http://localhost/* (the site access the modal or the ask card
// asks for in the click; headless Chromium cannot show that prompt). One Chromium at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { createDaemon } from '../src/daemon.js';
import { FaiBrowserClient } from '../src/client.js';

const ROOT = resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

// One server, two origins: http://127.0.0.1:<port> (the task's) and http://localhost:<port> (the partner's).
function startSite() {
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const partner = `http://localhost:${port}`;
    const path = new URL(req.url, 'http://x').pathname;
    const page = (title, body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`);
    };
    if (path === '/child') return page('Child page', '<p>Opened by the task page.</p>');
    if (path === '/details') return page('Details page', '<p>Row details.</p><a href="/">Home</a>');
    if (path === '/partner') return page('Partner page', '<p>The partner site.</p>');
    return page('Task page', `<p>Rows.</p><a href="/details">Details</a> <a href="${partner}/partner">Partner page</a>
      <button type="button" onclick="window.open('/child')">Open child</button>`);
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}

async function launch(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-continuity-'));
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });
  const site = await startSite();
  cleanup.push(() => new Promise(done => { site.closeAllConnections?.(); site.close(done); }));
  const port = site.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const partner = `http://localhost:${port}`;
  const extension = join(scratch, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    // A page's window.open after a synthetic click: the popup blocker would stop it before the extension sees it.
    args: ['--no-sandbox', '--disable-popup-blocking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  cleanup.push(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const home = join(scratch, 'home');
  const secret = randomBytes(24).toString('hex');
  const daemon = createDaemon({ home, env: { FAI_BRIDGE_SECRET: secret, FAI_EXTENSION_ID: extensionId }, port: 0 });
  await daemon.listen();
  cleanup.push(() => daemon.close());
  // No page opens by itself and no approval window: the test approves through the worker, as the user's click does.
  await worker.evaluate(settings => chrome.storage.local.set(settings), {
    endpoint: `http://127.0.0.1:${daemon.port}`, secret, openRightAway: false, approvalWindow: false, tabMode: 'multiple' });
  assert.ok(await until(() => worker.evaluate(async () => (await chrome.storage.session.get('connection')).connection?.connected)),
    'the extension connects to the private daemon');
  const page = context.pages()[0];
  await page.goto(`${origin}/`);
  const client = new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName: 'continuity-test' });
  return { context, worker, extensionId, daemon, client, page, origin, partner };
}

// The user's approval of `requestId` on the task page's tab (startSession with that tab, as the modal's Approve does).
async function approve(env, requestId, { level, tabMode = 'single', ask = false, guardMs = 0 } = {}) {
  return env.worker.evaluate(async ({ requestId, level, tabMode, ask, guardMs, url }) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    // guardMs: the modal's own last check of the tab after the lease reply (approvalGuard) takes that long.
    const guard = guardMs ? async data => { if (data) await new Promise(done => setTimeout(done, guardMs)); } : undefined;
    try {
      await startSession({ requestId, level, tabMode, ...(ask ? { ask: true } : {}) }, { ...tab, ...(guard ? { approvalGuard: guard } : {}) });
      return 'ok';
    } catch (error) {
      return String(error?.message ?? error);
    }
  }, { requestId, level, tabMode, ask, guardMs, url: env.origin });
}

async function activeRequest(env, { mode = 'reversible', tabMode = 'multiple', origins = [env.origin] } = {}) {
  const { requestId } = await env.client.requestTab({ origins, mode, reason: 'Work on the task page' });
  assert.equal(await approve(env, requestId, { level: mode, tabMode }), 'ok');
  assert.equal((await env.client.wait({ requestId, maxMs: 5000 })).state, 'active');
  return requestId;
}

const actionFor = (observed, label) => observed.actions.find(action => action.label === label);
async function act(env, requestId, actionId) {
  const response = await env.client.act({ requestId, actionId, waitMs: 20_000 });
  return response.result;
}

test('#30 Multiple task tabs: a tab the page opens on the approved origin joins the request and takes the commands', async t => {
  const env = await launch(t);
  const requestId = await activeRequest(env);
  const observed = await env.client.observe({ requestId });
  const open = actionFor(observed, 'Open child');
  assert.ok(open, JSON.stringify(observed.actions.map(action => action.label)));
  const result = await act(env, requestId, open.id);
  assert.notEqual(result.status, 'needs_user', JSON.stringify({ code: result.code, needs: result.needs }));
  const view = (await env.client.getRequest(requestId));
  assert.equal(view.state, 'active', `still active: ${view.stateReason}`);
  const again = await env.client.observe({ requestId });
  assert.equal(again.page?.title ?? again.observation?.title, 'Child page', JSON.stringify(again.page ?? again.observation).slice(0, 300));
  assert.equal(again.lease?.requestId ?? requestId, requestId);
});

test('#30 an unapproved origin: refused up front, asked on the same request, approved, continued in the same tab', async t => {
  const env = await launch(t);
  const requestId = await activeRequest(env, { tabMode: 'single' });
  const { leaseId, tabId } = (await env.client.getRequest(requestId)).lease;
  const before = await env.client.observe({ requestId });
  assert.equal(actionFor(before, 'Partner page'), undefined, 'a link off the approved origins is not offered');
  const refused = (await env.client.act({ requestId, url: `${env.partner}/partner`, waitMs: 10_000 })).result;
  assert.equal(refused.code, 'cross_origin');
  assert.match(refused.needs.message, /fai_browser_open with this requestId and http:\/\/localhost:\d+ in origins/);
  const asked = await env.client.ask(requestId, { origins: [env.partner] });
  assert.equal(asked.asked, true);
  // The user approves the ask on its card in the FAI Browser window (a window of its own, as the worker opens it).
  const cdp = await env.context.browser()?.newBrowserCDPSession?.().catch(() => null);
  let card = null;
  if (cdp) {
    await cdp.send('Target.createTarget', { url: `chrome-extension://${env.extensionId}/popup.html?window=1`, newWindow: true });
    card = await until(() => env.context.pages().find(page => page.url().includes('popup.html')));
  }
  if (card) {
    await card.waitForSelector('.ask-approve:not([disabled])', { timeout: 5000 });
    assert.match(await card.locator('.ask-meta').innerText(), /Same task and tab: add http:\/\/localhost:\d+/);
    await card.click('.ask-approve');
  } else {
    // No CDP window: the same worker call the card makes.
    await env.worker.evaluate(async requestId => approveOnSessionTab({ type: 'start', requestId, level: 'reversible', ask: true,
      tabMode: 'single' }), requestId);
  }
  assert.ok(await until(async () => !(await env.client.getRequest(requestId)).ask), 'the ask is answered');
  const view = await env.client.getRequest(requestId);
  assert.deepEqual([view.state, view.lease.leaseId, view.lease.tabId], ['active', leaseId, tabId], 'same request, lease and tab');
  assert.ok(view.origins.includes(env.partner));
  const after = await env.client.observe({ requestId });
  const link = actionFor(after, 'Partner page');
  assert.ok(link, `the partner link is offered now: ${JSON.stringify(after.actions.map(action => action.label))}`);
  const landed = await act(env, requestId, link.id);
  assert.notEqual(landed.status, 'needs_user', JSON.stringify({ code: landed.code, needs: landed.needs }));
  const there = await env.client.observe({ requestId });
  assert.equal((there.page ?? there.observation).title, 'Partner page');
  assert.equal((await env.client.getRequest(requestId)).state, 'active');
});

test('#30 a higher level on the same request keeps its id, lease, page and tab mode', async t => {
  const env = await launch(t);
  const requestId = await activeRequest(env, { mode: 'read-only', tabMode: 'multiple' });
  const observed = await env.client.observe({ requestId });
  await act(env, requestId, actionFor(observed, 'Details').id);
  const lease = (await env.client.getRequest(requestId)).lease;
  const asked = await env.client.ask(requestId, { mode: 'reversible' });
  assert.equal(asked.request.ask.level, 'reversible');
  await env.worker.evaluate(async requestId => approveOnSessionTab({ type: 'start', requestId, level: 'reversible', ask: true,
    tabMode: 'multiple' }), requestId);
  const view = await env.client.getRequest(requestId);
  assert.deepEqual([view.requestId, view.state, view.lease.leaseId, view.grant.level, view.grant.tabMode],
    [requestId, 'active', lease.leaseId, 'reversible', 'multiple']);
  const now = await env.client.observe({ requestId });
  assert.equal((now.page ?? now.observation).title, 'Details page', 'the same page, not the start URL');
  assert.equal(now.permissions?.tabMode ?? 'multiple', 'multiple');
  assert.equal((await env.client.listRequests()).requests.length, 1, 'no second request');
});

test('#31 a command for a lease whose approval is still finishing is not answered "stopped"', async t => {
  const env = await launch(t);
  const first = await activeRequest(env, { mode: 'read-only', tabMode: 'single' });
  const { requestId } = await env.client.requestTab({ origins: [env.origin], mode: 'read-only', reason: 'A second task' });
  // The modal's last check after the lease reply takes 1.5 s: the daemon has the new lease active (and the old one
  // superseded, its session stopped in the worker) while the worker is still binding the new one.
  const approving = approve(env, requestId, { level: 'read-only', guardMs: 1500 });
  assert.equal((await env.client.wait({ requestId, maxMs: 5000 })).state, 'active');
  const observed = await env.client.observe({ requestId });
  assert.equal(observed.result?.code, undefined, `no lease code: ${JSON.stringify(observed.result?.needs ?? {})}`);
  assert.equal((observed.page ?? observed.observation)?.title, 'Task page');
  assert.equal(await approving, 'ok');
  const old = await env.client.observe({ requestId: first });
  assert.equal(old.result.code, 'request_closed');
  assert.match(old.result.needs.message, /replaced this one/);
});
