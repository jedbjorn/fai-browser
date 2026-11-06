// The Approve gate in extension/page.js on real pages (headless Chromium): the page rules on several distinct,
// site-neutral markups (a checkout path, an order summary total, a payment field, a commit dialog, credential actions
// and an eye toggle), and the dispatch-time recheck: a gated control runs only with an approval whose target, class
// and label hash match what the page script reads itself; the worker's settings can turn the credential ask off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const FULL = ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'];
const REVERSIBLE = ['navigate', 'controls'];
const TESTING = [...FULL, 'sign_in', 'purchase'];

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => browser?.close());

const doc = body => `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>${body}
<script>window.clicked = []; document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) clicked.push(b.textContent.trim() || b.getAttribute('aria-label')); }, true);</script></body></html>`;

async function load(t, path, body) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  t.after(() => page.close());
  await page.route('https://shop.test/**', route => route.fulfill({ contentType: 'text/html', body: doc(body) }));
  await page.goto(`https://shop.test${path}`);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = (page, allow = FULL) => page.evaluate(a => globalThis.__faiPage.observe({ allow: a }), allow);
const byLabel = (observation, label) => observation.controls.find(control => control.label === label);

function execute(page, target, revision, { allow = FULL, approval = null } = {}) {
  return page.evaluate(([t, r, a, ap]) => globalThis.__faiPage.execute({ type: 'click', target: t }, r, { quietMs: 10, capMs: 50 },
    [], [], a, undefined, [], ap).then(() => ({ ok: true }), error => ({ code: error.code, message: error.message })), [target, revision, allow, approval]);
}

test('purchase page by path: commit-like buttons are purchases; other buttons, steppers, back-outs and links are not', async t => {
  const page = await load(t, '/shop/checkout', `<h1>Checkout</h1><button>Apply coupon</button><button>Place order</button>
    <button aria-label="Increase quantity">+</button><button>Back</button><a href="/help">Help</a>`);
  const observation = await observe(page);
  assert.notEqual(byLabel(observation, 'Apply coupon').risk, 'purchase', 'not commit-like, no checkout region');
  assert.equal(byLabel(observation, 'Apply coupon').gate, undefined);
  assert.equal(byLabel(observation, 'Place order').risk, 'purchase');
  assert.notEqual(byLabel(observation, 'Increase quantity').risk, 'purchase');
  assert.notEqual(byLabel(observation, 'Back').risk, 'purchase');
  assert.equal(byLabel(observation, 'Help').risk, 'navigation');
});

test('purchase page narrowed: the payment form and a checkout-named region are purchases; nav, search, saves and publishes are not', async t => {
  // A payment field makes the page a purchase page; only its own form (and commit-like labels) count.
  const form = await load(t, '/account/settings', `<nav><button>Search</button><button>Next</button></nav>
    <form role="search"><input type="search" name="q"><button>Submit</button></form>
    <form id="pay"><label>Card number <input autocomplete="cc-number"></label><button type="button">Apply</button></form>
    <form id="profile"><label>Name <input name="display"></label><button type="button">Save</button><button type="button">Publish</button></form>`);
  const first = await observe(form);
  assert.equal(byLabel(first, 'Apply').risk, 'purchase', 'inside the payment form');
  assert.equal(byLabel(first, 'Apply').region, 'checkout');
  for (const label of ['Save', 'Publish']) assert.notEqual(byLabel(first, label).risk, 'purchase', label);
  assert.notEqual(byLabel(first, 'Search').risk, 'purchase', 'navigation stays');
  assert.notEqual(byLabel(first, 'Next').risk, 'purchase', 'a commit-like label in navigation stays');
  assert.notEqual(byLabel(first, 'Submit').risk, 'purchase', 'a search form stays');
  assert.equal(byLabel(first, 'Next').region, 'navigation');
  // A container named checkout (class words), on a purchase path given as a file stem.
  const region = await load(t, '/store/billing.html', `<section class="checkoutPanel"><button>Gift options</button></section>
    <aside><button>Share cart</button><button>Continue</button></aside>`);
  const second = await observe(region);
  assert.equal(byLabel(second, 'Gift options').risk, 'purchase', 'inside a region named checkout');
  assert.notEqual(byLabel(second, 'Share cart').risk, 'purchase');
  assert.equal(byLabel(second, 'Continue').risk, 'purchase', 'commit-like');
  // Not a purchase page: nothing changes.
  const plain = await load(t, '/blog/orders-of-magnitude', `<button>Continue</button>`);
  assert.notEqual(byLabel(await observe(plain), 'Continue').risk, 'purchase');
});

test('purchase page by an order summary total, and by a payment field', async t => {
  const summary = await load(t, '/basket', `<h2>Order summary</h2><p>Items (2)</p><p>€19,90</p><button>Continue</button>`);
  assert.equal(byLabel(await observe(summary), 'Continue').risk, 'purchase');
  const field = await load(t, '/donate', `<label>Card number <input autocomplete="cc-number"></label><button>Next</button>`);
  assert.equal(byLabel(await observe(field), 'Next').risk, 'purchase');
  const plain = await load(t, '/orders', `<p>Order 112-1, total $41.99.</p><button>Track package</button>`);
  assert.equal(byLabel(await observe(plain), 'Track package').risk, 'reversible', 'an order history line is no summary');
});

test('commit dialog: its committing button is a delete, its back-out is not; a picker dialog is untouched', async t => {
  const page = await load(t, '/settings', `<div role="alertdialog" aria-modal="true"><p>Are you sure? This cannot be undone.</p>
    <button>Yes</button><button>Cancel</button></div><div role="dialog"><p>Pick a date</p><button>Done</button></div>`);
  const observation = await observe(page, REVERSIBLE);
  assert.equal(byLabel(observation, 'Yes').risk, 'delete');
  assert.equal(byLabel(observation, 'Yes').gate, 'delete');
  assert.equal(byLabel(observation, 'Cancel').risk, 'reversible');
  assert.equal(byLabel(observation, 'Done').risk, 'reversible');
  // Below full the delete is refused without an approval, and runs with one for exactly that click.
  const yes = byLabel(observation, 'Yes');
  assert.equal((await execute(page, yes.id, observation.revision, { allow: REVERSIBLE })).code, 'blocked_risky');
  const info = await page.evaluate(([t, r]) => globalThis.__faiPage.approvalInfo(t, r), [yes.id, observation.revision]);
  assert.equal(info.cls, 'delete');
  assert.equal(info.label, 'Yes');
  const ran = await execute(page, yes.id, observation.revision, { allow: REVERSIBLE,
    approval: { target: yes.id, cls: 'delete', labelHash: info.labelHash } });
  assert.deepEqual(ran, { ok: true });
  assert.deepEqual(await page.evaluate(() => window.clicked), ['Yes']);
});

test('credential actions and an eye toggle ask at every level; only a matching approval runs them', async t => {
  const page = await load(t, '/settings/keys', `<button>Create API key</button><button>Refresh</button>
    <div class="field"><input type="password" value="x"><button class="eye-toggle" aria-label="Show">👁</button></div>`);
  const observation = await observe(page, TESTING);
  const create = byLabel(observation, 'Create API key');
  const eye = observation.controls.find(control => control.gate === 'secret' && control.id !== create.id);
  assert.equal(create.gate, 'secret');
  assert.ok(eye, JSON.stringify(observation.controls));
  assert.equal(byLabel(observation, 'Refresh').gate, undefined);
  // Even at testing, no approval: refused.
  assert.equal((await execute(page, create.id, observation.revision, { allow: TESTING })).code, 'blocked_risky');
  const info = await page.evaluate(([t, r]) => globalThis.__faiPage.approvalInfo(t, r), [create.id, observation.revision]);
  assert.equal(info.cls, 'secret');
  // A wrong label hash, another class or another target: refused.
  for (const approval of [{ target: create.id, cls: 'secret', labelHash: 'deadbeef' }, { target: create.id, cls: 'purchase', labelHash: info.labelHash },
    { target: eye.id, cls: 'secret', labelHash: info.labelHash }]) {
    assert.equal((await execute(page, create.id, observation.revision, { allow: TESTING, approval })).code, 'blocked_risky', JSON.stringify(approval));
  }
  assert.deepEqual(await execute(page, create.id, observation.revision, { allow: TESTING,
    approval: { target: create.id, cls: 'secret', labelHash: info.labelHash } }), { ok: true });
  // The user turned the credential ask off: it runs at its level.
  await page.evaluate(() => globalThis.__faiPage.useGates({ purchase: true, secret: false, level: true }));
  const next = await observe(page, FULL);
  assert.deepEqual(await execute(page, byLabel(next, 'Refresh').id, next.revision), { ok: true });
  const again = await observe(page, FULL);
  assert.deepEqual(await execute(page, byLabel(again, 'Create API key').id, again.revision), { ok: true });
});

test('a purchase runs at full only with an approval; never a payment field, never at a forbidden label', async t => {
  const page = await load(t, '/checkout', `<label>Card number <input autocomplete="cc-number"></label><button>Pay now</button>
    <button>Gift wrap</button>`);
  const observation = await page.evaluate(a => globalThis.__faiPage.observe({ allow: a, forbid: ['Gift wrap'] }), FULL);
  const pay = byLabel(observation, 'Pay now');
  assert.equal((await execute(page, pay.id, observation.revision)).code, 'blocked_risky');
  const info = await page.evaluate(([t, r]) => globalThis.__faiPage.approvalInfo(t, r), [pay.id, observation.revision]);
  assert.equal(info.cls, 'purchase');
  assert.deepEqual(await execute(page, pay.id, observation.revision, { approval: { target: pay.id, cls: 'purchase', labelHash: info.labelHash } }), { ok: true });
  const next = await page.evaluate(a => globalThis.__faiPage.observe({ allow: a, forbid: ['Gift wrap'] }), FULL);
  const gift = byLabel(next, 'Gift wrap');
  const giftInfo = await page.evaluate(([t, r]) => globalThis.__faiPage.approvalInfo(t, r), [gift.id, next.revision]);
  assert.equal(giftInfo.cls, null, 'a forbidden label has no gate class');
  const field = next.controls.find(control => control.autocomplete === 'cc-number');
  assert.equal((await execute(page, field.id, next.revision, { approval: { target: field.id, cls: 'purchase', labelHash: 'x' } })).code, 'blocked_risky');
});

test('the approval card receives the complete displayed total, not just its first digit', async t => {
  for (const amount of ['$142.80', '€1.234,56', 'GBP 119.00', '142.80 USD']) {
    const page = await load(t, '/checkout', `<p>Total ${amount}</p><button>Pay now</button>`);
    const observation = await observe(page);
    const pay = byLabel(observation, 'Pay now');
    const info = await page.evaluate(([target, revision]) => globalThis.__faiPage.approvalInfo(target, revision),
      [pay.id, observation.revision]);
    assert.equal(info.total, `Total ${amount}`);
    await page.close();
  }
});

test('label hash: page.js SHA-256 matches node:crypto (block boundaries, Unicode), and approvals work on a plain-http page', async t => {
  const source = await readFile(PAGE_SCRIPT, 'utf8');
  const body = source.match(/\n {2}function sha256Hex\(text\) \{[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(body, 'page.js defines sha256Hex');
  // eslint-disable-next-line no-new-func
  const sha256Hex = new Function(`${body}\nreturn sha256Hex;`)();
  for (const text of ['', 'abc', 'Pay now', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Zahlen 💳 jetzt — ü']) {
    assert.equal(sha256Hex(text), createHash('sha256').update(text, 'utf8').digest('hex'), JSON.stringify(text.slice(0, 20)));
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  t.after(() => page.close());
  await page.route('http://plain.test/**', route => route.fulfill({ contentType: 'text/html', body: doc('<button>Create API key</button>') }));
  await page.goto('http://plain.test/settings');
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const observation = await observe(page, FULL);
  const create = byLabel(observation, 'Create API key');
  const info = await page.evaluate(([t, r]) => globalThis.__faiPage.approvalInfo(t, r), [create.id, observation.revision]);
  assert.equal(info.labelHash, createHash('sha256').update('Create API key').digest('hex').slice(0, 32));
  assert.deepEqual(await execute(page, create.id, observation.revision, { approval: { target: create.id, cls: 'secret', labelHash: info.labelHash } }),
    { ok: true });
});
