import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';

const ORIGIN = 'https://example.com';
const SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());
async function load(t, body) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <style>[role=tab]{display:inline-block;padding:12px;margin:4px}[hidden]{display:none}</style>${body}` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ path: SCRIPT });
  return page;
}
const byLabel = (items, label) => items.find(item => item.label === label);
const options = { mode: 'reversible', allowedOrigins: [ORIGIN] };

test('div/span tabs are offered with selected state, native tabs are unique, and action ids select them', async t => {
  const page = await load(t, `<div role="tablist">
    <div role="tab" aria-selected="true">Recommended</div>
    <span role="tab" aria-selected="false">Cheapest</span>
    <button role="tab" type="button">Flexible</button>
    <span role="tab" aria-disabled="true">Unavailable</span>
    <span role="tab" hidden>Hidden choice</span>
    <span role="tab" style="visibility:hidden">Invisible choice</span>
    </div><div role="tabpanel">Result panel</div><p id="status">No selection made</p>
    <script>document.querySelectorAll('[role=tab]').forEach(tab => tab.onclick = () => {
      document.querySelectorAll('[role=tab]').forEach(item => item.setAttribute('aria-selected', String(item === tab)));
      document.getElementById('status').textContent = 'Selected cheapest results';
    });</script>`);
  const runtime = new BrowserRuntime({ bridge: new PageBridge(page, { level: 'reversible' }) });
  const first = await runtime.observe(options);
  const controls = first.observation.controls;
  assert.equal(byLabel(controls, 'Cheapest')?.role, 'tab');
  assert.equal(byLabel(controls, 'Recommended').checked, true);
  assert.equal(byLabel(controls, 'Cheapest').checked, false);
  assert.equal(byLabel(controls, 'Flexible').checked, undefined, 'missing selected state stays unknown');
  assert.equal(controls.filter(c => c.label === 'Flexible').length, 1);
  assert.equal(byLabel(controls, 'Unavailable')?.enabled, false);
  await assert.rejects(new PageBridge(page, { level: 'reversible' }).execute(
    { type: 'click', target: byLabel(controls, 'Unavailable').id }, first.observation.revision),
  error => error.code === 'target_unavailable');
  for (const label of ['Unavailable', 'Hidden choice', 'Invisible choice', 'Result panel']) {
    assert.equal(byLabel(first.actions, label), undefined);
  }
  assert.match(byLabel(first.actions, 'Recommended').description, /currently selected/);
  assert.match(byLabel(first.actions, 'Cheapest').description, /currently unselected/);
  const done = await runtime.act({ actionId: byLabel(first.actions, 'Cheapest').id },
    { revision: first.observation.revision, expectation: { textIncludes: 'Selected cheapest results' } });
  assert.equal(done.status, 'completed', done.reason);
  assert.equal(done.verification.passed, true);
  assert.equal(byLabel(done.observation.controls, 'Cheapest').checked, true);
});

test('a point on a tab descendant resolves and executes through the guarded control route', async t => {
  const page = await load(t, `<div role="tablist"><span role="tab" id="choice" aria-selected="false">
    <b>Details</b></span></div><p id="status">Initial view</p>
    <script>choice.onclick=()=>{choice.setAttribute('aria-selected','true');document.getElementById('status').textContent='Changed view'}</script>`);
  const bridge = new PageBridge(page, { level: 'reversible' });
  const before = await bridge.observe();
  const box = await page.locator('#choice b').boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const located = await bridge.locate(point, before.revision);
  assert.equal(located.control.role, 'tab');
  assert.equal(located.id, byLabel(before.controls, 'Details').id);
  const after = await bridge.execute({ type: 'click', point }, before.revision);
  assert.equal(byLabel(after.observation.controls, 'Details').checked, true);
});

test('tabs keep read-only, dangerous label, request policy and native form-submit restrictions', async t => {
  const page = await load(t, `<div role="tablist">
    <div role="tab">Details</div><span role="tab">Buy now</span><span role="tab">Delete account</span>
    <span role="tab">Sign in</span><span role="tab" aria-label="Overview">Buy now</span>
    </div><form><button role="tab">Send message</button></form>`);
  const bridge = new PageBridge(page, { level: 'reversible' });
  const observation = await bridge.observe();
  const actions = legalActions(observation, options);
  assert.ok(byLabel(actions, 'Details'));
  for (const label of ['Buy now', 'Delete account', 'Sign in', 'Overview', 'Send message']) {
    assert.equal(byLabel(actions, label), undefined, label);
    const control = byLabel(observation.controls, label);
    assert.ok(control, label);
    await assert.rejects(bridge.execute({ type: 'click', target: control.id }, observation.revision),
      error => error.code === 'blocked_risky');
  }
  // The runtime also checks a tab's own label when an older bridge does not supply risk metadata.
  const withoutRisk = { ...observation, controls: observation.controls.map(({ risk, ...control }) => control) };
  for (const label of ['Buy now', 'Delete account', 'Sign in', 'Send message']) {
    assert.equal(byLabel(legalActions(withoutRisk, options), label), undefined);
  }
  assert.equal(byLabel(legalActions(observation, { ...options, mode: 'read-only' }), 'Details'), undefined);
  const forbidden = await bridge.observe(undefined, { forbid: ['Details'] });
  assert.equal(byLabel(forbidden.controls, 'Details').risk, 'destructive');
  assert.equal(byLabel(legalActions(forbidden, { ...options, policy: { forbid: ['Details'] } }), 'Details'), undefined);
  const box = await page.getByText('Details', { exact: true }).boundingBox();
  const point = { x: box.x + 4, y: box.y + 4 };
  const located = await bridge.locate(point, forbidden.revision, { forbid: ['Details'] });
  assert.equal(located.control.risk, 'destructive');
  const refused = await page.evaluate(([point, revision]) => __faiPage.execute({ type: 'click', point }, revision,
    { quietMs: 50, capMs: 300 }, [], ['Details'], ['navigate', 'controls']).then(
    () => null, error => error.code), [point, forbidden.revision]);
  assert.equal(refused, 'blocked_risky');
});

test('tabs in an active dialog keep dialog scope while hidden panels supply no controls', async t => {
  const page = await load(t, `<div role="dialog" aria-modal="true" style="position:fixed;inset:20%;background:white">
    <div role="tablist"><div role="tab" aria-selected="true">Dates</div><span role="tab">Guests</span></div>
    <div role="tabpanel" hidden><span role="tab">Hidden nested choice</span></div></div>`);
  const observation = await new PageBridge(page, { level: 'reversible' }).observe();
  assert.equal(byLabel(observation.controls, 'Dates')?.dialog, true);
  assert.equal(byLabel(observation.controls, 'Guests')?.dialog, true);
  assert.equal(byLabel(observation.controls, 'Hidden nested choice'), undefined);
  assert.ok(byLabel(legalActions(observation, options), 'Guests'));
});

test('tabs retain button-equivalent purchase-page and destructive-dialog gates', async t => {
  for (const [body, risk] of [
    ['<h1>Checkout</h1><input aria-label="Card number" autocomplete="cc-number"><div class="checkout"><div role="tab">Continue</div><button>Continue</button></div>', 'purchase'],
    ['<div role="dialog" aria-modal="true"><p>Are you sure? This cannot be undone.</p><div role="tab">Confirm</div><button>Confirm</button></div>', 'delete'],
  ]) {
    const page = await load(t, body);
    const bridge = new PageBridge(page, { level: 'reversible' });
    const observation = await bridge.observe();
    for (const role of ['tab', 'button']) {
      const control = observation.controls.find(item => item.role === role);
      assert.equal(control?.risk, risk, role);
      assert.equal(legalActions(observation, options).some(action => action.target === control.id), false);
      await assert.rejects(bridge.execute({ type: 'click', target: control.id }, observation.revision),
        error => error.code === 'blocked_risky');
    }
  }
});
