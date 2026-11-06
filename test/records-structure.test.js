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
import { buildDigest } from '../src/digest.js';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const fixture = name => readFile(new URL(`../fixtures/records/${name}`, import.meta.url), 'utf8');

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function observe(t, html, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page.evaluate(() => __faiPage.observe());
}

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

const titles = (observation, list) => observation.records.filter(record => record.list === list).map(record => record.title);
const all = record => [record.title, ...record.fields].join(' · ');

test('card parts and modules: four part boxes per card stay one record; the inserts are none; the strip of experiences is its own list', async t => {
  const observation = await observe(t, await fixture('stays-modules.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 7, kept: 7, afterCount: true }, { list: 1, total: 6, kept: 6, afterCount: true, carousel: true }]);
  assert.deepEqual(titles(observation, 0), ['Casa do Mirante', 'Pensão Azulejo', 'Quinta das Gaivotas', 'Hostel Ribeira',
    'Solar dos Arcos', 'Residencial Tejo', 'Palácio Verde'], 'the cards, not their part boxes');
  assert.equal(titles(observation, 1)[0], 'Tram 28 hop-on tour');
  const text = observation.records.map(all).join('\n');
  assert.doesNotMatch(text, /Ranking may depend|Travel more|Popular filters|Option 0a/, 'no notice, promo or filter group is a record');
  const casa = observation.records[0];
  assert.deepEqual([casa.hints.rating, casa.hints.reviews, casa.hints.price], [8.6, 1204, '€ 512']);
  assert.deepEqual([observation.records[7].hints.rating, observation.records[7].hints.scale], [4.62, 5], '"4.62 (812 reviews)" is a 5-point rating');
  // The digest holds whole cards, each name once.
  const { digest } = buildDigest(observation, 'Which stay is cheapest?');
  for (const block of digest.filter(item => item.rec)) assert.ok(!/Scored|Price €/.test(block.text.split(' · ')[0]), block.text);
  const question = 'Which stay with a rating of 8 or more is cheapest for the 4 nights, with its name, price for the stay and rating?';
  const { result, lean } = await answer(observation, question, { textIncludes: 'stays found' });
  assert.equal(result.status, 'completed');
  // "4 nights, 2 adults € 344" and "Price € 344" are one price, not an ambiguous one; the €19 museum ticket is no stay.
  assert.deepEqual(lean.answer.aggregate, { op: 'min', measure: 'price', items: 5, states: 1, partial: false });
  assert.match(lean.verdict.answer?.text ?? '', /Hostel Ribeira.*Scored 8\.2.*€ 344/, lean.verdict.why.join(' '));
});

test('card sections in li > article: the app banner li is no record, the snapping rail is a list of its own, the guest score beats the star class', async t => {
  const observation = await observe(t, await fixture('hits-sections.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 6, kept: 6, main: true, afterCount: true },
    { list: 1, total: 5, kept: 5, main: true, afterCount: true, carousel: true }]);
  assert.deepEqual(titles(observation, 0), ['Harbour Loft', 'Kanal Rooms', 'Nørre Garden House', 'Vester Budget Beds',
    'Østerport Suites', 'Islands Brygge Flat']);
  assert.ok(!observation.records.some(record => /Get the app/.test(all(record))));
  const loft = observation.records[0];
  assert.deepEqual([loft.hints.rating, loft.hints.scale], [8.2, 10], '"Very good 8.2", next to the review count, is the rating');
  assert.deepEqual(loft.hints.ratings, [{ value: 4, scale: 5 }, { value: 8.2, scale: 10 }]);
  const trip = observation.records.find(record => record.title === 'Kronborg castle trip');
  assert.equal(trip.hints.price, '$ 45', '"4.7 out of 5 $ 45": the "5" is the scale, not an amount');
  const { lean } = await answer(observation, 'Which place rated 8 or more is cheapest, with its name and price?', { textIncludes: '6 results' });
  // A bound of 8 reads the 10-point score: the 4-star class never fails it, the US$ 88 dorm (6.9) is out.
  assert.equal(lean.answer.aggregate.items, 4);
  assert.match(lean.verdict.answer?.text ?? '', /Harbour Loft.*US\$ 238/, lean.verdict.why.join(' '));
});

test('a carousel above the results: a strip that scrolls on the x axis ranks after the result rows, and its deals are no answer', async t => {
  const observation = await observe(t, await fixture('carousel-above.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 6, kept: 6, main: true, afterCount: true },
    { list: 1, total: 12, kept: 12, main: true, carousel: true }]);
  assert.equal(titles(observation, 0)[0], 'Fietsenwinkel Oudegracht');
  assert.equal(titles(observation, 1)[0], 'Weekend deal 1');
  const { lean } = await answer(observation, 'Which bike rental is cheapest, and what does it cost?', { textIncludes: 'rentals found' });
  assert.match(lean.verdict.answer?.text ?? '', /Tandem Utrecht.*€ 10 \/ day/, lean.verdict.why.join(' '));
  assert.doesNotMatch(lean.verdict.answer?.text ?? '', /Weekend deal/);
});

test('a carousel in one row wider than the viewport (clipped, no scrolling, no landmark) ranks after the product grid', async t => {
  const observation = await observe(t, await fixture('snap-row.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 5, kept: 5, afterCount: true }, { list: 1, total: 12, kept: 12, carousel: true }]);
  assert.deepEqual(titles(observation, 0), ['Arc floor lamp', 'Clamp desk lamp', 'Brass banker lamp', 'LED task light', 'Paper globe lamp']);
  const { lean } = await answer(observation, 'Which lamp rated 4.5 or more is cheapest, with its name and price?', { textIncludes: '5 products' });
  assert.match(lean.verdict.answer?.text ?? '', /LED task light.*\$29\.00/, lean.verdict.why.join(' '));
});

test('a bigger list above the results: the list after the result count wins over a "popular" grid; filter counts are no result count', async t => {
  const observation = await observe(t, await fixture('related-above.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 4, kept: 4, afterCount: true }, { list: 1, total: 9, kept: 9 }]);
  assert.deepEqual(titles(observation, 0), ['Raekoja Loft', 'Kalamaja Wooden House', 'Rotermann Studio', 'Telliskivi Flat']);
  const { lean } = await answer(observation, 'Which apartment rated 8 or more is cheapest per night, with its name and price?', { textIncludes: 'apartments found' });
  assert.match(lean.verdict.answer?.text ?? '', /Rotermann Studio.*€ 74/, lean.verdict.why.join(' '));
});

test('a bigger list outside main: the results inside the main landmark win over a "recently viewed" column', async t => {
  const observation = await observe(t, await fixture('aside-list.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 4, kept: 4, main: true }, { list: 1, total: 8, kept: 8 }]);
  assert.equal(titles(observation, 0)[0], 'Pine Hollow Cabin');
  const { lean } = await answer(observation, 'Which cabin rated 4.5 or more is cheapest, with its name and price?', { textIncludes: 'Cabins by the lake' });
  assert.match(lean.verdict.answer?.text ?? '', /Pine Hollow Cabin.*\$185/, lean.verdict.why.join(' '));
});

test('heterogeneous cards: a badge with two extra wrappers, or a section with a definition list, is still a card of the list', async t => {
  const observation = await observe(t, await fixture('mixed-cards.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 7, kept: 7, afterCount: true }]);
  assert.deepEqual(titles(observation, 0), ['Old town walking tour', 'Salt mine guided visit', 'Vodka tasting evening',
    'Tatra mountains day trip', 'Pierogi cooking class', 'Auschwitz memorial tour', 'Wawel castle entry']);
  const { lean } = await answer(observation, 'Which tour rated 4.6 or more is cheapest, with its name and price?', { textIncludes: '7 tours' });
  assert.match(lean.verdict.answer?.text ?? '', /Tatra mountains day trip.*\$ 35/, lean.verdict.why.join(' '));
});

test('heterogeneous rows: featured rows in a nested frame are events of the list; the newsletter row between them is not', async t => {
  const observation = await observe(t, await fixture('mixed-rows.html'));
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 6, kept: 6, afterCount: true }]);
  assert.deepEqual(titles(observation, 0), ['Jazz on the quay', 'Northern lights concert', 'Stand-up night', 'Fjord film festival',
    'Chamber choir', 'Indie rock showcase']);
  const { lean } = await answer(observation, 'Which event rated 4.4 or more is cheapest, with its name and price?', { textIncludes: 'events found' });
  assert.match(lean.verdict.answer?.text ?? '', /Northern lights concert.*€ 21/, lean.verdict.why.join(' '));
});

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
