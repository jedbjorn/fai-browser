// Blocking overlays (src/overlay.js, the runtime's Rung 0 dismissal, extension/page.js detectOverlay): the plan's
// order and guards, the runtime's limits (each step once per overlay, overlay:persistent after the third return,
// overlay:undismissable, overlay:user_opened, the dismiss step class at read-only), and page-script cases the pattern
// corpus does not cover (an app shell is not an overlay, a "Close and sign in" button is no close control, Escape is
// refused on a task dialog). The corpus itself is test/patterns.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BrowserRuntime, actionClass } from '../src/runtime.js';
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

// A page with a nag overlay. `closes` decides which dismissal method closes it; `returns` how many times it comes back
// (on the next observe after it closed); `afterClick` opens the overlay only after a click on button 2.
class OverlayBridge {
  constructor({ closes = ['close'], returns = 0, afterClick = false } = {}) {
    Object.assign(this, { closes, returns, afterClick, open: !afterClick, version: 1, executions: [], comeBack: false });
  }

  get observation() {
    const controls = [...main, { id: '2', role: 'button', label: 'Favourite', enabled: true, risk: 'reversible' }];
    if (this.open) controls.push(closeControl);
    return {
      revision: `r${this.version}`, documentId: 'doc', url: `${ORIGIN}/shop`, title: 'Shop', text: 'Garden tools: 8 results',
      blocks: [{ t: 'h1', text: 'Garden tools: 8 results' }], controls, consent: null, warnings: [],
      ...(this.open ? { overlay: NAG } : {}),
    };
  }

  // The overlay comes back on a later look or action, never in the dismissal's own observation.
  reopen() {
    if (this.comeBack && this.returns > 0) {
      this.returns--;
      this.open = true;
      this.version++;
    }
    this.comeBack = false;
  }

  async observe() {
    this.reopen();
    return this.observation;
  }

  async execute(action) {
    this.executions.push(action);
    if (!action.method && action.target !== '3') this.reopen();
    const method = action.type === 'dismiss_overlay' ? action.method : action.target === '3' ? 'close' : null;
    if (method && this.closes.includes(method)) {
      this.open = false;
      this.comeBack = true;
      this.version++;
    }
    if (action.target === '2' && this.afterClick) {
      this.open = true;
      this.version++;
    }
    return { observation: this.observation, settle: { reason: 'quiet', ms: 0 }, navigated: false, screenshot: Promise.resolve(null) };
  }
}

const doneProvider = { model: 'fake', async decide() { return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } }; } };
const run = (bridge, options = {}, provider = doneProvider) => new BrowserRuntime({ bridge, provider }).run('Read the garden tools list.',
  { mode: 'read-only', capture: 'none', expectation: { textIncludes: 'Garden tools' }, retry: false, consentWaitMs: 0, maxActions: 4, ...options });

test('a nag is closed at read-only by its close control, as a dismiss step, before any decision', async () => {
  const bridge = new OverlayBridge();
  const result = await run(bridge);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.steps.map(step => [step.class, step.decision.by, step.action.type]), [['dismiss', 'runtime', 'click']]);
  assert.ok(result.verdict.why.includes('overlay:dismissed') && result.verdict.why.includes('overlay:close'));
});

test('a close control that does nothing is not repeated: Escape, then the backdrop', async () => {
  const bridge = new OverlayBridge({ closes: ['backdrop'] });
  const result = await run(bridge);
  assert.deepEqual(bridge.executions.map(action => action.method ?? action.target), ['3', 'escape', 'backdrop']);
  assert.ok(result.verdict.why.includes('overlay:backdrop'));
});

test('an overlay nothing closes is reported overlay:undismissable after three steps, and the task goes on', async () => {
  const bridge = new OverlayBridge({ closes: [] });
  const result = await run(bridge);
  assert.equal(bridge.executions.length, 3);
  assert.ok(result.verdict.why.includes('overlay:undismissable'), result.verdict.why.join(','));
  assert.ok(!result.verdict.why.includes('overlay:dismissed'));
  assert.equal(result.status, 'completed');
});

test('an overlay that comes back more than twice is persistent: three dismissals, then no more', async () => {
  const bridge = new OverlayBridge({ returns: 5 });
  // The provider scrolls on, so the page is looked at again after each dismissal.
  const scroller = { model: 'fake', async decide(observation, actions) {
    const scroll = actions.find(action => action.type === 'scroll' && action.direction === 'down');
    return { actionId: scroll.id, confidence: 0.9, done: { probability: 0.05 } };
  } };
  const result = await run(bridge, { maxActions: 6 }, scroller);
  assert.equal(bridge.executions.filter(action => action.target === '3').length, 3, bridge.executions.map(action => action.target ?? action.method).join(','));
  assert.ok(result.verdict.why.includes('overlay:persistent'), result.verdict.why.join(','));
});

test('a nag the run\'s own click opened is left to the provider (overlay:user_opened)', async () => {
  const bridge = new OverlayBridge({ afterClick: true });
  let calls = 0;
  const provider = { model: 'fake', async decide(observation, actions) {
    calls++;
    const save = actions.find(action => action.label === 'Favourite');
    if (calls === 1) return { actionId: save.id, confidence: 0.9, done: { probability: 0.05 } };
    return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } };
  } };
  const result = await run(bridge, { mode: 'reversible' }, provider);
  assert.ok(result.verdict.why.includes('overlay:user_opened'), result.verdict.why.join(','));
  assert.ok(!result.steps.some(step => step.class === 'dismiss'));
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
