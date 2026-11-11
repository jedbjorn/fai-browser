import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { legalActions } from '../src/runtime.js';

async function fixture(t, html) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  return page;
}

test('codex: truncated visible text still changes semantic revision', async t => {
  const page = await fixture(t, `<div style="width:100px;overflow:hidden;white-space:nowrap">${'A'.repeat(8100)}</div>`);
  const before = await page.evaluate(() => __faiPage.observe());
  assert.equal(before.text.length, 8000);
  assert.equal(before.textTruncated, true);
  await page.evaluate(() => { document.querySelector('div').firstChild.nodeValue = 'B'.repeat(8100); });
  const after = await page.evaluate(() => __faiPage.observe());
  assert.notEqual(after.revision, before.revision, 'visible text changed but revision did not');
});

test('codex: child-tab links are excluded from executable offers', async t => {
  const page = await fixture(t, '<a href="/child" target="_blank">Child</a><a href="/about">About</a>');
  const observation = await page.evaluate(() => __faiPage.observe());
  const refused = await page.evaluate(async revision => {
    try { await __faiPage.execute({ type: 'click', target: '1' }, revision, { quietMs: 0, capMs: 50 }); }
    catch (error) { return error.code; }
  }, observation.revision);
  assert.equal(refused, 'child_tab');
  assert.deepEqual(legalActions(observation).filter(a => a.type === 'click').map(a => a.label), ['About']);
});

test('codex: disabled select options are excluded from executable offers', async t => {
  const page = await fixture(t, '<select><option value="a">A</option><option value="b" disabled>B</option><optgroup disabled label="disabled"><option value="c">C</option></optgroup><option value="d">D</option></select>');
  const observation = await page.evaluate(() => __faiPage.observe());
  assert.deepEqual(legalActions(observation, { mode: 'reversible' }).filter(a => a.type === 'select').map(a => a.value), ['d']);
});

test('codex: standalone input button with type submit is clickable', async t => {
  const page = await fixture(t, '<input type="submit" value="Expand" onclick="document.title=\'Expanded\'">');
  const observation = await page.evaluate(() => __faiPage.observe());
  assert.equal(observation.controls[0].risk, 'reversible');
  const action = legalActions(observation, { mode: 'reversible' }).find(a => a.type === 'click');
  assert.ok(action, 'non-form button was dropped merely because type=submit');
});

test('codex: base target blank is blocked before a child tab opens', async t => {
  const page = await fixture(t, '<base target="_blank"><a href="/child">Child</a>');
  const observation = await page.evaluate(() => __faiPage.observe());
  const outcome = await page.evaluate(async revision => {
    try {
      await __faiPage.execute({ type: 'click', target: '1' }, revision, { quietMs: 0, capMs: 50 });
      return 'executed';
    } catch (error) { return error.code; }
  }, observation.revision);
  assert.equal(outcome, 'child_tab');
  assert.ok(!legalActions(observation).some(a => a.type === 'click'));
});

test('codex: page excludes passwords and rejects javascript links with button-only risk', async t => {
  const page = await fixture(t, '<input type="password" aria-label="Secret"><a href="javascript:document.title=\'Executed\'">Script</a><a href="/help">Delete help</a><a href="/guide">How to delete a help topic</a><button type="button">Savings</button><button type="button">Delete</button><label><input type="checkbox">Save receipts</label><label><input type="radio">Pay monthly</label>');
  const observation = await page.evaluate(() => __faiPage.observe());
  assert.ok(!observation.controls.some(c => c.type === 'password'));
  // A link gets the link rule, not the button label classes: a short label leading with an action verb is that
  // action (as the runtime's destructiveLink judges it), a longer descriptive one stays navigation.
  assert.equal(observation.controls.find(c => c.label === 'Delete help').risk, 'delete');
  assert.equal(observation.controls.find(c => c.label === 'How to delete a help topic').risk, 'navigation');
  assert.equal(observation.controls.find(c => c.label === 'Savings').risk, 'reversible');
  assert.equal(observation.controls.find(c => c.label === 'Delete').risk, 'delete');
  assert.equal(observation.controls.find(c => c.type === 'checkbox').role, 'checkbox');
  assert.equal(observation.controls.find(c => c.type === 'radio').role, 'radio');
  const script = observation.controls.find(c => c.label === 'Script');
  const errorCode = await page.evaluate(async ({ id, revision }) => {
    try { await __faiPage.execute({ type: 'click', target: id }, revision, { quietMs: 0, capMs: 50 }); }
    catch (error) { return error.code; }
  }, { id: script.id, revision: observation.revision });
  assert.equal(errorCode, 'blocked_risky');
  assert.notEqual(await page.title(), 'Executed');
});
