// Point clicks and action-id screenshot tags on a real page in headless Chromium: extension/page.js locate() (the
// control under a viewport point, offered or left out by the cap, text, a point outside, a frame from another origin,
// a stale revision), execute() with a point (only the located element, once), the page-level guardrails on what is
// under the point (Delete, Buy now, a password field, an off-site link, a forbidden label), the runtime's act over the
// page bridge, and extension/offscreen.js annotate(): the badges name the offered action ids at the controls' boxes.
// CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { BrowserRuntime, actionLabels, offeredActions } from '../src/runtime.js';
import { PURCHASE_REFUSAL_TEXT } from '../src/oversight.js';
import { PageBridge } from './helpers/page-bridge.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const OFFSCREEN_SCRIPT = new URL('../extension/offscreen.js', import.meta.url).pathname;
const ORIGIN = 'https://example.com';

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(),
    args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

// The point page: named controls first, then 100 filler buttons (the page script's control cap) in view, then "Expand
// row", which the cap leaves out of every observation; a cross-origin frame; an off-screen link below the fold.
const FILLERS = Array.from({ length: 100 }, (_, i) => `<button class="f" onclick="hit('row ${i + 1}')">R${i + 1}</button>`).join('');
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Point page</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  .main button, .main a { display: block; width: 120px; height: 24px; margin: 6px 10px; box-sizing: border-box; }
  .grid { display: flex; flex-wrap: wrap; width: 1000px; margin-left: 150px; }
  .grid .f { width: 36px; height: 20px; margin: 2px; font-size: 10px; padding: 0; }
  #late { width: 120px; height: 24px; margin: 6px 10px; display: block; }
  #frame { position: absolute; left: 700px; top: 20px; width: 200px; height: 100px; border: 0; }
  #text { position: absolute; left: 700px; top: 150px; width: 300px; }
  #below { margin-top: 900px; display: block; }
</style></head><body>
<h1 id="h">Point page</h1><p id="status">idle</p>
<div class="main">
  <button id="plan" onclick="hit('plan')"><span>Show plan</span></button>
  <a id="about" href="/about">About</a>
  <button id="del" onclick="hit('deleted')">Delete</button>
  <button id="buy" onclick="hit('bought')">Buy now</button>
  <input id="pw" type="password" aria-label="Password">
  <a id="partner" href="https://other.example/offers">Partner</a>
  <button id="archive" onclick="hit('archived')">Archive thread</button>
  <button id="later" disabled>Later</button>
</div>
<iframe id="frame" src="https://other.example/frame"></iframe>
<p id="text">Plain text that is not a control.</p>
<div class="grid">${FILLERS}</div>
<button id="late" onclick="hit('expanded')">Expand row</button>
<a id="below" href="/below">Below the fold</a>
<script>function hit(what) { document.getElementById('status').textContent = what; }</script>
</body></html>`;
const ABOUT = '<!doctype html><html><head><title>About</title></head><body><h1>About</h1><a href="/">Home</a></body></html>';
const FRAME = '<!doctype html><html><body><button onclick="document.title=\'framed\'">Framed</button></body></html>';

async function load(t, { viewport = { width: 1280, height: 800 }, deviceScaleFactor = 1 } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();
  t.after(() => context.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/about') ? ABOUT : PAGE }));
  await page.route('https://other.example/**', route => route.fulfill({ contentType: 'text/html', body: FRAME }));
  await page.goto(ORIGIN + '/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const REVERSIBLE = ['navigate', 'controls'];
const observe = (page, allow = REVERSIBLE, forbid = []) => page.evaluate(o => __faiPage.observe(o), { terms: [], forbid, allow, expectText: [] });
const locate = (page, point, revision, allow = REVERSIBLE, forbid = []) => page.evaluate(
  ([p, r, a, f]) => Promise.resolve().then(() => __faiPage.locate(p, r, null, f, a, undefined))
    .then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
  [point, revision, allow, forbid],
);
const execute = (page, action, revision, allow = REVERSIBLE, forbid = []) => page.evaluate(
  ([a, r, al, f]) => __faiPage.execute(a, r, { quietMs: 0, capMs: 100 }, null, f, al, undefined, []).then(
    value => ({ value }), error => ({ error: { code: error.code, message: error.message } })),
  [action, revision, allow, forbid],
);
const status = page => page.evaluate(() => document.getElementById('status').textContent);
// The centre of an element, in CSS viewport pixels.
const centre = (page, id) => page.evaluate(id => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, id);
const byLabel = (observation, label) => observation.controls.find(c => c.label === label);

test('locate resolves the control under a point: offered by id, capped out as "point", else refused with its own code', async t => {
  const page = await load(t);
  const observation = await observe(page);
  assert.ok(observation.controls.length === 100 && observation.controlsDropped >= 1, 'the cap left controls out');
  assert.equal(byLabel(observation, 'Expand row'), undefined, 'Expand row is not observed');
  const plan = byLabel(observation, 'Show plan');

  // A point on the span inside the button walks up to the button, with the observed id.
  const offered = await locate(page, await centre(page, 'plan'), observation.revision);
  assert.equal(offered.error, undefined, JSON.stringify(offered.error));
  assert.equal(offered.value.id, plan.id);
  assert.equal(offered.value.control.label, 'Show plan');
  assert.equal(offered.value.control.risk, 'reversible');

  const capped = await locate(page, await centre(page, 'late'), observation.revision);
  assert.equal(capped.value.id, null, 'a control the cap left out has no observed id');
  assert.equal(capped.value.control.id, 'point');
  assert.equal(capped.value.control.label, 'Expand row');
  assert.equal(capped.value.control.role, 'button');
  assert.equal(capped.value.control.risk, 'reversible');
  assert.deepEqual(Object.keys(capped.value.control.bounds), ['x', 'y', 'width', 'height']);

  // Classes travel with the description, as in an observation.
  assert.equal((await locate(page, await centre(page, 'del'), observation.revision)).value.control.risk, 'delete');
  assert.equal((await locate(page, await centre(page, 'buy'), observation.revision)).value.control.risk, 'purchase');
  assert.equal((await locate(page, await centre(page, 'pw'), observation.revision)).value.control.risk, 'sign_in');
  const partner = (await locate(page, await centre(page, 'partner'), observation.revision)).value.control;
  assert.equal(partner.role, 'link');
  assert.equal(partner.href, 'https://other.example/offers');
  const forbidden = await locate(page, await centre(page, 'archive'), observation.revision, REVERSIBLE, ['Archive']);
  assert.equal(forbidden.value.control.risk, 'destructive');
  const disabled = (await locate(page, await centre(page, 'later'), observation.revision)).value.control;
  assert.equal(disabled.enabled, false);

  assert.equal((await locate(page, await centre(page, 'text'), observation.revision)).error?.code, 'no_control');
  assert.equal((await locate(page, { x: 1279, y: 799 }, observation.revision)).error?.code, 'no_control', 'empty page area');
  assert.equal((await locate(page, { x: 1280, y: 10 }, observation.revision)).error?.code, 'point_outside');
  assert.equal((await locate(page, { x: -1, y: 10 }, observation.revision)).error?.code, 'point_outside');
  assert.equal((await locate(page, { x: 10, y: 800 }, observation.revision)).error?.code, 'point_outside');
  assert.equal((await locate(page, { x: 'a', y: 1 }, observation.revision)).error?.code, 'unsupported');
  assert.equal((await locate(page, await centre(page, 'frame'), observation.revision)).error?.code, 'point_frame');
  assert.equal((await locate(page, await centre(page, 'plan'), 'stale-revision')).error?.code, 'stale');
});

test('execute with a point clicks only the element locate() found on that revision, once', async t => {
  const page = await load(t);
  const observation = await observe(page);
  const plan = await centre(page, 'plan');
  // No locate first: nothing is clicked.
  assert.equal((await execute(page, { type: 'click', point: plan }, observation.revision)).error?.code, 'stale');
  assert.equal(await status(page), 'idle');
  // A point with a target, or a non-click, is never dispatched.
  await locate(page, plan, observation.revision);
  assert.equal((await execute(page, { type: 'click', point: plan, target: '1' }, observation.revision)).error?.code, 'unsupported');
  await locate(page, plan, observation.revision);
  assert.equal((await execute(page, { type: 'fill_supplied_text', point: plan, text: 'x' }, observation.revision)).error?.code, 'unsupported');
  // Another point than the located one is stale.
  await locate(page, plan, observation.revision);
  assert.equal((await execute(page, { type: 'click', point: { x: plan.x + 1, y: plan.y } }, observation.revision)).error?.code, 'stale');
  assert.equal(await status(page), 'idle');

  const located = await locate(page, plan, observation.revision);
  const clicked = await execute(page, { type: 'click', point: plan }, observation.revision);
  assert.equal(clicked.error, undefined, JSON.stringify(clicked.error));
  assert.deepEqual(clicked.value.target, { id: located.value.id, role: 'button', label: 'Show plan' });
  assert.equal(await status(page), 'plan');
  // The located element is spent with the click.
  const again = await execute(page, { type: 'click', point: plan }, clicked.value.observation.revision);
  assert.equal(again.error?.code, 'stale');

  // A control the cap left out is clicked by its point too.
  const fresh = clicked.value.observation;
  const late = await centre(page, 'late');
  const found = await locate(page, late, fresh.revision);
  assert.equal(found.value.id, null);
  const expanded = await execute(page, { type: 'click', point: late }, fresh.revision);
  assert.equal(expanded.error, undefined, JSON.stringify(expanded.error));
  assert.deepEqual(expanded.value.target, { id: 'point', role: 'button', label: 'Expand row' });
  assert.equal(await status(page), 'expanded');
});

test('the page script refuses a point click on Delete, Buy now, a password field, an off-site link and a forbidden label', async t => {
  const page = await load(t);
  const observation = await observe(page);
  const refused = async (id, code, allow = REVERSIBLE, forbid = []) => {
    const point = await centre(page, id);
    const found = await locate(page, point, observation.revision, allow, forbid);
    assert.equal(found.error, undefined, `${id}: ${JSON.stringify(found.error)}`);
    const outcome = await execute(page, { type: 'click', point }, observation.revision, allow, forbid);
    assert.equal(outcome.error?.code, code, `${id}: ${JSON.stringify(outcome)}`);
  };
  await refused('del', 'blocked_risky');
  await refused('buy', 'blocked_risky');
  await refused('buy', 'blocked_risky', ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept']); // full never buys
  await refused('pw', 'blocked_risky');
  await refused('partner', 'cross_origin');
  await refused('archive', 'blocked_risky', REVERSIBLE, ['Archive']);
  await refused('later', 'target_unavailable');
  // Read-only: a button needs controls.
  await refused('plan', 'blocked_risky', ['navigate']);
  assert.equal(await status(page), 'idle', 'nothing ran');
  // Delete is allowed at full.
  const del = await centre(page, 'del');
  const full = ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'];
  await locate(page, del, observation.revision, full);
  const deleted = await execute(page, { type: 'click', point: del }, observation.revision, full);
  assert.equal(deleted.error, undefined, JSON.stringify(deleted.error));
  assert.equal(await status(page), 'deleted');
});

test('runtime act with a point over the page bridge: an offered control runs its action, a capped-out one is clicked, the rest are refused', async t => {
  const page = await load(t);
  const bridge = new PageBridge(page, { level: 'reversible' });
  const runtime = new BrowserRuntime({ bridge });
  const options = { mode: 'reversible', allowedOrigins: [ORIGIN] };
  const act = async (id, extra = {}) => {
    const { observation } = await runtime.observe({ ...options, ...extra });
    // 1280x800 at dpr 1: screenshot pixels are CSS pixels.
    return runtime.act({ point: await centre(page, id) }, { revision: observation.revision });
  };
  const { observation, actions } = await runtime.observe(options);
  const plan = actions.find(a => a.label === 'Show plan');
  const planned = await runtime.act({ point: await centre(page, 'plan') }, { revision: observation.revision });
  assert.equal(planned.status, 'checkpoint', planned.reason);
  assert.equal(planned.steps[0].decision.actionId, plan.id);
  assert.deepEqual(planned.steps[0].decision.resolved, { ref: plan.target, label: 'Show plan', offered: true });
  assert.deepEqual(bridge.executions.at(-1), { type: 'click', target: plan.target });
  assert.equal(await status(page), 'plan');

  const expanded = await act('late');
  assert.equal(expanded.status, 'checkpoint', expanded.reason);
  assert.deepEqual(expanded.steps[0].decision.resolved, { ref: 'point', label: 'Expand row', offered: false });
  assert.equal(bridge.executions.at(-1).point !== undefined, true);
  assert.equal(await status(page), 'expanded');

  const deleted = await act('del');
  assert.equal(deleted.code, 'refused_action');
  assert.equal(deleted.needs.level, 'full');
  // Delete is an observed control: the refusal names its ref.
  assert.deepEqual(deleted.needs.control, { ref: byLabel(observation, 'Delete').id, label: 'Delete' });
  const bought = await act('buy');
  assert.equal(bought.code, 'refused_action');
  assert.equal(bought.needs.message, PURCHASE_REFUSAL_TEXT);
  const password = await act('pw');
  assert.equal(password.code, 'refused_action');
  assert.ok(password.verdict.why.includes('point:sign_in'));
  const partner = await act('partner');
  assert.equal(partner.code, 'cross_origin');
  const archived = await act('archive', { policy: { forbid: ['Archive'] } });
  assert.equal(archived.code, 'refused_action');
  assert.ok(archived.verdict.why.includes('point:forbid'));
  const nothing = await act('text');
  assert.equal(nothing.code, 'no_control');
  const framed = await act('frame');
  assert.equal(framed.code, 'point_frame');
  assert.equal(await status(page), 'expanded', 'no refused click ran');
  // About is an offered link: the click navigates.
  const about = await act('about');
  assert.equal(about.status, 'checkpoint', about.reason);
  assert.equal(about.steps[0].decision.resolved.offered, true);
  assert.equal(about.steps[0].action.toUrl, `${ORIGIN}/about`);
});

// extension/offscreen.js in the page: `handle` is its message handler, with the decode/encode paths it uses in the
// offscreen document (createImageBitmap, a DOM canvas toDataURL).
async function loadAnnotator(page) {
  await page.evaluate(() => { globalThis.chrome = { runtime: { id: 'test', onMessage: { addListener() {} } } }; });
  await page.addScriptTag({ path: OFFSCREEN_SCRIPT });
}

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('the annotated screenshot tags each in-view offered control with its action id at its box', async t => {
  const page = await load(t);
  const observation = await observe(page);
  const offer = offeredActions(observation, { mode: 'reversible', allowedOrigins: [ORIGIN] });
  const labels = actionLabels(offer.actions);
  await loadAnnotator(page);
  const dataUrl = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')}`;
  const result = await page.evaluate(([dataUrl, observation, labels]) => handle({ dataUrl, observation, action: null, labels, redact: { rects: [], viewport: observation.viewport } }),
    [dataUrl, observation, labels]);
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert.ok(result.dataUrl.startsWith('data:image/jpeg;base64,'));

  // One tag per in-view offered control, naming its action id (a select or field would read "a3–a5").
  const inView = observation.controls.filter(c => !c.offscreen && labels[c.id]);
  // The cap keeps 100 controls, all in view here; at reversible Delete, Buy now, the off-site link and the disabled
  // button are not offered, so they get no tag.
  for (const label of ['Delete', 'Buy now', 'Partner', 'Later']) assert.equal(labels[byLabel(observation, label).id], undefined, label);
  assert.equal(inView.length, observation.controls.filter(c => !c.offscreen).length - 4);
  assert.ok(inView.length >= 95);
  const untagged = inView.filter(c => !result.tags.some(tag => tag.ref === c.id)).map(c => ({ id: c.id, label: c.label, bounds: c.bounds }));
  assert.equal(result.tags.length, inView.length, `untagged: ${JSON.stringify(untagged)}`);
  for (const tag of result.tags) {
    const control = observation.controls.find(c => c.id === tag.ref);
    assert.deepEqual([tag.id], labels[control.id], `${control.label} is tagged with its action id`);
    // The badge sits at the control's box: left of it, above, below, inside or right of it, never far away.
    const box = control.bounds;
    const dx = Math.max(box.x - (tag.x + tag.width), tag.x - (box.x + box.width), 0);
    const dy = Math.max(box.y - (tag.y + tag.height), tag.y - (box.y + box.height), 0);
    assert.ok(dx <= 4 && dy <= 4, `${control.label}: tag ${JSON.stringify(tag)} is at box ${JSON.stringify(box)}`);
    assert.ok(tag.x >= 0 && tag.y >= 0 && tag.x + tag.width <= 1280 && tag.y + tag.height <= 800, 'inside the frame');
  }
  // The offered ids on the screenshot are the ids the host acts with.
  const planTag = result.tags.find(tag => tag.ref === byLabel(observation, 'Show plan').id);
  assert.equal(planTag.id, offer.actions.find(a => a.label === 'Show plan').id);
  // Badges of the spaced-out named controls overlap no other badge.
  for (const label of ['Show plan', 'About', 'Archive thread']) {
    const tag = result.tags.find(entry => entry.ref === byLabel(observation, label).id);
    assert.ok(!result.tags.some(other => other !== tag && overlaps(tag, other)), `${label}'s tag is clear of the others`);
  }
  // The off-screen link (when the cap keeps it) is offered but not tagged; a control without an offered action gets no tag.
  const below = byLabel(observation, 'Below the fold');
  if (below) {
    assert.equal(below.offscreen, true);
    assert.ok(!result.tags.some(tag => tag.ref === below.id));
  }
  const later = byLabel(observation, 'Later');
  assert.equal(labels[later.id], undefined);
  assert.ok(!result.tags.some(tag => tag.ref === later.id));

  // Without labels the frame is annotated as before: refs, and no tags reported.
  const plain = await page.evaluate(([dataUrl, observation]) => handle({ dataUrl, observation, action: null, redact: { rects: [], viewport: observation.viewport } }), [dataUrl, observation]);
  assert.equal(plain.tags, undefined);
  assert.equal(plain.width, 1280);
});

test('on a high-DPI frame the tags are scaled with the image and the point maps back through the image size', async t => {
  const page = await load(t, { viewport: { width: 1000, height: 600 }, deviceScaleFactor: 2 });
  const observation = await observe(page);
  assert.deepEqual(observation.viewport, { width: 1000, height: 600, dpr: 2 });
  const offer = offeredActions(observation, { mode: 'reversible', allowedOrigins: [ORIGIN] });
  const labels = actionLabels(offer.actions);
  await loadAnnotator(page);
  const dataUrl = `data:image/jpeg;base64,${(await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')}`;
  const result = await page.evaluate(([dataUrl, observation, labels]) => handle({ dataUrl, observation, action: null, labels, redact: { rects: [], viewport: observation.viewport } }),
    [dataUrl, observation, labels]);
  // 2000x1200 device pixels, downscaled to 1280 wide: 1.28 image pixels per CSS pixel.
  assert.deepEqual([result.width, result.height], [1280, 768]);
  const plan = byLabel(observation, 'Show plan');
  const tag = result.tags.find(entry => entry.ref === plan.id);
  const box = { x: plan.bounds.x * 1.28, y: plan.bounds.y * 1.28, width: plan.bounds.width * 1.28, height: plan.bounds.height * 1.28 };
  const dx = Math.max(box.x - (tag.x + tag.width), tag.x - (box.x + box.width), 0);
  const dy = Math.max(box.y - (tag.y + tag.height), tag.y - (box.y + box.height), 0);
  assert.ok(dx <= 4 && dy <= 4, `tag ${JSON.stringify(tag)} at scaled box ${JSON.stringify(box)}`);

  // The runtime maps a point of that image back to the page: the centre of Show plan in image pixels clicks it.
  const bridge = new PageBridge(page, { level: 'reversible' });
  const runtime = new BrowserRuntime({ bridge });
  const observed = await runtime.observe({ mode: 'reversible', allowedOrigins: [ORIGIN] });
  runtime.noteImage(observed.observation.revision, { width: result.width, height: result.height });
  const css = await centre(page, 'plan');
  const acted = await runtime.act({ point: { x: Math.round(css.x * 1.28), y: Math.round(css.y * 1.28) } }, { revision: observed.observation.revision });
  assert.equal(acted.status, 'checkpoint', acted.reason);
  assert.equal(acted.point.scale, 1.28);
  assert.deepEqual(acted.steps[0].decision.resolved, { ref: plan.id, label: 'Show plan', offered: true });
  assert.equal(await status(page), 'plan');
});
