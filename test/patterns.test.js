// The front-end pattern corpus (fixtures/patterns/manifest.json): every pattern page is loaded into headless Chromium
// with the real extension/page.js, and every check of the manifest is one test. Observation checks run the check's
// steps through the page script (as the extension does: execute with dispatch, settle and observe) and compare the
// manifest's expected facts; `run` checks drive BrowserRuntime over the page (test/helpers/page-bridge.js) with a
// provider that only reports done, so the runtime's own Rung 0 (consent reject, overlay dismissal) is what acts. A
// check with `finding` is a known gap: a todo whose name carries the FINDING message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserRuntime } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';
import { headlessEnv } from '../scripts/headless-env.mjs';

const DIR = resolve(import.meta.dirname, '..', 'fixtures', 'patterns');
const MANIFEST = JSON.parse(readFileSync(resolve(DIR, 'manifest.json'), 'utf8'));
const ORIGIN = 'https://patterns.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
// extension/background.js CAPABILITIES.
const CAPABILITIES = {
  'read-only': ['navigate'],
  reversible: ['navigate', 'controls'],
  interactive: ['navigate', 'controls', 'submit_safe'],
};
const SETTLE = { quietMs: 50, capMs: 400 };

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); });

async function open(t, file) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route(`${ORIGIN}/**`, route => {
    const name = new URL(route.request().url()).pathname.split('/').pop() || 'index.html';
    let body;
    try {
      body = readFileSync(resolve(DIR, name));
    } catch {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({ contentType: TYPES[extname(name)] ?? 'text/plain', body });
  });
  await page.goto(`${ORIGIN}/${file}`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(100);
  return page;
}

const observe = (page, allow) => page.addScriptTag({ path: PAGE_SCRIPT })
  .then(() => page.evaluate(value => __faiPage.observe(value), { allow }));

function findControl(observation, label) {
  const controls = observation.controls ?? [];
  return controls.find(control => control.label === label) ?? controls.find(control => control.label.includes(label));
}

async function execute(page, observation, action, allow) {
  const outcome = await page.evaluate(([a, r, s, allow]) => __faiPage.execute(a, r, s, null, [], allow).then(
    value => ({ value }), error => ({ error: { code: error.code, message: error.message } })), [action, observation.revision, SETTLE, allow]);
  if (outcome.error) throw new Error(`${action.type} failed: ${outcome.error.code} ${outcome.error.message}`);
  return outcome.value;
}

async function runSteps(page, steps, allow) {
  let observation = await observe(page, allow);
  let fill = null;
  for (const step of steps ?? []) {
    if (step.wait) {
      await page.waitForTimeout(step.wait);
      observation = await page.evaluate(value => __faiPage.observe(value), { allow });
      continue;
    }
    let action;
    if (step.scroll) action = { type: 'scroll', direction: step.scroll };
    else {
      const control = findControl(observation, step.click ?? step.fill);
      assert.ok(control, `no control "${step.click ?? step.fill}" in ${observation.controls.map(c => c.label).join(' | ')}`);
      action = step.click ? { type: 'click', target: control.id } : { type: 'fill_supplied_text', target: control.id, text: step.text };
    }
    const value = await execute(page, observation, action, allow);
    if (value.fill) fill = value.fill;
    observation = value.observation ?? await page.evaluate(value => __faiPage.observe(value), { allow });
  }
  return { observation, fill };
}

function checkObservation(observation, fill, expect) {
  const labels = (observation.controls ?? []).map(control => control.label);
  const has = label => labels.some(item => item === label || item.includes(label));
  const blocks = (observation.blocks ?? []).map(block => block.text);
  const inBlocks = text => blocks.some(block => block.includes(text));
  const where = () => `controls: ${labels.join(' | ')}`;
  if ('overlay' in expect) {
    if (expect.overlay === null) assert.equal(observation.overlay ?? null, null, `unexpected overlay ${JSON.stringify(observation.overlay)}`);
    else {
      assert.ok(observation.overlay, 'an overlay is reported');
      for (const [key, value] of Object.entries(expect.overlay)) {
        assert.deepEqual(observation.overlay[key], value, `overlay.${key} in ${JSON.stringify(observation.overlay)}`);
      }
    }
  }
  if ('consent' in expect) assert.equal(Boolean(observation.consent), expect.consent, 'consent dialog');
  for (const text of expect.text ?? []) assert.ok(observation.text.includes(text), `text has "${text}": ${observation.text.slice(0, 400)}`);
  for (const text of expect.textAbsent ?? []) assert.ok(!observation.text.includes(text), `text lacks "${text}"`);
  for (const text of expect.blocks ?? []) assert.ok(inBlocks(text), `a block has "${text}": ${blocks.slice(0, 40).join(' / ')}`);
  for (const text of expect.blocksAbsent ?? []) assert.ok(!inBlocks(text), `no block has "${text}"`);
  for (const label of expect.controls ?? []) assert.ok(has(label), `control "${label}"; ${where()}`);
  for (const label of expect.controlsAbsent ?? []) assert.ok(!has(label), `no control "${label}"; ${where()}`);
  if (expect.marked) {
    const marked = observation.controls.filter(control => control.overlay).map(control => control.label);
    assert.deepEqual(marked.filter(label => expect.marked.some(want => label.includes(want))).length, expect.marked.length,
      `marked overlay controls ${marked.join(' | ')}`);
    if (!expect.marked.length) assert.deepEqual(marked, [], 'no control is marked');
  }
  if (expect.dismiss) {
    const closers = (observation.overlay?.closers ?? []).map(closer => closer.label);
    assert.deepEqual(closers, expect.dismiss, 'close controls');
    for (const closer of observation.overlay?.closers ?? []) {
      assert.equal(observation.controls.find(control => control.id === closer.id)?.dismiss, true, `${closer.label} is a dismiss control`);
    }
  }
  for (const label of expect.frameControls ?? []) {
    assert.ok(observation.controls.some(control => control.label.includes(label) && control.frame !== undefined), `frame control "${label}"; ${where()}`);
  }
  if ('fillKept' in expect) assert.equal(fill?.kept, expect.fillKept, `fill ${JSON.stringify(fill)}`);
  for (const code of expect.warnings ?? []) assert.ok(observation.warnings.includes(code), `warning ${code} in ${observation.warnings}`);
  // Records (detectRecords): `records` is the expected record titles in order (a prefix when `recordsAtLeast` is set),
  // or [] for a page whose rows stay plain blocks; `recordHints` maps a title to hints it must carry.
  if (expect.records) {
    const titles = (observation.records ?? []).map(record => record.title);
    if (expect.recordsAtLeast) {
      assert.ok(titles.length >= expect.recordsAtLeast, `at least ${expect.recordsAtLeast} records: ${titles.join(' / ')}`);
      assert.deepEqual(titles.slice(0, expect.records.length), expect.records, 'record titles');
    } else {
      assert.deepEqual(titles, expect.records, 'record titles');
    }
  }
  for (const [title, hints] of Object.entries(expect.recordHints ?? {})) {
    const record = (observation.records ?? []).find(item => item.title === title);
    assert.ok(record, `record "${title}"`);
    for (const [key, value] of Object.entries(hints)) assert.deepEqual(record.hints?.[key], value, `${title} hint ${key}`);
  }
}

async function checkRun(page, run, expect) {
  const provider = { model: 'fake', async decide() { return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } }; } };
  const runtime = new BrowserRuntime({ bridge: new PageBridge(page, { level: run.level }), provider });
  const result = await runtime.run(run.instruction ?? 'Read the page.', { mode: run.level, capture: 'none',
    expectation: run.expectation, maxActions: 6, retry: false, consentWaitMs: 50,
    ...(run.answerQuestion ? { answerQuestion: run.answerQuestion } : {}) });
  const dismissSteps = result.steps.filter(step => step.class === 'dismiss').map(step => step.action.method ?? 'close');
  const why = result.verdict?.why ?? [];
  const trail = `${result.status}/${result.code} why ${why.join(',')} steps ${result.steps.map(step => `${step.class}:${step.action.type}:${step.action.label}`).join(' / ')}`;
  if (expect.dismissSteps) assert.deepEqual(dismissSteps, expect.dismissSteps, trail);
  if ('overlayAfter' in expect) assert.equal(Boolean(result.observation?.overlay), expect.overlayAfter, trail);
  for (const code of expect.why ?? []) assert.ok(why.includes(code), `why ${code}: ${trail}`);
  if (expect.status) assert.equal(result.status, expect.status, trail);
  for (const text of expect.finalBlocks ?? []) {
    assert.ok((result.observation?.blocks ?? []).some(block => block.text.includes(text)), `final block "${text}": ${trail}`);
  }
}

for (const pattern of MANIFEST.patterns) {
  for (const check of pattern.checks) {
    const name = `${pattern.id}: ${check.id}${check.finding ? ` (${check.finding})` : ''}`;
    test(name, check.finding ? { todo: check.finding } : {}, async t => {
      const page = await open(t, pattern.file);
      if (check.run) return checkRun(page, check.run, check.expect);
      const allow = CAPABILITIES[check.level ?? 'read-only'];
      const { observation, fill } = await runSteps(page, check.steps, allow);
      checkObservation(observation, fill, check.expect);
    });
  }
}

test('the manifest names every pattern page, and every page is in the manifest', () => {
  const files = new Set(MANIFEST.patterns.map(pattern => pattern.file));
  for (const pattern of MANIFEST.patterns) {
    assert.ok(pattern.id && pattern.exercises && pattern.checks.length, pattern.id);
    readFileSync(resolve(DIR, pattern.file));
  }
  const pages = ['nag-aria-dialog-x', 'nag-div-backdrop', 'nag-native-dialog', 'nag-bottom-sheet-app', 'cookie-plus-nag', 'task-dialog',
    'sticky-header', 'lazy-list', 'load-more', 'pagination', 'tabs-accordion', 'shadow-dom', 'iframe-same-origin', 'virtual-list',
    'controlled-input', 'custom-select', 'date-picker'];
  for (const page of pages) assert.ok(files.has(`${page}.html`), page);
});
