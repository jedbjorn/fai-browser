// Competing record lists (fixtures/records/lists-*.html, invented content): a page whose cheapest priced thing sits in
// another list than the results the question is about. Each trait in two markups:
// - a carousel of priced extras above the results (a strip that scrolls on the x axis; one clipped row wider than
//   the viewport);
// - a "similar items" or "recently viewed" module (a bigger grid after the results; a list before the result count);
// - a sponsored strip (a row of ad cards above the count; a bigger "promoted" list after the results).
// Run in headless Chromium through extension/page.js (the position signals it sends with each list), then the core with
// a mock provider that answers the `lists` question (src/typesafe.js) as a reader of the page would: the list of the
// question's items, and, as its answer pick, one of them that is not the cheapest. The aggregation then reads the
// chosen list and the complete minimum is the answer (src/runtime.js listChoice, aggregateOverride). CHROMIUM_PATH
// overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { recordListsOf } from '../src/digest.js';
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

async function observe(t, html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page.evaluate(() => __faiPage.observe());
}

/**
 * One run on the observed page with a provider that chooses the list whose first title matches `results` (at 0.9)
 * and picks, as its answer, the whole line of the item `pick` names (another item of that list than the cheapest), or
 * answers no lists question at all (`lists: false`).
 */
async function answer(observation, question, expectation, { results, pick, lists = true } = {}) {
  const { scroll, ...still } = observation;
  const bridge = {
    async observe() { return structuredClone(still); },
    async execute() { throw Object.assign(new Error('no actions here'), { code: 'target_unavailable' }); },
  };
  const requests = [];
  const provider = {
    model: 'x',
    async decide() { return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } }; },
    async choose(request) {
      requests.push(request);
      const named = request.candidates.filter(candidate => pick.test(candidate.text))
        .sort((a, b) => b.text.length - a.text.length);
      const reply = { choice: (named[0] ?? request.candidates[0]).id, confidence: 0.9 };
      const wanted = request.lists?.find(entry => results.test(entry.titles[0] ?? ''));
      if (lists && wanted) reply.lists = { choice: wanted.list, confidence: 0.9 };
      return reply;
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Read the results listed.', {
    mode: 'read-only', capture: 'none', expectation, answerQuestion: question,
  });
  const lean = agentResult(result);
  return { result, lean, why: lean.verdict.why, request: requests.at(-1) };
}

const CASES = [
  {
    trait: 'a carousel of priced add-ons above the stays (a strip that scrolls on the x axis)',
    file: 'lists-addons-strip.html', results: /^(?:Linden|Quayside|Mill Street|Old Granary|Tannery)/, decoy: /Luggage storage|City bike/,
    question: 'Which stay rated 4.5 or more is cheapest per night, with its name and price?', expectation: { textIncludes: 'stays found' },
    answer: /Quayside Guesthouse.*€ 131/, pick: /Linden Court Rooms/, other: { carousel: true },
  },
  {
    trait: 'a row of experiences wider than the viewport (clipped, no scrolling) above the apartments',
    file: 'lists-experiences-rail.html', results: /^(?:Canal View|Brick Lane|Garden House|Market Square)/, decoy: /Experience 1\b/,
    question: 'Which apartment rated 4.5 or more is cheapest a night, with its name and price?', expectation: { textIncludes: 'apartments found' },
    answer: /Brick Lane Studio.*€ 88/, pick: /Canal View Apartment/, other: { carousel: true },
  },
  {
    trait: 'a bigger "similar items" grid of cheaper picks after the results, both inside main and after the count',
    file: 'lists-similar-after.html', results: /^(?:Trail runner|Road racer|Court classic|Hiking mid)/, decoy: /Similar pick/,
    question: 'Which shoe rated 4.5 or more is cheapest, with its name and price?', expectation: { textIncludes: '4 results' },
    answer: /Court classic shoe.*\$72\.00/, pick: /Trail runner shoe/,
  },
  {
    trait: 'a "recently viewed" list of cheaper desks before the result count',
    file: 'lists-recent-before.html', results: /^(?:Oak standing|Walnut writing|Pine corner|Ash folding)/, decoy: /Viewed desk/,
    question: 'Which desk rated 4.5 or more is cheapest, with its name and price?', expectation: { textIncludes: '4 products' },
    answer: /Ash folding desk.*\$189/, pick: /Oak standing desk/,
  },
  {
    trait: 'a sponsored row of cheaper lamps above the count, then the result rows',
    file: 'lists-sponsored-row.html', results: /^(?:Arc floor|Clamp desk|Brass banker|Paper globe|LED task)/, decoy: /Sponsored lamp/,
    question: 'Which lamp rated 4.5 or more is cheapest, with its name and price?', expectation: { textIncludes: '5 products' },
    answer: /Clamp desk lamp.*\$34\.00/, pick: /Arc floor lamp/,
  },
  {
    trait: 'a bigger "promoted" list of cheaper offers after the tents, both inside main and after the count',
    file: 'lists-promoted-after.html', results: /^(?:Ridge two|Dome family|Ultralight solo|Tunnel trek)/, decoy: /Promoted offer/,
    question: 'Which tent rated 4.5 or more is cheapest, with its name and price?', expectation: { textIncludes: '4 items found' },
    answer: /Tunnel trek tent.*€ 159/, pick: /Dome family tent/,
  },
];

for (const entry of CASES) {
  test(`competing lists, ${entry.trait}: the provider's list is read, its complete minimum confirmed`, async t => {
    const observation = await observe(t, await fixture(entry.file));
    const lists = recordListsOf(observation);
    assert.ok(lists.length >= 2, JSON.stringify(observation.recordLists));
    const ours = lists.find(item => entry.results.test(item.titles[0] ?? ''));
    const theirs = lists.find(item => item !== ours);
    assert.ok(ours && theirs, JSON.stringify(lists));
    for (const [flag, value] of Object.entries(entry.other ?? {})) assert.equal(theirs[flag], value, JSON.stringify(theirs));
    assert.ok(!ours.carousel, 'the results are no carousel');
    const { result, lean, why, request } = await answer(observation, entry.question, entry.expectation, { results: entry.results, pick: entry.pick });
    assert.equal(result.status, 'completed');
    assert.equal(request.lists.length, lists.length, 'the lists question was asked');
    assert.ok(why.includes(`lists:provider:${ours.list}`), why.join(' '));
    assert.match(lean.verdict.answer?.text ?? '', entry.answer, why.join(' '));
    assert.doesNotMatch(lean.verdict.answer.text, entry.decoy);
    // The provider's answer pick was another item of the list: the computed minimum overrides it.
    assert.ok(why.includes('answer:aggregate_overrides'), why.join(' '));
    assert.equal(result.answerDetail.aggregate.pick, 'item');
  });
}

test('competing lists without a lists reply: the page script\'s order stands, and nothing confirms a pick from another list', async t => {
  for (const entry of CASES) {
    const observation = await observe(t, await fixture(entry.file));
    const { lean, why } = await answer(observation, entry.question, entry.expectation, { results: entry.results, pick: entry.pick, lists: false });
    assert.ok(why.includes('lists:fallback:no_reply'), why.join(' '));
    // Either the page script's best list is the results (and the minimum is confirmed) or it is not (and the
    // provider's pick, a result, disagrees with the aggregation): never a decoy.
    assert.doesNotMatch(lean.verdict.answer?.text ?? '', entry.decoy, `${entry.file}: ${why.join(' ')}`);
    if (lean.verdict.answer) assert.match(lean.verdict.answer.text, entry.answer, entry.file);
  }
});
