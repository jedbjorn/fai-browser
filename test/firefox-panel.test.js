// The chat panel in real, headless Firefox (spec #84 acceptance 12, spec #80 acceptance 5): the Firefox build installs
// with panel.html as its sidebar and the sidebar API, the panel loads from the add-on and says it is not connected
// without a service, and against the fake FAI service (test/helpers/chat-panel-fake.js) it opens a new chat, runs and
// ends a turn with Stop in place of Send, renders text only, shows an open agent with Browsing…, follows the system
// theme and the Appearance setting, and passes the same contrast, naming and keyboard checks as in Chromium.
//
// Skipped without a Firefox binary (FIREFOX_PATH, else `firefox` on PATH). Marionette drives only this throwaway
// browser and profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFirefox, GECKO_ID } from '../scripts/build-firefox.mjs';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { Marionette } from '../scripts/marionette.mjs';
import { CLAUDE_AGENT, CONVERSATION, fakeChromeSource, scenarios } from './helpers/chat-panel-fake.js';
import { contrastFailures, namedControls } from './helpers/panel-checks.js';

const ROOT = resolve(import.meta.dirname, '..');
const FIREFOX = process.env.FIREFOX_PATH || 'firefox';
const hasFirefox = spawnSync(FIREFOX, ['--version'], { stdio: 'ignore', env: headlessEnv() }).status === 0;
const skip = hasFirefox ? false : 'no Firefox binary (set FIREFOX_PATH)';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const SETTINGS = { defaultProvider: null, models: { codex: null, claude: null, opencode: null }, appearance: 'system' };

async function freePort() {
  const server = net.createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

let firefox;
let marionette;
let scratch;
let server;
let origin;
let uuid;
// The scenario the next panel.html load gets (the server injects the fake before the panel's own script).
let scenario = {};

test.before(async () => {
  if (skip) return;
  scratch = await mkdtemp(join(tmpdir(), 'fai-ff-panel-'));
  server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname.slice(1) || 'panel.html';
    const body = await readFile(join(ROOT, 'extension', path)).catch(() => null);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.png') ? 'image/png' : 'text/html';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    if (path !== 'panel.html') return res.end(body);
    res.end(String(body).replace('<script type="module"', `<script>${fakeChromeSource(scenario)}</script>\n  <script type="module"`));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;

  const addon = await buildFirefox({ root: ROOT, out: join(scratch, 'addon') });
  const profile = join(scratch, 'profile');
  const port = await freePort();
  await mkdir(profile, { recursive: true });
  const prefs = {
    'marionette.port': port, 'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage_override.mstone': 'ignore',
    'browser.startup.page': 0, 'browser.aboutwelcome.enabled': false, 'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false, 'app.update.disabledForTesting': true, 'extensions.autoDisableScopes': 0,
    'extensions.update.enabled': false, 'browser.tabs.warnOnClose': false, 'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false, 'browser.newtabpage.enabled': false,
    // Light unless a test asks for dark (0 dark, 1 light, 2 the system's).
    'layout.css.prefers-color-scheme.content-override': 1,
  };
  await writeFile(join(profile, 'user.js'),
    Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n'));
  const env = { ...headlessEnv(), HOME: join(scratch, 'home'), MOZ_HEADLESS: '1', MOZ_CRASHREPORTER_DISABLE: '1',
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', MOZ_HEADLESS_WIDTH: '360', MOZ_HEADLESS_HEIGHT: '720' };
  await mkdir(env.HOME, { recursive: true });
  firefox = spawn(FIREFOX, ['-headless', '-no-remote', '-profile', profile, '-marionette', 'about:blank'], { env, stdio: 'ignore' });
  marionette = await Marionette.connect(port, { timeoutMs: 60_000 });
  await marionette.newSession();
  await marionette.installAddon(addon, { temporary: true });
  await marionette.setContext('chrome');
  uuid = await marionette.execute(`return WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)})?.mozExtensionHostname ?? null;`);
  await marionette.setContext('content');
});

test.after(async () => {
  try { await marionette?.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch { /* gone */ }
  marionette?.close();
  if (firefox && firefox.exitCode === null) {
    await Promise.race([new Promise(done => firefox.once('exit', done)), sleep(5000)]);
    if (firefox.exitCode === null) firefox.kill('SIGKILL');
  }
  server?.closeAllConnections?.();
  await new Promise(done => (server ? server.close(() => done()) : done()));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const run = (body, args = []) => marionette.execute(body, args);
async function until(body, args = [], ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await run(body, args).catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${body}`);
    await sleep(100);
  }
}
async function panel(next, { dark = false } = {}) {
  scenario = { pollMs: 100, ...next };
  await marionette.setContext('chrome');
  await run(`Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', ${dark ? 0 : 1});`);
  await marionette.setContext('content');
  await marionette.navigate(`${origin}/panel.html`);
  await until(`return document.getElementById('title').textContent !== 'FAI Chat' || !document.getElementById('empty').hidden;`);
}
const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click();`);
const key = (key, selector = null) => run(`(${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'} ?? document)
  .dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));`);

test('the Firefox build: panel.html is the sidebar, the sidebar API is there, and the panel loads from the add-on', { skip }, async () => {
  await marionette.setContext('chrome');
  const manifest = await run(`const ext = WebExtensionPolicy.getByID(${JSON.stringify(GECKO_ID)}).extension;
    return { panel: ext.manifest.sidebar_action?.default_panel, side: ext.manifest.side_panel ?? null };`);
  await marionette.setContext('content');
  // Firefox resolves the sidebar's page to the add-on's own URL.
  assert.deepEqual(manifest, { panel: `moz-extension://${uuid}/panel.html`, side: null });
  await marionette.navigate(`moz-extension://${uuid}/panel.html`);
  // No FAI service in this test: the real worker answers, and the panel says how to connect.
  await until(`return document.getElementById('empty').textContent.includes('FAI is not connected');`);
  assert.equal(await run('return typeof browser.sidebarAction.open;'), 'function');
  assert.equal(await run('return document.getElementById(\'composer\').hidden;'), true);
});

test('Firefox: a new chat runs a turn, Stop replaces Send while it runs, and replies are text only', { skip }, async () => {
  await panel({ ...scenarios()['first-open'], settings: SETTINGS, reply: '<img src=x onerror="window.__pwned=1">32 GB', replyMs: 500 });
  assert.equal(await run('return document.activeElement.id;'), 'text');
  assert.equal(await run('return document.querySelector(\'[aria-label="Provider for this chat"]\').value;'), 'codex');
  await run(`const text = document.getElementById('text'); text.value = 'Which has more memory?';
    document.getElementById('composer').requestSubmit();`);
  await until(`return !document.getElementById('stop').hidden && document.getElementById('send').hidden
    && document.getElementById('text').disabled && !document.getElementById('browsing').hidden;`);
  await until('return !document.getElementById(\'send\').hidden && document.getElementById(\'browsing\').hidden;');
  const shown = await run('return [...document.querySelectorAll(\'#messages li\')].map(li => li.textContent);');
  assert.deepEqual(shown, ['Which has more memory?', 'Codex<img src=x onerror="window.__pwned=1">32 GB']);
  assert.equal(await run('return document.querySelectorAll(\'#messages img\').length;'), 0);
  assert.equal(await run('return window.__pwned ?? null;'), null);
  const [send] = await run('return globalThis.__sent.filter(message => message.type === \'chat_send\');');
  assert.deepEqual(send, { type: 'chat_send', provider: 'codex', model: null, text: 'Which has more memory?', files: [] });
});

test('Firefox: an open agent working in this window, with Browsing… and Sending… then Sent', { skip }, async () => {
  await panel({ ...scenarios()['open-agent'], settings: SETTINGS });
  await until('return document.getElementById(\'title\').textContent === \'Claude Code · fai-browser\';');
  await until('return !document.getElementById(\'browsing\').hidden && document.querySelectorAll(\'#messages li\').length === 3;');
  await run(`document.getElementById('text').value = 'go on'; document.getElementById('composer').requestSubmit();`);
  await until('return document.querySelector(\'[data-pending="sent"]\')?.textContent === \'go onSent\';');
  const sent = await run('return globalThis.__sent.filter(message => message.type === \'agent_send\').map(message => message.sessionId);');
  assert.deepEqual(sent, [CLAUDE_AGENT.sessionId]);
});

test('Firefox: the system theme by default, Appearance forces one; contrast, names and keyboard in both', { skip }, async () => {
  const background = () => run('return getComputedStyle(document.body).backgroundColor;');
  await panel({ ...scenarios()['first-open'], settings: SETTINGS }, { dark: true });
  assert.equal(await background(), 'rgb(27, 25, 22)');
  await panel({ ...scenarios()['first-open'], settings: { ...SETTINGS, appearance: 'light' } }, { dark: true });
  assert.equal(await background(), 'rgb(244, 240, 232)');
  for (const theme of ['light', 'dark']) {
    for (const name of ['first-open', 'open-agent', 'drawer', 'settings']) {
      const next = { ...scenarios()[name], settings: { ...SETTINGS, appearance: theme }, transcripts: { chat_a: CONVERSATION } };
      await panel(next, { dark: theme === 'dark' });
      if (next.agentReads) await until('return document.querySelectorAll(\'#messages li\').length > 0;');
      if (name === 'drawer' || name === 'settings') await click('#drawer-toggle');
      if (name === 'settings') {
        await click('#open-settings');
        await until('return document.activeElement?.id === \'settings-title\' && !document.getElementById(\'settings-body\').textContent.includes(\'Reading\');');
      }
      assert.deepEqual(await run(`return (${contrastFailures})();`), [], `contrast: ${name} ${theme}`);
      assert.deepEqual((await run(`return (${namedControls})();`)).filter(control => !control.name), [], `names: ${name} ${theme}`);
      assert.ok(await run('return document.documentElement.scrollWidth <= document.documentElement.clientWidth;'), `width: ${name} ${theme}`);
    }
  }
  // The drawer takes focus when it opens and Escape gives it back; settings likewise.
  await panel({ ...scenarios()['first-open'], settings: SETTINGS });
  await click('#drawer-toggle');
  assert.equal(await run('return document.activeElement.id;'), 'new-chat');
  await key('Escape');
  await until('return document.getElementById(\'drawer\').hidden && document.activeElement.id === \'drawer-toggle\';');
  await click('#drawer-toggle');
  await click('#open-settings');
  await until('return document.activeElement?.id === \'settings-title\';');
  await key('Escape');
  await until('return document.getElementById(\'settings\').hidden && document.activeElement.id === \'text\';');
});
