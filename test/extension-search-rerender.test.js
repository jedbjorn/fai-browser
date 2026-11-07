import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, directResult } from '../src/result.js';
import { PageBridge } from './helpers/page-bridge.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const FIXTURE = await readFile(new URL('../fixtures/search-rerender.html', import.meta.url), 'utf8');
const ORIGIN = 'https://example.com';

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(),
    args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

test('a real DOM rerender fills and submits supplied text exactly once without leaking it', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const bridge = new PageBridge(page, { level: 'interactive' });
  const runtime = new BrowserRuntime({ bridge });
  const initial = await runtime.observe({ mode: 'interactive', allowedOrigins: [ORIGIN], suppliedText: { query: 'blue kettle!' } });
  const fill = initial.actions.find(action => action.type === 'fill_supplied_text' && action.label === 'Search');
  assert.ok(fill);

  await page.evaluate(() => {
    const current = document.getElementById('query');
    current.replaceWith(current.cloneNode(true));
  });
  const result = await runtime.act({ actionId: fill.id, submit: true }, {
    revision: initial.observation.revision, expectation: { textIncludes: 'Search completed' },
  });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.verification.passed, true);
  assert.deepEqual(bridge.executions.map(action => action.type), ['fill_supplied_text', 'fill_supplied_text', 'submit_field']);
  assert.deepEqual(await page.evaluate(() => ({ inputs: window.inputCount, submits: window.submitCount })), { inputs: 1, submits: 1 });
  assert.equal(await page.locator('#query').inputValue(), 'blue kettle!');
  const lean = agentResult(result);
  assert.ok(!JSON.stringify(lean).includes('blue kettle!'));
  assert.ok(!JSON.stringify(directResult(lean)).includes('blue kettle!'));
});
