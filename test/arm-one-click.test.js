// Real Chromium, the real extension and a private daemon: the request modal (arm.html) approves with exactly one
// click. The page that opened by itself is slow to answer, so the click lands while the task tab has not committed its
// first page yet (tab.url is still empty and pendingUrl names the page). The worker waits for that page to commit on
// the approved origin instead of refusing the click as "The page changed". An agent repeating the identical
// request-tab call while it waits gets the same request back: no second tab, no second prompt window.
//
// The temporary manifest grants http://127.0.0.1/* (as the modal's own site access does once allowed), so Chrome's
// site-access prompt resolves at once in the click; headless Chromium cannot show that prompt.
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
const SLOW_MS = 2500;

async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

test('arm.html: one click approves, even before the opened page has committed; a repeated request reuses the pending one', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-arm-click-'));
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });

  // The site: "/slow" answers after SLOW_MS (the first page of the request).
  const site = http.createServer((req, res) => {
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Slow</title><h1>Slow page</h1><button>Save draft</button>');
    };
    if (req.url.startsWith('/slow')) setTimeout(reply, SLOW_MS);
    else reply();
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise(done => { site.closeAllConnections?.(); site.close(done); }));
  const origin = `http://127.0.0.1:${site.address().port}`;

  const extension = join(scratch, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  cleanup.push(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = await worker.evaluate(() => chrome.runtime.id);

  const home = join(scratch, 'home');
  const secret = randomBytes(24).toString('hex');
  const daemon = createDaemon({ home, env: { FAI_BRIDGE_SECRET: secret, FAI_EXTENSION_ID: extensionId }, port: 0 });
  await daemon.listen();
  cleanup.push(() => daemon.close());
  await context.pages()[0].goto(`${origin}/`);
  await worker.evaluate(pairing => chrome.storage.local.set(pairing), { endpoint: `http://127.0.0.1:${daemon.port}`, secret });
  assert.ok(await until(() => worker.evaluate(async () => (await chrome.storage.session.get('connection')).connection?.connected)),
    'the extension connects to the private daemon');

  const client = new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName: 'one-click-test' });
  const body = { origins: [origin], mode: 'read-only', reason: 'Read the slow page', url: `${origin}/slow` };
  const armPages = () => context.pages().filter(page => page.url().includes('/arm.html'));
  const armedTabs = async () => (await worker.evaluate(() => chrome.storage.session.get('armedTabs'))).armedTabs ?? [];
  const created = await client.requestTab(body);
  assert.equal(created.state, 'pending');
  const prompt = await until(() => armPages()[0], 10_000);
  assert.ok(prompt, `the request modal opened next to the page: ${JSON.stringify(context.pages().map(page => page.url()))}`);

  // The agent repeats the identical call while the user has not clicked yet: the same pending request comes back,
  // and nothing new opens.
  const again = await client.requestTab(body);
  assert.equal(again.requestId, created.requestId, 'an identical repeat reuses the pending request');
  assert.equal(again.repeated, true);
  await sleep(300);
  assert.equal(armPages().length, 1, 'no second request window');
  assert.equal((await armedTabs()).length, 1, 'no second task tab');

  // One click while the slow page is still loading (the tab has not committed it yet).
  await prompt.waitForSelector('#approve:not([disabled])', { timeout: 5000 });
  const before = await worker.evaluate(async () => {
    const [arm] = (await chrome.storage.session.get('armedTabs')).armedTabs ?? [];
    const tab = arm ? await chrome.tabs.get(arm.tabId) : null;
    return { url: tab?.url ?? null, pendingUrl: tab?.pendingUrl ?? null };
  });
  assert.equal(before.pendingUrl, `${origin}/slow`, `the click lands before the page commits: ${JSON.stringify(before)}`);
  assert.deepEqual(await prompt.locator('.arm-actions button').allTextContents(), ['Use', 'Act', 'Deny this request']);
  assert.equal(await prompt.locator('select').count(), 0);
  await prompt.click('#approve');
  const outcome = await client.wait({ requestId: created.requestId, maxMs: SLOW_MS + 8000 });
  const status = await prompt.evaluate(() => document.querySelector('#status')?.textContent).catch(() => '(closed)');
  assert.equal(outcome.state, 'active', `one click approves (modal: ${status})`);
  assert.ok(await until(() => armPages().length === 0, 5000), 'the request window closes once approved');
  assert.equal((await client.status()).requests.filter(view => view.state === 'pending').length, 0, 'no second request waits');
  const useView = await client.observe({ requestId: created.requestId, capture: false });
  assert.equal(useView.permissions.effective, 'read-only');
  assert.equal(useView.permissions.tabMode, 'single');
  assert.ok(!useView.actions.some(action => action.label === 'Save draft'));

  await client.release(created.requestId);
  const actRequest = await client.requestTab({ ...body, reason: 'Act on the draft', url: `${origin}/act` });
  const actPrompt = await until(() => armPages()[0]);
  await actPrompt.waitForSelector('#act:not([disabled])');
  await actPrompt.click('#act');
  const actOutcome = await client.wait({ requestId: actRequest.requestId, maxMs: 8000 });
  assert.equal(actOutcome.state, 'active');
  const actView = await client.observe({ requestId: actRequest.requestId, capture: false });
  assert.equal(actView.permissions.effective, 'full', 'Act overrides the original read-only default');
  assert.equal(actView.permissions.tabMode, 'multiple');
  assert.ok(actView.actions.some(action => action.label === 'Save draft'));

  await client.release(actRequest.requestId);
  await worker.evaluate(() => chrome.storage.local.set({ openRightAway: false, tabMode: 'single' }));
  const direct = await client.requestTab({ ...body, mode: 'full', reason: 'Direct Act approval', url: `${origin}/direct` });
  // Headless Chromium does not expose the toolbar popup as a Playwright page. Open that
  // same request UI explicitly; its one Act click must handle the task page and approval.
  const requestPopup = await context.newPage();
  await requestPopup.goto(`chrome-extension://${extensionId}/popup.html?window=1`);
  const actButton = requestPopup.locator(`[data-request-id="${direct.requestId}"] .approve-request[data-level="full"]`);
  await actButton.waitFor();
  await actButton.click();
  const directOutcome = await client.wait({ requestId: direct.requestId, maxMs: 8000 });
  assert.equal(directOutcome.state, 'active', 'one Act click opens and approves the requested task page');
  assert.equal(armPages().length, 0, 'no second FAI approval modal is needed');
  const directView = await client.observe({ requestId: direct.requestId, capture: false });
  assert.equal(directView.permissions.effective, 'full');
  assert.equal(directView.permissions.tabMode, 'multiple', 'old single-tab setting cannot veto Act');

});
