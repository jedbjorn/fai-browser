// Fixture-level tests of the termination rules (src/runtime.js #loop, earlyEnd/endOnPass/notePrepass) on the real
// long-corpus pages in headless Chromium with extension/page.js (test/helpers/page-bridge.js), driven by scripted
// providers that reproduce what live Jev did in the round 6 baseline (bench/results/long-2026-10-06-baseline):
// - catalog overshoot: "Click Next page" passes its step's expectation after one click while done stays 0.27-0.45;
//   the step used to click Next page again and land past its page (cap_actions, 0/3 in condition b);
// - pre-passing expectation: textIncludes "Date grid" passes on the flights page before the toggle is clicked; the
//   run used to complete with no action (done >= 0.5 on the start page) or click the toggle again and close the grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { startQaSite } from '../bench/qa/serve.mjs';
import { loadLongSuite } from '../bench/long/lib.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { PageBridge } from './helpers/page-bridge.js';

const suite = loadLongSuite();
const catalog = suite.tasks.find(task => task.id === 'catalog-cheapest-tent');

let site;
let browser;
test.before(async () => {
  site = await startQaSite();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => {
  await browser?.close();
  await site?.close();
});

async function open(t, path, level) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.goto(site.origin + path);
  return new PageBridge(page, { level });
}

const requests = result => result.cost.requests.map(entry => entry.kind);

/**
 * Jev as the baseline traces show it on the catalog: on a step that names Next page it clicks "Next page ›" at 0.9
 * with done 0.35 on every page; on a read-only step (no click named) done is 0.9. The slim guards request scores the
 * pages clean.
 */
function catalogJev() {
  const calls = { decide: 0, confirm: 0 };
  return {
    model: 'catalog-jev',
    calls,
    async decide(observation, actions, context) {
      calls.decide++;
      const clicks = /Next page/.test(context.instruction ?? '');
      const next = actions.find(action => action.label === 'Next page ›' || action.label === 'Next page');
      return clicks && next
        ? { actionId: next.id, confidence: 0.9, done: { probability: 0.35 } }
        : { actionId: 'handoff', confidence: 0.6, done: { probability: 0.9 } };
    },
    async confirm() {
      calls.confirm++;
      return { done: { probability: 0.35 }, guards: { blocked: 0.02, injection: 0.01 } };
    },
  };
}

test('catalog overshoot: the 13-step list ends every step on its own page, one Next page click each', async t => {
  const bridge = await open(t, '/long/catalog/page.html?p=1', 'read-only');
  const provider = catalogJev();
  const runtime = new BrowserRuntime({ bridge, provider });
  const raw = await runtime.run({ steps: catalog.steps, mode: 'read-only', capture: 'none',
    allowedOrigins: [site.origin] });
  const result = agentResult(raw);
  assert.equal(result.status, 'completed', JSON.stringify([result.reason, result.verdict, raw.errorDetail]));
  assert.equal(result.verification.passed, true);
  assert.equal(result.stepResults.length, 13);
  assert.ok(result.stepResults.every(step => step.passed));
  assert.equal(result.steps.length, 12, 'exactly the 12 Next page clicks of the gold path');
  assert.match(result.page.url, /p=13$/);
  assert.ok(result.verdict.why.includes('steps:13/13'));
  // Step 1 (a read step) gets its terminal decide; each later step one decide and one end-of-step guards request.
  assert.deepEqual(provider.calls, { decide: 13, confirm: 12 });
});

test('catalog overshoot: the first five steps (one list before MAX_STEPS 15) stop on page 5, not past it', async t => {
  const bridge = await open(t, '/long/catalog/page.html?p=1', 'read-only');
  const provider = catalogJev();
  const raw = await new BrowserRuntime({ bridge, provider }).run({ steps: catalog.steps.slice(0, 5),
    mode: 'read-only', capture: 'none', allowedOrigins: [site.origin] });
  const result = agentResult(raw);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.stepResults.map(step => step.code), Array(5).fill('expectation_passed'));
  assert.equal(result.steps.length, 4);
  assert.match(result.page.url, /p=5$/);
  assert.deepEqual(requests(raw).filter(kind => kind !== 'decide'), Array(4).fill('step_guards'));
});

test('catalog overshoot: one step on its own still overshoots nothing (single run "Click Next page.")', async t => {
  const bridge = await open(t, '/long/catalog/page.html?p=4', 'read-only');
  const provider = catalogJev();
  const result = agentResult(await new BrowserRuntime({ bridge, provider }).run(catalog.steps[4].instruction, {
    expectation: catalog.steps[4].expectation, maxActions: 3, capture: 'none', allowedOrigins: [site.origin] }));
  assert.equal(result.status, 'completed');
  assert.equal(result.steps.length, 1);
  assert.match(result.page.url, /p=5$/);
  assert.ok(result.verdict.why.includes('early_end:named_actions'));
});

/**
 * Jev on the flights page as the round 6 study saw it (A3v): it clicks the Date grid toggle while the grid is closed,
 * and on the opened grid it is unsure (done `openDone`) and clicks the toggle again (closing it) unless the toggle is
 * not offered, when it hands off. `startDone` is its done on the start page.
 */
function flightsJev({ startDone, openDone }) {
  const calls = { decide: 0, confirm: 0, offered: [] };
  return {
    model: 'flights-jev',
    calls,
    async decide(observation, actions) {
      calls.decide++;
      const open = /Lowest fare/.test(observation.text ?? '');
      const grid = actions.find(action => action.label === 'Date grid');
      calls.offered.push(Boolean(grid));
      if (grid) return { actionId: grid.id, confidence: open ? 0.52 : 0.9, done: { probability: open ? openDone : startDone } };
      return { actionId: 'handoff', confidence: 0.5, done: { probability: openDone } };
    },
    async confirm() {
      calls.confirm++;
      return { done: { probability: openDone }, guards: { blocked: 0.02, injection: 0.01 } };
    },
  };
}

const GRID_TASK = 'On the Marseille to London flights page, click the \'Date grid\' button to open the date grid.';
const GRID = { mode: 'reversible', expectation: { textIncludes: 'Date grid' }, maxActions: 4, capture: 'none' };

test('pre-passing: a start-page pass never completes the run before the named click (done 0.6 on the start page)',
  async t => {
    const bridge = await open(t, '/long/flights/', 'reversible');
    const provider = flightsJev({ startDone: 0.6, openDone: 0.45 });
    const result = agentResult(await new BrowserRuntime({ bridge, provider }).run(GRID_TASK,
      { ...GRID, allowedOrigins: [site.origin] }));
    assert.equal(result.status, 'completed');
    assert.equal(result.verification.passed, true);
    assert.ok(result.warnings.includes('expectation_prepassing'));
    assert.ok(result.verdict.why.includes('expectation_prepassing'));
    assert.equal(result.steps.length, 1, 'the toggle was clicked once');
    assert.equal(result.steps[0].action.label, 'Date grid');
    assert.match(result.page.digest.join?.('\n') ?? JSON.stringify(result.page), /Lowest fare/, 'the grid is open');
    assert.ok(result.verdict.why.includes('early_end:named_actions'));
  });

test('pre-passing: the click that made the expectation count is never undone by a second toggle click', async t => {
  // Not a bounded imperative ("every"), so the opened grid gets a decide: the toggle is not offered there.
  const bridge = await open(t, '/long/flights/', 'reversible');
  const provider = flightsJev({ startDone: 0.3, openDone: 0.45 });
  const result = agentResult(await new BrowserRuntime({ bridge, provider }).run(
    `${GRID_TASK} Read every fare in it.`, { ...GRID, allowedOrigins: [site.origin] }));
  assert.equal(result.steps.length, 1, 'one click: the toggle was excluded from the next offer');
  assert.deepEqual(provider.calls.offered, [true, false]);
  assert.ok(result.verdict.why.includes('toggle_excluded'));
  assert.equal(result.code, 'handoff_expectation_passed');
  assert.match(JSON.stringify(result.page), /Lowest fare/, 'the grid is still open');
});
