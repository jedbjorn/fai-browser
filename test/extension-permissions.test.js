// The popup's Permissions section and request-card level selector (configurable-guardrails.md §3.3): the pure logic
// in extension/permissions.js (storage shape, default level, origin validation, testing visibility), its agreement
// with the worker's and the runtime's level tables, and popup.js itself in headless Chromium against a fake chrome
// API (what it renders and stores, and the exact `start` message Approve sends).
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import {
  BUDGET_LIMITS, BUDGET_MINUTES, CAPABILITIES, DEFAULT_LEVELS, LEVELS, LEVEL_TEXT, addTestingOrigin, budgetFromFields,
  describeBudget, exactOrigin, levelChoices, minLevel, normalizeBudget, normalizePermissions, normalizeRememberedSites,
  removeTestingOrigin, requestedLevel, startTarget, testingAllowed,
} from '../extension/permissions.js';
import { TESTING_WARNING } from '../extension/ui.js';
import * as guardrails from '../src/guardrails.js';

const EXTENSION = new URL('../extension/', import.meta.url);

test('empty or malformed storage yields Act (preselect ceiling) and no testing environments', () => {
  assert.deepEqual(normalizePermissions(undefined), { defaultLevel: 'full', testingOrigins: [] });
  assert.deepEqual(normalizePermissions(null), { defaultLevel: 'full', testingOrigins: [] });
  assert.deepEqual(normalizePermissions({ defaultLevel: 'testing', testingOrigins: 'http://localhost:3000' }),
    { defaultLevel: 'full', testingOrigins: [] }, 'testing is never a default; a string is not a list');
  assert.deepEqual(normalizePermissions({
    defaultLevel: 'full',
    testingOrigins: ['http://localhost:3000', 'http://localhost:3000', 'https://*.example.com', 'ftp://x.test', 42, 'http://127.0.0.1:8080'],
  }), { defaultLevel: 'full', testingOrigins: ['http://localhost:3000', 'http://127.0.0.1:8080'] });
  for (const level of DEFAULT_LEVELS) assert.equal(normalizePermissions({ defaultLevel: level }).defaultLevel, level);
});

test('testing environments are exact http(s) origins: no paths, wildcards, user info or other schemes', () => {
  for (const origin of ['http://localhost:3000', 'http://localhost', 'http://127.0.0.1:5173', 'https://staging.example.com',
    'http://[::1]:8080', 'https://xn--bcher-kva.example']) {
    assert.equal(exactOrigin(origin), origin, origin);
  }
  for (const value of ['https://staging.example.com/', 'https://staging.example.com/app', 'https://*.example.com',
    'staging.example.com', 'localhost:3000', 'ftp://example.com', 'chrome://extensions', 'file:///tmp',
    'https://user:pw@example.com', 'HTTPS://Example.com', 'https://example.com:443', 'http://localhost:3000?x=1',
    '', ' http://localhost:3000', null, 42]) {
    assert.equal(exactOrigin(value), null, String(value));
  }
});

test('adding and removing testing environments', () => {
  const empty = normalizePermissions(undefined);
  const added = addTestingOrigin(empty, '  http://localhost:3000  ');
  assert.deepEqual(added.permissions, { defaultLevel: 'full', testingOrigins: ['http://localhost:3000'] });
  assert.match(addTestingOrigin(added.permissions, 'http://localhost:3000').error, /already listed/);
  assert.match(addTestingOrigin(empty, 'https://staging.example.com/app').error, /Did you mean https:\/\/staging\.example\.com\?/);
  assert.match(addTestingOrigin(empty, 'https://*.example.com').error, /no wildcards/);
  assert.doesNotMatch(addTestingOrigin(empty, 'https://*.example.com').error, /Did you mean/);
  assert.match(addTestingOrigin(empty, 'ftp://example.com').error, /exact origin/);
  assert.deepEqual(removeTestingOrigin(added.permissions, 'http://localhost:3000').testingOrigins, []);
});

test('the request card offers levels up to the asked one, presets the asked one, and offers testing only for listed origins', () => {
  const permissions = { defaultLevel: 'full', testingOrigins: ['http://localhost:3000', 'http://localhost:4000'] };
  const levels = choice => choice.options.map(option => option.level);
  const names = choice => choice.options.map(option => option.name);
  // The bug this fixes: with empty storage a Full request preset to Read-only.
  let choice = levelChoices({ mode: 'full', origins: ['https://app.example.com'] }, undefined);
  assert.equal(choice.requested, 'full');
  assert.equal(choice.preset, 'full');
  assert.deepEqual(levels(choice), ['read-only', 'interactive', 'full']);
  assert.deepEqual(names(choice), ['Read', 'Use', 'Act']);
  assert.equal(levelChoices({ mode: 'full', origins: ['https://a.test'] }, { defaultLevel: 'read-only' }).preset, 'read-only',
    'the Preselect up to setting caps the preset');
  assert.equal(levelChoices({ mode: 'full', origins: ['https://a.test'] }, { defaultLevel: 'reversible' }).preset, 'interactive',
    'a ceiling saved as Reversible counts as Use');
  choice = levelChoices({ mode: 'read-only', origins: ['https://app.example.com'] }, { defaultLevel: 'full' });
  assert.equal(choice.preset, 'read-only', 'never above what the agent asked for');
  assert.deepEqual(levels(choice), ['read-only'], 'nothing above the asked level is offered');
  assert.deepEqual(levels(levelChoices({ mode: 'reversible', origins: ['https://a.test'] }, permissions)), ['read-only', 'reversible'],
    'Use stands for reversible when that is what the agent asked for');
  assert.deepEqual(levels(levelChoices({ mode: 'interactive', origins: ['https://a.test'] }, permissions)), ['read-only', 'interactive']);
  assert.deepEqual(levels(levelChoices({ mode: 'full', origins: ['http://localhost:3000'] }, permissions)), ['read-only', 'interactive', 'full'],
    'Test site only when the agent asked for testing');
  choice = levelChoices({ mode: 'testing', origins: ['http://localhost:3000', 'http://localhost:4000'] }, permissions);
  assert.deepEqual(levels(choice), ['read-only', 'interactive', 'full', 'testing']);
  assert.equal(choice.options.at(-1).name, 'Test site');
  assert.equal(choice.preset, 'full', 'testing is never preset; the user picks it');
  assert.equal(choice.options.find(option => option.level === 'testing').warning, true);
  assert.equal(levelChoices({ mode: 'testing', origins: ['http://localhost:3000'] }, { defaultLevel: 'interactive', testingOrigins: ['http://localhost:3000'] }).preset, 'interactive');
  for (const origins of [['http://localhost:3000', 'https://prod.example.com'], [], undefined, ['http://localhost:3000/']]) {
    assert.ok(!levels(levelChoices({ mode: 'testing', origins }, permissions)).includes('testing'), JSON.stringify(origins));
  }
  assert.equal(levelChoices({ origins: ['https://a.test'] }, undefined).preset, 'read-only', 'empty storage, legacy request');
  assert.equal(requestedLevel({ mode: 'reversible' }), 'reversible');
  assert.equal(requestedLevel({ level: 'interactive', mode: 'read-only' }), 'interactive');
  assert.equal(requestedLevel({ mode: 'root' }), 'read-only');
  assert.equal(minLevel('testing', 'full'), 'full');
  assert.equal(minLevel('bogus', 'full'), 'read-only');
  assert.equal(testingAllowed(['http://localhost:3000'], ['http://localhost:3000']), true);
  assert.equal(testingAllowed([], ['http://localhost:3000']), false);
});

test('level copy describes purchase approval and the protections that remain on test sites', () => {
  assert.equal(LEVEL_TEXT.full.description,
    'Also saves, sends and deletes. Recognized purchases require approval when offered; otherwise they stay refused. No sign-in.');
  assert.equal(LEVEL_TEXT.testing.description,
    'May log in and buy on test sites. Origin, policy, redaction and approval protections remain.');
  assert.equal(TESTING_WARNING,
    'For your test sites only. The agent may log in, submit, delete and pay. Origin and policy limits, secret redaction and approval protections still apply.');
});

test('the popup, the worker and the runtime agree on the levels and their capabilities (drift check)', async () => {
  const worker = await readFile(new URL('background.js', EXTENSION), 'utf8');
  const levels = worker.match(/\nconst LEVELS = (\[[^\]]+\]);/)?.[1];
  const capabilities = worker.match(/\nconst CAPABILITIES = (\{[\s\S]*?\n\});/)?.[1];
  assert.ok(levels && capabilities, 'background.js defines LEVELS and CAPABILITIES');
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(`(${levels})`))), [...LEVELS]);
  const workerCapabilities = JSON.parse(JSON.stringify(vm.runInNewContext(`(${capabilities})`)));
  assert.deepEqual(workerCapabilities, JSON.parse(JSON.stringify(CAPABILITIES)));
  assert.deepEqual([...guardrails.LEVELS], [...LEVELS]);
  assert.deepEqual(JSON.parse(JSON.stringify(guardrails.CAPABILITIES)), JSON.parse(JSON.stringify(CAPABILITIES)));
  // purchase and sign_in exist only at testing.
  for (const level of LEVELS.slice(0, -1)) {
    assert.ok(!CAPABILITIES[level].includes('purchase') && !CAPABILITIES[level].includes('sign_in'), level);
  }
});

// --- popup.js in Chromium -------------------------------------------------------------------------------------------

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

// Loads popup.html with a fake chrome API. `local` is chrome.storage.local, `requests` the worker's request list,
// `state` what the worker answers to every message (merged with the message log).
// `allowSite`: what Chrome's site-access prompt answers to chrome.permissions.request (recorded in __permissionRequests).
// `held`: patterns Chrome already holds (chrome.permissions.contains); removals are recorded in __permissionRemovals.
async function popup(t, { local = {}, requests = [], state = {}, tabUrl = 'http://localhost:3000/app', allowSite = true,
  held = [], query = '', pinned = true, connected = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  t.after(() => page.close());
  await page.route('https://popup.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    route.fulfill({ contentType: type, body: await readFile(new URL(file, EXTENSION), 'utf8') });
  });
  await page.addInitScript(([local, requests, state, tabUrl, allowSite, held, pinned, connected]) => {
    const listeners = [];
    globalThis.__permissionRequests = [];
    globalThis.__permissionRemovals = [];
    const granted = new Set(held);
    globalThis.__listeners = listeners;
    globalThis.__state = state;
    // The worker's request list: a test may replace it (the next reply and session read return it).
    globalThis.__requests = requests;
    globalThis.__sent = [];
    globalThis.__local = local;
    globalThis.__closed = 0;
    window.close = () => { globalThis.__closed++; };
    globalThis.__tabQueries = 0;
    globalThis.chrome = {
      storage: {
        local: {
          async get(keys) { return Object.fromEntries(keys.filter(key => key in __local).map(key => [key, structuredClone(__local[key])])); },
          async set(values) { Object.assign(__local, structuredClone(values)); },
        },
        session: { async get() { return { requests: __requests, approvals: __state.approvals ?? [], connection: { connected, transport: connected ? 'websocket' : 'none', paired: connected, native: __state.native ?? null, ...(__state.connection ?? {}) } }; } },
        onChanged: { addListener(listener) { listeners.push(listener); } },
      },
      tabs: { async query() { __tabQueries++; return [{ id: 7, url: tabUrl, title: 'App' }]; } },
      permissions: { request(permission) {
        __permissionCalls.push({ permission, active: navigator.userActivation.isActive });
        return Promise.resolve(__access);
      } },
      commands: { async getAll() { return [{ name: '_execute_action', shortcut: 'Ctrl+Shift+Y' }]; } },
      action: { async getUserSettings() { return { isOnToolbar: pinned }; } },
      permissions: {
        async request(value) {
          __permissionRequests.push({ ...value, sentBefore: __sent.length, heldBefore: value.origins.every(o => granted.has(o)) });
          if (allowSite) for (const origin of value.origins) granted.add(origin);
          return allowSite || value.origins.every(o => granted.has(o));
        },
        async contains({ origins }) { return origins.every(origin => granted.has(origin)); },
        async remove({ origins }) {
          __permissionRemovals.push(...origins);
          for (const origin of origins) granted.delete(origin);
          return true;
        },
      },
      runtime: {
        async sendMessage(message) {
          __sent.push(message);
          if (message.type === 'pair' && __state.pairError) return { error: __state.pairError };
          const live = connected || (message.type === 'pair' && !__state.pairError);
          return { status: __state.status ?? null, session: __state.session ?? null, requests: __requests,
            connection: { connected: live, transport: live ? 'websocket' : 'none', paired: live, native: __state.native ?? null,
              ...(__state.control ? { control: __state.control } : {}), ...(__state.connection ?? {}) } };
        },
      },
    };
  }, [local, requests, state, tabUrl, allowSite, held, pinned, connected]);
  await page.goto(`https://popup.test/popup.html${query}`);
  await page.waitForFunction(expected => document.querySelector('#transport').textContent.includes(expected),
    connected ? 'websocket' : 'not connected');
  return page;
}

const PAIRED = { endpoint: 'http://127.0.0.1:4318', secret: 'x'.repeat(30) };
const request = (origins, mode) => ({ requestId: 'req_1', state: 'pending', origins, mode, reason: 'Run the checkout test', createdAt: new Date().toISOString() });
const options = page => page.$$eval('.request-card .level-select option', nodes => nodes.map(node => node.value));
// How many elements match. Never assert on an element handle itself: a failing assertion makes node inspect the whole
// Playwright object graph behind it, which takes gigabytes of memory in seconds.
const count = (page, selector) => page.locator(selector).count();

async function computedDescription(page, selector) {
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = await session.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { nodes } = await session.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    return nodes[0]?.description?.value ?? '';
  } finally {
    await session.detach();
  }
}

test('popup: works with empty storage; Advanced preselects up to Act and no testing environments', async t => {
  const page = await popup(t, { requests: [request(['http://localhost:3000'], 'full')] });
  assert.equal(await page.$eval('#default-level', node => node.value), 'full');
  assert.equal(await page.$eval('#testing-empty', node => node.hidden), false);
  assert.equal(await page.$eval('.request-card .level-select', node => node.value), 'full', 'preset: what the agent asked for');
  assert.deepEqual(await options(page), ['read-only', 'interactive', 'full']);
  assert.deepEqual(await page.$$eval('.request-card .level-select option', nodes => nodes.map(node => node.textContent)),
    ['Read', 'Use', 'Act']);
  assert.match(await page.$eval('.request-meta', node => node.textContent), /asks for Act/);
});

test('popup: the default level and testing environments persist as permissions = { defaultLevel, testingOrigins }', async t => {
  const page = await popup(t, { local: { ...PAIRED } });
  assert.equal(await page.$eval('#advanced', node => node.open), false, 'Advanced starts collapsed');
  await page.click('#advanced summary');
  assert.equal(await page.$eval('#default-level', node => node.value), 'full', 'preselect up to Act by default');
  await page.selectOption('#default-level', 'interactive');
  assert.match(await page.$eval('#default-level-help', node => node.textContent), /up to this level/);
  await page.fill('#testing-origin', 'https://staging.example.com/app');
  await page.click('#testing-add');
  assert.match(await page.$eval('#testing-error', node => node.textContent), /Did you mean https:\/\/staging\.example\.com\?/);
  await page.fill('#testing-origin', 'http://localhost:3000');
  await page.press('#testing-origin', 'Enter');
  await page.fill('#testing-origin', 'https://staging.example.com');
  await page.click('#testing-add');
  assert.deepEqual(await page.evaluate(() => __local.permissions),
    { defaultLevel: 'interactive', testingOrigins: ['http://localhost:3000', 'https://staging.example.com'] });
  assert.deepEqual(await page.$$eval('#testing-list code', nodes => nodes.map(node => node.textContent)),
    ['http://localhost:3000', 'https://staging.example.com']);
  await page.click('#testing-list button[aria-label="Remove http://localhost:3000"]');
  assert.deepEqual(await page.evaluate(() => __local.permissions.testingOrigins), ['https://staging.example.com']);
});

test('popup: Testing appears only when every requested origin is listed, warning-styled; Approve sends the level', async t => {
  const local = { ...PAIRED, permissions: { defaultLevel: 'full', testingOrigins: ['http://localhost:3000'] } };
  const mixed = await popup(t, { local, requests: [request(['http://localhost:3000', 'https://prod.example.com'], 'testing')] });
  assert.ok(!(await options(mixed)).includes('testing'));

  const page = await popup(t, { local, requests: [request(['http://localhost:3000'], 'testing')] });
  assert.deepEqual(await options(page), ['read-only', 'interactive', 'full', 'testing']);
  assert.equal(await page.$eval('.request-card .level-select', node => node.value), 'full', 'preset: requested, never testing');
  assert.equal(await page.$eval('.request-card .level-warning', node => node.hidden), true);
  assert.equal(await page.$eval('option[value="testing"]', node => node.className), 'level-testing');
  for (const level of ['read-only', 'interactive', 'full']) {
    await page.selectOption('.request-card .level-select', level);
    assert.equal(await page.getAttribute('.request-card .level-select', 'aria-describedby'), 'level-req_1-help');
    assert.equal(await computedDescription(page, '.request-card .level-select'), LEVEL_TEXT[level].description);
  }
  assert.match(await page.textContent('#advanced'), /Test site\. Origin and policy limits, redaction and approval protections still apply\./);
  await page.selectOption('.request-card .level-select', 'testing');
  assert.equal(await page.$eval('.request-card', node => node.dataset.level), 'testing');
  assert.equal(await page.$eval('.request-card .level-help', node => node.textContent), LEVEL_TEXT.testing.description);
  assert.equal(await page.$eval('.request-card .level-warning', node => node.hidden), false);
  assert.equal(await page.getAttribute('.request-card .level-select', 'aria-describedby'), 'level-req_1-help level-req_1-warning');
  const testingDescription = await computedDescription(page, '.request-card .level-select');
  assert.match(testingDescription, new RegExp(LEVEL_TEXT.testing.description));
  assert.match(testingDescription, new RegExp(TESTING_WARNING));
  await page.click('.approve-request');
  const start = (await page.evaluate(() => __sent)).find(message => message.type === 'start');
  assert.deepEqual(start, { type: 'start', requestId: 'req_1', level: 'testing', tabMode: 'single' }, 'the pairing never rides along');
});

test('popup: Approve sends the preset level when the user does not change it', async t => {
  const page = await popup(t, { local: { ...PAIRED, permissions: { defaultLevel: 'reversible' } }, requests: [request(['http://localhost:3000'], 'full')] });
  await page.click('.approve-request');
  const start = (await page.evaluate(() => __sent)).find(message => message.type === 'start');
  assert.equal(start.level, 'interactive', 'a Reversible ceiling counts as Use');
});

test('popup: replacing a request card preserves its selected level and keyboard focus', async t => {
  const original = request(['http://localhost:3000'], 'full');
  const page = await popup(t, { local: { ...PAIRED }, requests: [original] });
  await page.focus('.request-card .level-select');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('level-select')), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.$eval('.request-card .level-select', node => node.value), 'interactive');
  await page.evaluate(updated => {
    for (const listener of __listeners) listener({ requests: { newValue: [updated] } }, 'session');
  }, { ...original, reason: 'Updated request' });
  assert.equal(await page.$eval('.request-reason', node => node.textContent), 'Updated request');
  assert.equal(await page.$eval('.request-card .level-select', node => node.value), 'interactive');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'level-req_1');
});

test('popup: replacing an approval card preserves keyboard focus on Approve once', async t => {
  const approval = { id: 'approval-1', kind: 'click', cls: 'purchase', origin: 'http://localhost:3000',
    title: 'Checkout', label: 'Pay now', total: 'Total $20.00', note: 'Complete the test order' };
  const page = await popup(t, { local: { ...PAIRED }, state: { approvals: [approval] } });
  await page.waitForSelector('.approval-card .primary-button');
  await page.focus('.approval-card .primary-button');
  await page.evaluate(updated => {
    for (const listener of __listeners) listener({ approvals: { newValue: [updated] } }, 'session');
  }, { ...approval, note: 'Updated test order' });
  assert.match(await page.textContent('.approval-card'), /Updated test order/);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Approve once');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.approval-card')?.dataset.approvalId), 'approval-1');
});

test('popup: upload consent identifies the file, size and destination before approving that upload', async t => {
  const approval = { id: 'upload-1', kind: 'upload', cls: 'submit', origin: 'http://localhost:3000',
    title: 'Application', label: 'Resume', file: { name: 'private-<report>.pdf', size: 56789 } };
  const page = await popup(t, { local: { ...PAIRED }, state: { approvals: [approval] } });
  await page.waitForSelector('.approval-card .primary-button');
  const text = await page.textContent('.approval-card');
  assert.match(text, /APPROVE UPLOAD/);
  assert.match(text, /private-<report>\.pdf/);
  assert.match(text, /55 KB/);
  assert.match(text, /http:\/\/localhost:3000/);
  assert.match(text, /one file from the agent's workspace/);
  assert.match(text, /site receives it when the form is sent/);
  assert.equal(await count(page, '.approval-card report'), 0, 'the filename is rendered as text');
  assert.ok(!(await page.evaluate(() => __sent)).some(message => message.type === 'approval_decision'));
  await page.click('.approval-card .primary-button');
  assert.deepEqual((await page.evaluate(() => __sent)).filter(message => message.type === 'approval_decision'),
    [{ type: 'approval_decision', id: 'upload-1', decision: 'approve' }]);
});

test('popup: normal-text color pairs meet WCAG AA contrast', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [request(['http://localhost:3000'], 'full')] });
  const pairs = await page.evaluate(() => {
    const luminance = color => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (foreground, background) => {
      const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (light + 0.05) / (dark + 0.05);
    };
    const style = (selector, pseudo = null) => getComputedStyle(document.querySelector(selector), pseudo);
    return [
      ['muted text on a card', style('.request-meta').color, style('.request-card').backgroundColor],
      ['primary button text', style('.primary-button').color, style('.primary-button').backgroundColor],
      ['placeholder text', style('#testing-origin', '::placeholder').color, style('#testing-origin').backgroundColor],
    ].map(([name, foreground, background]) => ({ name, ratio: ratio(foreground, background) }));
  });
  for (const pair of pairs) assert.ok(pair.ratio >= 4.5, `${pair.name}: ${pair.ratio.toFixed(2)}:1`);
});

test('popup: Approve gate checkboxes are compact, left aligned and keep a visible focus indicator', async t => {
  const page = await popup(t, { local: { ...PAIRED } });
  await page.click('#advanced summary');
  const rows = await page.$$eval('.approval-setting', nodes => nodes.map(node => {
    const label = node.querySelector('label');
    const input = node.querySelector('input');
    const name = node.querySelector('.approval-setting-name');
    const help = node.querySelector('.field-help');
    const labelBox = label.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    return {
      width: inputBox.width, height: inputBox.height,
      inputLeft: inputBox.left - labelBox.left,
      nameGap: nameBox.left - inputBox.right,
      helpOffset: help.getBoundingClientRect().left - nameBox.left,
      justify: getComputedStyle(label).justifyContent,
      align: getComputedStyle(label).textAlign,
    };
  }));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.width, 31);
    assert.equal(row.height, 31);
    assert.equal(row.inputLeft, 0);
    assert.equal(row.nameGap, 8);
    assert.equal(row.helpOffset, 0);
    assert.equal(row.justify, 'flex-start');
    assert.equal(row.align, 'left');
  }
  await page.keyboard.press('Tab');
  await page.focus('#approval-purchase');
  assert.equal(await page.$eval('#approval-purchase', node => node.matches(':focus-visible')), true);
  assert.equal(await page.$eval('#approval-purchase', node => getComputedStyle(node).outlineStyle), 'solid');
});

test('popup: an active testing lease reads "TEST SITE" in the warning style', async t => {
  const session = { requestId: 'req_1', leaseId: 'lease-1', tabId: 7, origin: 'http://localhost:3000', status: 'active', level: 'testing' };
  const active = { ...request(['http://localhost:3000'], 'testing'), state: 'active' };
  const page = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [active], state: { status: 'active', session } });
  await page.waitForFunction(() => document.querySelector('#state-label').dataset.state === 'testing');
  assert.equal(await page.$eval('#state-label', node => node.textContent), 'TEST SITE');
  assert.equal(await page.$eval('#state-label', node => getComputedStyle(node).color), 'rgb(168, 50, 42)');

  const full = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [active], state: { status: 'active', session: { ...session, level: 'full' } } });
  await full.waitForFunction(() => document.querySelector('#state-label').dataset.state === 'active');
  assert.equal(await full.$eval('#state-label', node => node.textContent), 'In use');
  assert.match(await full.$eval('.request-card', node => node.textContent), /Approved: Act/);
});

test('popup: removing the testing environment while open refreshes the tab card from the worker', async t => {
  const session = { requestId: 'req_1', leaseId: 'lease-1', tabId: 7, origin: 'http://localhost:3000', status: 'active', level: 'testing' };
  const active = { ...request(['http://localhost:3000'], 'testing'), state: 'active' };
  const permissions = { defaultLevel: 'full', testingOrigins: ['http://localhost:3000'] };
  const page = await popup(t, { local: { ...PAIRED, status: 'active', permissions }, requests: [active], state: { status: 'active', session } });
  await page.waitForFunction(() => document.querySelector('#state-label').dataset.state === 'testing');
  await page.evaluate(() => {
    // The worker drops the session to Full once the origin is gone; storage.onChanged reaches the popup.
    __state.session = { ...__state.session, level: 'full' };
    for (const listener of __listeners) listener({ permissions: { newValue: { defaultLevel: 'full', testingOrigins: [] } } }, 'local');
  });
  await page.waitForFunction(() => document.querySelector('#state-label').dataset.state === 'active');
  assert.equal(await page.$eval('#state-label', node => node.textContent), 'In use');
  assert.match(await page.$eval('.request-card', node => node.textContent), /Approved: Act/);
});

// --- domain roots on the request card -------------------------------------------------------------------------------

const ROOT_REQUEST = { requestId: 'req_1', state: 'pending', origins: ['https://*.example.org'], mode: 'read-only',
  reason: 'Read the team page', createdAt: new Date().toISOString() };
const DEV_TAB = 'https://developer.example.org/docs';
const startMessage = page => page.evaluate(() => __sent.find(message => message.type === 'start'));

test('popup: a domain root reads "all of example.org", with an explicit site choice preset to the domain', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [ROOT_REQUEST], tabUrl: DEV_TAB });
  assert.match(await page.$eval('.request-meta', node => node.textContent), /^all of example\.org · asks for Read$/);
  assert.doesNotMatch(await page.$eval('.request-card', node => node.textContent), /\*/, 'no wildcard pattern is shown');
  const options = await page.$$eval('.request-scope label', nodes => nodes.map(node => node.textContent));
  assert.deepEqual(options, ['All of example.org', 'Only https://developer.example.org']);
  assert.equal(await page.$eval('.request-scope input[value="domain"]', node => node.checked), true);
  assert.equal(await page.$eval('.request-card', node => node.dataset.scope), 'domain');
  assert.match(await page.$eval('.scope-prompt', node => node.textContent), /Chrome asks you to allow site access/);
});

test('popup: Approve requests https://*.<root>/* in the click, before the start message, and sends scope domain', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [ROOT_REQUEST], tabUrl: DEV_TAB });
  await page.click('.approve-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'));
  const [asked] = await page.evaluate(() => __permissionRequests);
  assert.deepEqual(asked.origins, ['https://*.example.org/*']);
  const sent = await page.evaluate(() => __sent);
  assert.ok(sent.findIndex(message => message.type === 'start') >= asked.sentBefore, 'requested before start was sent');
  assert.deepEqual(sent.find(message => message.type === 'track').patterns, ['https://*.example.org/*'],
    'the worker is told which pattern this extension requested');
  const start = await startMessage(page);
  assert.equal(start.scope, 'domain');
  assert.equal(start.level, 'read-only');
});

test('popup: a declined Chrome prompt approves the exact origin only and says so', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [ROOT_REQUEST], tabUrl: DEV_TAB, allowSite: false });
  await page.click('.approve-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'));
  assert.equal((await startMessage(page)).scope, 'origin');
  await page.waitForFunction(() => /site access was not allowed/.test(document.querySelector('#status').textContent));
});

test('popup: "Only <origin>" asks Chrome for nothing and sends scope origin', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [ROOT_REQUEST], tabUrl: DEV_TAB });
  await page.check('.request-scope input[value="origin"]');
  assert.equal(await page.$eval('.request-card', node => node.dataset.scope), 'origin');
  await page.click('.approve-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'));
  assert.deepEqual(await page.evaluate(() => __permissionRequests), []);
  assert.equal((await startMessage(page)).scope, 'origin');
});

test('popup: an exact request has no site choice; a tab outside the root cannot approve it', async t => {
  const exact = await popup(t, { local: { ...PAIRED }, requests: [request(['http://localhost:3000'], 'read-only')] });
  assert.equal(await count(exact, '.request-scope'), 0);
  const away = await popup(t, { local: { ...PAIRED }, requests: [ROOT_REQUEST], tabUrl: 'https://example.net/' });
  assert.equal(await count(away, '.request-scope'), 0);
  assert.match(await away.$eval('.request-mismatch', node => node.textContent), /asked for: all of example\.org/);
  assert.equal(await away.$eval('.approve-request', node => node.disabled), true);
  const http = await popup(t, { local: { ...PAIRED }, requests: [ROOT_REQUEST], tabUrl: 'http://developer.example.org/' });
  assert.equal(await http.$eval('.approve-request', node => node.disabled), true, 'roots are https only');
});

test('popup: the active domain lease shows the site it covers', async t => {
  const active = { ...ROOT_REQUEST, state: 'active' };
  const session = { requestId: 'req_1', leaseId: 'lease-1', tabId: 7, origin: 'https://developer.example.org', status: 'active',
    level: 'read-only', scope: 'domain' };
  const page = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [active], tabUrl: DEV_TAB, state: { status: 'active', session } });
  await page.waitForFunction(() => document.querySelector('.scope-approved'));
  assert.equal(await page.$eval('.scope-approved', node => node.textContent), 'Site: all of example.org');
  const narrowed = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [active], tabUrl: DEV_TAB,
    state: { status: 'active', session: { ...session, scope: 'origin' } } });
  await narrowed.waitForFunction(() => document.querySelector('.scope-approved'));
  assert.equal(await narrowed.$eval('.scope-approved', node => node.textContent), 'Site: only https://developer.example.org');
});

test('popup: "Remember domain approvals" is off by default, persists, lists remembered domains and forgets one', async t => {
  const until = Date.now() + 3600_000;
  const page = await popup(t, { local: { ...PAIRED } });
  await page.click('#advanced summary');
  assert.equal(await page.$eval('#remember-domains', node => node.checked), false);
  assert.equal(await page.$eval('#remembered-list', node => node.hidden), true);
  await page.check('#remember-domains');
  assert.deepEqual(await page.evaluate(() => __local.domainMemory), { remember: true });
  const listed = await popup(t, { local: { ...PAIRED, domainMemory: { remember: true },
    rememberedSites: [{ root: 'example.org', until }, { root: 'co.uk', until }] }, requests: [ROOT_REQUEST], tabUrl: DEV_TAB,
  held: ['https://*.example.org/*'] });
  await listed.click('#advanced summary');
  assert.equal(await listed.$eval('#remember-domains', node => node.checked), true);
  assert.deepEqual(await listed.$$eval('#remembered-list code', nodes => nodes.map(node => node.textContent)), ['all of example.org']);
  await listed.waitForFunction(() => document.querySelector('.scope-prompt')?.dataset.kind === 'remembered');
  assert.match(await listed.$eval('.scope-prompt', node => node.textContent), /Remembered until .*no Chrome prompt/);
  await listed.click('#remembered-list button[aria-label="Forget example.org"]');
  assert.ok((await listed.evaluate(() => __sent)).some(message => message.type === 'forget' && message.root === 'example.org'));
});

test('popup: a domain remembered at Read-only still prompts at Full (removed, then requested again)', async t => {
  const until = Date.now() + 3600_000;
  const page = await popup(t, { local: { ...PAIRED, permissions: { defaultLevel: 'full' }, domainMemory: { remember: true },
    rememberedSites: [{ root: 'example.org', until }] }, requests: [{ ...ROOT_REQUEST, mode: 'full' }], tabUrl: DEV_TAB,
  held: ['https://*.example.org/*'] });
  // The card ends the remembered grant before any click, so the click requests synchronously and Chrome asks again.
  await page.waitForFunction(() => document.querySelector('.scope-prompt')?.dataset.kind === 'prompt');
  assert.deepEqual(await page.evaluate(() => __permissionRemovals), ['https://*.example.org/*']);
  assert.ok((await page.evaluate(() => __sent)).some(message => message.type === 'forget' && message.root === 'example.org'));
  assert.deepEqual(await page.evaluate(() => __permissionRequests), [], 'nothing requested before the click');
  await page.click('.approve-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'));
  const [asked] = await page.evaluate(() => __permissionRequests);
  assert.equal(asked.heldBefore, false, 'Chrome had to ask again');
  assert.equal((await startMessage(page)).scope, 'domain');
  // Back at Read-only the remembered grant needs no prompt.
  const ro = await popup(t, { local: { ...PAIRED, domainMemory: { remember: true }, rememberedSites: [{ root: 'example.org', until }] },
    requests: [ROOT_REQUEST], tabUrl: DEV_TAB, held: ['https://*.example.org/*'] });
  await ro.waitForFunction(() => document.querySelector('.scope-prompt')?.dataset.kind === 'remembered');
  await ro.click('.approve-request');
  await ro.waitForFunction(() => __sent.some(message => message.type === 'start'));
  assert.deepEqual(await ro.evaluate(() => __permissionRemovals), []);
});

test('popup: when Chrome already allows the site (site access setting) the card says no prompt will appear', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [ROOT_REQUEST], tabUrl: DEV_TAB, held: ['https://*.example.org/*'] });
  await page.waitForFunction(() => document.querySelector('.scope-prompt')?.dataset.kind === 'granted');
  assert.match(await page.$eval('.scope-prompt', node => node.textContent), /no prompt will appear/);
  await page.click('.approve-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'));
  assert.ok(!(await page.evaluate(() => __sent)).some(message => message.type === 'track'),
    'a site the user allowed by hand is not tracked, so the worker never removes it');
  assert.equal((await startMessage(page)).scope, 'domain');
});

// --- Open <host> --------------------------------------------------------------------------------------------------

test('startTarget: the request url on its origins, else the first exact origin; never off-origin or http elsewhere', () => {
  const exact = ['https://shop.example.com', 'http://localhost:3000'];
  assert.deepEqual(startTarget({ origins: exact, url: 'https://shop.example.com/cart?x=1' }),
    { url: 'https://shop.example.com/cart?x=1', origin: 'https://shop.example.com', host: 'shop.example.com' });
  assert.equal(startTarget({ origins: exact, url: 'https://evil.example.net/' }).url, 'https://shop.example.com/');
  assert.equal(startTarget({ origins: exact, url: 'javascript:alert(1)' }).url, 'https://shop.example.com/');
  assert.equal(startTarget({ origins: ['http://localhost:3000'] }).host, 'localhost:3000', 'the port stays');
  assert.equal(startTarget({ origins: ['https://*.example.org'] }), null, 'roots only, no url: no open path');
  assert.equal(startTarget({ origins: ['https://*.example.org'], url: 'https://docs.example.org/a' }).origin, 'https://docs.example.org');
  assert.equal(startTarget({ origins: ['http://intranet.example'] }).url, 'http://intranet.example/', 'opening needs no host permission');
  const until = Date.now() + 1000;
  assert.deepEqual(normalizeRememberedSites([{ origin: 'https://shop.example.com', until }, { root: 'example.org', until }]),
    [{ root: 'example.org', until }], 'exact origins are no longer remembered');
});

const SHOP_REQUEST = { ...request(['https://shop.example.com'], 'read-only'), url: 'https://shop.example.com/cart' };

const openMessage = page => page.evaluate(() => __sent.find(message => message.type === 'open'));

test('popup: a tab off the request offers "Open <host>"; the click asks Chrome for nothing and sends open', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [SHOP_REQUEST] });
  assert.equal(await count(page, '#approve'), 0, '#approve stays the plain matching-tab path');
  const button = await page.$('.open-request');
  assert.equal(await button.textContent(), 'Open shop.example.com');
  assert.match(await page.$eval('.request-mismatch', node => node.textContent),
    /asked for: https:\/\/shop\.example\.com\. Open shop\.example\.com opens it in a new tab; approve there with the FAI Browser icon\./);
  await button.click();
  await page.waitForFunction(() => __sent.some(message => message.type === 'open'));
  assert.deepEqual(await page.evaluate(() => __permissionRequests), [], 'no Chrome permission for a single origin');
  const open = await openMessage(page);
  assert.deepEqual({ requestId: open.requestId, level: open.level, scope: open.scope },
    { requestId: 'req_1', level: 'read-only', scope: 'origin' });
  assert.equal(await page.evaluate(() => __sent.some(message => ['start', 'intent', 'track'].includes(message.type))), false);
  await page.waitForFunction(() => /click the FAI Browser icon \(or Ctrl\+Shift\+Y\) to approve/.test(document.querySelector('#status').textContent));
});

test('popup: a matching tab keeps "Approve this tab" as #approve, with a secondary "Open in a new tab"', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [{ ...request(['http://localhost:3000'], 'read-only'), url: 'http://localhost:3000/app' }] });
  assert.equal(await page.$eval('#approve', node => node.textContent), 'Approve this tab');
  assert.equal(await page.$eval('.link-button.open-request', node => node.textContent), 'Open in a new tab');
  await page.click('.link-button.open-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'open'));
  assert.equal((await openMessage(page)).requestId, 'req_1');
});

test('popup: "All of <root>" asks Chrome for the roots in the click and opens with scope domain; declined is origin', async t => {
  const rooted = { ...ROOT_REQUEST, url: 'https://developer.example.org/docs' };
  const page = await popup(t, { local: { ...PAIRED }, requests: [rooted], tabUrl: 'https://example.net/' });
  assert.equal(await page.$eval('.open-request', node => node.textContent), 'Open developer.example.org');
  const before = await page.evaluate(() => __sent.length);
  await page.click('.open-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'open'));
  const [asked] = await page.evaluate(() => __permissionRequests);
  assert.deepEqual(asked.origins, ['https://*.example.org/*']);
  assert.equal(asked.sentBefore, before, 'requested before any message of the click (inside the gesture)');
  const sent = await page.evaluate(() => __sent.map(message => message.type));
  assert.deepEqual(sent.filter(type => ['intent', 'open'].includes(type)), ['intent', 'open']);
  assert.equal((await openMessage(page)).scope, 'domain');
  const declined = await popup(t, { local: { ...PAIRED }, requests: [rooted], tabUrl: 'https://example.net/', allowSite: false });
  await declined.click('.open-request');
  await declined.waitForFunction(() => __sent.some(message => message.type === 'open'));
  assert.equal((await openMessage(declined)).scope, 'origin');
  await declined.waitForFunction(() => /Chrome site access was not allowed: developer\.example\.org opened for its own origin only/
    .test(document.querySelector('#status').textContent));
});

test('approval window: no current tab; the card opens the request\'s page and the window closes after the open', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [SHOP_REQUEST], query: '?window=1',
    tabUrl: 'https://shop.example.com/cart' });
  assert.equal(await page.evaluate(() => __tabQueries), 0, 'its own extension tab is never the current tab');
  assert.equal(await page.$eval('.tab-card .card-label', node => node.textContent), 'AGENT REQUEST');
  const button = await page.$('.open-request');
  assert.equal(await button.textContent(), 'Open shop.example.com');
  assert.equal(await page.evaluate(() => __closed), 0);
  await button.click();
  await page.waitForFunction(() => __closed > 0);
  assert.equal((await openMessage(page)).requestId, 'req_1');
});

// Issue #13: with an older task paused (or done) and a new request waiting, the user's click went to the older one.
// The new request comes first and apart; a paused task has its own label and a secondary Resume; a stale one (its
// agent asked for another tab since) is folded away; the approval window lists new requests only.
test('popup: a new request comes first, apart from paused tasks, with distinct labels; stale ones are folded away', async t => {
  const minutes = n => new Date(Date.now() - n * 60_000).toISOString();
  const stale = { ...SHOP_REQUEST, requestId: 'req_stale', state: 'paused', stateReason: 'tab_changed', stale: 'newer_request',
    reason: 'Entra task', createdAt: minutes(40), pausedAt: minutes(20), lease: { leaseId: 'l0', tabId: 3 } };
  const paused = { ...SHOP_REQUEST, requestId: 'req_paused', state: 'paused', stateReason: 'child_tab', reason: 'Cloudflare task',
    createdAt: minutes(30), pausedAt: minutes(2), lease: { leaseId: 'l1', tabId: 7 } };
  const fresh = { ...request(['https://partner.example.net'], 'read-only'), requestId: 'req_new', url: 'https://partner.example.net/home',
    reason: 'Partner Center task', createdAt: minutes(1) };
  // The daemon lists requests oldest first.
  const requests = [stale, paused, fresh];
  const page = await popup(t, { local: { ...PAIRED }, requests, tabUrl: 'https://shop.example.com/cart' });
  const cards = await page.$$eval('#request-list > .request-card', nodes => nodes.map(node => ({ id: node.dataset.requestId,
    label: node.querySelector('.card-label').textContent, buttons: [...node.querySelectorAll('.request-actions button')]
      .map(button => ({ text: button.textContent, primary: button.classList.contains('primary-button') })) })));
  assert.deepEqual(cards.map(card => card.id), ['req_new', 'req_paused'], 'the new request first; the stale one is not a top-level card');
  assert.deepEqual(cards.map(card => card.label), ['NEW TAB REQUEST', 'PAUSED TASK']);
  assert.deepEqual(cards[0].buttons[0], { text: 'Open partner.example.net', primary: true });
  assert.deepEqual(cards[1].buttons[0], { text: 'Resume on this tab', primary: false }, 'Resume is secondary, never the primary look');
  assert.deepEqual(await page.$$eval('#request-list > .request-section', nodes => nodes.map(node => node.textContent)),
    ['WAITING FOR YOUR APPROVAL', 'PAUSED TASKS']);
  assert.match(await page.$eval('[data-request-id="req_paused"] .pause-reason', node => node.textContent), /opened a new tab or window/);
  // The first primary button in the list is the new request's.
  assert.equal(await page.$eval('#request-list .primary-button', node => node.closest('.request-card').dataset.requestId), 'req_new');
  // The stale task is listed folded, with why, and can still be released or resumed once unfolded.
  assert.equal(await page.$eval('.stale-requests', node => node.open), false);
  assert.equal(await page.$eval('.stale-requests summary', node => node.textContent), 'Older paused tasks (1)');
  assert.equal(await page.locator('[data-request-id="req_stale"] .resume-request').isVisible(), false);
  await page.click('.stale-requests summary');
  assert.match(await page.$eval('[data-request-id="req_stale"] .pause-reason', node => node.textContent), /asked for another tab since/);
  assert.equal(await page.locator('[data-request-id="req_stale"] .resume-request').isVisible(), true);
  // Each button sends its own card's request.
  await page.click('[data-request-id="req_new"] .open-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'open'));
  assert.equal((await openMessage(page)).requestId, 'req_new');
  await page.click('[data-request-id="req_paused"] .resume-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'));
  assert.equal((await startMessage(page)).requestId, 'req_paused');

  // The approval window lists only the new request: no Open button for a paused task there.
  const win = await popup(t, { local: { ...PAIRED }, requests, query: '?window=1' });
  assert.deepEqual(await win.$$eval('.request-card', nodes => nodes.map(node => node.dataset.requestId)), ['req_new']);
  assert.equal(await count(win, '.resume-request'), 0);
  assert.equal(await count(win, '.stale-requests'), 0);
  // Only paused tasks left: nothing for the window to approve, so it closes.
  await win.evaluate(list => { for (const listener of __listeners) listener({ requests: { newValue: list } }, 'session'); }, [stale, paused]);
  assert.equal(await win.evaluate(() => __closed), 1);
});

// The list stays controlled: newest first by last activity in every section (pending by when it was asked, paused by
// when it paused), at most 5 paused tasks in their section, the rest folded with the stale ones, and the fold shows at
// most 5 before "Show n more". A folded card's Release sends its own request, and focus on it survives a re-render.
test('popup: newest first by activity, at most 5 paused tasks shown, the rest folded with the stale ones behind Show more', async t => {
  const minutes = n => new Date(Date.now() - n * 60_000).toISOString();
  // Created in this order (oldest first, as the daemon lists them), paused in another order.
  const paused = Array.from({ length: 8 }, (_, i) => ({ ...SHOP_REQUEST, requestId: `req_p${i}`, state: 'paused',
    stateReason: 'paused', reason: `Paused ${i}`, createdAt: minutes(100 - i), pausedAt: minutes([9, 3, 12, 1, 7, 2, 15, 5][i]) }));
  const stale = Array.from({ length: 3 }, (_, i) => ({ ...SHOP_REQUEST, requestId: `req_s${i}`, state: 'paused',
    stateReason: 'tab_changed', stale: 'newer_request', reason: `Stale ${i}`, createdAt: minutes(200 - i), pausedAt: minutes([4, 30, 20][i]) }));
  const pending = Array.from({ length: 2 }, (_, i) => ({ ...SHOP_REQUEST, requestId: `req_n${i}`, reason: `New ${i}`,
    createdAt: minutes(2 - i) }));
  const page = await popup(t, { local: { ...PAIRED }, requests: [...stale, ...paused, ...pending], tabUrl: 'https://shop.example.com/cart' });
  const top = await page.$$eval('#request-list > .request-card', nodes => nodes.map(node => node.dataset.requestId));
  // Pending newest first, then the 5 most recently paused tasks.
  assert.deepEqual(top, ['req_n1', 'req_n0', 'req_p3', 'req_p5', 'req_p1', 'req_p7', 'req_p4']);
  assert.equal(await page.$eval('.stale-requests summary', node => node.textContent), 'Older paused tasks (6)');
  await page.click('.stale-requests summary');
  const folded = () => page.$$eval('.stale-requests .request-card', nodes => nodes.map(node => node.dataset.requestId));
  // The other 3 paused tasks and the 3 stale ones, by when they paused: s0 (4), p0 (9), p2 (12), p6 (15), s2 (20).
  assert.deepEqual(await folded(), ['req_s0', 'req_p0', 'req_p2', 'req_p6', 'req_s2']);
  assert.equal(await page.$eval('.stale-requests .show-more', node => node.textContent), 'Show 1 more');
  // Keyboard focus on a folded card survives a re-render (a requests update).
  await page.focus('[data-request-id="req_p2"] .deny-request');
  await page.evaluate(list => { for (const listener of __listeners) listener({ requests: { newValue: list } }, 'session'); },
    [...stale, ...paused, ...pending]);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.request-card')?.dataset.requestId), 'req_p2');
  await page.click('.stale-requests .show-more');
  assert.deepEqual(await folded(), ['req_s0', 'req_p0', 'req_p2', 'req_p6', 'req_s2', 'req_s1']);
  assert.equal(await count(page, '.stale-requests .show-more'), 0);
  // Release on a folded card releases that request.
  assert.equal(await page.$eval('[data-request-id="req_s1"] .deny-request', node => node.textContent), 'Release');
  await page.click('[data-request-id="req_s1"] .deny-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'deny'));
  assert.equal(await page.evaluate(() => __sent.find(message => message.type === 'deny').requestId), 'req_s1');
});

// --- Pause and Stop at the top ----------------------------------------------------------------------------------------
// The owner releases a tab in one glance: while an agent holds a tab, Pause and Stop sit right under the header, above
// every card, inside the popup's normal size, and first in tab order; in the approval window too. They follow the
// session live while the popup is open. With no session the popup looks as before: no row, no extra space.
const ago = n => new Date(Date.now() - n * 60_000).toISOString();
const LIVE = { ...SHOP_REQUEST, requestId: 'req_live', state: 'active', reason: 'Compare shoes', createdAt: ago(6),
  lease: { leaseId: 'l1', tabId: 7 } };
const PAUSED = { ...SHOP_REQUEST, requestId: 'req_paused', state: 'paused', stateReason: 'child_tab', reason: 'Order history',
  createdAt: ago(30), pausedAt: ago(3), lease: { leaseId: 'l0', tabId: 4 } };
const FRESH = { ...request(['https://partner.example.net'], 'read-only'), requestId: 'req_new',
  url: 'https://partner.example.net/home', reason: 'Partner dashboard', createdAt: ago(1) };
const LIVE_SESSION = { requestId: 'req_live', leaseId: 'l1', tabId: 7, origin: 'https://shop.example.com', status: 'active', level: 'read-only' };
// Chrome's popup is at most 600 px tall; the body is 364 px wide.
const POPUP = { width: 364, height: 600 };
// Every card or section that can show besides the row (hidden ones are skipped by `tops`).
const CARDS = '#pin-hint, #update, #setup, .tab-card, #invite > *, #approvals > *, #request-list > *, .control-area, '
  + '#connection-line, #advanced';
const box = (page, selector) => page.$eval(selector, node => {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
});
const tops = (page, selector) => page.$$eval(selector, nodes => nodes.filter(node => node.getClientRects().length)
  .map(node => ({ id: node.id || node.className, top: node.getBoundingClientRect().top })));
const rowShown = page => page.evaluate(() => !document.getElementById('controls').hidden);
// The worker changes the session's status (storage.local `status`) and, optionally, its request list.
const workerSays = (page, { status, session = null, requests }) => page.evaluate(([status, session, requests]) => {
  __state.status = status;
  __state.session = session;
  if (requests) {
    __requests = requests;
    for (const listener of __listeners) listener({ requests: { newValue: requests } }, 'session');
  }
  for (const listener of __listeners) listener({ status: { newValue: status } }, 'local');
}, [status, session, requests ?? null]);
// The ids of the first `n` controls Tab reaches from the top of the page.
async function tabOrder(page, n) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  // A click in the page's top corner moves the browser's focus starting point back to the top (blur alone keeps it).
  await page.mouse.click(2, 2);
  const ids = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    ids.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || ''));
  }
  return ids;
}
async function checkTop(page, what, { atLeast = 4 } = {}) {
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.locator('#controls').isVisible(), true, `${what}: the row shows`);
  assert.equal(await page.locator('#pause').isVisible(), true, `${what}: Pause shows`);
  assert.equal(await page.locator('#stop').isVisible(), true, `${what}: Stop shows`);
  const header = await box(page, '.topbar');
  const pause = await box(page, '#pause');
  const stop = await box(page, '#stop');
  assert.ok(pause.top >= header.bottom && stop.top >= header.bottom, `${what}: under the header`);
  assert.ok(Math.max(pause.bottom, stop.bottom) <= POPUP.height, `${what}: inside the popup without scrolling`);
  const below = await tops(page, CARDS);
  assert.ok(below.length >= atLeast, `${what}: the other cards are there (${below.length})`);
  for (const card of below) assert.ok(card.top >= Math.max(pause.bottom, stop.bottom), `${what}: above ${card.id} (${card.top})`);
  assert.deepEqual(await tabOrder(page, 2), ['pause', 'stop'], `${what}: first in tab order`);
}

test('popup: Pause and Stop come first, above every card and first in tab order, only while an agent holds a tab', async t => {
  const page = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [PAUSED, LIVE, FRESH],
    tabUrl: 'https://shop.example.com/cart', state: { status: 'active', session: LIVE_SESSION } });
  await page.setViewportSize(POPUP);
  // The list itself is unchanged: the new request first, then the task in use, then the paused one.
  assert.deepEqual(await page.$$eval('#request-list > .request-card', nodes => nodes.map(node => node.dataset.requestId)),
    ['req_new', 'req_live', 'req_paused']);
  assert.deepEqual(await page.$$eval('#controls button', nodes => nodes.map(node => ({ id: node.id, text: node.textContent,
    type: node.type, className: node.className }))), [
    { id: 'pause', text: 'Pause', type: 'button', className: 'secondary-button' },
    { id: 'stop', text: 'Stop', type: 'button', className: 'secondary-button' },
  ], 'same buttons, labels and styles');
  assert.equal(await page.$eval('#controls', node => node.getAttribute('aria-label')), 'Browser controls');
  await checkTop(page, 'active');
  // Advanced open does not push them down.
  await page.click('#advanced summary');
  assert.equal(await page.$eval('#advanced', node => node.open), true);
  await checkTop(page, 'Advanced open');
  // Stop still stops.
  await page.click('#stop');
  await page.waitForFunction(() => __sent.some(message => message.type === 'stop'));

  // The approval window (Act and Test site requests) shows the same row first while a session runs.
  const win = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [LIVE, FRESH], query: '?window=1',
    state: { status: 'active', session: LIVE_SESSION } });
  await win.setViewportSize(POPUP);
  await checkTop(win, 'approval window');

  // No session: no row and no space for it; the tab card sits under the header as before and Tab skips them.
  const idle = await popup(t, { local: { ...PAIRED }, requests: [PAUSED, FRESH], tabUrl: 'https://shop.example.com/cart' });
  await idle.setViewportSize(POPUP);
  assert.equal(await idle.locator('#controls').isVisible(), false);
  assert.equal(await idle.locator('#stop').isVisible(), false);
  const header = await box(idle, '.topbar');
  assert.equal((await box(idle, '.tab-card')).top - header.bottom, 17, 'the header margin only, as before');
  assert.ok(!(await tabOrder(idle, 3)).some(id => id === 'pause' || id === 'stop'));
  // A paused session has no Stop either (Release on its card ends it), as before.
  const pausedOnly = await popup(t, { local: { ...PAIRED, status: 'paused' }, requests: [PAUSED],
    tabUrl: 'https://shop.example.com/cart', state: { status: 'paused', session: { ...LIVE_SESSION, status: 'paused' } } });
  assert.equal(await pausedOnly.locator('#controls').isVisible(), false);
});

// The cards that only sometimes show: the pin hint, an update, an Approve-once card, the invite picker (the session
// runs on another tab) and, with the FAI service unreachable, the setup card. Pause and Stop stay above all of them.
test('popup: Pause and Stop stay above the pin hint, update, approval, invite and setup cards', async t => {
  const approval = { id: 'approval-1', kind: 'click', cls: 'purchase', origin: 'https://shop.example.com',
    title: 'Checkout', label: 'Pay now', total: 'Total $20.00', note: 'Complete the order' };
  const update = { available: true, latest: 'v9.9.9', current: 'v0.7.0', installable: true,
    notesUrl: 'https://github.com/jedbjorn/fai-browser/releases/tag/v9.9.9' };
  const elsewhere = { ...LIVE_SESSION, tabId: 9 };
  const live = { ...LIVE, lease: { leaseId: 'l1', tabId: 9 } };
  const page = await popup(t, { local: { ...PAIRED, status: 'active' }, pinned: false, requests: [PAUSED, live, FRESH],
    tabUrl: 'https://shop.example.com/cart', state: { status: 'active', session: elsewhere, approvals: [approval], connection: { update } } });
  await page.setViewportSize(POPUP);
  await page.waitForSelector('.approval-card');
  for (const selector of ['#pin-hint', '#update', '#update-install', '.approval-card', '.invite-picker', '#request-list .request-card']) {
    assert.equal(await page.locator(selector).first().isVisible(), true, `${selector} shows in this scenario`);
  }
  await checkTop(page, 'every card', { atLeast: 8 });

  // The FAI service is not answering while the session is still active: the setup card shows, under the row.
  const setup = await popup(t, { local: { ...PAIRED, status: 'active' }, pinned: false, connected: false, requests: [LIVE],
    tabUrl: 'https://shop.example.com/cart', state: { status: 'active', session: LIVE_SESSION, connection: { update } } });
  await setup.setViewportSize(POPUP);
  for (const selector of ['#pin-hint', '#update', '#setup']) {
    assert.equal(await setup.locator(selector).isVisible(), true, `${selector} shows when not connected`);
  }
  await checkTop(setup, 'setup card', { atLeast: 5 });
});

// Waits that fail fast (an old popup that never follows the status times out in 3 s, not 30).
const FAST = { timeout: 3000 };
const rowGone = page => page.waitForFunction(() => document.getElementById('controls').hidden, undefined, FAST);
const rowBack = page => page.waitForFunction(() => !document.getElementById('controls').hidden, undefined, FAST);
const sentTypes = (page, from = 0) => page.evaluate(n => __sent.slice(n).map(message => message.type), from);
// How far the row moves what is below it: its height and its own margins, measured.
const rowSpace = page => page.$eval('#controls', node => {
  const style = getComputedStyle(node);
  return node.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
});

// The popup and the approval window follow the session while they are open (the worker's storage `status`): the row
// appears when a session starts (approved in the page's request modal) and goes when it ends (released, tab closed,
// budget spent). Focus stays where the user has it, and nothing moves under a press until it ends.
test('popup: Pause and Stop appear and disappear with the session while the popup is open', async t => {
  // (a) The session ends while the popup is open, with keyboard focus on Stop.
  const page = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [PAUSED, LIVE, FRESH],
    tabUrl: 'https://shop.example.com/cart', state: { status: 'active', session: LIVE_SESSION } });
  await page.setViewportSize(POPUP);
  assert.equal(await rowShown(page), true);
  assert.deepEqual(await tabOrder(page, 2), ['pause', 'stop']);
  const sentBefore = await page.evaluate(() => __sent.length);
  await workerSays(page, { status: 'stopped', requests: [PAUSED, FRESH] });
  await rowGone(page);
  assert.equal(await page.$eval('#state-label', node => node.textContent), 'Stopped');
  assert.equal(await page.$eval('#status', node => node.textContent), 'Stopped');
  // Focus went to the tab card, which does nothing on Enter or Space.
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tab-card')), true);
  // It re-read the session with the read-only `state`, never `connect`.
  await page.waitForFunction(n => __sent.slice(n).some(message => message.type === 'state'), sentBefore, FAST);
  assert.equal((await sentTypes(page, sentBefore)).includes('connect'), false);
  // The same status again (this popup's own Stop already applied it) changes nothing.
  await page.evaluate(() => { document.getElementById('status').textContent = 'Request denied.'; });
  await workerSays(page, { status: 'stopped' });
  assert.equal(await page.$eval('#status', node => node.textContent), 'Request denied.');
  // A connection text the worker writes into `status` keeps a note on the status line, and only reads (no `connect`:
  // that one reconnects and reports this browser as used, as if the user had opened the popup).
  const sentNow = await page.evaluate(() => __sent.length);
  await workerSays(page, { status: 'Not connected to the FAI service. Retrying.' });
  await page.waitForFunction(n => __sent.slice(n).some(message => message.type === 'state'), sentNow, FAST);
  assert.equal(await page.$eval('#status', node => node.textContent), 'Request denied.', 'the note stays');
  assert.equal(await page.$eval('#state-label', node => node.textContent), 'Ready');
  assert.deepEqual(await sentTypes(page, sentNow), ['state']);
  // Without a note, the status line says what the worker said (as on opening the popup).
  await page.evaluate(() => { document.getElementById('status').textContent = 'Stopped'; });
  await workerSays(page, { status: '' });
  await workerSays(page, { status: 'Not connected to the FAI service. Retrying.' });
  assert.equal(await page.$eval('#status', node => node.textContent), 'Not connected to the FAI service. Retrying.');

  // (b) A session starts while the popup is open (approved in the page's modal): the row appears and keyboard focus on
  // a card's button stays there.
  const idle = await popup(t, { local: { ...PAIRED }, requests: [PAUSED, FRESH], tabUrl: 'https://shop.example.com/cart' });
  await idle.setViewportSize(POPUP);
  assert.equal(await rowShown(idle), false);
  await idle.focus('[data-request-id="req_new"] .open-request');
  await workerSays(idle, { status: 'active', session: LIVE_SESSION, requests: [PAUSED, LIVE, FRESH] });
  await rowBack(idle);
  await idle.waitForSelector('[data-request-id="req_live"][data-state="active"]', FAST);
  assert.equal(await idle.$eval('#state-label', node => node.textContent), 'In use');
  assert.equal(await idle.$eval('#status', node => node.textContent),
    "The agent is using its tab. Close that tab's window or press Stop to end it.");
  assert.deepEqual(await idle.evaluate(() => [document.activeElement.closest('.request-card')?.dataset.requestId,
    document.activeElement.classList.contains('open-request')]), ['req_new', true], 'focus stays on the card');
  await checkTop(idle, 'started while open');

  // (c) A press in progress (here on the Update button, above the list): the row waits for it to end, so nothing under
  // the pointer moves mid-press; then only the row's own space moves it.
  const update = { available: true, latest: 'v9.9.9', current: 'v0.7.0', installable: true,
    notesUrl: 'https://github.com/jedbjorn/fai-browser/releases/tag/v9.9.9' };
  const pressed = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [LIVE, FRESH],
    tabUrl: 'https://shop.example.com/cart', state: { status: 'active', session: LIVE_SESSION, connection: { update } } });
  await pressed.setViewportSize(POPUP);
  await pressed.waitForSelector('#update-install', { state: 'visible', ...FAST });
  const button = await pressed.$eval('#update-install', node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + 20, y: rect.top + rect.height / 2, top: rect.top };
  });
  const space = await rowSpace(pressed);
  await pressed.mouse.move(button.x, button.y);
  await pressed.mouse.down();
  await workerSays(pressed, { status: 'stopped' });
  await pressed.waitForTimeout(150);
  assert.equal(await pressed.$eval('#state-label', node => node.textContent), 'Stopped', 'the label follows at once');
  assert.equal(await rowShown(pressed), true, 'the row waits for the press');
  assert.equal(await pressed.$eval('#update-install', node => node.getBoundingClientRect().top), button.top, 'nothing moved');
  // Released away from the button (no click): the row goes, and the button moves up by the row's space only.
  await pressed.mouse.move(2, 2);
  await pressed.mouse.up();
  await rowGone(pressed);
  const after = await pressed.$eval('#update-install', node => node.getBoundingClientRect().top);
  assert.ok(Math.abs(button.top - after - space) < 1, `the row's space only (${button.top - after} vs ${space})`);
  assert.equal((await sentTypes(pressed)).includes('update_install'), false);

  // (d) The approval window: a session starts (one request approved in its page's modal) while another still waits.
  const second = { ...FRESH, requestId: 'req_two', reason: 'Second request', origins: ['https://docs.example.org'],
    url: 'https://docs.example.org/' };
  const win = await popup(t, { local: { ...PAIRED }, requests: [FRESH, second], query: '?window=1' });
  await win.setViewportSize(POPUP);
  assert.equal(await rowShown(win), false);
  const started = { ...FRESH, state: 'active', lease: { leaseId: 'l2', tabId: 11 } };
  await workerSays(win, { status: 'active', session: { ...LIVE_SESSION, requestId: 'req_new', tabId: 11,
    origin: 'https://partner.example.net' }, requests: [started, second] });
  await rowBack(win);
  await win.waitForSelector('[data-request-id="req_new"][data-state="active"]', FAST);
  assert.equal(await win.evaluate(() => __closed), 0, 'a request still waits: the window stays');
  await checkTop(win, 'approval window, started while open');
  // And it goes again when the session ends.
  await workerSays(win, { status: 'stopped', requests: [second] });
  await rowGone(win);
});

// An older re-read never brings the row back: the reply to a status change that a later one (or this popup's own Stop)
// overtook is dropped.
test('popup: a stale session re-read after a stop does not show Pause and Stop again', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [FRESH], tabUrl: 'https://shop.example.com/cart' });
  // The worker answers `state` reads late, in reverse order: the first read (session active) arrives last.
  await page.evaluate(session => {
    const original = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = async message => {
      if (message.type !== 'state') return original(message);
      const first = reads++ === 0;
      await new Promise(resolve => setTimeout(resolve, first ? 400 : 50));
      return first ? { status: 'active', session, requests: [], connection: { connected: true, transport: 'websocket' } }
        : { status: null, session: null, requests: [], connection: { connected: true, transport: 'websocket' } };
    };
  }, LIVE_SESSION);
  await workerSays(page, { status: 'active', session: LIVE_SESSION });
  await rowBack(page);
  await workerSays(page, { status: 'stopped' });
  await rowGone(page);
  await page.waitForTimeout(600);
  assert.equal(await rowShown(page), false, 'the late reply to the first read was dropped');
  assert.equal(await page.$eval('#state-label', node => node.textContent), 'Stopped');
});

// Focus never lands on a control that acts: after a keyboard Stop, or a session ending by itself while Stop has focus,
// it goes to the tab card, so a held or repeated Enter or a Space presses nothing (not Update, not Pair), and Tab goes
// on from there to the next control.
test('popup: after Stop hides the row, Enter and Space press nothing (update card, setup card)', async t => {
  const update = { available: true, latest: 'v9.9.9', current: 'v0.7.0', installable: true };
  const cards = {
    'update card without notes': { connected: true, state: { connection: { update } }, next: 'update-install' },
    'setup card': { connected: false, state: {}, next: 'pair' },
  };
  for (const [name, { connected, state, next }] of Object.entries(cards)) {
    for (const how of ['keyboard Stop', 'session ended']) {
      const what = `${name}, ${how}`;
      const page = await popup(t, { local: { ...PAIRED, status: 'active' }, connected, requests: [LIVE, FRESH],
        tabUrl: 'https://shop.example.com/cart', state: { status: 'active', session: LIVE_SESSION, ...state } });
      await page.setViewportSize(POPUP);
      assert.equal(await page.locator(`#${next}`).isVisible(), true, `${what}: #${next} shows`);
      assert.equal(await page.locator('#update-notes').isVisible(), false, `${what}: no notes link`);
      assert.deepEqual(await tabOrder(page, 2), ['pause', 'stop'], what);
      const from = await page.evaluate(() => __sent.length);
      if (how === 'keyboard Stop') {
        await page.evaluate(() => { __state.status = 'stopped'; __state.session = null; });
        await page.keyboard.press('Enter');
        await page.waitForFunction(n => __sent.slice(n).some(message => message.type === 'stop'), from, FAST);
      } else {
        await workerSays(page, { status: 'stopped', requests: [FRESH] });
        await page.waitForFunction(n => __sent.slice(n).some(message => message.type === 'state'), from, FAST);
      }
      await rowGone(page);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('tab-card')), true,
        `${what}: focus on the tab card`);
      const settled = await page.evaluate(() => __sent.length);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      // A held Enter (auto-repeat).
      await page.keyboard.down('Enter');
      await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await page.waitForTimeout(150);
      assert.deepEqual(await sentTypes(page, settled), [], `${what}: Enter and Space press nothing`);
      // Tab goes on from the tab card.
      await page.keyboard.press('Tab');
      const reached = await page.evaluate(() => document.activeElement.id || document.activeElement.className);
      assert.notEqual(reached, 'pause');
      assert.notEqual(reached, 'stop');
      await page.close();
    }
  }
});

test('approval window: it closes itself when no pending or paused request is left', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [SHOP_REQUEST], query: '?window=1' });
  assert.equal(await page.evaluate(() => __closed), 0);
  await page.evaluate(() => { for (const listener of __listeners) listener({ requests: { newValue: [] } }, 'session'); });
  assert.equal(await page.evaluate(() => __closed), 1);
});

test('approval window: a request with no page to open cannot be approved from the window', async t => {
  const roots = { ...request(['https://*.example.com'], 'read-only') };
  const page = await popup(t, { local: { ...PAIRED }, requests: [roots], query: '?window=1' });
  assert.equal(await page.$eval('.request-card .primary-button', node => node.disabled), true);
  assert.match(await page.$eval('.request-card', node => node.textContent), /approve there with the FAI Browser icon/);
});

test('approval window: a higher level for the tab the session drives is "Approve on the FAI tab", sent onSessionTab', async t => {
  const session = { requestId: 'req_1', leaseId: 'lease-1', tabId: 7, origin: 'https://shop.example.com', status: 'active', level: 'read-only' };
  const live = { ...SHOP_REQUEST, state: 'active' };
  const raise = { ...SHOP_REQUEST, requestId: 'req_2', mode: 'full' };
  const page = await popup(t, { local: { ...PAIRED, status: 'active' }, requests: [live, raise], query: '?window=1',
    state: { status: 'active', session } });
  assert.equal(await page.textContent('.fai-tab-request'), 'Approve on the FAI tab');
  assert.equal(await count(page, '.open-request'), 0, 'nothing opens a second window');
  await page.click('.fai-tab-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'));
  const start = await startMessage(page);
  assert.deepEqual({ requestId: start.requestId, onSessionTab: start.onSessionTab }, { requestId: 'req_2', onSessionTab: true });
});

test('popup: "Show a window when an agent asks for a tab" is on by default and saves approvalWindow', async t => {
  const page = await popup(t, { local: { ...PAIRED } });
  assert.equal(await page.evaluate(() => __closed), 0, 'the toolbar popup never closes itself');
  await page.click('#advanced summary');
  assert.equal(await page.$eval('#approval-window', node => node.checked), true);
  await page.click('#approval-window');
  assert.equal(await page.evaluate(() => __local.approvalWindow), false);
});

test('popup: "Open requested pages right away" is on by default (absent or any other value), off only on an explicit false', async t => {
  const page = await popup(t, { local: { ...PAIRED } });
  await page.click('#advanced summary');
  assert.equal(await page.$eval('#open-right-away', node => node.checked), true);
  const help = await page.$eval('label[for="open-right-away"] + .field-help', node => node.textContent);
  assert.match(help, /Opening approves nothing/);
  assert.match(help, /click the FAI Browser icon on the page/);
  await page.click('#open-right-away');
  assert.equal(await page.evaluate(() => __local.openRightAway), false);
  const off = await popup(t, { local: { ...PAIRED, openRightAway: false } });
  assert.equal(await off.$eval('#open-right-away', node => node.checked), false);
  const legacy = await popup(t, { local: { ...PAIRED, openRightAway: 'yes' } });
  assert.equal(await legacy.$eval('#open-right-away', node => node.checked), true);
});

test('popup: tab access defaults to single, multiple is visible at approval and asks only for the current site', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [request(['http://localhost:3000'], 'read-only')] });
  assert.equal(await page.$eval('#tab-mode', node => node.value), 'single');
  assert.match(await page.textContent('.tab-access'), /One task tab/);
  await page.click('#advanced summary');
  await page.selectOption('#tab-mode', 'multiple');
  await page.waitForFunction(() => __local.tabMode === 'multiple');
  assert.match(await page.textContent('.tab-access'), /Multiple task tabs/);
  await page.click('.approve-request');
  const asked = await page.evaluate(() => __permissionRequests);
  assert.deepEqual(asked[0].origins, ['http://localhost/*']);
  const start = await page.evaluate(() => __sent.find(message => message.type === 'start'));
  assert.equal(start.tabMode, 'multiple');
});

// --- arm.html: the waiting prompt next to a page that opened by itself ------------------------------------------

// Loads arm.html?tab=<tabId> with a fake chrome API: `arms` is chrome.storage.session.armedTabs, `requests` the
// worker's request list, `permissions` chrome.storage.local.permissions.
async function armPage(t, { arms, requests = [], permissions = null, tabId = 9, pinned = true, holdPrepare = false,
  viewport = { width: 400, height: 250 }, held = [], holdContains = false } = {}) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  await page.route('https://popup.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    route.fulfill({ contentType: type, body: await readFile(new URL(file, EXTENSION), 'utf8') });
  });
  await page.addInitScript(([arms, requests, permissions, pinned, holdPrepare, held, holdContains]) => {
    const listeners = [];
    globalThis.__holdPrepare = holdPrepare;
    globalThis.__listeners = listeners;
    globalThis.__sent = [];
    globalThis.__closed = 0;
    globalThis.__access = true;
    globalThis.__permissionCalls = [];
    globalThis.__reply = null;
    window.close = () => { globalThis.__closed++; };
    globalThis.chrome = {
      storage: {
        local: { async get() { return permissions ? { permissions } : {}; } },
        session: { async get() { return { armedTabs: arms, requests }; } },
        onChanged: { addListener(listener) { listeners.push(listener); } },
      },
      runtime: {
        async sendMessage(message) {
          __sent.push(message);
          if (__reply) return __reply;
          if (message.type === 'arm_prepare') {
            // `__holdPrepare`: the worker's answer waits until the test calls __releasePrepare(). `__prepareError`:
            // the worker refuses. Each answer for the same arm has a fresh token (`__prepares` counts them).
            if (globalThis.__holdPrepare) await new Promise(done => { globalThis.__releasePrepare = done; });
            if (globalThis.__prepareError) return { error: __prepareError };
            const key = `${message.requestId}-${message.at}`;
            globalThis.__prepares ??= {};
            __prepares[key] = (__prepares[key] ?? 0) + 1;
            const again = __prepares[key] > 1 ? `-${__prepares[key]}` : '';
            return { approval: { token: `prepared-${message.requestId}-${message.at}${again}`, pattern: 'https://shop.example.com/*' } };
          }
          // `__staleOnce`: the first arm_approve finds a restarted worker that no longer knows the token.
          if (message.type === 'arm_approve' && globalThis.__staleOnce) {
            globalThis.__staleOnce = false;
            return { error: 'This approval was prepared by an earlier run of the extension. Nothing was approved.', code: 'stale_approval' };
          }
          if (message.type === 'arm_approve') return message.granted
            ? { status: 'active', session: { tabId: 9, requestId: message.requestId } }
            : { error: 'Browser site access was not granted.' };
          return { status: null };
        },
      },
      permissions: {
        request(permission) {
          __permissionCalls.push({ permission, active: navigator.userActivation.isActive });
          if (__access) for (const origin of permission.origins) __held.add(origin);
          return Promise.resolve(__access);
        },
        // `__held`: the host patterns the browser holds; `__holdContains`: the answer waits until released.
        // `__permissionsChanged()`: fires onAdded/onRemoved.
        async contains({ origins }) {
          if (globalThis.__holdContains) await new Promise(done => { (globalThis.__containsWaiting ??= []).push(done); });
          return origins.every(origin => __held.has(origin));
        },
      },
      commands: { async getAll() { return [{ name: '_execute_action', shortcut: 'Ctrl+Shift+Y' }]; } },
      action: { async getUserSettings() { return { isOnToolbar: pinned }; } },
    };
    const permissionListeners = [];
    chrome.permissions.onAdded = { addListener(listener) { permissionListeners.push(listener); } };
    chrome.permissions.onRemoved = { addListener(listener) { permissionListeners.push(listener); } };
    globalThis.__permissionsChanged = origins => { for (const listener of permissionListeners) listener({ origins }); };
    globalThis.__held = new Set(held);
    globalThis.__holdContains = holdContains;
  }, [arms, requests, permissions, pinned, holdPrepare, held, holdContains]);
  await page.goto(`https://popup.test/arm.html?tab=${tabId}`);
  await page.waitForFunction(() => document.querySelector('#level option') !== null || globalThis.__closed > 0);
  return page;
}

const ARM = { tabId: 9, requestId: 'req_1', level: 'reversible', scope: 'origin', patterns: [], client: 'Codex', at: Date.now(),
  groupId: null, promptWindowId: 31 };
const ARM_REQUEST = { ...request(['https://shop.example.com'], 'reversible'), url: 'https://shop.example.com/cart', client: 'Codex' };

test('arm.html says to click the icon on the opened page, names the client, host, reason and level, and offers the levels', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
  assert.match(await page.$eval('#headline', node => node.textContent), /Approve this request/);
  const detail = await page.$eval('#detail', node => node.textContent);
  assert.match(detail, /Codex asks for shop\.example\.com: "Run the checkout test"/);
  assert.match(detail, /Click the FAI Browser icon there \(or Ctrl\+Shift\+Y\), or approve here at the level below/);
  assert.equal(await page.$eval('#level', node => node.value), 'reversible');
  assert.deepEqual(await page.$$eval('#level option', nodes => nodes.map(node => node.value)), ['read-only', 'reversible'],
    'never above what the agent asked for');
  assert.deepEqual(await page.$$eval('#level option', nodes => nodes.map(node => node.textContent)), ['Read', 'Use']);
  assert.match(await page.$eval('#level-help', node => node.textContent), /Clicks, picks options/);
  assert.equal(await page.getAttribute('#level', 'aria-describedby'), 'level-help');
  assert.equal(await computedDescription(page, '#level'), LEVEL_TEXT.reversible.description);
  assert.equal(await page.$eval('#pin-hint', node => node.hidden), true, 'pinned: no hint');
  assert.equal(await page.$eval('#level-warning', node => node.hidden), true);
  assert.equal(await page.evaluate(() => __closed), 0);
});

test('arm.html: changing the level sends arm_level for the tab; Deny sends deny for the request', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
  await page.selectOption('#level', 'read-only');
  await page.waitForFunction(() => __sent.some(message => message.type === 'arm_level'));
  assert.deepEqual(await page.evaluate(() => __sent.find(message => message.type === 'arm_level')), { type: 'arm_level', tabId: 9, level: 'read-only' });
  await page.waitForFunction(() => /approve Read\./.test(document.querySelector('#status').textContent));
  await page.click('#deny');
  await page.waitForFunction(() => __sent.some(message => message.type === 'deny'));
  assert.deepEqual(await page.evaluate(() => __sent.find(message => message.type === 'deny')), { type: 'deny', requestId: 'req_1' });
  await page.waitForFunction(() => /Request denied/.test(document.querySelector('#status').textContent));
  // The worker's refusal is shown.
  const refused = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
  await refused.evaluate(() => { globalThis.__reply = { error: 'This page is no longer waiting for approval.' }; });
  await refused.selectOption('#level', 'read-only');
  await refused.waitForFunction(() => /no longer waiting/.test(document.querySelector('#status').textContent));
});

test('arm.html offers Testing only when every requested origin is a listed environment, and closes when its arm ends', async t => {
  const listed = { defaultLevel: 'read-only', testingOrigins: ['http://localhost:3000'] };
  const local = { ...request(['http://localhost:3000'], 'testing'), url: 'http://localhost:3000/app' };
  const page = await armPage(t, { arms: [{ ...ARM, level: 'interactive' }], requests: [local], permissions: listed });
  assert.deepEqual(await page.$$eval('#level option', nodes => nodes.map(node => node.value)), ['read-only', 'interactive', 'full', 'testing']);
  assert.equal(await page.$eval('#level', node => node.value), 'interactive');
  await page.selectOption('#level', 'testing');
  await page.waitForFunction(() => __sent.some(message => message.type === 'arm_level' && message.level === 'testing'));
  await page.evaluate(arm => {
    for (const listener of __listeners) listener({ armedTabs: { newValue: [arm] } }, 'session');
  }, { ...ARM, level: 'testing' });
  assert.equal(await page.$eval('#level-help', node => node.textContent), LEVEL_TEXT.testing.description);
  assert.equal(await page.$eval('#level-warning', node => node.textContent), TESTING_WARNING);
  assert.equal(await page.$eval('#level-warning', node => node.hidden), false);
  assert.equal(await page.getAttribute('#level', 'aria-describedby'), 'level-help level-warning');
  const testingDescription = await computedDescription(page, '#level');
  assert.match(testingDescription, new RegExp(LEVEL_TEXT.testing.description));
  assert.match(testingDescription, new RegExp(TESTING_WARNING));
  // An interactive request on a listed test site still offers nothing above Use.
  const use = await armPage(t, { arms: [{ ...ARM, level: 'interactive' }], requests: [{ ...local, mode: 'interactive' }], permissions: listed });
  assert.deepEqual(await use.$$eval('#level option', nodes => nodes.map(node => node.value)), ['read-only', 'interactive']);
  // The arm leaves storage.session (approved, denied, expired or the tab closed): the prompt closes itself.
  await page.evaluate(() => { for (const listener of __listeners) listener({ armedTabs: { newValue: [] } }, 'session'); });
  assert.equal(await page.evaluate(() => __closed), 1);
  // No arm for this tab at all (a stale window): it closes at once.
  const stale = await armPage(t, { arms: [], requests: [] });
  assert.equal(await stale.evaluate(() => __closed), 1);
  // Without the request list yet (a worker restart before the daemon's snapshot), only the armed level is shown.
  const bare = await armPage(t, { arms: [ARM], requests: [] });
  assert.deepEqual(await bare.$$eval('#level option', nodes => nodes.map(node => node.value)), ['reversible']);
  assert.match(await bare.$eval('#detail', node => node.textContent), /Codex asks for that page/);
});

// --- per-request budget (Setup & connection) ---------------------------------------------------------------------

test('normalizeBudget: integers within the bounds, else null (not set); the bounds match src/settings.js', async () => {
  const settings = await import('../src/settings.js');
  assert.deepEqual(BUDGET_LIMITS, settings.BUDGET_LIMITS, 'the popup and the server agree on the bounds');
  assert.deepEqual(BUDGET_MINUTES, { min: 1, max: 240 });
  assert.equal(normalizeBudget(undefined), null);
  assert.equal(normalizeBudget(null), null);
  assert.equal(normalizeBudget({ maxCalls: 0, maxMs: 60_000 }), null);
  assert.deepEqual(BUDGET_LIMITS.maxCalls, { min: 1, max: 10_000 });
  assert.deepEqual(normalizeBudget({ maxCalls: 10_000, maxMs: 60_000 }), { maxCalls: 10_000, maxMs: 60_000 });
  assert.equal(normalizeBudget({ maxCalls: 10_001, maxMs: 60_000 }), null);
  assert.equal(normalizeBudget({ maxCalls: 5, maxMs: 999 }), null);
  assert.equal(normalizeBudget({ maxCalls: 5, maxMs: 14_400_001 }), null);
  assert.equal(normalizeBudget({ maxCalls: '5', maxMs: 60_000 }), null);
  assert.equal(normalizeBudget({ maxCalls: 5 }), null, 'both fields are needed');
  assert.deepEqual(normalizeBudget({ maxCalls: 5, maxMs: 60_000, extra: 1 }), { maxCalls: 5, maxMs: 60_000 });
  assert.deepEqual(normalizeBudget(settings.DEFAULT_BUDGET), { maxCalls: 50, maxMs: 1_200_000 });
});

test('budgetFromFields: whole numbers within the bounds; both empty removes the setting; describeBudget reads back', () => {
  assert.deepEqual(budgetFromFields({ calls: '', minutes: '' }), { budget: null });
  assert.deepEqual(budgetFromFields({ calls: ' 12 ', minutes: '5' }), { budget: { maxCalls: 12, maxMs: 300_000 } });
  assert.match(budgetFromFields({ calls: '', minutes: '5' }).error, /Fill in both calls and minutes, or leave both empty/);
  assert.match(budgetFromFields({ calls: '12', minutes: '' }).error, /Fill in both/);
  assert.match(budgetFromFields({ calls: '0', minutes: '5' }).error, /Calls must be a whole number from 1 to 10000/);
  assert.deepEqual(budgetFromFields({ calls: '10000', minutes: '240' }), { budget: { maxCalls: 10_000, maxMs: 14_400_000 } });
  assert.match(budgetFromFields({ calls: '10001', minutes: '5' }).error, /Calls must be/);
  assert.match(budgetFromFields({ calls: '1.5', minutes: '5' }).error, /Calls must be/);
  assert.match(budgetFromFields({ calls: '0', minutes: '' }).error, /Calls must be/, 'a bad value is named before the missing one');
  assert.match(budgetFromFields({ calls: '12', minutes: '241' }).error, /Minutes must be a whole number from 1 to 240/);
  assert.match(budgetFromFields({ calls: '12', minutes: '-3' }).error, /Minutes must be/);
  assert.equal(describeBudget({ maxCalls: 50, maxMs: 1_200_000 }), '50 calls, 20 min');
  assert.equal(describeBudget({ maxCalls: 1, maxMs: 90_000 }), '1 call, 1.5 min');
  assert.equal(describeBudget({ maxCalls: 10_000, maxMs: 14_400_000 }), '10000 calls, 240 min');
  assert.equal(describeBudget(null), '');
});

test('popup: the per-request budget fields are empty by default, validate whole numbers and save budget = {maxCalls, maxMs}', async t => {
  const page = await popup(t, { local: { ...PAIRED } });
  await page.click('#advanced summary');
  assert.equal(await page.$eval('#budget-calls', node => node.value), '');
  assert.equal(await page.$eval('#budget-minutes', node => node.value), '');
  assert.equal(await page.$eval('#budget-calls', node => node.placeholder), '50');
  assert.match(await page.$eval('#budget-effective', node => node.textContent), /^In effect: 50 calls, 20 min \(default\)$/);
  // A bad value shows an error and saves nothing.
  await page.fill('#budget-calls', '0');
  await page.dispatchEvent('#budget-calls', 'change');
  assert.match(await page.$eval('#budget-error', node => node.textContent), /Calls must be a whole number from 1 to 10000/);
  assert.equal(await page.evaluate(() => __local.budget), undefined);
  await page.fill('#budget-calls', '10001');
  await page.fill('#budget-minutes', '5');
  await page.dispatchEvent('#budget-minutes', 'change');
  assert.match(await page.$eval('#budget-error', node => node.textContent), /Calls must be a whole number from 1 to 10000/);
  assert.equal(await page.evaluate(() => __local.budget), undefined);
  // The most it takes: five digits, saved, and the value fits its field.
  assert.equal(await page.$eval('#budget-calls', node => node.max), '10000');
  await page.fill('#budget-calls', '10000');
  await page.fill('#budget-minutes', '240');
  await page.dispatchEvent('#budget-minutes', 'change');
  assert.equal(await page.$eval('#budget-error', node => node.textContent), '');
  assert.deepEqual(await page.evaluate(() => __local.budget), { maxCalls: 10_000, maxMs: 14_400_000 });
  assert.equal(await page.$eval('#budget-calls', node => node.scrollWidth <= node.clientWidth), true, 'five digits fit the field');
  // Both fields valid: saved as milliseconds.
  await page.fill('#budget-calls', '12');
  await page.fill('#budget-minutes', '5');
  await page.dispatchEvent('#budget-minutes', 'change');
  assert.equal(await page.$eval('#budget-error', node => node.textContent), '');
  assert.deepEqual(await page.evaluate(() => __local.budget), { maxCalls: 12, maxMs: 300_000 });
  // Both cleared: the setting goes (null), the daemon's default applies again.
  await page.fill('#budget-calls', '');
  await page.fill('#budget-minutes', '');
  await page.dispatchEvent('#budget-minutes', 'change');
  assert.equal(await page.evaluate(() => __local.budget), null);
  // A stored budget shows in the fields.
  const stored = await popup(t, { local: { ...PAIRED, budget: { maxCalls: 8, maxMs: 600_000 } } });
  await stored.click('#advanced summary');
  assert.equal(await stored.$eval('#budget-calls', node => node.value), '8');
  assert.equal(await stored.$eval('#budget-minutes', node => node.value), '10');
});

// --- setup, pairing, pin hint, privacy note -------------------------------------------------------------------------

test('popup: connected collapses setup to one line; the saved secret never reaches the page', async t => {
  const page = await popup(t, { local: { ...PAIRED } });
  assert.equal(await page.$eval('#connection-line', node => node.hidden), false);
  assert.match(await page.textContent('#connection-line'), /Connected to the FAI service/);
  assert.equal(await page.$eval('#setup', node => node.hidden), true);
  assert.equal(await page.$eval('#secret', node => node.value), '', 'the secret field is never prefilled');
  assert.equal(await page.evaluate(secret => document.documentElement.outerHTML.includes(secret), PAIRED.secret), false);
  assert.equal(await page.$eval('#endpoint', node => node.value), 'http://127.0.0.1:4318');
  assert.equal(await page.$eval('#advanced', node => node.open), false);
  assert.equal(await count(page, '#start'), 0, 'no Phase 1 "Select tab and start" button');
  // A typed secret is saved and the field cleared.
  await page.click('#advanced summary');
  await page.fill('#secret', 'y'.repeat(32));
  await page.dispatchEvent('#secret', 'change');
  await page.waitForFunction(() => __local.secret === 'y'.repeat(32));
  assert.equal(await page.$eval('#secret', node => node.value), '');
});

test('popup: with two browsers paired, a request waiting in the other one is listed with Open here, which moves it', async t => {
  // Several browsers (issue #9): this popup is Chromium's; the request waits in Firefox, the browser used last.
  // As the service sends them: names and `self`/`mine` only, never another browser's id.
  const browsers = [{ product: 'chromium', name: 'Chromium', self: true }, { product: 'firefox', name: 'Firefox', self: false }];
  const elsewhere = { ...request(['https://example.com'], 'read-only'), browser: { product: 'firefox', name: 'Firefox', mine: false } };
  const mine = { ...request(['https://example.org'], 'read-only'), requestId: 'req_2', browser: { product: 'chromium', name: 'Chromium', mine: true } };
  const page = await popup(t, { local: { ...PAIRED }, requests: [elsewhere, mine],
    state: { connection: { browserId: 'b-chromium-self', browsers } } });
  await page.waitForSelector('.elsewhere-request');
  assert.match(await page.textContent('#connection-line'), /Connected to the FAI service, with Firefox/);
  assert.equal(await count(page, '.elsewhere-request'), 1);
  assert.equal(await page.textContent('.elsewhere-request .card-label'), 'IN ANOTHER BROWSER');
  assert.match(await page.textContent('.elsewhere-request .request-meta'), /waiting in Firefox/);
  assert.equal(await count(page, '.elsewhere-request .level-select'), 0, 'no approval controls for another browser\'s request');
  // This browser's own request keeps its usual card.
  assert.equal(await count(page, '.request-card:not(.elsewhere-request) .level-select'), 1);
  await page.click('.elsewhere-request .move-request');
  await page.waitForFunction(() => __sent.some(message => message.type === 'move'));
  const moved = await page.evaluate(() => __sent.find(message => message.type === 'move'));
  assert.deepEqual(moved, { type: 'move', requestId: 'req_1' });
});

test('popup: unpaired shows the setup card; Pair asks the worker and the card goes once connected', async t => {
  const page = await popup(t, { connected: false });
  assert.equal(await page.$eval('#setup', node => node.hidden), false);
  assert.equal(await page.$eval('#connection-line', node => node.hidden), true);
  assert.match(await page.textContent('#setup-text'), /npm run setup/);
  assert.equal(await page.textContent('#state-label'), 'Setup needed');
  await page.click('#pair');
  await page.waitForFunction(() => __sent.some(message => message.type === 'pair'));
  await page.waitForFunction(() => document.querySelector('#setup').hidden);
  assert.match(await page.textContent('#status'), /Paired/);
  const missing = await popup(t, { connected: false, state: { native: 'missing', pairError: 'Automatic pairing is not installed.' } });
  assert.match(await missing.textContent('#setup-text'), /Automatic pairing is not installed/);
  await missing.click('#pair');
  await missing.waitForFunction(() => /not installed/.test(document.querySelector('#status').textContent));
  assert.equal(await missing.$eval('#setup', node => node.hidden), false);
});

test('popup and arm.html: an unpinned icon shows how to pin it; the shortcut comes from chrome.commands', async t => {
  const page = await popup(t, { local: { ...PAIRED }, pinned: false });
  await page.waitForFunction(() => !document.querySelector('#pin-hint').hidden);
  assert.match(await page.textContent('#pin-hint'), /Pin FAI Browser: you approve requests by clicking it/);
  const pinned = await popup(t, { local: { ...PAIRED } });
  assert.equal(await pinned.$eval('#pin-hint', node => node.hidden), true);
  const arm = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST], pinned: false });
  await arm.waitForFunction(() => !document.querySelector('#pin-hint').hidden);
  assert.match(await arm.textContent('#pin-hint'), /Or press Ctrl\+Shift\+Y\./);
});

test('popup: the privacy note names where page text goes', async t => {
  const page = await popup(t, { local: { ...PAIRED } });
  await page.waitForFunction(() => /coding agent\.$/.test(document.querySelector('#privacy-note').textContent));
});


test('arm.html Approve requests exact host permission in the click gesture, then confirms the armed tab', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  assert.equal(await page.locator('#approve').textContent(), 'Approve Use');
  assert.equal(await page.evaluate(() => document.activeElement.id), '', 'approval is not focused automatically');
  await page.locator('#approve').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => __closed > 0);
  assert.deepEqual(await page.evaluate(() => __permissionCalls), [{ permission: { origins: ['https://shop.example.com/*'] }, active: true }]);
  const message = await page.evaluate(() => __sent.find(item => item.type === 'arm_approve'));
  assert.equal(message.tabId, 9);
  assert.equal(message.requestId, ARM.requestId);
  assert.equal(message.at, ARM.at);
  assert.equal(message.level, 'reversible');
  assert.equal(message.granted, true);
});

test('arm.html denied browser access leaves the modal open and announces the failure', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
  await page.evaluate(() => { __access = false; });
  await page.click('#approve');
  await page.waitForFunction(() => /not granted/.test(document.querySelector('#status').textContent));
  assert.equal(await page.evaluate(() => __closed), 0);
  assert.equal(await page.locator('#status').getAttribute('role'), 'status');
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
});

// --- one click approves (the owner's "Approve sometimes takes several clicks") -----------------------------------

// The approval the worker prepared for the request modal (arm_prepare), as armPage's fake answers it.
const preparedToken = arm => `prepared-${arm.requestId}-${arm.at}`;
const emit = (page, changes) => page.evaluate(changes => { for (const listener of __listeners) listener(changes, 'session'); }, changes);

test('arm.html: a click before the worker has prepared the approval is kept and approves once it is ready', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST], holdPrepare: true });
  await page.waitForFunction(() => __sent.some(message => message.type === 'arm_prepare'));
  // A real pointer click while arm_prepare is still in flight.
  await page.click('#approve', { force: true });
  await page.evaluate(() => globalThis.__releasePrepare?.());
  await page.waitForFunction(() => __closed > 0 || __sent.some(message => message.type === 'arm_approve'), null, { timeout: 3000 })
    .catch(() => {});
  const approved = await page.evaluate(() => __sent.filter(message => message.type === 'arm_approve'));
  assert.equal(approved.length, 1, `one click, one approval: ${await page.textContent('#status')}`);
  assert.equal(approved[0].token, preparedToken(ARM));
  assert.equal(approved[0].requestId, ARM.requestId);
  assert.deepEqual(await page.evaluate(() => __permissionCalls), [{ permission: { origins: ['https://shop.example.com/*'] }, active: true }],
    'site access is still requested inside the click');
  await page.waitForFunction(() => __closed > 0);
});

test('arm.html: an early click asks for the request\'s other exact origins in the same prompt, as the prepared approval would', async t => {
  const twoSites = { ...ARM_REQUEST, origins: ['https://shop.example.com', 'https://login.example.com', 'https://*.example.org'] };
  const page = await armPage(t, { arms: [ARM], requests: [twoSites], holdPrepare: true });
  await page.waitForFunction(() => __sent.some(message => message.type === 'arm_prepare'));
  await page.click('#approve', { force: true });
  await page.evaluate(() => globalThis.__releasePrepare?.());
  await page.waitForFunction(() => __closed > 0);
  assert.deepEqual(await page.evaluate(() => __permissionCalls.map(call => call.permission.origins)),
    [['https://shop.example.com/*', 'https://login.example.com/*']], 'exact origins only, the task origin first');
});

test('arm.html: a re-arm of the same request or a requests update between prepare and click keeps the prepared approval', async t => {
  for (const change of ['rearm', 'requests', 'both']) {
    const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
    await page.waitForFunction(() => !document.querySelector('#approve').disabled);
    // showArm on a page load, a tab group the worker recorded, or another request arriving in the list.
    if (change !== 'requests') await emit(page, { armedTabs: { newValue: [{ ...ARM, groupId: 4, patterns: ['https://shop.example.com/*'] }] } });
    if (change !== 'rearm') await emit(page, { requests: { newValue: [ARM_REQUEST, { ...ARM_REQUEST, requestId: 'req_other' }] } });
    assert.equal(await page.$eval('#approve', node => node.disabled), false, change);
    await page.click('#approve');
    await page.waitForFunction(() => __closed > 0);
    const sent = await page.evaluate(() => __sent);
    assert.equal(sent.filter(message => message.type === 'arm_prepare').length, 1, `${change}: prepared once`);
    assert.equal(sent.filter(message => message.type === 'arm_approve').length, 1, change);
  }
});

test('arm.html: a different request on the tab needs its own approval: the click approves that one, never the old one', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  const next = { ...ARM, requestId: 'req_2', at: ARM.at + 1 };
  await emit(page, { armedTabs: { newValue: [next] }, requests: { newValue: [{ ...ARM_REQUEST, requestId: 'req_2' }] } });
  await page.click('#approve');
  await page.waitForFunction(() => __closed > 0 || /./.test(document.querySelector('#status').textContent));
  const approved = await page.evaluate(() => __sent.filter(message => message.type === 'arm_approve'));
  assert.equal(approved.length, 1);
  assert.equal(approved[0].requestId, 'req_2');
  assert.equal(approved[0].at, next.at);
  assert.equal(approved[0].token, preparedToken(next), 'a token prepared for the new request');
});

test('popup: a press on Approve that spans a re-render still approves (the card is not replaced under the pointer)', async t => {
  const page = await popup(t, { local: { ...PAIRED }, requests: [request(['http://localhost:3000'], 'reversible')] });
  // Focus elsewhere first (the level just chosen): the press moves focus to Approve, which must not end the hold.
  await page.focus('.request-card .level-select');
  const box = await page.locator('.approve-request').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Another request arrives (or the connection or the arms change) while the button is held.
  await emit(page, { requests: { newValue: [request(['http://localhost:3000'], 'reversible'), { ...request(['https://other.test'], 'read-only'), requestId: 'req_9' }] } });
  await page.mouse.up();
  await page.waitForFunction(() => __sent.some(message => message.type === 'start'), null, { timeout: 2000 }).catch(() => {});
  assert.equal((await page.evaluate(() => __sent)).filter(message => message.type === 'start').length, 1, 'one press, one approval');
  // A press that clicks nothing: the update waits for its end, then renders.
  const other = await popup(t, { local: { ...PAIRED }, requests: [request(['http://localhost:3000'], 'read-only')] });
  const text = await other.locator('.request-reason').boundingBox();
  await other.mouse.move(text.x + 2, text.y + 2);
  await other.mouse.down();
  await emit(other, { requests: { newValue: [request(['http://localhost:3000'], 'read-only'), { ...request(['https://other.test'], 'read-only'), requestId: 'req_9' }] } });
  assert.equal(await count(other, '[data-request-id="req_9"]'), 0, 'held while pressed');
  await other.mouse.up();
  await other.waitForFunction(() => document.querySelector('[data-request-id="req_9"]') !== null);
});

test('popup: a press on Approve once that spans an approvals update still approves', async t => {
  const approval = { id: 'approval-1', kind: 'click', cls: 'purchase', origin: 'http://localhost:3000', title: 'Checkout', label: 'Pay now' };
  const page = await popup(t, { local: { ...PAIRED }, state: { approvals: [approval] } });
  const box = await page.locator('.approval-card .primary-button').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await emit(page, { approvals: { newValue: [approval, { ...approval, id: 'approval-2', label: 'Pay again' }] } });
  await page.mouse.up();
  await page.waitForFunction(() => __sent.some(message => message.type === 'approval_decision'), null, { timeout: 2000 }).catch(() => {});
  assert.deepEqual((await page.evaluate(() => __sent)).filter(message => message.type === 'approval_decision'),
    [{ type: 'approval_decision', id: 'approval-1', decision: 'approve' }]);
  await page.waitForFunction(() => document.querySelector('[data-approval-id="approval-2"]') !== null);
});

test('arm.html: while Chrome asks for site access the window says so in view, and another click changes nothing', async t => {
  // The prompt window's own size (background.js PROMPT_SIZE, 440 x 430) less the window's title bar.
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST], viewport: { width: 440, height: 400 }, pinned: false });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled && !document.querySelector('#pin-hint').hidden);
  await page.evaluate(() => {
    chrome.permissions.request = permission => {
      __permissionCalls.push({ permission, active: navigator.userActivation.isActive });
      return new Promise(done => { globalThis.__answerAccess = done; });
    };
  });
  await page.click('#approve');
  await page.waitForFunction(() => /Waiting for browser site access/.test(document.querySelector('#status').textContent));
  assert.equal(await page.$eval('#approve', node => node.textContent), 'Approving…');
  const visible = await page.$eval('#status', node => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight + 1 ? true : JSON.stringify({ top: box.top, bottom: box.bottom, innerHeight });
  });
  assert.equal(visible, true, 'the status line is in view (the small window scrolls to it)');
  // The user clicks again while the browser prompt is open: nothing more is asked or sent.
  await page.click('#approve', { force: true });
  assert.equal(await page.evaluate(() => __permissionCalls.length), 1);
  await page.evaluate(() => __answerAccess(true));
  await page.waitForFunction(() => __closed > 0);
  assert.equal(await page.evaluate(() => __sent.filter(message => message.type === 'arm_approve').length), 1);
});

test('arm.html: Approve waits for the local held check; a grant reports only the patterns the browser did not hold (arm_track)', async t => {
  const twoSites = { ...ARM_REQUEST, origins: ['https://shop.example.com', 'https://login.example.com'] };
  const page = await armPage(t, { arms: [ARM], requests: [twoSites], held: ['https://login.example.com/*'], holdContains: true });
  assert.equal(await page.$eval('#approve', node => node.disabled), true, 'disabled until the held check is in');
  await page.evaluate(() => { globalThis.__holdContains = false; for (const done of globalThis.__containsWaiting ?? []) done(); });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  await page.click('#approve');
  await page.waitForFunction(() => __closed > 0);
  const sent = await page.evaluate(() => __sent.filter(message => ['arm_track', 'arm_approve'].includes(message.type)));
  assert.deepEqual(sent.map(message => message.type), ['arm_track', 'arm_approve'], 'tracked before the approval');
  assert.deepEqual(sent[0], { type: 'arm_track', tabId: 9, requestId: ARM.requestId, at: ARM.at, patterns: ['https://shop.example.com/*'] });
  // Nothing newly granted (already held, or the user said no): nothing to report.
  for (const options of [{ held: ['https://shop.example.com/*'] }, {}]) {
    const other = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST], ...options });
    if (!options.held) await other.evaluate(() => { __access = false; });
    await other.waitForFunction(() => !document.querySelector('#approve').disabled);
    await other.click('#approve');
    await other.waitForFunction(() => __sent.some(message => message.type === 'arm_approve'));
    assert.equal(await other.evaluate(() => __sent.some(message => message.type === 'arm_track')), false, JSON.stringify(options));
  }
});

test('arm.html: an early click whose prepare is refused reports the grant, approves nothing and can be tried again', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST], holdPrepare: true });
  await page.waitForFunction(() => __sent.some(message => message.type === 'arm_prepare') && !document.querySelector('#approve').disabled);
  await page.evaluate(() => { __prepareError = 'The request was no longer waiting or this tab left its site: nothing was approved.'; });
  await page.click('#approve');
  await page.evaluate(() => globalThis.__releasePrepare?.());
  await page.waitForFunction(() => /no longer waiting/.test(document.querySelector('#status').textContent));
  const sent = await page.evaluate(() => __sent);
  assert.deepEqual(sent.filter(message => message.type === 'arm_track').map(message => message.patterns), [['https://shop.example.com/*']],
    'the grant is reported even though nothing was approved');
  assert.equal(sent.some(message => message.type === 'arm_approve'), false);
  assert.equal(await page.evaluate(() => __closed), 0);
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
});

test('arm.html: a worker that restarted after preparing is prepared again once and the same click approves', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST] });
  await page.evaluate(() => { __staleOnce = true; });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  await page.click('#approve');
  await page.waitForFunction(() => __closed > 0);
  const approves = await page.evaluate(() => __sent.filter(message => message.type === 'arm_approve'));
  assert.equal(approves.length, 2);
  assert.equal(approves[0].token, preparedToken(ARM));
  assert.equal(approves[1].token, `${preparedToken(ARM)}-2`, 'a freshly prepared token');
  assert.equal(approves[1].granted, true, 'the access the click obtained, read from the browser');
  assert.equal(await page.evaluate(() => __permissionCalls.length), 1, 'one prompt, one click');
});

test('arm.html: site access removed after the window checked it is reported again when the click grants it back', async t => {
  const page = await armPage(t, { arms: [ARM], requests: [ARM_REQUEST], held: ['https://shop.example.com/*'] });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  // The user removes the site's access (chrome://extensions) before clicking.
  await page.evaluate(() => { __held.delete('https://shop.example.com/*'); __permissionsChanged(['https://shop.example.com/*']); });
  await page.waitForFunction(() => !document.querySelector('#approve').disabled);
  await page.click('#approve');
  await page.waitForFunction(() => __closed > 0);
  assert.deepEqual(await page.evaluate(() => __sent.filter(message => message.type === 'arm_track').map(message => message.patterns)),
    [['https://shop.example.com/*']]);
});
