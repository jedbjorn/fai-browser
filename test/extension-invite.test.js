// The popup's "Invite agent" (extension/invite-card.js) in headless Chromium against a fake chrome API: one tap with
// one live agent session, a one-tap list with several, the level chips and the optional text, the copy line when the
// wake fails, and nothing in the approval window. Plus the card's pure helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { agentLabel, joinLine, wakeLine } from '../extension/invite-card.js';

const EXTENSION = new URL('../extension/', import.meta.url);
const CLAUDE = { sessionId: 'ses_1', host: 'claude', repo: 'fai-browser', lastActiveAt: new Date().toISOString(), wake: 'claude-socket', ready: true };
const CODEX = { sessionId: 'ses_2', host: 'codex', repo: 'shop', lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(), wake: 'none', ready: false };

test('invite card helpers: labels, the copy line and what each wake state says', () => {
  assert.equal(agentLabel(CLAUDE), 'Claude Code · fai-browser');
  assert.equal(joinLine('inv-abcd2345'), 'join FAI invite inv-abcd2345');
  const session = { host: 'claude', repo: 'fai-browser' };
  assert.deepEqual(wakeLine({ state: 'open', session, wake: { state: 'queued' } }), { text: 'Waking Claude Code · fai-browser…', fallback: false });
  assert.deepEqual(wakeLine({ state: 'open', session, wake: { state: 'delivered' } }),
    { text: 'Sent to Claude Code · fai-browser. It should start in a moment.', fallback: 'soft' });
  const failed = wakeLine({ state: 'open', session, wake: { state: 'failed', error: { message: 'crossSessionInbound is refuse' } } });
  assert.equal(failed.fallback, true);
  assert.match(failed.text, /Could not wake Claude Code · fai-browser \(crossSessionInbound is refuse\)/);
  assert.equal(wakeLine({ state: 'open', session: null, wake: { state: 'none' } }).fallback, true);
  assert.match(wakeLine({ state: 'joined', joinedBy: session, wake: { state: 'delivered' } }).text, /joined/);
});

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

// popup.html with a fake chrome API: `agents` answers the session list; `invite` answers an active invited request.
async function popup(t, { sessions, wake = 'queued', search = '', requests = [] }) {
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  t.after(() => page.close());
  await page.route('https://popup.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    route.fulfill({ contentType: type, body: await readFile(new URL(file, EXTENSION), 'utf8') });
  });
  await page.addInitScript(([sessions, wake, requests]) => {
    const local = { endpoint: 'http://127.0.0.1:4318', secret: 'x'.repeat(30) };
    globalThis.__sent = [];
    globalThis.__requests = requests;
    globalThis.__local = local;
    const connection = { connected: true, transport: 'websocket', paired: true, native: null };
    const state = () => ({ status: globalThis.__requests.some(item => item.invite) ? 'active' : null, session: globalThis.__session ?? null,
      requests: globalThis.__requests, connection });
    globalThis.chrome = {
      storage: {
        local: { async get(keys) { return Object.fromEntries((keys ?? []).filter(k => k in local).map(k => [k, local[k]])); },
          async set(values) { Object.assign(local, values); } },
        session: { async get() { return { requests: [], approvals: [], connection }; } },
        onChanged: { addListener() {} },
      },
      tabs: { async query() { return [{ id: 7, url: 'https://shop.example/cart', title: 'Cart' }]; } },
      commands: { async getAll() { return [{ name: '_execute_action', shortcut: 'Ctrl+Shift+Y' }]; } },
      action: { async getUserSettings() { return { isOnToolbar: true }; } },
      permissions: { async request() { return true; }, async contains() { return false; }, async remove() { return true; } },
      runtime: {
        getManifest: () => ({ version: '0.5.1' }),
        async sendMessage(message) {
          __sent.push(message);
          if (message.type === 'agents') return { ...state(), agents: { sessions } };
          if (message.type === 'invite') {
            const session = sessions.find(item => item.sessionId === message.sessionId) ?? null;
            globalThis.__session = { requestId: 'req_inv', tabId: 7, origin: 'https://shop.example', status: 'active', level: message.level, inviteId: 'inv-abcd2345' };
            globalThis.__requests = [{ requestId: 'req_inv', state: 'active', origins: ['https://shop.example'], mode: message.level,
              lease: { tabId: 7 }, invite: { inviteId: 'inv-abcd2345', state: 'open', level: message.level, origin: 'https://shop.example',
                session: session && { sessionId: session.sessionId, host: session.host, repo: session.repo },
                wake: { state: session && session.wake !== 'none' ? wake : 'none', error: wake === 'failed' ? { code: 'refused', message: 'held' } : null } } }];
            return state();
          }
          return state();
        },
      },
    };
  }, [sessions, wake, requests]);
  await page.goto(`https://popup.test/popup.html${search}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  return page;
}

test('popup: one live session is one tap; the level defaults to Use and the text goes along', async t => {
  const page = await popup(t, { sessions: [CLAUDE], wake: 'delivered' });
  await page.waitForSelector('#invite .invite-agent');
  assert.equal(await page.textContent('#invite .invite-agent'), 'Invite Claude Code · fai-browser');
  assert.equal(await page.getAttribute('.invite-level[aria-checked="true"]', 'data-level'), 'interactive', 'Use is interactive');
  await page.fill('#invite .invite-text', 'Compare the two plans');
  await page.click('#invite .invite-agent');
  await page.waitForSelector('#invite .invite-status');
  const sent = await page.evaluate(() => __sent.filter(message => message.type === 'invite'));
  assert.deepEqual(sent, [{ type: 'invite', sessionId: 'ses_1', level: 'interactive', text: 'Compare the two plans' }]);
  assert.match(await page.textContent('#invite .invite-line'), /^Sent to Claude Code · fai-browser\. It should start in a moment\.$/);
  assert.match(await page.textContent('#invite .invite-copy-text'), /^If it does not start, tell it: join FAI invite inv-abcd2345$/,
    'sent is not received: the copy line stays, softly');
});

test('popup: several sessions are a one-tap list; a level chip is remembered; a failed wake shows the copy line', async t => {
  const page = await popup(t, { sessions: [CLAUDE, CODEX], wake: 'failed' });
  await page.waitForSelector('#invite .invite-row');
  const rows = await page.$$eval('#invite .invite-row', nodes => nodes.map(node => node.textContent));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Claude Code · fai-browser/);
  assert.match(rows[1], /Codex · shop.*not ready/);
  await page.click('.invite-level[data-level="full"]');
  assert.equal(await page.evaluate(() => __local.inviteLevel), 'full');
  assert.equal(await page.$('.invite-level[data-level="testing"]'), null, 'Test site only on a listed test site');
  await page.click('#invite .invite-row >> nth=0');
  await page.waitForSelector('#invite .invite-copy');
  assert.equal(await page.textContent('#invite .invite-join'), 'join FAI invite inv-abcd2345');
  assert.match(await page.textContent('#invite .invite-line'), /Could not wake/);
  const sent = await page.evaluate(() => __sent.filter(message => message.type === 'invite'));
  assert.deepEqual(sent.map(message => [message.sessionId, message.level]), [['ses_1', 'full']]);
});

test('popup: no session still invites (copy line); the approval window never offers Invite', async t => {
  const page = await popup(t, { sessions: [] });
  await page.waitForSelector('#invite .invite-agent');
  assert.equal(await page.textContent('#invite .invite-agent'), 'Invite agent');
  await page.click('#invite .invite-agent');
  await page.waitForSelector('#invite .invite-copy');
  const windowed = await popup(t, { sessions: [CLAUDE], search: '?window=1' });
  await windowed.waitForTimeout(200);
  assert.equal(await windowed.$eval('#invite', node => node.hidden), true);
});

test('popup: an invite that would end another agent\'s task in this browser says so first and needs a second tap', async t => {
  const other = { requestId: 'req_other', state: 'active', origins: ['https://docs.example'], mode: 'read-only', reason: 'Docs',
    createdAt: new Date().toISOString(), lease: { tabId: 9 }, browser: { mine: true },
    owner: { sessionId: 'ses_2', host: 'codex', repo: 'shop' } };
  const page = await popup(t, { sessions: [CLAUDE], requests: [other], wake: 'delivered' });
  await page.waitForSelector('#invite .invite-supersede');
  assert.equal(await page.textContent('#invite .invite-supersede'), "This will end Codex · shop's current tab task.");
  await page.click('#invite .invite-agent');
  assert.equal(await page.textContent('#invite .invite-agent'), 'End that task and invite');
  assert.match(await page.textContent('#invite .invite-supersede'), /Tap again to invite anyway/);
  assert.deepEqual(await page.evaluate(() => __sent.filter(message => message.type === 'invite')), [], 'the first tap only warns');
  await page.click('#invite .invite-agent');
  await page.waitForFunction(() => __sent.some(message => message.type === 'invite'));
  // The same agent's own task is no conflict: it moves to the new tab with one tap.
  const own = await popup(t, { sessions: [CLAUDE], requests: [{ ...other, owner: { sessionId: 'ses_1', host: 'claude', repo: 'fai-browser' } }] });
  await own.waitForSelector('#invite .invite-agent');
  assert.equal(await own.$('#invite .invite-supersede'), null);
});

