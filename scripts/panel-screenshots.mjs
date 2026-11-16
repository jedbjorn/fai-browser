#!/usr/bin/env node
// The chat panel's design-review screenshot set (spec #84 "Appearance and quality", acceptance 13): every listed
// state, light and dark, narrow and wide, in headless Chromium against the fake service of
// test/helpers/chat-panel-fake.js. Writes <out>/<state>-<theme>-<width>.png and an index.html contact sheet.
//   node scripts/panel-screenshots.mjs --out shared/sprints/sprint-3/panel-screens
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { headlessEnv } from './headless-env.mjs';
import { installFakeChrome, panelPage, scenarios, showState } from '../test/helpers/chat-panel-fake.js';

const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } });
const out = resolve(values.out ?? 'dist/panel-screens');
// Chrome's side panel is at least 320 px wide; wide is where the drawer stays beside the conversation.
const WIDTHS = { narrow: 320, wide: 720 };
const THEMES = ['light', 'dark'];
const LABELS = {
  'first-open': 'First open, a provider available',
  'new-opencode': 'A new chat on OpenCode (long model names)',
  'no-provider': 'No provider available',
  'opencode-only': 'OpenCode only, choosing a model',
  running: 'A conversation with a running turn',
  'failed-turn': 'A failed turn (FAI line)',
  attachments: 'A message with attachments (and files in the composer)',
  'provider-failed': "A turn the program failed, with the program's own message",
  drawer: 'The drawer',
  settings: 'Settings',
  'delete-confirm': 'Delete confirmation',
  'open-agent': "An open agent (spec #80's view), working in this window",
  'approval-prompt': 'The approval prompt over a page with the panel open',
  'popup-chat': 'The popup\'s Chat button that opens the panel (the popup keeps today\'s look)',
};

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  env: headlessEnv(), args: ['--no-sandbox'] });
const shots = [];
const all = scenarios();
const wanted = values.only ? values.only.split(',') : [...Object.keys(all), 'approval-prompt', 'popup-chat'];
try {
  for (const name of wanted) {
    for (const theme of THEMES) {
      for (const [size, width] of Object.entries(WIDTHS)) {
        const file = `${name}-${theme}-${size}.png`;
        if (name === 'popup-chat') {
          if (theme !== 'light' || size !== 'narrow') continue;
          await popupChat(file);
        } else if (name === 'approval-prompt') await approvalPrompt(theme, size, width, file);
        else {
          const scenario = { ...all[name], settings: { defaultProvider: null, models: { codex: null, claude: null, opencode: null }, appearance: theme } };
          const page = await panelPage(browser, scenario, { width, height: 720, colorScheme: theme });
          await showState(page, scenario, { wide: size === 'wide' });
          await page.screenshot({ path: join(out, file) });
          await page.close();
        }
        shots.push({ name, theme, size, file });
        console.log(file);
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(join(out, 'index.html'), contactSheet(shots));
console.log(`${shots.length} screenshots and index.html in ${out}`);

// The page, the panel beside it (its own theme), and the existing approval window over the page (popup.html?window=1,
// which keeps today's look: restyling it is out of scope in spec #84).
async function approvalPrompt(theme, size, width, file) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, colorScheme: theme });
  const extension = new URL('../extension/', import.meta.url);
  await page.route('https://panel.test/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === 'review.html') return route.fulfill({ contentType: 'text/html', body: reviewPage(width) });
    const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.png') ? 'image/png' : 'text/html';
    const body = await readFile(new URL(path, extension)).catch(() => null);
    return body ? route.fulfill({ contentType: type, body }) : route.fulfill({ status: 404, body: '' });
  });
  const scenario = { ...all['open-agent'], settings: { appearance: theme, models: {} } };
  await page.addInitScript({ content: `(${installApprovalFake})(${JSON.stringify(scenario)}, ${installFakeChrome});` });
  await page.goto('https://panel.test/review.html');
  await page.frameLocator('#approval').locator('.request-card').first().waitFor();
  await page.frameLocator('#panel').locator('#messages li').first().waitFor();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, file) });
  await page.close();
}

async function popupChat(file) {
  const page = await browser.newPage({ viewport: { width: 364, height: 560 } });
  const extension = new URL('../extension/', import.meta.url);
  await page.route('https://panel.test/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.png') ? 'image/png' : 'text/html';
    const body = await readFile(new URL(path, extension)).catch(() => null);
    return body ? route.fulfill({ contentType: type, body }) : route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript({ content: `(${installApprovalFake})({}, null);` });
  await page.goto('https://panel.test/popup.html');
  await page.waitForSelector('#chat');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, file) });
  await page.close();
}

function reviewPage(panelWidth) {
  return `<!doctype html><html><head><style>
    body { margin: 0; display: flex; height: 100vh; font: 14px system-ui, sans-serif; background: #e7e7ea; }
    .site { position: relative; flex: 1; overflow: hidden; background: #fff; color: #222; }
    .site header { padding: 14px 24px; background: #1f4f8a; color: #fff; font-weight: 700; }
    .site main { padding: 24px; } .site .card { height: 90px; margin: 0 0 14px; border-radius: 10px; background: #eef1f6; }
    #panel { width: ${panelWidth}px; height: 100%; border: 0; border-left: 1px solid #b9b9c0; }
    #approval { position: absolute; top: 60px; right: 40px; width: 380px; height: 600px; border: 1px solid #9a9aa4;
      border-radius: 10px; box-shadow: 0 18px 50px #0006; background: #fff; }
  </style></head><body>
    <div class="site"><header>shop.example</header><main><h2>Your order #4471</h2><div class="card"></div><div class="card"></div><div class="card"></div></main>
      <iframe id="approval" title="FAI Browser approval window" src="popup.html?window=1"></iframe></div>
    <iframe id="panel" title="FAI chat panel" src="panel.html"></iframe>
  </body></html>`;
}

// The chat fake for the panel frame, plus a pending request for the approval window frame.
function installApprovalFake(scenario, installPanel) {
  if (location.pathname.endsWith('/panel.html')) return installPanel(scenario);
  if (!location.pathname.endsWith('/popup.html')) return;
  const requests = [{ requestId: 'r12', state: 'pending', origins: ['https://shop.example'], mode: 'read-only', level: 'read-only',
    reason: 'Check the order status', client: 'Claude Code · fai-browser', createdAt: new Date().toISOString(),
    owner: { sessionId: 'ses_1', host: 'claude', repo: 'fai-browser' }, url: 'https://shop.example/orders/4471' }];
  const local = { endpoint: 'http://127.0.0.1:4318', secret: 'x'.repeat(30) };
  const connection = { connected: true, transport: 'websocket', paired: true, native: null };
  globalThis.chrome = {
    storage: { local: { async get(keys) { return Object.fromEntries((keys ?? []).filter(k => k in local).map(k => [k, local[k]])); }, async set() {} },
      session: { async get() { return { requests, connection }; } }, onChanged: { addListener() {} } },
    tabs: { async query() { return [{ id: 7, windowId: 1, url: 'https://shop.example/orders/4471', title: 'Order #4471' }]; } },
    commands: { async getAll() { return [{ name: '_execute_action', shortcut: 'Ctrl+Shift+Y' }]; } },
    action: { async getUserSettings() { return { isOnToolbar: true }; } },
    permissions: { async request() { return true; }, async contains() { return false; }, async remove() { return true; } },
    runtime: { getManifest: () => ({ version: '0.11.0' }), getURL: path => `${location.origin}/${path}`,
      async sendMessage() { return { status: null, session: null, requests, connection }; } },
  };
}

function contactSheet(list) {
  const rows = Object.keys(LABELS).filter(name => list.some(shot => shot.name === name)).map(name => {
    const cells = list.filter(shot => shot.name === name)
      .map(shot => `<figure><a href="${shot.file}"><img src="${shot.file}" alt="${shot.name} ${shot.theme} ${shot.size}"></a><figcaption>${shot.theme} · ${shot.size}</figcaption></figure>`).join('');
    return `<section><h2>${LABELS[name]}</h2><div class="row">${cells}</div></section>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>FAI chat panel: design review</title><style>
    body { margin: 24px; font: 14px system-ui, sans-serif; background: #f2f0ec; color: #222; }
    .row { display: flex; gap: 14px; align-items: flex-start; overflow-x: auto; }
    figure { margin: 0; } img { max-height: 420px; border: 1px solid #ccc; } figcaption { color: #555; font-size: 12px; }
    h2 { margin: 28px 0 8px; font-size: 16px; }
  </style><h1>FAI chat panel: design review (spec #84 acceptance 13)</h1>
  <p>Every state in light and dark, narrow (320 px, Chrome's narrowest side panel) and wide (720 px, the drawer stays beside the conversation). Rendered in headless Chromium against a fake FAI service.</p>
  ${rows}`;
}
