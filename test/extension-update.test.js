// The popup's update card (extension/update-card.js) in headless Chromium against a fake chrome API: the banner for a
// newer release with its notes link, the exact message Update sends, a refusal shown in place, the install's
// progress and outcome, and nothing shown when up to date. Plus the card's pure view function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { updateCard } from '../extension/update-card.js';

const EXTENSION = new URL('../extension/', import.meta.url);
const NOTES = 'https://github.com/jedbjorn/fai-browser/releases/tag/v0.9.0';
const AVAILABLE = { current: '0.4.0', latest: '0.9.0', available: true, notesUrl: NOTES, install: null };

test('update card view: available, running, failed, recent success, nothing', () => {
  const now = Date.parse('2026-11-21T08:00:00Z');
  assert.equal(updateCard(null).hidden, true);
  assert.equal(updateCard({ current: '0.4.0', latest: '0.4.0', available: false, install: null }).hidden, true);
  const available = updateCard(AVAILABLE, { now });
  assert.equal(available.label, 'UPDATE AVAILABLE');
  assert.equal(available.button, 'Update to 0.9.0');
  assert.equal(available.notesUrl, NOTES);
  assert.equal(updateCard(AVAILABLE, { installing: true }).state, 'running');
  const byHand = updateCard({ ...AVAILABLE, installable: false }, { now });
  assert.equal(byHand.button, null, 'no button for a copy that is not a git clone');
  assert.match(byHand.text, /npm install -g fai-browser@latest/);
  assert.equal(updateCard({ ...AVAILABLE, available: false, latest: '0.4.0', install: { state: 'up_to_date', to: '0.4.0' } }).hidden, true);
  const failed = updateCard({ ...AVAILABLE, install: { state: 'rolled_back', to: '0.9.0', at: '2026-11-21T07:00:00Z',
    message: 'restart failed. Rolled back to 0.4.0.' } }, { now });
  assert.equal(failed.state, 'failed');
  assert.match(failed.text, /undone: restart failed/);
  assert.equal(failed.button, 'Try again: update to 0.9.0');
  const done = { current: '0.9.0', latest: '0.9.0', available: false, install: { state: 'succeeded', to: '0.9.0', at: '2026-11-21T07:00:00Z' } };
  assert.equal(updateCard(done, { now }).label, 'UPDATED');
  assert.equal(updateCard(done, { now: now + 2 * 24 * 60 * 60_000 }).hidden, true, 'the success note fades after a day');
});

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

// popup.html with a fake chrome API: the worker's state carries `update`; `update_install` answers `installReply`.
async function popup(t, { update, installReply }) {
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  t.after(() => page.close());
  await page.route('https://popup.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    route.fulfill({ contentType: type, body: await readFile(new URL(file, EXTENSION), 'utf8') });
  });
  await page.addInitScript(([update, installReply]) => {
    const listeners = [];
    globalThis.__listeners = listeners;
    globalThis.__sent = [];
    const connection = () => ({ connected: true, transport: 'websocket', paired: true, native: null,
      ...(globalThis.__update ? { update: globalThis.__update } : {}) });
    globalThis.__update = update;
    globalThis.chrome = {
      storage: {
        local: { async get() { return { endpoint: 'http://127.0.0.1:4318', secret: 'x'.repeat(30) }; }, async set() {} },
        session: { async get() { return { requests: [], approvals: [], connection: connection() }; } },
        onChanged: { addListener(listener) { listeners.push(listener); } },
      },
      tabs: { async query() { return [{ id: 7, url: 'http://localhost:3000/app', title: 'App' }]; } },
      commands: { async getAll() { return [{ name: '_execute_action', shortcut: 'Ctrl+Shift+Y' }]; } },
      action: { async getUserSettings() { return { isOnToolbar: true }; } },
      permissions: { async request() { return true; }, async contains() { return false; }, async remove() { return true; } },
      runtime: {
        async sendMessage(message) {
          __sent.push(message);
          if (message.type === 'update_install') {
            if (installReply.error) return { error: installReply.error };
            globalThis.__update = installReply.update;
          }
          return { status: null, session: null, requests: [], connection: connection() };
        },
      },
    };
  }, [update, installReply ?? {}]);
  await page.goto('https://popup.test/popup.html');
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  return page;
}

const shown = page => page.$eval('#update', node => !node.hidden);

test('popup: the banner offers the update with its notes link, and Update sends one update_install', async t => {
  const page = await popup(t, { update: AVAILABLE,
    installReply: { update: { ...AVAILABLE, install: { state: 'running', to: '0.9.0', message: 'Installing 0.9.0.' } } } });
  await page.waitForFunction(() => !document.querySelector('#update').hidden);
  assert.equal(await page.textContent('#update-label'), 'UPDATE AVAILABLE');
  assert.match(await page.textContent('#update-text'), /FAI Browser 0\.9\.0 is available \(you have 0\.4\.0\)/);
  assert.equal(await page.getAttribute('#update-notes', 'href'), NOTES);
  assert.equal(await page.$eval('#update-notes', node => node.hidden), false);
  assert.equal(await page.textContent('#update-install'), 'Update to 0.9.0');
  assert.deepEqual(await page.evaluate(() => __sent.filter(message => message.type.startsWith('update'))), [],
    'opening the popup installs nothing');
  await page.click('#update-install');
  await page.waitForFunction(() => document.querySelector('#update-label').textContent === 'UPDATING');
  assert.deepEqual(await page.evaluate(() => __sent.filter(message => message.type === 'update_install')), [{ type: 'update_install' }]);
  assert.equal(await page.$eval('#update-install', node => node.hidden), true, 'no second click while it installs');
  assert.match(await page.textContent('#update-text'), /Installing 0\.9\.0/);
  // The restarted service reports the outcome through the worker's session state.
  await page.evaluate(() => __listeners.forEach(listener => listener({ connection: { newValue: { connected: true,
    update: { current: '0.9.0', latest: '0.9.0', available: false, notesUrl: null,
      install: { state: 'succeeded', to: '0.9.0', at: new Date().toISOString(), message: 'Updated.' } } } } }, 'session')));
  await page.waitForFunction(() => document.querySelector('#update-label').textContent === 'UPDATED');
  assert.match(await page.textContent('#update-text'), /Restart your coding agent/);
});

test('popup: a refused update shows its reason and keeps the button for another try', async t => {
  const page = await popup(t, { update: AVAILABLE,
    installReply: { error: 'An agent holds a browser tab. Let the task finish or press Stop, then update.' } });
  await page.waitForFunction(() => !document.querySelector('#update').hidden);
  await page.click('#update-install');
  await page.waitForFunction(() => document.querySelector('#update-error').textContent.includes('holds a browser tab'));
  assert.equal(await page.$eval('#update-install', node => node.hidden || node.disabled), false);
  assert.equal(await page.textContent('#update-label'), 'UPDATE AVAILABLE');
});

test('popup: nothing to show when up to date or when the service names no update', async t => {
  const current = await popup(t, { update: { current: '0.4.0', latest: '0.4.0', available: false, notesUrl: null, install: null } });
  assert.equal(await shown(current), false);
  const older = await popup(t, { update: undefined });
  assert.equal(await shown(older), false);
});
