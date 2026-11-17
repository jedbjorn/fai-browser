// Real Chromium, the real extension and a private daemon (spec #79 "Window over the driven tab", acceptance 8 and 9):
// with two normal windows and the task tab in the one that is not focused, an act that asks the user opens the
// approval window inside the task tab's window, top right, with the direct line `Click "<label>" on <site>?`. When the
// task tab then navigates (a redirect on the approved site) while the ask waits, the window stays open and adds the
// page-changed line.
//
// Headless, like every test browser here (test/headless-guard.test.js). Headless Chromium honors window positions and
// tracks the last focused window, but reports every window focused and gives a new window its default size whatever
// width and height were asked: the test records the bounds the worker asks for (chrome.windows.create) and checks
// those lie inside the task tab's window and that the browser put the window at that position.
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
const CHECKOUT = '<!doctype html><title>Checkout</title><h1>Checkout</h1><p>Total $12.00</p><button>Place order</button>';

async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

test('approval window: opens over the task tab\'s unfocused window with the direct line, and survives its navigation', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-approval-window-'));
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  });

  // The site: a checkout page (its "Place order" is a purchase, which asks at Act), and /go, a redirect back to a
  // second checkout step on the same site.
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/go')) {
      res.writeHead(302, { Location: '/checkout/review' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CHECKOUT);
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise(done => { site.closeAllConnections?.(); site.close(done); }));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const host = new URL(origin).host;

  const extension = join(scratch, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox', '--screen-info={3000x2000}', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  cleanup.push(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = await worker.evaluate(() => chrome.runtime.id);

  const secret = randomBytes(24).toString('hex');
  const daemon = createDaemon({ home: join(scratch, 'home'), env: { FAI_BRIDGE_SECRET: secret, FAI_EXTENSION_ID: extensionId }, port: 0 });
  await daemon.listen();
  cleanup.push(() => daemon.close());
  await context.pages()[0].goto(`${origin}/`);
  await worker.evaluate(pairing => chrome.storage.local.set(pairing), { endpoint: `http://127.0.0.1:${daemon.port}`, secret });
  assert.ok(await until(() => worker.evaluate(async () => (await chrome.storage.session.get('connection')).connection?.connected)),
    'the extension connects to the private daemon');

  // Act on the checkout page.
  const client = new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName: 'approval-window-test' });
  const created = await client.requestTab({ origins: [origin], mode: 'full', reason: 'Place the order', url: `${origin}/checkout` });
  const prompt = await until(() => context.pages().find(page => page.url().includes('/arm.html')));
  assert.ok(prompt, 'the request modal opened');
  await prompt.waitForSelector('#act:not([disabled])', { timeout: 10_000 });
  await prompt.click('#act');
  assert.equal((await client.wait({ requestId: created.requestId, maxMs: 10_000 })).state, 'active');

  // Two normal windows: the task tab's (moved to the right of the screen) and another one, focused, on the left.
  const taskWindow = await worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url: `${url}/checkout` });
    await chrome.windows.update(tab.windowId, { state: 'normal', left: 1400, top: 100, width: 1200, height: 900 });
    return chrome.windows.get(tab.windowId);
  }, origin);
  assert.deepEqual([taskWindow.left, taskWindow.top, taskWindow.width, taskWindow.height], [1400, 100, 1200, 900]);
  const other = await worker.evaluate(() => chrome.windows.create({ url: 'about:blank', type: 'normal', focused: true,
    left: 0, top: 0 }));
  assert.ok(await until(() => worker.evaluate(async id => (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id === id,
    other.id)), 'the other window has the focus');
  // What the worker asks of chrome.windows.create for a popup window.
  await worker.evaluate(() => {
    const create = chrome.windows.create.bind(chrome.windows);
    globalThis.popupAsks = [];
    chrome.windows.create = options => {
      if (options?.type === 'popup') globalThis.popupAsks.push(options);
      return create(options);
    };
  });

  // The agent's act on "Place order" asks; nobody answers within its wait.
  const page = await client.observe({ requestId: created.requestId, capture: false });
  const order = page.actions.find(action => action.label === 'Place order');
  assert.ok(order?.needsApproval, `the purchase asks the user: ${JSON.stringify(page.actions)}`);
  const asked = await client.act({ requestId: created.requestId, actionId: order.id, revision: page.revision, approvalWaitMs: 1500,
    reason: 'Place the order' });
  assert.equal(asked.result?.next?.kind ?? asked.next?.kind, 'approve', JSON.stringify(asked));

  // Acceptance 8: the window lies inside the task tab's window, and the header is the direct line.
  // The window that shows approve.html, found through the extension's own contexts: without the tabs permission
  // Chrome 153 reports no URL for a tab, the extension's own pages included.
  const approvalWindow = () => worker.evaluate(async () => {
    const [page] = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] }))
      .filter(context => context.documentUrl?.startsWith(chrome.runtime.getURL('approve.html')));
    return page ? chrome.windows.get(page.windowId).catch(() => null) : null;
  });
  const shown = await until(approvalWindow);
  assert.ok(shown, 'the approval window opened (not the toolbar popup of the focused window)');
  const [ask] = await worker.evaluate(() => globalThis.popupAsks);
  assert.match(ask?.url ?? '', /\/approve\.html\?bundle=/);
  const within = ask.left >= taskWindow.left && ask.top >= taskWindow.top
    && ask.left + ask.width <= taskWindow.left + taskWindow.width && ask.top + ask.height <= taskWindow.top + taskWindow.height;
  assert.ok(within, `inside the task window: ${JSON.stringify({ ask, taskWindow })}`);
  assert.deepEqual([ask.left, ask.top], [1400 + 1200 - 440 - 24, 100 + 90], 'top right, below the toolbar');
  assert.deepEqual([shown.left, shown.top], [ask.left, ask.top], 'the browser placed it there');
  const approve = await until(() => context.pages().find(item => item.url().startsWith(`chrome-extension://${extensionId}/approve.html`)));
  assert.ok(approve, 'the approval page is reachable');
  await approve.waitForFunction(() => document.getElementById('headline').textContent.startsWith('Click'));
  assert.equal(await approve.textContent('#headline'), `Click "Place order" on ${host}?`);
  assert.equal(await approve.getAttribute('#headline .page-text', 'title'), 'Text from the page');
  assert.equal(await approve.isHidden('#changed'), true, 'nothing has changed yet');

  // Acceptance 9: the task tab navigates through a redirect on the approved site while the ask waits.
  await worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url: `${url}/checkout` });
    await chrome.tabs.update(tab.id, { url: `${url}/go` });
  }, origin);
  assert.ok(await until(() => worker.evaluate(async url => (await chrome.tabs.query({ url: `${url}/checkout/review` })).length === 1, origin)),
    'the tab followed the redirect');
  await approve.waitForSelector('#changed:not([hidden])', { timeout: 5000 });
  assert.equal(await approve.textContent('#changed'), 'The page has changed since the agent asked.');
  await sleep(500);
  assert.equal((await approvalWindow())?.id, shown.id, 'the same window is still open');
  assert.equal(approve.isClosed(), false);

  // Deny closes it, as before.
  // Clicked in the page: the window closes itself right after, which a Playwright click may still be waiting on.
  await approve.evaluate(() => document.getElementById('deny').click());
  assert.ok(await until(async () => (await approvalWindow()) === null, 5000), 'the window closes on the decision');
  await client.release(created.requestId);
});
