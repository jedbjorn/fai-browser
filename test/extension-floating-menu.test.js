// Semantic floating menus and overlays on a generic local fixture: portal menu items and radio state, dynamic
// open/close, priority over a capped background without dropping its risk controls, native popovers, policy/level
// enforcement, action-id execution and matching screenshot badges. CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime, actionLabels, legalActions, offeredActions } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const OFFSCREEN_SCRIPT = new URL('../extension/offscreen.js', import.meta.url).pathname;
const FIXTURE = await readFile(new URL('../fixtures/floating-menu.html', import.meta.url), 'utf8');
const ORIGIN = 'https://example.com';
const REVERSIBLE = ['navigate', 'controls'];
const FULL = ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'];

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(),
    args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function load(t, html = FIXTURE) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = (page, { allow = REVERSIBLE, forbid = [] } = {}) => page.evaluate(
  options => __faiPage.observe({ terms: [], ...options }), { allow, forbid },
);
const execute = (page, action, revision, { allow = REVERSIBLE, forbid = [] } = {}) => page.evaluate(
  ([a, r, options]) => __faiPage.execute(a, r, { quietMs: 0, capMs: 100 }, null, options.forbid, options.allow,
    undefined, []).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
  [action, revision, { allow, forbid }],
);
const byLabel = (observation, label) => observation.controls.find(control => control.label === label);
const actionByLabel = (actions, label) => actions.find(action => action.label === label);
const resultActions = result => result.actions ?? result.offer?.actions ?? [];
const resultRevision = result => result.observation?.revision ?? result.offer?.revision;

async function openMenu(page) {
  const initial = await observe(page);
  const opened = await execute(page, { type: 'click', target: byLabel(initial, 'Sort messages').id }, initial.revision);
  assert.equal(opened.error, undefined, JSON.stringify(opened.error));
  return opened.value.observation;
}

test('a portal menu outside its trigger subtree is offered first under the cap and runs by action id', async t => {
  const page = await load(t);
  const bridge = new PageBridge(page, { level: 'reversible' });
  const runtime = new BrowserRuntime({ bridge });
  const options = { mode: 'reversible', allowedOrigins: [ORIGIN] };

  const initial = await runtime.observe(options);
  assert.equal(actionByLabel(initial.actions, 'Most recent'), undefined, 'a closed menu is not offered');
  const sort = actionByLabel(initial.actions, 'Sort messages');
  assert.ok(sort, 'the trigger is offered');

  const opened = await runtime.act({ actionId: sort.id }, { revision: initial.observation.revision });
  assert.equal(opened.status, 'checkpoint', opened.reason);
  const observation = await observe(page);
  const floating = observation.controls.filter(control => control.floating);
  assert.deepEqual(floating.map(control => [control.role, control.label, control.checked]), [
    ['menuitem', 'Most recent', undefined],
    ['menuitemradio', 'Exact matches', false],
    ['menuitemcheckbox', 'Include archived', true],
    ['menuitem', 'Delete filtered messages', undefined],
  ]);
  assert.deepEqual(observation.controls.slice(0, 4).map(control => control.label), floating.map(control => control.label));
  assert.equal(observation.controls.length, 100);
  assert.ok(observation.warnings.includes('controls_capped'));
  assert.equal(byLabel(observation, 'Delete filtered messages').risk, 'delete');
  assert.equal(byLabel(observation, 'Delete background message').risk, 'delete', 'background risk controls stay visible');
  assert.ok(byLabel(observation, 'Background action 1'), 'ordinary background controls are not isolated away');

  const actions = resultActions(opened);
  assert.deepEqual(actions.filter(action => action.floating).map(action => action.label),
    ['Most recent', 'Exact matches', 'Include archived']);
  assert.deepEqual(actions.filter(action => action.type === 'click').slice(0, 3).map(action => action.label),
    ['Most recent', 'Exact matches', 'Include archived'], 'safe menu actions precede background clicks');
  const listed = opened.offer.listed.map(id => actions.find(action => action.id === id));
  for (const label of ['Most recent', 'Exact matches', 'Include archived']) {
    assert.ok(listed.some(action => action.label === label), `${label} survives the observe listing cap`);
  }
  assert.equal(actionByLabel(actions, 'Delete filtered messages'), undefined, 'reversible still refuses Delete');
  assert.equal(actionByLabel(actions, 'Delete background message'), undefined, 'background Delete is refused too');

  const recent = actionByLabel(actions, 'Most recent');
  const chosen = await runtime.act({ actionId: recent.id }, { revision: resultRevision(opened) });
  assert.equal(chosen.status, 'checkpoint', chosen.reason);
  assert.deepEqual(bridge.executions.at(-1), { type: 'click', target: recent.target });
  assert.match(chosen.observation.text, /Chosen: Most recent/);
  assert.equal(actionByLabel(resultActions(chosen), 'Exact matches'), undefined, 'choosing closes the menu');

  const reopen = actionByLabel(resultActions(chosen), 'Sort messages');
  const reopened = await runtime.act({ actionId: reopen.id }, { revision: resultRevision(chosen) });
  const exact = actionByLabel(resultActions(reopened), 'Exact matches');
  assert.ok(exact, 'the dynamically reopened menu offers its radio item again');
  const radio = await runtime.act({ actionId: exact.id }, { revision: resultRevision(reopened) });
  assert.equal(radio.status, 'checkpoint', radio.reason);
  assert.match(radio.observation.text, /Chosen: Exact matches/);

  const again = await runtime.act({ actionId: actionByLabel(resultActions(radio), 'Sort messages').id },
    { revision: resultRevision(radio) });
  assert.equal(actionByLabel(resultActions(again), 'Exact matches').checked, true, 'radio state is reported');
});

test('menu priority preserves read-only, policy and full-level risk rules plus background controls', async t => {
  const page = await load(t);
  const observation = await openMenu(page);
  const readOnly = legalActions({ ...observation, url: `${ORIGIN}/` }, { mode: 'read-only', allowedOrigins: [ORIGIN] });
  assert.equal(actionByLabel(readOnly, 'Most recent'), undefined);
  const full = legalActions({ ...observation, url: `${ORIGIN}/` }, { mode: 'full', allowedOrigins: [ORIGIN] });
  assert.ok(actionByLabel(full, 'Delete filtered messages'));
  assert.ok(actionByLabel(full, 'Delete background message'), 'prioritizing the menu does not hide background risk');

  const forbidden = await observe(page, { forbid: ['Most recent'] });
  assert.equal(byLabel(forbidden, 'Most recent').risk, 'destructive');
  assert.equal(actionByLabel(legalActions({ ...forbidden, url: `${ORIGIN}/` },
    { mode: 'reversible', allowedOrigins: [ORIGIN], policy: { forbid: ['Most recent'] } }), 'Most recent'), undefined);
  const refused = await execute(page, { type: 'click', target: byLabel(forbidden, 'Most recent').id }, forbidden.revision,
    { forbid: ['Most recent'] });
  assert.equal(refused.error?.code, 'blocked_risky');
  assert.equal(await page.evaluate(() => document.getElementById('status').textContent), 'Nothing chosen');

  const current = await observe(page);
  const exact = await execute(page, { type: 'click', target: byLabel(current, 'Exact matches').id }, current.revision);
  assert.equal(exact.error, undefined, JSON.stringify(exact.error));
  assert.match(exact.value.observation.text, /Chosen: Exact matches/);
});

test('a native floating popover offers ordinary buttons before the capped background and closes dynamically', async t => {
  const page = await load(t);
  const initial = await observe(page);
  const opened = await execute(page, { type: 'click', target: byLabel(initial, 'Layout options').id }, initial.revision);
  assert.equal(opened.error, undefined, JSON.stringify(opened.error));
  const observation = opened.value.observation;
  const compact = byLabel(observation, 'Compact layout');
  assert.ok(compact, 'the popover button is observed');
  assert.equal(compact.floating, true);
  assert.equal(observation.controls[0].label, 'Compact layout');
  assert.equal(observation.overlay, undefined, 'an ordinary popover is not reported as a blocking overlay');
  assert.ok(byLabel(observation, 'Delete background message'), 'the background remains classified');

  const chosen = await execute(page, { type: 'click', target: compact.id }, observation.revision);
  assert.equal(chosen.error, undefined, JSON.stringify(chosen.error));
  assert.match(chosen.value.observation.text, /Chosen: Compact layout/);
  assert.equal(byLabel(chosen.value.observation, 'Compact layout'), undefined);
});

test('screenshot action badges cover the same open portal-menu controls', async t => {
  const page = await load(t);
  const observation = await openMenu(page);
  const offer = offeredActions({ ...observation, url: `${ORIGIN}/` }, { mode: 'reversible', allowedOrigins: [ORIGIN] });
  const labels = actionLabels(offer.actions);
  await page.evaluate(() => { globalThis.chrome = { runtime: { id: 'test', onMessage: { addListener() {} } } }; });
  await page.addScriptTag({ path: OFFSCREEN_SCRIPT });
  const dataUrl = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')}`;
  const annotated = await page.evaluate(([data, pageObservation, actionIds]) => handle({
    dataUrl: data, observation: pageObservation, action: null, labels: actionIds,
    redact: { rects: [], viewport: pageObservation.viewport },
  }), [dataUrl, observation, labels]);

  for (const label of ['Most recent', 'Exact matches', 'Include archived']) {
    const control = byLabel(observation, label);
    const action = actionByLabel(offer.actions, label);
    const tag = annotated.tags.find(entry => entry.ref === control.id);
    assert.ok(tag, `${label} has a screenshot badge`);
    assert.equal(tag.id, action.id, `${label}'s badge is its semantic action id`);
  }
  assert.equal(annotated.tags.some(tag => tag.ref === byLabel(observation, 'Delete filtered messages').id), false,
    'a refused menu item gets no action badge');
});

test('a blocking dialog with a closed nested popover keeps its overlay dismissal semantics', async t => {
  const page = await load(t, `<!doctype html><html><body>
    <div role="dialog" aria-modal="true" style="position:fixed;inset:25%;background:white">
      <p>Join our newsletter for updates.</p>
      <div popover><button>Closed popover action</button></div>
      <button>Close</button>
    </div>
    <button>Background action</button>
  </body></html>`);
  const observation = await observe(page);
  assert.equal(observation.overlay?.kind, 'newsletter');
  const close = byLabel(observation, 'Close');
  assert.equal(close.dismiss, true);
  assert.equal(close.floating, undefined);
  assert.equal(byLabel(observation, 'Closed popover action'), undefined);
});

for (const kind of ['popover', 'listbox']) {
  test(`a non-dialog newsletter with an open nested ${kind} keeps read-only dismissal and floating marks`, async t => {
    const nested = kind === 'popover' ? `
      <div id="choices" popover="manual"><button>Weekly updates</button></div>
      <script>document.getElementById('choices').showPopover()</script>` : `
      <div id="choices" role="listbox" aria-label="Frequency">
        <div role="option" aria-selected="false">Weekly updates</div>
        <div role="option" aria-selected="false">Monthly updates</div>
      </div>`;
    const page = await load(t, `<!doctype html><html><body>
      <main><h1>Garden notes</h1><p>Practical advice for every season.</p><button>Background action</button></main>
      <div id="newsletter" style="position:fixed;inset:15%;background:white;z-index:10">
        <p>Join our newsletter for updates.</p>${nested}
        <button id="close">Close</button>
      </div>
      <script>document.getElementById('close').addEventListener('click', () => document.getElementById('newsletter').remove())</script>
    </body></html>`);
    const observation = await observe(page);
    assert.equal(observation.overlay?.kind, 'newsletter');
    const close = byLabel(observation, 'Close');
    assert.equal(close.dismiss, true);
    assert.equal(close.floating, undefined);
    assert.equal(byLabel(observation, 'Weekly updates').floating, true);

    const dismissed = await execute(page, { type: 'click', target: close.id }, observation.revision, { allow: ['navigate'] });
    assert.equal(dismissed.error, undefined, JSON.stringify(dismissed.error));
    assert.equal(dismissed.value.observation.overlay, undefined);
    assert.equal(await page.locator('#newsletter').count(), 0);
  });
}

test('CSS position alone does not open a static sidebar or a closing offcanvas menu', async t => {
  for (const closing of [false, true]) {
    const page = await load(t, `<!doctype html><html><body>
      <button aria-expanded="false" aria-controls="sidebar">Navigation</button>
      <div id="sidebar" role="menu" style="position:fixed;left:0;top:0;width:240px;height:100%;background:white;${closing ? 'transform:translateX(-95%);' : ''}">
        <div role="menuitem">Static action</div>
      </div>
      <main><h1>Page content</h1><button>Background action</button></main>
    </body></html>`);
    const observation = await observe(page);
    assert.equal(observation.overlay, undefined);
    assert.equal(observation.controls.some(control => control.floating), false);
    assert.equal(byLabel(observation, 'Static action')?.floating, undefined);
  }
});

test('a large listbox needs explicit expansion for floating priority', async t => {
  const options = Array.from({ length: 60 }, (_, i) => `<div role="option">Option ${i}</div>`).join('');
  const page = await load(t, `<!doctype html><html><body>
    <button id="trigger" aria-controls="choices">Choose options</button>
    <button>Background action</button>
    <div id="choices" role="listbox" style="position:absolute">${options}</div>
  </body></html>`);
  const closed = await observe(page);
  assert.ok(byLabel(closed, 'Option 0'));
  assert.equal(closed.controls.some(control => control.floating), false);
  assert.ok(closed.controls.findIndex(control => control.label === 'Background action')
    < closed.controls.findIndex(control => control.label === 'Option 0'));

  await page.evaluate(() => document.getElementById('trigger').setAttribute('aria-expanded', 'true'));
  const opened = await observe(page);
  assert.equal(byLabel(opened, 'Option 0').floating, true);
  assert.equal(byLabel(opened, 'Option 59').floating, true);
  assert.equal(opened.controls[0].label, 'Option 0');
  assert.ok(opened.controls.findIndex(control => control.label === 'Option 0')
    < opened.controls.findIndex(control => control.label === 'Background action'));
});
