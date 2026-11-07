// The bench harness approves tabs like a user at the level each task needs: bench/fai-condition.mjs approveExpression
// (the popup script FaiRun.clickApprove runs) against popup.js in headless Chromium with a fake chrome API, and the
// QA corpus's approval levels (bench/qa/lib.mjs approvalLevel): every task at its declared mode, refusal tests never
// above the level their expectation assumes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { approveExpression } from '../bench/fai-condition.mjs';
import { approvalLevel, loadSuite, validateTask } from '../bench/qa/lib.mjs';
import { headlessEnv } from '../scripts/headless-env.mjs';

const EXTENSION = new URL('../extension/', import.meta.url);
const PAIRING = { endpoint: 'http://127.0.0.1:4999', secret: 's'.repeat(30) };

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(),
    args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

// popup.html with a fake chrome API: `local` is chrome.storage.local, `requests` the worker's pending requests,
async function popup(t, { local = {}, requests = [], mode = 'daemon' } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  t.after(() => page.close());
  await page.route('https://popup.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    route.fulfill({ contentType: type, body: await readFile(new URL(file, EXTENSION), 'utf8') });
  });
  await page.addInitScript(([local, requests, mode]) => {
    globalThis.__sent = [];
    globalThis.__local = local;
    const connection = { connected: true, transport: 'websocket', mode };
    globalThis.chrome = {
      storage: {
        local: {
          async get(keys) { return Object.fromEntries(keys.filter(key => key in __local).map(key => [key, structuredClone(__local[key])])); },
          async set(values) { Object.assign(__local, structuredClone(values)); },
        },
        session: { async get() { return { requests, connection }; } },
        onChanged: { addListener() {} },
      },
      tabs: { async query() { return [{ id: 7, url: 'http://127.0.0.1:5000/start', title: 'QA' }]; } },
      runtime: {
        async sendMessage(message) {
          __sent.push(message);
          return { status: message.type === 'start' ? 'active' : null, session: null, requests, connection };
        },
      },
    };
  }, [local, requests, mode]);
  await page.goto('https://popup.test/popup.html');
  await page.waitForFunction(() => document.querySelector('#transport').textContent.includes('websocket'));
  return page;
}

const request = mode => ({ requestId: 'req_qa', state: 'pending', origins: ['http://127.0.0.1:5000'], mode, reason: 'QA corpus', createdAt: new Date().toISOString() });
const starts = page => page.evaluate(() => __sent.filter(message => message.type === 'start'));

test('harness: approves the request card at the task level', async t => {
  const page = await popup(t, { requests: [request('full')] });
  assert.equal(await page.$eval('.request-card .level-select', node => node.value), 'full', 'preset: the asked level');
  const clicked = await page.evaluate(approveExpression({ level: 'interactive', ...PAIRING }));
  assert.equal(clicked.via, 'card');
  assert.equal(clicked.level, 'interactive');
  assert.deepEqual(await starts(page), [{ type: 'start', requestId: 'req_qa', level: 'interactive', tabMode: 'single' }]);
  assert.equal(await page.evaluate(() => __local.secret), PAIRING.secret, 'the typed secret is saved');
});

test('harness: without a level the card preset (the asked level) is approved', async t => {
  const page = await popup(t, { requests: [request('reversible')] });
  const clicked = await page.evaluate(approveExpression({ ...PAIRING }));
  assert.equal(clicked.level, 'reversible');
  assert.equal((await starts(page))[0].level, 'reversible');
});

test('harness: a level the card does not offer is refused and nothing is approved', async t => {
  const page = await popup(t, { requests: [request('testing')] });
  const clicked = await page.evaluate(approveExpression({ level: 'testing', ...PAIRING }));
  assert.equal(clicked.clicked, false);
  assert.equal(clicked.refused, true);
  assert.match(clicked.status, /not offered/);
  assert.deepEqual(await starts(page), []);
});

test('qa corpus: every task is approved at its declared mode; refusal tests never above it', () => {
  const suite = loadSuite();
  const refusalCodes = new Set(['refused_action', 'blocked', 'login', 'consent_banner']);
  const codes = clause => (clause.anyOf ? clause.anyOf.flatMap(codes) : [clause.code ?? []].flat());
  let reversible = 0;
  for (const task of suite.tasks) {
    assert.equal(approvalLevel(task), task.mode, `${task.id} approved at its mode`);
    if (task.mode === 'reversible') reversible += 1;
    if (task.expectOutcome && codes(task.expectOutcome).some(code => refusalCodes.has(code))) {
      assert.ok(['read-only', 'reversible'].includes(approvalLevel(task)), `${task.id}: never full or testing`);
    }
  }
  assert.ok(reversible >= 20, 'the reversible tasks are approved at reversible, not read-only');
  const cart = suite.tasks.find(task => task.id === 'cart-place-order');
  assert.equal(approvalLevel(cart), 'reversible', 'a purchase refusal is tested at reversible, not over-granted');
  assert.equal(approvalLevel({ ...cart, grant: 'read-only' }), 'read-only');
  assert.deepEqual(validateTask({ ...cart, grant: 'read-only' }).errors, []);
  assert.ok(validateTask({ ...cart, mode: 'read-only', grant: 'reversible' }).errors.some(e => /never over-grant/.test(e)));
  assert.ok(validateTask({ ...cart, grant: 'full' }).errors.some(e => /grant must be/.test(e)));
});
