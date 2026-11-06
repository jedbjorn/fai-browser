// Host-composed acts on a real page in headless Chromium with extension/input.js and extension/page.js injected, as
// the extension injects both: keys (Escape, Tab, Shift+Tab, PageDown, Space on a cleared control only, a Ctrl
// shortcut only at full), hover (a menu that opens on mouseover, also over a Delete button), and typed text (the
// agent's own) refused in a password field at every level; the Test-site dev hook (extension/devhook.js in the page
// world, extension/devlog.js beside page.js): console errors, uncaught errors, failed fetch and XHR without bodies or
// query strings, and confirm/prompt answered at once (dismissed, or the armed answer). CHROMIUM_PATH overrides the
// browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const INPUT_SOURCE = readFileSync(new URL('../extension/input.js', import.meta.url), 'utf8');
const DEVHOOK = new URL('../extension/devhook.js', import.meta.url).pathname;
const DEVLOG = new URL('../extension/devlog.js', import.meta.url).pathname;
const ORIGIN = 'https://example.com';
const REVERSIBLE = ['navigate', 'controls'];
const FULL = ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Keys</title>
<style>body{font:14px sans-serif}#menu{display:none}#menu.open{display:block}.tall{height:3000px}</style></head><body>
<p id="status">idle</p>
<label>Name <input id="name"></label>
<label>Email <input id="email"></label>
<label>Password <input id="pw" type="password"></label>
<button id="toggle" onclick="document.getElementById('status').textContent='toggled'">Toggle panel</button>
<button id="del" onclick="document.getElementById('status').textContent='deleted'">Delete account</button>
<div id="nav"><button id="menubtn">Menu</button><div id="menu"><a href="/settings">Settings</a></div></div>
<div id="modal" role="dialog">Modal open</div>
<div class="tall"></div>
<script>
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('modal').remove();
    if (e.key === 'a' && e.ctrlKey) document.getElementById('status').textContent = 'select-all';
  });
  document.getElementById('menubtn').addEventListener('mouseover', () => document.getElementById('menu').classList.add('open'));
  document.getElementById('del').addEventListener('mouseover', () => { document.getElementById('del').title = 'hovered'; });
</script></body></html>`;

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function load(t) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  t.after(() => context.close());
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: INPUT_SOURCE });
  // No think time or travel in tests.
  await page.evaluate(() => globalThis.__faiInput.configure({ think: [0, 0] }));
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = (page, allow = REVERSIBLE) => page.evaluate(o => __faiPage.observe(o), { terms: [], forbid: [], allow, expectText: [] });
const execute = (page, action, revision, allow = REVERSIBLE) => page.evaluate(
  ([a, r, al]) => __faiPage.execute(a, r, { quietMs: 0, capMs: 100 }, null, [], al, undefined, []).then(
    value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
  [action, revision, allow],
);
const byLabel = (observation, label) => observation.controls.find(control => control.label === label);
const text = (page, id) => page.evaluate(id => document.getElementById(id)?.textContent ?? null, id);
const active = page => page.evaluate(() => document.activeElement?.id ?? null);

test('keys: Escape reaches the page, Tab and Shift+Tab move focus, PageDown scrolls, a Ctrl shortcut needs full', async t => {
  const page = await load(t);
  let observation = await observe(page);
  const escape = await execute(page, { type: 'press', key: 'Escape' }, observation.revision);
  assert.equal(escape.error, undefined, JSON.stringify(escape.error));
  assert.equal(await text(page, 'modal'), null, 'the page handled Escape');

  observation = await observe(page);
  const name = byLabel(observation, 'Name');
  assert.ok(name, 'the Name field is observed');
  const tab = await execute(page, { type: 'press', key: 'Tab', target: name.id }, observation.revision);
  assert.equal(tab.error, undefined, JSON.stringify(tab.error));
  assert.equal(await active(page), 'email', 'Tab from Name lands on Email');
  observation = await observe(page);
  const back = await execute(page, { type: 'press', key: 'Shift+Tab' }, observation.revision);
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal(await active(page), 'name', 'Shift+Tab goes back to Name');

  await page.evaluate(() => document.activeElement.blur());
  observation = await observe(page);
  const down = await execute(page, { type: 'press', key: 'PageDown' }, observation.revision);
  assert.equal(down.error, undefined, JSON.stringify(down.error));
  assert.ok(await page.evaluate(() => window.scrollY) > 100, 'PageDown scrolled the page');

  observation = await observe(page);
  const shortcut = await execute(page, { type: 'press', key: 'Ctrl+A' }, observation.revision);
  assert.equal(shortcut.error?.code, 'blocked_risky', 'a shortcut is refused below full');
  assert.equal(await text(page, 'status'), 'idle');
  observation = await observe(page, FULL);
  const allowed = await execute(page, { type: 'press', key: 'Ctrl+A' }, observation.revision, FULL);
  assert.equal(allowed.error, undefined, JSON.stringify(allowed.error));
  assert.equal(await text(page, 'status'), 'select-all');

  const readOnly = await execute(page, { type: 'press', key: 'Escape' }, (await observe(page, ['navigate'])).revision, ['navigate']);
  assert.equal(readOnly.error?.code, 'blocked_risky', 'no key at read-only');
});

test('Space activates a cleared button only: never a Delete button below full', async t => {
  const page = await load(t);
  let observation = await observe(page);
  const toggle = byLabel(observation, 'Toggle panel');
  const pressed = await execute(page, { type: 'press', key: 'Space', target: toggle.id }, observation.revision);
  assert.equal(pressed.error, undefined, JSON.stringify(pressed.error));
  assert.equal(await text(page, 'status'), 'toggled');
  observation = await observe(page);
  const del = byLabel(observation, 'Delete account');
  const refused = await execute(page, { type: 'press', key: 'Space', target: del.id }, observation.revision);
  assert.equal(refused.error?.code, 'blocked_risky');
  assert.equal(await text(page, 'status'), 'toggled', 'the Delete button never ran');
});

test('hover opens a menu that opens on mouseover; hovering a Delete button never clicks it', async t => {
  const page = await load(t);
  let observation = await observe(page);
  const menu = byLabel(observation, 'Menu');
  const hovered = await execute(page, { type: 'hover', target: menu.id }, observation.revision);
  assert.equal(hovered.error, undefined, JSON.stringify(hovered.error));
  observation = await observe(page);
  assert.ok(byLabel(observation, 'Settings'), 'the menu item is observed after the hover');
  const del = byLabel(observation, 'Delete account');
  const over = await execute(page, { type: 'hover', target: del.id }, observation.revision);
  assert.equal(over.error, undefined, JSON.stringify(over.error));
  assert.equal(await page.evaluate(() => document.getElementById('del').title), 'hovered');
  assert.equal(await text(page, 'status'), 'idle', 'a hover never clicks');
});

test('typed text fills an ordinary field and is refused in a password field at every level', async t => {
  const page = await load(t);
  let observation = await observe(page, FULL);
  const name = byLabel(observation, 'Name');
  const filled = await execute(page, { type: 'fill_supplied_text', target: name.id, text: 'Ada', typed: true }, observation.revision, FULL);
  assert.equal(filled.error, undefined, JSON.stringify(filled.error));
  assert.equal(await page.evaluate(() => document.getElementById('name').value), 'Ada');
  observation = await observe(page, [...FULL, 'sign_in']);
  const pw = observation.controls.find(control => control.type === 'password');
  const refused = await execute(page, { type: 'fill_supplied_text', target: pw.id, text: 'hunter22', typed: true },
    observation.revision, [...FULL, 'sign_in']);
  assert.equal(refused.error?.code, 'blocked_risky', JSON.stringify(refused));
  assert.equal(await page.evaluate(() => document.getElementById('pw').value), '');
});

test('dev hook: console errors, uncaught errors and failed requests are drained once; confirm is dismissed unless armed', async t => {
  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(() => context.close());
  await page.route(`${ORIGIN}/**`, route => {
    const url = route.request().url();
    if (url.includes('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"secret":"body"}' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Dev</title><p>dev</p>' });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ path: DEVLOG });
  await page.addScriptTag({ path: DEVHOOK });
  await page.evaluate(async () => {
    console.error('Boom', { code: 7 });
    console.warn('Careful');
    setTimeout(() => { throw new Error('Uncaught one'); }, 0);
    await fetch('/api/items?token=abc123', { method: 'post', body: 'payload' });
    await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/other?q=1');
      xhr.onloadend = resolve;
      xhr.send();
    });
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  const first = await page.evaluate(() => globalThis.__faiDevLog.drain());
  const kinds = first.logs.map(entry => entry.kind);
  assert.deepEqual(kinds.sort(), ['error', 'exception', 'network', 'network', 'warning'].sort(), JSON.stringify(first.logs));
  const fetched = first.logs.find(entry => entry.method === 'POST');
  assert.deepEqual({ ...fetched, text: undefined }, { kind: 'network', method: 'POST', url: `${ORIGIN}/api/items?…`, status: 404, text: undefined });
  assert.ok(!JSON.stringify(first).includes('abc123'), 'no query string');
  assert.ok(!JSON.stringify(first).includes('payload') && !JSON.stringify(first).includes('"secret"'), 'no bodies');
  assert.match(first.logs.find(entry => entry.kind === 'error').text, /Boom \{"code":7\}/);
  assert.deepEqual((await page.evaluate(() => globalThis.__faiDevLog.drain())).logs, [], 'drained once');

  const dismissed = await page.evaluate(() => confirm('Delete it?'));
  assert.equal(dismissed, false, 'an unarmed confirm is dismissed at once (never blocks)');
  assert.deepEqual(await page.evaluate(() => globalThis.__faiDevLog.takeDialog()), { kind: 'confirm', text: 'Delete it?', answered: 'dismiss' });
  assert.equal(await page.evaluate(() => globalThis.__faiDevLog.takeDialog()), null, 'reported once');
  await page.evaluate(() => globalThis.__faiDevLog.arm('accept', 'Ada'));
  assert.equal(await page.evaluate(() => prompt('Name?', 'x')), 'Ada', 'the armed answer and text');
  assert.equal(await page.evaluate(() => confirm('Again?')), false, 'an armed answer is used once');
});

test('upload: a file input (a styled picker behind its label) is offered at Act only, and takes the file only with the user\'s approval', async t => {
  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(() => context.close());
  const html = `<!doctype html><title>Upload</title><form><label for="f" style="display:inline-block;padding:8px">Choose avatar</label>
    <input id="f" type="file" style="display:none"><p id="got">none</p></form>
    <script>document.getElementById('f').addEventListener('change', async e => {
      const file = e.target.files[0]; document.getElementById('got').textContent = file.name + ':' + file.size + ':' + file.type + ':' + await file.text();
    });</script>`;
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const interactive = await observe(page, ['navigate', 'controls', 'submit_safe']);
  assert.equal(interactive.controls.find(control => control.type === 'file'), undefined, 'no file input below Act');
  let observation = await observe(page, FULL);
  const input = observation.controls.find(control => control.type === 'file');
  assert.ok(input, JSON.stringify(observation.controls));
  const file = { name: 'a.txt', size: 5, type: 'text/plain', data: Buffer.from('hello').toString('base64') };
  const refused = await execute(page, { type: 'upload', target: input.id, file }, observation.revision, FULL);
  assert.equal(refused.error?.code, 'blocked_risky', 'never without an approval');
  const info = await page.evaluate(([t, r]) => __faiPage.approvalInfo(t, r, 'upload'), [input.id, observation.revision]);
  assert.equal(info.cls, 'submit');
  const labelHash = createHash('sha256').update(String(info.label)).digest('hex').slice(0, 32);
  assert.equal(info.labelHash, labelHash);
  observation = await observe(page, FULL);
  const approval = { target: input.id, cls: 'submit', labelHash, kind: 'upload' };
  const done = await page.evaluate(([a, r, al, ap]) => __faiPage.execute(a, r, { quietMs: 0, capMs: 100 }, null, [], al, undefined, [], ap)
    .then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
  [{ type: 'upload', target: input.id, file }, observation.revision, FULL, approval]);
  assert.equal(done.error, undefined, JSON.stringify(done.error));
  assert.equal(await page.evaluate(() => document.getElementById('got').textContent), 'a.txt:5:text/plain:hello');
});
