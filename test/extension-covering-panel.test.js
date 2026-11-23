// A panel and a dropdown built of plain divs (no dialog, menu or listbox role), mounted at the end of the body and
// opened over a page with more controls than the cap (fixtures/covering-panel.html, the shape of a mail client's
// search options and its label picker): their controls are offered as open floating UI, ahead of the page behind
// them, a control the panel covers gives its place under the cap to one a press can reach, and a fixed bar the page
// scrolls under stays page chrome. CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const FIXTURE = await readFile(new URL('../fixtures/covering-panel.html', import.meta.url), 'utf8');
const ORIGIN = 'https://example.com';
const PANEL = ['From', 'Has the words', 'greater than', 'Choose label...', 'Skip the Inbox (Archive it)', 'Create filter', 'Search'];
const MENU = ['Newsletters', 'Receipts', 'Travel', 'New label...'];

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(),
    args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function load(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = page => page.evaluate(() => __faiPage.observe({ terms: [], allow: ['navigate', 'controls'] }));
const labelsOf = controls => controls.map(control => control.label);
const floating = observation => observation.controls.filter(control => control.floating);

test('a role-less panel over a capped page: its controls are floating, first, and take the places of what it covers', async t => {
  const page = await load(t);
  const closed = await observe(page);
  assert.equal(closed.controls.length, 100);
  assert.deepEqual(floating(closed), [], 'nothing floats over the page before the panel opens');
  assert.equal(closed.controls.find(control => control.label === 'Create filter'), undefined);

  await page.click('#options');
  const open = await observe(page);
  assert.deepEqual(labelsOf(floating(open)), PANEL);
  assert.deepEqual(labelsOf(open.controls.slice(0, PANEL.length)), PANEL, 'the panel comes before the page behind it');
  for (const control of floating(open)) assert.equal(control.actionability, 'ready', control.label);
  assert.equal(open.controls.find(control => control.label === 'Search options').floating, undefined, 'the bar is page chrome');
  // What the panel covers is never offered: its places go to controls a press can reach.
  const blocked = open.controls.filter(control => control.actionability === 'blocked');
  assert.deepEqual(labelsOf(blocked), [], 'no place under the cap is spent on a covered control');
  assert.equal(open.controls.length, 100);
  assert.ok(open.warnings.includes('controls_capped'));

  await page.click('#pick');
  const picking = await observe(page);
  assert.deepEqual(labelsOf(floating(picking)).filter(label => MENU.includes(label)), MENU, 'the div menu over the panel floats too');
  assert.ok(labelsOf(floating(picking)).includes('From'), 'the panel under the menu stays floating');
});

test('a fixed bar the page scrolls under is not floating UI', async t => {
  const page = await load(t);
  const covered = await page.evaluate(() => {
    scrollTo(0, 40);
    const bar = document.getElementById('bar').getBoundingClientRect();
    return [...document.querySelectorAll('#rows button')].filter(button => button.getBoundingClientRect().bottom <= bar.bottom).length;
  });
  assert.ok(covered >= 2, `the bar covers ${covered} controls`);
  assert.deepEqual(floating(await observe(page)), [], 'and is still page chrome');
});

test('the runtime offers the panel and its menu first, and a choice in the menu runs by action id', async t => {
  const page = await load(t);
  const bridge = new PageBridge(page, { level: 'reversible' });
  const runtime = new BrowserRuntime({ bridge });
  const options = { mode: 'reversible', allowedOrigins: [ORIGIN] };
  const initial = await runtime.observe(options);
  const trigger = initial.actions.find(action => action.label === 'Search options');
  const opened = await runtime.act({ actionId: trigger.id }, { revision: initial.observation.revision });
  const actions = opened.actions ?? opened.offer.actions;
  const first = actions.filter(action => action.floating).map(action => action.label);
  for (const label of PANEL) assert.ok(first.includes(label), `${label} is offered as floating UI`);
  const listed = opened.offer.listed.map(id => actions.find(action => action.id === id).label);
  for (const label of PANEL) assert.ok(listed.includes(label), `${label} survives the listing cap`);

  const pick = actions.find(action => action.label === 'Choose label...');
  const picking = await runtime.act({ actionId: pick.id }, { revision: opened.observation?.revision ?? opened.offer.revision });
  const menu = picking.actions ?? picking.offer.actions;
  const choice = menu.find(action => action.label === 'Newsletters');
  assert.equal(choice?.floating, true);
  const chosen = await runtime.act({ actionId: choice.id }, { revision: picking.observation?.revision ?? picking.offer.revision });
  const after = chosen.actions ?? chosen.offer.actions;
  assert.ok(after.find(action => action.label === 'Newsletters' && action.type === 'click' && action.floating),
    'the picker now shows the chosen label');
  assert.equal(after.find(action => action.label === 'Travel'), undefined, 'choosing closes the menu');
});

test('a select built on a menu button: the listbox that has a popup is the control, its caption is not an option', async t => {
  const page = await load(t);
  await page.click('#options');
  const open = await observe(page);
  const size = open.controls.filter(control => control.label === 'greater than');
  assert.deepEqual(size.map(control => [control.role, control.actionability]), [['listbox', 'ready']], 'one control: the button');

  const bridge = new PageBridge(page, { level: 'reversible' });
  const runtime = new BrowserRuntime({ bridge });
  const offered = await runtime.observe({ mode: 'reversible', allowedOrigins: [ORIGIN] });
  const trigger = offered.actions.find(action => action.label === 'greater than');
  assert.equal(trigger?.type, 'click');
  const opened = await runtime.act({ actionId: trigger.id }, { revision: offered.observation.revision });
  const actions = opened.actions ?? opened.offer.actions;
  const less = actions.find(action => action.label === 'less than' && action.role === 'option');
  assert.ok(less, 'the open list offers its options');
  const chosen = await runtime.act({ actionId: less.id }, { revision: opened.observation?.revision ?? opened.offer.revision });
  const after = chosen.actions ?? chosen.offer.actions;
  assert.ok(after.find(action => action.label === 'less than' && action.role === 'listbox'), 'the button shows the choice');
  assert.equal(after.find(action => action.role === 'option'), undefined, 'the list is closed and the caption is no option');
});

test('a checkbox the page hides behind its label: the label stands in for it, and a press on it checks the box', async t => {
  const page = await load(t);
  await page.click('#options');
  const bridge = new PageBridge(page, { level: 'reversible' });
  const runtime = new BrowserRuntime({ bridge });
  const offered = await runtime.observe({ mode: 'reversible', allowedOrigins: [ORIGIN] });
  const skip = offered.actions.find(action => action.label === 'Skip the Inbox (Archive it)');
  assert.deepEqual([skip?.type, skip?.role, skip?.checked, skip?.floating], ['click', 'checkbox', false, true]);
  const pressed = await runtime.act({ actionId: skip.id }, { revision: offered.observation.revision });
  assert.equal(pressed.status, 'checkpoint', pressed.reason);
  assert.equal(await page.evaluate(() => document.getElementById('skip').checked), true);
  const after = (pressed.actions ?? pressed.offer.actions).find(action => action.label === 'Skip the Inbox (Archive it)');
  assert.equal(after?.checked, true, 'the new state is reported');
});
