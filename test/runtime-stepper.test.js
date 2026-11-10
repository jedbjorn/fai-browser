// Late changes after quiet button clicks, host act() re-resolve and picker textbox clicks, on fixtures/stepper.html in
// headless Chromium with extension/page.js (test/helpers/page-bridge.js) and scripted providers. The fixture's date
// arrows re-render (URL, date and results) ?delay= ms after a click that settles at once, as Google Flights does
// (live run 2026-10-06: the arrow click settled in ~120 ms, the page changed 1-5 s later).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';

const STEPPER = await readFile(new URL('../fixtures/stepper.html', import.meta.url), 'utf8');
const NEXT_ARROW = 'next-value button after "Departure" (unlabelled)';

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function open(t, delay, body = STEPPER) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body }));
  await page.goto(`https://example.com/flights?delay=${delay}`);
  return { page, bridge: new PageBridge(page, { level: 'reversible' }) };
}

test('E4c: a host act on an offer the late change made stale runs the same control on the fresh page', async t => {
  const { page, bridge } = await open(t, 600);
  const runtime = new BrowserRuntime({ bridge });
  const first = await runtime.observe({ mode: 'reversible' });
  const arrow = first.actions.find(action => action.label === NEXT_ARROW);
  const clicked = await runtime.act(arrow.id, { revision: first.observation.revision });
  assert.equal(clicked.status, 'checkpoint');
  // The host looks again before the late change lands, then acts on that offer after it landed.
  const second = await runtime.observe({ mode: 'reversible' });
  assert.ok(second.observation.text.includes('departing 2026-10-10'));
  await page.waitForURL(/date=2026-10-11/);
  const again = second.actions.find(action => action.label === NEXT_ARROW);
  const result = await runtime.act(again.id, { revision: second.observation.revision });
  assert.equal(result.status, 'checkpoint', `${result.code}: ${result.reason}`);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
  assert.ok(result.verdict.why.includes('act:stale_reresolve'));
  await page.waitForURL(/date=2026-10-12/);
});

test('E5: the read-only Departure textbox is offered as a click and the click opens the date dialog', async t => {
  const { bridge } = await open(t, 1200);
  const runtime = new BrowserRuntime({ bridge });
  const { observation, actions } = await runtime.observe({ mode: 'reversible' });
  const departure = actions.find(action => action.type === 'click' && action.label === 'Departure');
  assert.ok(departure, actions.map(action => `${action.type}:${action.label}`).join(' | '));
  assert.equal(departure.opens, true);
  const result = await runtime.act(departure.id, { revision: observation.revision, expectation: { textIncludes: 'Choose a date' } });
  assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
});

