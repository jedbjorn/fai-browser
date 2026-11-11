// The contact-modal fixture (fixtures/patterns/contact-modal.html) end to end through the real page script and the
// runtime, headless Chromium: the traits of a field report on a small site's contact dialog. At read-only the page's
// key controls are buttons, so the result counts what reversible would offer; in the dialog each supplied value goes
// into its own field (placeholder-named, no <label>), the spam-trap field off the page is never offered, a fills batch
// takes the supplied fills without text; and a "sent" line that shows a moment after the submit, then goes with the
// dialog, verifies the send only because a later read of the page showed it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, directResult } from '../src/result.js';
import { PageBridge } from './helpers/page-bridge.js';

const FIXTURE = await readFile(new URL('../fixtures/patterns/contact-modal.html', import.meta.url), 'utf8');
const ORIGIN = 'https://contact.test';
const SUPPLIED = { name: 'Ada Example', email: 'ada@example.com', message: 'Hello there' };

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(),
    args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function open(t, level, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
  await page.goto(`${ORIGIN}/`);
  const bridge = new PageBridge(page, { level });
  return { page, bridge, runtime: new BrowserRuntime({ bridge, ...options }) };
}

const config = mode => ({ mode, allowedOrigins: [ORIGIN], suppliedText: SUPPLIED });

test('read-only: the contact buttons are counted for reversible, never offered', async t => {
  const { runtime } = await open(t, 'read-only');
  const observed = await runtime.observe(config('read-only'));
  assert.ok(observed.observation.warnings.includes('controls_need_reversible:2'), observed.observation.warnings.join());
  assert.ok(!observed.actions.some(action => /Contact|get in touch/i.test(action.label ?? '')));
});

test('the dialog: each supplied value in its own field, no spam-trap field, a fills batch without text, then a late "sent"', async t => {
  const { page, runtime } = await open(t, 'full');
  const home = await runtime.observe(config('full'));
  const contact = home.actions.find(action => action.type === 'click' && action.label === 'Contact');
  const opened = await runtime.act(contact.id, { revision: home.observation.revision });
  const actions = opened.offer.actions;
  const supplied = actions.filter(action => action.type === 'fill_supplied_text').map(action => [action.label, action.suppliedName]);
  assert.deepEqual(supplied, [['Name', 'name'], ['Email', 'email'], ['Message', 'message']]);
  assert.ok(!actions.some(action => /company/i.test(action.label ?? '')), 'the off-page spam-trap field is never offered');
  const fills = actions.filter(action => action.type === 'fill_supplied_text').map(action => ({ actionId: action.id }));
  const filled = await runtime.act({ fills }, { revision: opened.offer.revision });
  assert.equal(filled.code, 'step_complete', filled.reason);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#contact-form input, #contact-form textarea')]
    .map(el => el.value)), [SUPPLIED.name, SUPPLIED.email, SUPPLIED.message, '']);
  const send = filled.offer.actions.find(action => action.type === 'click' && action.label === 'Send message');
  assert.ok(send, filled.offer.actions.map(action => action.description).join(' | '));
  const sent = await runtime.act(send.id, { revision: filled.offer.revision, expectation: { textIncludes: 'sent, we will' } });
  assert.equal(sent.status, 'completed', sent.reason);
  assert.equal(sent.verification.passed, true);
  assert.ok(Number.isInteger(sent.verification.seenAfterMs) && sent.verification.seenAfterMs < 2500, `${sent.verification.seenAfterMs}`);
  assert.ok(sent.verdict.why.includes('expect:late'));
  assert.equal(directResult(agentResult(sent)).verification.seenAfterMs, sent.verification.seenAfterMs);
  // The dialog closes 1.6 s later: what passed was seen, not assumed.
  await page.waitForTimeout(1900);
  assert.equal(await page.locator('#contact-modal').isHidden(), true);
});

test('the spam-trap field is reported (trap) for the page facts but never offered, at any level', async t => {
  const { page, runtime } = await open(t, 'full');
  await page.click('.contact-link');
  const observed = await runtime.observe(config('full'));
  const trap = observed.observation.controls.find(control => control.label === 'company');
  assert.equal(trap?.trap, true, 'reported and marked');
  assert.ok(!observed.observation.controls.some(control => control.trap && control.label !== 'company'), 'only the trap is marked');
  assert.ok(!observed.actions.some(action => action.label === 'company'), 'no fill, typed or supplied, and no click');
  // A value that fits no visible field still never goes there.
  const loose = await runtime.observe({ ...config('full'), suppliedText: { note: 'x' } });
  assert.deepEqual(loose.actions.filter(action => action.suppliedName === 'note').map(action => action.label), ['Name', 'Email', 'Message']);
});
