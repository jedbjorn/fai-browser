// Unnamed icon controls in extension/page.js, run in headless Chromium on fixtures/stepper.html (the Google Flights
// date arrows of the live 2026-10-06 run): direction labels for unnamed button pairs and tokens, tooltip and
// aria-describedby names, the `opens` flag of a picker textbox, and the named-control rule on derived labels.
// CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { legalActions } from '../src/runtime.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const STEPPER = await readFile(new URL('../fixtures/stepper.html', import.meta.url), 'utf8');

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function load(t, html = STEPPER) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/flights');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = page => page.evaluate(() => __faiPage.observe({}));
const labels = observation => observation.controls.map(control => control.label);

test('an unnamed button pair flanking a date field is labelled previous/next by side, never by SVG shape', async t => {
  const observation = await observe(await load(t));
  const all = labels(observation);
  assert.ok(all.includes('previous-value button before "Departure" (unlabelled)'), all.join(' | '));
  assert.ok(all.includes('next-value button after "Departure" (unlabelled)'), all.join(' | '));
  const next = observation.controls.find(control => control.label.startsWith('next-value button after'));
  assert.equal(next.unnamed, true);
  // A lone icon after a field (a calendar or clear icon) gets no direction.
  assert.ok(all.some(label => /^unlabelled button( \d of \d)? next to "/.test(label)), all.join(' | '));
  assert.ok(!all.some(label => /value button (?:before|after) "Return"/.test(label)), all.join(' | '));
});

test('a pair around a short text, and class or data-* tokens, give directions; whole class names do not', async t => {
  const all = labels(await observe(await load(t)));
  assert.ok(all.includes('previous-value button before "Photo 3 / 8" (unlabelled)'), all.join(' | '));
  assert.ok(all.includes('next-value button after "Photo 3 / 8" (unlabelled)'), all.join(' | '));
  // "nav-chevron-left" (shape + left) and data-action="increment" spell a direction; "float-right" does not.
  assert.ok(all.some(label => /^previous button beside "Passengers" \(unlabelled\)$/.test(label)), all.join(' | '));
  assert.ok(all.some(label => /^increase button beside "Passengers" \(unlabelled\)$/.test(label)), all.join(' | '));
  assert.ok(all.includes('unlabelled button next to "Passengers"'), all.join(' | '));
});

test('two unnamed icons whose class, id or SVG <use> says trash, clear, edit or calendar get no previous/next claim', async t => {
  const icon = (attrs, use = '') => `<button type="button" ${attrs} style="width:24px;height:24px">`
    + (use ? `<svg width="16" height="16"><use href="#${use}"></use></svg>` : '') + '</button>';
  const html = `<!doctype html><html><body>
    <div style="display:flex;gap:4px">${icon('', 'icon-trash')}<input aria-label="Item name" value="Socks">${icon('class="btn-edit"')}</div>
    <div style="display:flex;gap:4px">${icon('class="clear-field"')}<input aria-label="Check-in" value="Oct 9">${icon('id="calendarToggle"')}</div>
    <div style="display:flex;gap:4px">${icon('class="row-delete"')}<span>Row 3</span>${icon('', 'pencil')}</div>
    <div style="display:flex;gap:4px">${icon('class="close"')}<span>Notice</span>${icon('class="nav-arrow-right"')}</div>
  </body></html>`;
  const all = labels(await observe(await load(t, html)));
  assert.ok(!all.some(label => /(?:previous|next)(?:-value)? button (?:before|after)/.test(label)), all.join(' | '));
  assert.ok(!all.some(label => /^previous/.test(label)), all.join(' | '));
});

test('a tooltip attribute or aria-describedby names an icon button that has no other name', async t => {
  const all = labels(await observe(await load(t)));
  assert.ok(all.includes('Swap origin and destination'), all.join(' | '));
  assert.ok(all.includes('Share this search'), all.join(' | '));
});

test('a read-only picker textbox is flagged `opens` and offered as a click at reversible; its click opens the picker',
  async t => {
    const page = await load(t);
    const observation = await observe(page);
    const departure = observation.controls.find(control => control.label === 'Departure');
    assert.equal(departure.opens, true);
    assert.equal(departure.role, 'textbox');
    const actions = legalActions(observation, { mode: 'reversible' });
    const click = actions.find(action => action.type === 'click' && action.label === 'Departure');
    assert.ok(click, 'the Departure textbox is offered as a click');
    assert.equal(click.opens, true);
    // Read-only offers no control clicks at all.
    assert.ok(!legalActions(observation, { mode: 'read-only' }).some(action => action.label === 'Departure'));
    const result = await page.evaluate(([action, revision]) => __faiPage.execute(action, revision, { quietMs: 50, capMs: 300 }),
      [{ type: 'click', target: departure.id }, observation.revision]);
    assert.ok(result.observation.text.includes('Choose a date'), 'the date dialog opened');
  });

