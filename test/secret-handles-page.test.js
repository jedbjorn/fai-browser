// Secret handles in extension/page.js on real pages (headless Chromium): which fields take a secret (secretTarget),
// that page.js hands redacted values to the worker only when the worker asks (useSecrets vault), that fill_secret runs
// only with an approval bound to the field (kind, target, SHA-256 label hash) and never into a textarea, search box,
// comment or email field, and that a filled field reports its placeholder only: never in an observation, boxed on
// screenshots, and its echo on the page redacted. The worker's side is in test/extension-worker.test.js, the whole
// flow over MCP in test/secret-handles.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { loadFakes } from './helpers/secret-fakes.js';
import { startStaticSite } from './helpers/static-site.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const REVERSIBLE = ['navigate', 'controls'];
const F = loadFakes();

let browser;
let site;
test.before(async () => {
  site = await startStaticSite(new URL('../fixtures/secrets/', import.meta.url).pathname);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => {
  await browser?.close();
  await site?.close();
});

async function open(t, path, settings = { vault: true, salt: 'lease-salt' }) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  t.after(() => page.close());
  await page.goto(site.origin + path);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  await page.evaluate(value => globalThis.__faiPage.useSecrets(value), settings);
  return page;
}

const observe = page => page.evaluate(allow => globalThis.__faiPage.observe({ allow }), REVERSIBLE);
const byLabel = (observation, label) => observation.controls.find(control => control.label === label);
const call = (page, method, args) => page.evaluate(([m, a]) => Promise.resolve().then(() => globalThis.__faiPage[m](...a))
  .then(value => ({ value }), error => ({ code: error.code, message: error.message })), [method, args]);

function fill(page, target, revision, text, approval) {
  return call(page, 'execute', [{ type: 'fill_secret', target, text }, revision, { quietMs: 10, capMs: 80 }, [], [], REVERSIBLE,
    undefined, [], approval]);
}

test('vault: page.js hands the values it redacted to the worker only when asked, never a card or a URL parameter', async t => {
  const asked = await open(t, '/api-keys/');
  const observation = await observe(asked);
  const vault = observation.__faiVault;
  assert.ok(Array.isArray(vault) && vault.length > 0, 'the worker gets the values it will number');
  assert.ok(vault.some(entry => entry.value === F.openai && entry.kind === 'openai' && entry.origin === site.origin));
  assert.ok(vault.every(entry => !['card', 'url-param'].includes(entry.kind)));
  // Each tag is the one the placeholder carries.
  for (const entry of vault) assert.ok(JSON.stringify(observation).includes(`[secret:~${entry.tag}`), entry.kind);
  // Drained: the next call hands over only what it redacts itself.
  const again = await observe(asked);
  assert.ok(Array.isArray(again.__faiVault));
  // A bridge that does not ask (no worker) never receives values.
  const plain = await open(t, '/api-keys/', { salt: 'lease-salt' });
  assert.equal((await observe(plain)).__faiVault, undefined);
});

test('secretTarget: an API key text field and a password field take a secret; search, textarea, comment, email, contenteditable do not', async t => {
  const page = await open(t, '/deploy.html');
  const observation = await observe(page);
  assert.equal(byLabel(observation, 'API key').secretTarget, true);
  assert.equal(byLabel(observation, 'Database password').secretTarget, true);
  for (const label of ['Search projects', 'Notes', 'Comment', 'Contact email', 'Key description', 'Secret memo']) {
    const control = byLabel(observation, label);
    assert.ok(control, `${label}: ${observation.controls.map(c => c.label)}`);
    assert.equal(control.secretTarget, undefined, label);
  }
});

test('fill_secret: refused without an approval, with another field\'s or label\'s binding, and into a textarea or search box', async t => {
  const page = await open(t, '/deploy.html');
  const observation = await observe(page);
  const api = byLabel(observation, 'API key');
  const notes = byLabel(observation, 'Notes');
  const search = byLabel(observation, 'Search projects');
  assert.equal((await fill(page, api.id, observation.revision, F.openai, null)).code, 'blocked_risky');
  const info = (await call(page, 'approvalInfo', [api.id, observation.revision, 'fill_secret'])).value;
  assert.equal(info.cls, 'secret');
  assert.equal(info.label, 'API key');
  assert.match(info.labelHash, /^[0-9a-f]{32}$/, 'SHA-256, truncated');
  assert.equal(info.origin, site.origin);
  // The approval window never opens for a field that does not take a secret.
  for (const field of [notes, search]) {
    assert.equal((await call(page, 'approvalInfo', [field.id, observation.revision, 'fill_secret'])).code, 'blocked_risky', field.label);
  }
  const bound = { target: api.id, cls: 'secret', labelHash: info.labelHash, kind: 'fill_secret' };
  for (const approval of [{ ...bound, labelHash: 'f'.repeat(32) }, { ...bound, kind: undefined }, { ...bound, target: notes.id },
    { ...bound, cls: 'purchase' }]) {
    assert.equal((await fill(page, api.id, observation.revision, F.openai, approval)).code, 'blocked_risky', JSON.stringify(approval));
  }
  // An approval for the API key field used on the textarea: refused (the binding names the target and the field type).
  assert.equal((await fill(page, notes.id, observation.revision, F.openai, { ...bound, target: notes.id })).code, 'blocked_risky');
  assert.equal(await page.evaluate(() => document.getElementById('api').value), '', 'nothing was filled');
});

test('fill_secret approved: the field holds the value, reports only its placeholder, is boxed on screenshots and its echo is redacted', async t => {
  const page = await open(t, '/deploy.html');
  const observation = await observe(page);
  const api = byLabel(observation, 'API key');
  const info = (await call(page, 'approvalInfo', [api.id, observation.revision, 'fill_secret'])).value;
  const ran = await fill(page, api.id, observation.revision, F.openai, { target: api.id, cls: 'secret', labelHash: info.labelHash,
    kind: 'fill_secret' });
  assert.equal(ran.code, undefined, ran.message);
  assert.deepEqual(ran.value.fill, { kept: true, empty: false });
  assert.equal(await page.evaluate(() => document.getElementById('api').value), F.openai, 'the page got the value');
  assert.equal(await page.evaluate(() => document.getElementById('preview').textContent), F.openai, 'and echoed it');
  // Nothing page.js reports carries it: not the execute result, not the next observation, not a vault hand-over.
  assert.equal(JSON.stringify(ran).includes(F.openai), false);
  const after = await observe(page);
  const { __faiVault: handedOver, ...reported } = after;
  assert.equal(JSON.stringify(reported).includes(F.openai), false, 'the observation never shows the filled value');
  assert.ok(!(handedOver ?? []).some(entry => entry.value === F.openai), 'a value page.js filled itself is never vaulted again');
  const field = byLabel(after, 'API key');
  assert.equal(field.sensitive, true, 'a filled secret field is a secret field');
  assert.match(field.secretValue, /^\[secret:~[0-9a-z]+\]$/);
  assert.equal(field.secretTarget, undefined, 'never offered again');
  assert.match(reported.text, /Preview: \[secret:~[0-9a-z]+[^\]]*\]/, 'the echo is redacted');
  // Screenshot boxes: the field and the echo's holder.
  const rects = await page.evaluate(() => globalThis.__faiPage.redactionRects({ arm: false }));
  const box = await page.evaluate(() => {
    const r = document.getElementById('api').getBoundingClientRect();
    const p = document.getElementById('preview').getBoundingClientRect();
    return { api: { x: r.x, y: r.y }, preview: { x: p.x, y: p.y } };
  });
  const covers = (point, rect) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  assert.ok(rects.rects.some(rect => covers({ x: box.api.x + 2, y: box.api.y + 2 }, rect)), 'the field is boxed');
  assert.ok(rects.rects.some(rect => covers({ x: box.preview.x + 1, y: box.preview.y + 1 }, rect)), 'the echo is boxed');
});

test('a read-only field showing a new key: its placeholder is reported and its value vaulted, never offered', async t => {
  const page = await open(t, '/deploy.html');
  await page.evaluate(value => {
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = value;
    input.setAttribute('aria-label', 'Your new secret key');
    document.body.prepend(input);
  }, F.openai);
  await page.evaluate(() => globalThis.__faiPage.useSecrets({ vault: true, salt: 'lease-salt' }));
  const observation = await observe(page);
  const field = byLabel(observation, 'Your new secret key');
  assert.equal(field.sensitive, true);
  assert.match(field.secretValue, /^\[secret:~[0-9a-z]+ openai sk-proj-…Yz56 len 64\]$/);
  assert.ok(observation.__faiVault.some(entry => entry.value === F.openai));
  const { __faiVault: _vault, ...reported } = observation;
  assert.equal(JSON.stringify(reported).includes(F.openai), false);
});
