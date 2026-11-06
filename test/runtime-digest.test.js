// Digest and answer-candidate selection (src/digest.js) on the benchmark fixture pages, modelled as the page script
// reports them: blocks in document order, nav links as `a` blocks with refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksOf, buildDigest, pickAnswerCandidates, stem, tokenize } from '../src/digest.js';
import { compactPage } from '../src/result.js';

const NAV = ['Home', 'About', 'Pricing', 'Docs', 'Catalog', 'Contact', 'Reconciliation status']
  .map((text, i) => ({ t: 'a', text, ref: String(i + 1) }));
const FOOTER = { t: 'p', text: 'Lanternfish Cloud is a fictional product used for benchmark fixtures.' };
const MEMBERS = [
  'Mira Okafor — Founder and API design',
  'Tomas Lindqvist — Infrastructure',
  'Priya Raman — Documentation lead',
  'Jonah Weiss — Support',
  'Elif Demir — Billing and plans',
];

function page(title, blocks, { text } = {}) {
  return {
    revision: 'r1',
    url: `https://fixture.test/${title.toLowerCase()}`,
    title,
    text: text ?? blocks.map(block => block.text).join('\n'),
    controls: NAV.map(block => ({ id: block.ref, role: 'link', label: block.text })),
    blocks,
  };
}

const ABOUT = page('About Lanternfish', [
  ...NAV,
  { t: 'h1', text: 'About Lanternfish' },
  { t: 'p', text: 'Lanternfish Cloud is built by a small distributed team.' },
  { t: 'h2', text: 'Members' },
  ...MEMBERS.map(text => ({ t: 'li', text })),
  { t: 'p', text: 'Former contributors are listed in the changelog, not here.' },
  FOOTER,
]);

const PRICING = page('Pricing', [
  ...NAV,
  { t: 'h1', text: 'Pricing' },
  { t: 'tr', text: 'Plan Monthly Yearly Seats' },
  { t: 'tr', text: 'Starter $12 per month $120 per year 2' },
  { t: 'tr', text: 'Pro $37 per month $370 per year 10' },
  { t: 'tr', text: 'Team $96 per month $960 per year 40' },
  { t: 'h2', text: 'Plan details' },
  { t: 'label', text: 'Plan Starter Pro Team', ref: '8' },
  { t: 'button', text: 'Show plan details', ref: '9' },
  FOOTER,
]);

const AUTH = page('Authentication', [
  ...NAV,
  { t: 'p', text: 'Docs › API reference › Authentication' },
  { t: 'a', text: 'API reference', ref: '9' },
  { t: 'h1', text: 'Authentication' },
  { t: 'p', text: 'Every request must carry your workspace token. Send it in the X-Lanternfish-Token HTTP header.' },
  { t: 'p', text: 'Older SDKs used the Authorization header with a Bearer token. That form is deprecated and will be '
    + 'rejected after June.' },
  FOOTER,
]);

const Q = {
  about: 'What are the names of the members listed on the About page? Give all of them, comma-separated.',
  pricing: 'What is the monthly price of the Pro plan?',
  auth: 'Which HTTP header does the API authentication page in the docs say to send your token in? Answer with the '
    + 'header name only.',
};

test('stemming and tokenizing are light and drop question filler only from queries', () => {
  assert.equal(stem('members'), 'member');
  assert.equal(stem('monthly'), stem('month'));
  assert.equal(stem('pricing'), stem('price'));
  assert.equal(stem('headers'), stem('header'));
  assert.deepEqual(tokenize('What are the names of the members?', { query: true }), ['member']);
  assert.deepEqual(tokenize('What is'), ['what', 'is']);
});

test('about-members: the list under the matching heading is one candidate, its items in order', () => {
  const candidates = pickAnswerCandidates(ABOUT, Q.about);
  assert.equal(candidates[0].t, 'list');
  assert.equal(candidates[0].items, MEMBERS.length);
  assert.equal(candidates[0].text, MEMBERS.join('; '));
  assert.ok(!candidates.some(candidate => MEMBERS.includes(candidate.text)), 'no single row competes with the list');
  assert.ok(candidates.every(candidate => candidate.t !== 'h2'), 'headings label answers; they are not candidates');
  const { digest } = buildDigest(ABOUT, Q.about);
  const texts = digest.map(block => block.text);
  for (const member of MEMBERS) assert.ok(texts.includes(member));
  assert.ok(texts.includes('About Lanternfish'), 'the first h1 is always included');
  assert.ok(texts.indexOf('Members') < texts.indexOf(MEMBERS[0]), 'document order is kept');
});

test('pricing-pro: the Pro row ranks first and the digest keeps the table header row', () => {
  const [first] = pickAnswerCandidates(PRICING, Q.pricing);
  assert.deepEqual({ t: first.t, text: first.text }, { t: 'tr', text: 'Pro $37 per month $370 per year 10' });
  const { digest } = buildDigest(PRICING, Q.pricing);
  const texts = digest.map(block => block.text);
  assert.ok(texts.includes('Plan Monthly Yearly Seats'));
  assert.ok(texts.indexOf('Plan Monthly Yearly Seats') < texts.indexOf('Pro $37 per month $370 per year 10'));
});

test('docs-auth-header: the sentence that names the header ranks first', () => {
  const candidates = pickAnswerCandidates(AUTH, Q.auth);
  assert.match(candidates[0].text, /X-Lanternfish-Token/);
  assert.equal(candidates[0].t, 'p');
  assert.ok(candidates.length <= 12);
});

test('digest is bounded by blocks and characters, deduplicated and in document order', () => {
  const blocks = [{ t: 'h1', text: 'Catalog' }];
  for (let i = 0; i < 150; i++) blocks.push({ t: 'li', text: `Catalog item ${i} lamp wallet ${'x'.repeat(80)}` });
  blocks.push({ t: 'li', text: blocks[1].text });
  const observation = page('Catalog', blocks);
  const { digest, truncated } = buildDigest(observation, 'Which catalog item is a lamp?');
  assert.ok(digest.length <= 25);
  assert.ok(digest.reduce((sum, block) => sum + block.text.length, 0) <= 1500);
  assert.equal(truncated, true);
  assert.equal(digest[0].text, 'Catalog');
  assert.equal(new Set(digest.map(block => block.text)).size, digest.length);
  const custom = buildDigest(observation, 'lamp', { maxBlocks: 3, maxChars: 5000 });
  assert.equal(custom.digest.length, 3);
});

test('a page with no matching terms still gets a readable digest of its leading content', () => {
  const { digest } = buildDigest(ABOUT, 'Summarize this');
  assert.ok(digest.length > 0);
  assert.equal(digest[0].t, 'h1');
  assert.ok(digest.every(block => block.t !== 'a'), 'filler skips navigation links');
  assert.deepEqual(pickAnswerCandidates(ABOUT, 'Summarize this'), []);
});

test('without page-script blocks, blocks are derived from text lines, control labels and the title', () => {
  const observation = {
    url: 'https://fixture.test/pricing',
    title: 'Pricing',
    text: 'Home\nPricing\nPlan\tMonthly\nPro\t$37 per month\n\nAll prices exclude tax.',
    controls: [{ id: '1', role: 'link', label: 'Home' }, { id: '2', role: 'password', label: 'x', type: 'password' }],
  };
  assert.deepEqual(blocksOf(observation), [
    { t: 'a', text: 'Home', ref: '1' },
    { t: 'h1', text: 'Pricing' },
    { t: 'tr', text: 'Plan Monthly' },
    { t: 'tr', text: 'Pro $37 per month' },
    { t: 'p', text: 'All prices exclude tax.' },
  ]);
  assert.equal(pickAnswerCandidates(observation, Q.pricing)[0].text, 'Pro $37 per month');
});

test('block input is normalized: unknown types become p, text is clipped to 300, at most 200 blocks', () => {
  const blocks = Array.from({ length: 250 }, (_, i) => ({ t: i ? 'p' : 'marquee', text: `  block   ${i} ${'y'.repeat(400)}` }));
  const normalized = blocksOf({ blocks });
  assert.equal(normalized.length, 200);
  assert.equal(normalized[0].t, 'p');
  assert.equal(normalized[0].text.length, 300);
  assert.ok(normalized[0].text.startsWith('block 0'));
});

test('compactPage returns the digest and a 600-character excerpt, without controls', () => {
  const long = page('About Lanternfish', ABOUT.blocks, { text: 'z'.repeat(2000) });
  const summary = compactPage(long, Q.about);
  assert.deepEqual(Object.keys(summary), ['url', 'title', 'digest', 'textExcerpt', 'truncated']);
  assert.equal(summary.textExcerpt.length, 600);
  assert.equal(summary.truncated, true);
  assert.ok(summary.digest.some(block => block.text === MEMBERS[0]));
  assert.equal(compactPage({ ...ABOUT, text: 'short' }, Q.about).truncated, false);
  assert.equal(compactPage({ ...ABOUT, text: 'short', blocksTruncated: true }, Q.about).truncated, true);
});

test('digest of 200 full-length blocks stays in the low milliseconds', () => {
  const words = 'alpha beta gamma delta pricing plan member monthly support ledger timezone batch wallet lamp'.split(' ');
  const make = k => ({
    url: 'https://fixture.test/', title: 't', text: '', controls: [],
    blocks: Array.from({ length: 200 }, (_, i) => ({
      t: i % 10 ? 'p' : 'h2',
      text: Array.from({ length: 45 }, (_, j) => `${words[(i * 7 + j * 3 + k) % words.length]}${k % 5}`).join(' ').slice(0, 300),
    })),
  });
  for (let i = 0; i < 20; i++) buildDigest(make(i), Q.pricing);
  // Best of three batches. On a quiet machine this measures about 1.5 ms; the bound is looser because npm test runs
  // every file in parallel. It still catches an algorithmic regression (anything quadratic in blocks).
  let average = Infinity;
  for (let batch = 0; batch < 3; batch++) {
    const pages = Array.from({ length: 30 }, (_, i) => make(batch * 100 + i + 100));
    const started = performance.now();
    for (const observation of pages) buildDigest(observation, Q.pricing);
    average = Math.min(average, (performance.now() - started) / pages.length);
  }
  assert.ok(average < 10, `average ${average.toFixed(3)} ms`);
});

// A flight results page as the page script reports it (bench/long flights-live, and the Google Flights page of the
// 2026-10-08 live run): a long preamble whose filter buttons repeat question words, a "Top flights" list whose
// heading is followed by a subtitle and sort controls before its rows, then a longer "Other flights" list, mostly off
// screen. The digest once kept one top row and every other row: the subtitle and buttons broke the heading's bonus
// to its rows, so the later list's rows outscored them and filled the budget by score.
const TOP_FLIGHTS = [
  '6:10 AM – 7:50 AM · Ryanair · Operated by Malta Air · 1 hr 40 min · MRS–STN · Nonstop · €44 · Select flight',
  '11:55 AM – 1:35 PM · British Airways · 1 hr 40 min · MRS–LHR · Nonstop · €89 · Select flight',
  '7:35 AM – 9:15 AM · easyJet · Operated by easyJet Europe · 1 hr 40 min · MRS–LGW · Nonstop · €96 · Select flight',
  '12:20 PM – 1:25 PM · British Airways · 2 hr 5 min · MRS–LHR · Nonstop · €187 · Select flight',
];
const OTHER_FLIGHTS = [
  '6:30 AM – 9:30 AM · KLM · Operated by KLM Cityhopper, German Airways · 4 hr · MRS–LHR · 1 stop · 55 min AMS · €127 · Select flight',
  '6:05 AM – 9:00 AM · Air France · 3 hr 55 min · MRS–LHR · 1 stop · 1 hr 5 min CDG · €128 · Select flight',
  '7:30 AM – 10:30 AM · Air France · 4 hr · MRS–LHR · 1 stop · 1 hr CDG · €128 · Select flight',
  '10:15 AM – 12:50 PM · Vueling · 3 hr 35 min · MRS–LGW · 1 stop · 1 hr 10 min BCN · €79 · Select flight',
  '10:40 AM – 12:20 PM · easyJet · Operated by easyJet Europe · 1 hr 40 min · MRS–LGW · Nonstop · €74 · Select flight',
  '12:05 PM – 1:45 PM · Ryanair · 1 hr 40 min · MRS–STN · Nonstop · €48 · Select flight',
  '6:20 PM – 9:25 PM · Air France · 4 hr 5 min · MRS–LHR · 1 stop · 1 hr 5 min CDG · €128 · Select flight',
  '9:45 PM – 9:10 AM+1 · Lufthansa · Operated by Lufthansa CityLine · 12 hr 25 min · MRS–LHR · 1 stop · FRA · €142 · Select flight',
  '12:13 PM – 6:20 PM · AccesRail, Air France · Operated by Sncf for Accesrail · 7 hr 7 min · 4 stops · QXB, XZN, XYD, CDG · €174 · Select flight',
];
const FLIGHT_RESULTS = {
  url: 'https://flights.test/search?tfs=CBwQAhooEgoyMDI3LTAxLTEy',
  title: 'Marseille to London | Flights',
  text: '',
  controls: [],
  blocks: [
    ...['Skip to main content', 'Explore', 'Flights', 'Hotels'].map((text, i) => ({ t: 'button', text, ref: String(i + 1) })),
    { t: 'h1', text: 'Flight search' },
    { t: 'button', text: '1', ref: '5' },
    { t: 'h2', text: 'Filters' },
    ...['All filters', 'Stops', 'Airlines', 'Bags', 'Price', 'Times', 'Emissions', 'Connecting airports', 'Duration']
      .map((text, i) => ({ t: 'button', text, ref: String(i + 6) })),
    { t: 'h2', text: 'Search results' },
    { t: 'p', text: 'Best' },
    { t: 'p', text: 'Cheapest' },
    { t: 'p', text: 'from €44' },
    { t: 'h3', text: 'Top flights' },
    { t: 'p', text: 'Ranked based on price and convenience. Prices include required taxes + fees for 1 adult. Optional charges and bag fees may apply.' },
    { t: 'button', text: 'bag fees', ref: '20' },
    { t: 'button', text: 'Passenger assistance', ref: '21' },
    { t: 'button', text: 'Sorted by top flights', ref: '22' },
    ...TOP_FLIGHTS.map(text => ({ t: 'li', text })),
    { t: 'h3', text: 'Price insights' },
    { t: 'p', text: 'Prices are currently typical' },
    { t: 'p', text: 'Track prices from Marseille to London departing 2027-01-12. Track prices from Marseille to London - Any dates' },
    { t: 'button', text: 'Date grid', ref: '23' },
    { t: 'button', text: 'Price graph', ref: '24' },
    { t: 'h3', text: 'Other flights' },
    ...OTHER_FLIGHTS.map(text => ({ t: 'li', text, offscreen: true })),
    { t: 'button', text: 'View more flights', ref: '25', offscreen: true },
    { t: 'p', text: 'Displayed currencies may differ from the currencies used to purchase flights. Learn more', offscreen: true },
    { t: 'p', text: 'Prices are final prices and include all taxes and fees, including payment fees for the cheapest common payment '
      + 'method (which may differ depending on the provider). Additional charges may apply for other types of payment, '
      + 'luggage, meals, WLAN or other additional services.', offscreen: true },
  ],
};
const FLIGHT_QUESTION = 'What is the cheapest flight departing before noon on 12 January, with its departure time, airline and price?';

test('flight results: every "Top flights" row survives in the digest, whole and in order, before the other list', () => {
  const { digest, truncated } = buildDigest(FLIGHT_RESULTS, FLIGHT_QUESTION);
  const texts = digest.map(block => block.text);
  assert.equal(truncated, true, 'the page does not fit: the budget is the default one');
  assert.ok(texts.length <= 25 && texts.join('').length <= 1500, `${texts.length} blocks, ${texts.join('').length} chars`);
  // Every top row, in page order, and none clipped (a row cut at the end loses its price).
  const topAt = TOP_FLIGHTS.map(text => texts.indexOf(text));
  assert.ok(topAt.every(at => at >= 0), JSON.stringify(texts));
  assert.deepEqual(topAt, [...topAt].sort((a, b) => a - b));
  assert.ok(!digest.some(block => block.t === 'li' && block.text.endsWith('…')), JSON.stringify(texts));
  // The other list keeps its first rows, in order, after the top list and under its heading; the top list is never
  // starved by it.
  const otherAt = OTHER_FLIGHTS.map(text => texts.indexOf(text)).filter(at => at >= 0);
  assert.ok(otherAt.length >= 3, JSON.stringify(texts));
  assert.ok(otherAt[0] > Math.max(...topAt));
  assert.deepEqual(otherAt, [...otherAt].sort((a, b) => a - b));
  assert.ok(texts.indexOf(OTHER_FLIGHTS[0]) >= 0 && texts.indexOf(OTHER_FLIGHTS[1]) >= 0, 'the earliest rows first');
  assert.ok(texts.indexOf('Top flights') < topAt[0] && texts.indexOf('Other flights') < otherAt[0]);
  // The page's own day is still there for the host to check.
  assert.ok(texts.some(text => text.includes('departing 2027-01-12')), JSON.stringify(texts));
});

test('flight results: a heading followed by a subtitle and sort controls still passes its score to its rows', () => {
  // The top rows rank with the other list's rows (not below them): the lead of at most four blocks keeps the decaying
  // share, the rows get the heading's score, as rows right under the heading do.
  // Compared on rows without a question word of their own ("12" is one): the first row of each list.
  const candidates = pickAnswerCandidates(FLIGHT_RESULTS, FLIGHT_QUESTION);
  const score = text => candidates.find(candidate => candidate.text === text)?.score ?? 0;
  const top = score(TOP_FLIGHTS[0]);
  const other = score(OTHER_FLIGHTS[0]);
  assert.ok(top > 0 && top >= other, `top ${top} other ${other}`);
  assert.ok(TOP_FLIGHTS.every(text => candidates.some(candidate => candidate.text === text)), 'every top row is a candidate');
});
