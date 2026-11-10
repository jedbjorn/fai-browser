// Blocking overlays (src/overlay.js, the runtime's Rung 0 dismissal, extension/page.js detectOverlay): the plan's
// order and guards, the runtime's limits (each step once per overlay, overlay:persistent after the third return,
// overlay:undismissable, overlay:user_opened, the dismiss step class at read-only), and page-script cases the pattern
// corpus does not cover (an app shell is not an overlay, a "Close and sign in" button is no close control, Escape is
// refused on a task dialog). The corpus itself is test/patterns.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { actionClass } from '../src/runtime.js';
import { overlayDismissActions, overlayKey, overlayOf } from '../src/overlay.js';
import { leanObserve } from '../src/result.js';
import { headlessEnv } from '../scripts/headless-env.mjs';

const ORIGIN = 'https://shop.test';
const NAG = { kind: 'newsletter', nag: true, text: 'Get 10% off. Join our newsletter.', closers: [{ id: '3', label: 'Close' }], escape: true, backdrop: true };
const main = [{ id: '1', role: 'link', label: 'Garden', href: `${ORIGIN}/garden`, enabled: true, risk: 'navigation' }];
const closeControl = { id: '3', role: 'button', label: 'Close', enabled: true, risk: 'reversible', dismiss: true, overlay: true };

test('overlayOf: only a known nag kind is a nag, whatever the flag; malformed overlays are none', () => {
  assert.equal(overlayOf({}), null);
  assert.equal(overlayOf({ overlay: { kind: 'banner' } }), null);
  assert.equal(overlayOf({ overlay: { ...NAG, kind: 'task' } }).nag, false);
  assert.equal(overlayOf({ overlay: { ...NAG, kind: 'age_gate' } }).nag, false);
  assert.equal(overlayOf({ overlay: NAG }).nag, true);
  assert.equal(overlayKey(overlayOf({ overlay: NAG })), 'newsletter:get 10% off. join our newsletter.');
});

test('overlayDismissActions: close controls the page script marked, then Escape, then the backdrop, each with a key', () => {
  const observation = { controls: [...main, closeControl], overlay: NAG };
  const actions = overlayDismissActions(overlayOf(observation), observation);
  assert.deepEqual(actions.map(action => action.key), ['close:close', 'escape', 'backdrop']);
  assert.ok(actions.every(action => action.overlayDismiss && actionClass(action) === 'dismiss'));
  // A closer that is not an offered dismiss control, or has a risky class, is not clicked.
  for (const control of [{ ...closeControl, dismiss: false }, { ...closeControl, risk: 'sign_in' }, { ...closeControl, enabled: false }]) {
    const keys = overlayDismissActions(overlayOf(observation), { controls: [control] }).map(action => action.key);
    assert.deepEqual(keys, ['escape', 'backdrop']);
  }
  assert.deepEqual(overlayDismissActions(overlayOf({ overlay: { ...NAG, kind: 'task' } }), observation), []);
});

test('leanObserve lists the overlay kind and its untrusted text; an unknown kind is dropped', () => {
  const page = { url: `${ORIGIN}/`, title: 'Shop', overlay: { ...NAG, text: '  Get 10% off.\n Join  ' } };
  assert.deepEqual(leanObserve({ page, actions: [] }).overlay, { kind: 'newsletter', text: 'Get 10% off. Join' });
  assert.equal(leanObserve({ page: { ...page, overlay: { kind: 'banner' } }, actions: [] }).overlay, undefined);
});

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); });

async function observe(t, html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  return { page, observation: await page.evaluate(() => __faiPage.observe({ allow: ['navigate'] })) };
}

test('page.js: an app shell fixed to the viewport is the page, not an overlay, even with sign-in words', async t => {
  const items = Array.from({ length: 40 }, (_, i) => `<li>Message ${i}: project update and notes for the week</li>`).join('');
  const { observation } = await observe(t, `<!doctype html><title>Mail</title><div style="position:fixed;inset:0;overflow:auto">
<header><a href="/account">Sign in</a> <button>Close</button></header><h1>Inbox</h1><ul>${items}</ul></div>`);
  assert.equal(observation.overlay, undefined, JSON.stringify(observation.overlay));
});

test('page.js: "Close and sign in" and "Subscribe" are never close controls; a nag without one still offers Escape', async t => {
  const { observation } = await observe(t, `<!doctype html><title>News</title><main><h1>Headlines</h1><p>Story one.</p></main>
<div role="dialog" aria-modal="true" style="position:fixed;top:30%;left:30%;width:40%;background:#fff">
<h2>Join our newsletter</h2><button>Close and sign in</button><button>Subscribe</button></div>`);
  assert.equal(observation.overlay.kind, 'newsletter');
  assert.deepEqual(observation.overlay.closers, []);
  assert.equal(observation.overlay.escape, true);
});

test('page.js: Escape is refused on a task dialog, and a nag\'s Escape closes a native modal dialog at read-only', async t => {
  const task = await observe(t, `<!doctype html><title>Account</title><main><h1>Account</h1></main>
<div role="dialog" aria-modal="true" style="position:fixed;top:20%;left:20%;width:60%;background:#fff">
<h2>Are you sure you want to delete this list?</h2><button>Cancel</button><button>Delete</button></div>`);
  assert.equal(task.observation.overlay.kind, 'task');
  const refused = await task.page.evaluate(rev => __faiPage.execute({ type: 'dismiss_overlay', method: 'escape' }, rev,
    { quietMs: 20, capMs: 200 }, null, [], ['navigate']).then(() => 'ran', error => error.code), task.observation.revision);
  assert.equal(refused, 'unsupported');
  const nag = await observe(t, `<!doctype html><title>Recipes</title><main><h1>Recipes</h1></main>
<dialog id="d"><h2>Create a free account</h2><p>Sign up to save recipes.</p><button>Sign up</button></dialog>
<script>document.getElementById('d').showModal()</script>`);
  const after = await nag.page.evaluate(rev => __faiPage.execute({ type: 'dismiss_overlay', method: 'escape' }, rev,
    { quietMs: 20, capMs: 200 }, null, [], ['navigate']).then(value => value.observation), nag.observation.revision);
  assert.equal(after.overlay, undefined);
  assert.equal(await nag.page.evaluate(() => document.getElementById('d').open), false);
});
