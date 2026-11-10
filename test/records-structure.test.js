// Record detection on the front-end traits that broke it on a live stay-results page (2026-10-10): each trait in two
// or more invented markups (fixtures/records/), run in headless Chromium through extension/page.js and then the core
// (digest, aggregation, auto-confirm) as a run would. The traits:
// - a card split into sibling part boxes (name, score, room, price) that form a group of their own inside it;
// - list wrappers whose depth-3 shape is the same for every child, with inserts between the cards (a ranking notice,
//   a promo, an app banner, a newsletter row) and a module of whole records inside one wrapper (a sideways strip);
// - a carousel (a strip that scrolls on the x axis, or one row wider than the viewport) above the main results;
// - a bigger secondary list above the results (a "popular" grid, a "recently viewed" column outside main);
// - heterogeneous cards: badges, extra wrappers, a section with a definition list, a featured frame;
// - a star class beside a guest score, a grade before its score, a decimal before its review count, and a price per
//   stay stated twice.
// No site rules: the fixtures are shapes, not copies. The last test reads the owner's saved live page when it is
// present (shared/, git-ignored) and checks generic facts only. CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

// One run on a single observed page: the provider ranks the first candidate at 0.97, as a confident ranker would. The
// page is read as it is: without its scroll position the runtime does not scroll a short page to load more (that path
// has its own tests), since this bridge executes nothing.
async function answer(observation, question, expectation) {
  const { scroll, ...still } = observation;
  const bridge = {
    async observe() { return structuredClone(still); },
    async execute() { throw Object.assign(new Error('no actions here'), { code: 'target_unavailable' }); },
  };
  const provider = {
    model: 'x',
    async decide() { return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } }; },
    async choose(request) { return { choice: request.candidates[0].id, confidence: 0.97 }; },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Read the results listed.', {
    mode: 'read-only', capture: 'none', expectation, answerQuestion: question,
  });
  return { result, lean: agentResult(result) };
}

// The owner's saved live results page (shared/page.html, git-ignored, never copied into the repo): JavaScript off, every
// network request blocked, the live viewport. Only generic facts are checked.
// FAI_SAVED_PAGE names another copy (a git worktree has no shared/).
const SAVED = process.env.FAI_SAVED_PAGE ? pathToFileURL(process.env.FAI_SAVED_PAGE) : new URL('../shared/page.html', import.meta.url);
const SAVED_SKIP = existsSync(SAVED) ? false : 'shared/page.html is absent (a saved live page kept only on the owner\'s machine)';

test('saved live results page: the main list follows the result count, every record named, priced or rated', { skip: SAVED_SKIP }, async t => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1140, height: 893 } });
  t.after(() => context.close());
  await context.route('**/*', route => (route.request().url().startsWith('file://') ? route.continue() : route.abort()));
  const page = await context.newPage();
  await page.goto(pathToFileURL(SAVED.pathname).href, { waitUntil: 'load', timeout: 60_000 });
  await page.evaluate(await readFile(PAGE_SCRIPT, 'utf8'));
  const observation = await page.evaluate(() => __faiPage.observe());
  const best = observation.records.filter(record => record.list === 0);
  assert.ok(best.length >= 15, JSON.stringify(observation.recordLists));
  for (const record of best) {
    assert.ok(record.title, JSON.stringify(record));
    assert.ok(record.hints?.rating !== undefined, `${record.title}: a rating hint`);
  }
  assert.ok(best.filter(record => record.hints?.price).length >= best.length * 0.6, 'most records carry a price hint');
  // The best list is the one after the "N properties found" line.
  const order = await page.evaluate(title => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let count = -1;
    for (let node = walker.nextNode(), i = 0; node; node = walker.nextNode(), i++) {
      if (count < 0 && /\d\s+properties found/i.test(node.nodeValue)) count = i;
      if (node.nodeValue.includes(title)) return { count, title: i };
    }
    return { count, title: -1 };
  }, best[0].title);
  assert.ok(order.count >= 0 && order.title > order.count, `the first record follows the result count: ${JSON.stringify(order)}`);
  const question = 'Which hotel with a rating of 8 or more is cheapest for the stay of 1-4 March 2027, with its name, price for the stay and rating?';
  const { result, lean } = await answer(observation, question, { textIncludes: 'properties found' });
  assert.equal(result.status, 'completed');
  assert.equal(lean.answer.aggregate?.op, 'min', JSON.stringify(lean.answer));
  const confirmed = lean.verdict.answer?.text ?? '';
  const record = best.find(item => confirmed.includes(item.title));
  assert.ok(record, `the answer names a record of the main list: ${confirmed}`);
  assert.ok(record.hints.rating >= 8 && record.hints.price, JSON.stringify(record.hints));
  // Cheapest among the main list's records rated 8 or more (on the 10-point score) with a price.
  const amount = text => Number(String(text).replace(/[^\d.]/g, ''));
  const eligible = best.filter(item => item.hints.price && (item.hints.scale ?? 10) > 5 && item.hints.rating >= 8 && !item.unavailable);
  assert.equal(amount(record.hints.price), Math.min(...eligible.map(item => amount(item.hints.price))));
});
