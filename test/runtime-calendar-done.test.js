// Regression: bench/long flights-live-landing-calendar condition b (2026-10-06) broke at step 2 in every run. On the
// results page Jev clicked Departure, the day cell ("Wednesday 14 October 2026 €47") and Done; the fixture applies the
// day 1.5 s after Done (like the live site), but the run decided again at once on the 13 Oct page and the step ended
// expectation_failed with answer:scope_mismatch. The Done had closed the calendar and changed nothing else, yet
// onlyDialogClosed said the page moved, so no late-change wait ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserRuntime } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';
import { headlessEnv } from '../scripts/headless-env.mjs';

const FIXTURE = resolve(import.meta.dirname, '..', 'fixtures', 'long', 'flights-live');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const TFS_13 = 'CBwQAhoeEgoyMDI2LTEwLTEzagUSA01SU3IFEgNMT05AAUgBcAGYAQI';

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] }); });
test.after(async () => { await browser?.close(); });

test('a calendar Done on the results page waits for the date the page applies 1.5 s later', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop() || 'index.html';
    route.fulfill({ contentType: TYPES[extname(name)] ?? 'text/plain', body: readFileSync(resolve(FIXTURE, name)) });
  });
  await page.goto(`https://example.com/long/flights-live/search.html?tfs=${TFS_13}&hl=en&curr=EUR`);
  await page.waitForTimeout(800);
  const route = [label => label === 'Departure', label => label.startsWith('Wednesday 14 October 2026'), label => label === 'Done'];
  const provider = { model: 'fake', async decide(observation, actions) {
    const want = route.shift();
    const action = want && actions.find(entry => want(String(entry.label ?? '')));
    return { actionId: action?.id ?? 'handoff', confidence: 0.9, done: { probability: action ? 0.05 : 0.9 } };
  } };
  const result = await new BrowserRuntime({ bridge: new PageBridge(page, { level: 'reversible' }), provider }).run(
    'Open the Departure date field, choose 14 in the calendar and click Done.', { mode: 'reversible', capture: 'none',
      expectation: { urlIncludes: 'MDI2LTEwLTE0' }, maxActions: 4, retry: false });
  const done = result.steps.find(step => step.action?.label === 'Done');
  assert.ok(done, result.steps.map(step => step.action?.label).join(' | '));
  assert.equal(done.settle, 'late_change', `moved ${done.moved}, ${result.code}: ${result.verdict?.why?.join(',')}`);
  assert.equal(result.status, 'completed', `${result.code}: ${result.steps.map(step => [step.action?.label, step.settle, step.moved, step.action?.toUrl?.slice(-60)].join(' ')).join(' / ')}`);
});
