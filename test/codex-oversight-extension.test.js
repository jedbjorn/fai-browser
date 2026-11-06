// The repository's page harness uses headless Chromium, not jsdom.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { BrowserRuntime } from '../src/runtime.js';
import { FakeBridge } from './runtime-fixtures.js';

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function observe(t, body) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><title>Administration</title>${body}` }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  return page.evaluate(() => __faiPage.observe());
}

test('codex oversight: Reject in a consent-request administration form is not cookie consent', async t => {
  const observation = await observe(t, '<h1>Review access request</h1><div id="consent-requests">'
    + '<form><p>Application access request from Ada</p><button>Accept request</button><button>Reject request</button></form></div>');
  assert.equal(observation.consent, null, 'the form must not receive the consent submit-risk override');
  assert.equal(observation.controls.find(c => c.label === 'Reject request').risk, 'submit');
});

test('codex oversight: a mixed accept/reject consent label is never clicked mechanically', async t => {
  for (const label of ['Accept analytics; reject marketing', 'Accept analytics, necessary only']) {
  const observation = await observe(t, '<div role="dialog"><p>We use cookies.</p>'
    + `<button>${label}</button><button>Accept all</button></div>`);
  const mixed = observation.consent.buttons.find(b => b.label === label);
  assert.equal(mixed.kind, 'accept');
  let calls = 0;
  const bridge = new FakeBridge({ pages: { '/': { ...observation } } });
  const runtime = new BrowserRuntime({ bridge, provider: { async decide() { calls++; return { actionId: 'handoff' }; } } });
  const result = await runtime.run('Read the page', { capture: 'none' });
  assert.equal(result.code, 'consent_banner');
  assert.equal(bridge.executions.length, 0);
  assert.equal(calls, 0);
  }
});

test('codex oversight: cookie and consent mentions with ordinary Reject buttons do not create a banner', async t => {
  const observation = await observe(t, '<h1>Cookies and consent documentation</h1>'
    + '<p>This article explains cookies and consent.</p><form><button>Reject</button></form>');
  assert.equal(observation.consent, null);
});

test('codex oversight: expiry during navigation follow cannot report success or start capture', async () => {
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const event = () => ({ addListener() {}, removeListener() {} });
  const context = vm.createContext({ URL, AbortSignal, AbortController, setTimeout, clearTimeout, setInterval() {},
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} }, session: { set: async () => {} }, onChanged: event() },
      runtime: { onMessage: event(), onStartup: event(), onInstalled: event() },
      action: { setBadgeText: async () => {}, setTitle: async () => {} },
      tabs: { onCreated: event(), onActivated: event(), onRemoved: event(), onUpdated: event() },
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    session = { leaseId: 'lease', tabId: 7, origin: 'https://example.com', status: 'active' };
    globalThis.captures = 0;
    globalThis.recordedReplies = [];
    send = async (type, reply) => { if (type === 'result') recordedReplies.push(reply); return { valid: true }; };
    startCapture = () => { captures++; };
    globalThis.releaseFollow = null;
    const followGate = new Promise(resolve => { releaseFollow = resolve; });
    executeCommand = async () => {
      await followGate;
      return { observation: { url: 'https://example.com/landed' },
        settle: { reason: 'load_complete' }, navigated: true, captureDetails: {} };
    };
    globalThis.command = { version: 3, id: 'expired-follow', deadline: Date.now() + 30000,
      method: 'execute', lease: { id: 'lease', tabId: 7 }, allowedOrigins: ['https://example.com'] };
  `, context);
  const handling = vm.runInContext('handleCommand(command)', context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext('command.deadline = Date.now() - 1; releaseFollow();', context);
  await handling;
  assert.equal(context.captures, 0);
  assert.equal(context.recordedReplies[0].result, undefined);
  assert.equal(context.recordedReplies[0].error.code, 'timeout');
});
