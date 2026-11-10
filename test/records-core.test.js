// Records in the core (src/digest.js recordsOf/blocksOf, src/facts.js, src/runtime.js answerPlan): a detected list of
// cards, tiles or rows (extension/page.js detectRecords) replaces its scattered blocks with one block per record, so
// the digest, the answer candidates, the fact memory and the aggregation read a card as one item: its name next to its
// price and rating. Synthetic observations shaped after a stay-search results page (live failure 2026-10-10: the
// digest interleaved prices with the wrong names and the best candidate was a room type and a price without a hotel).
// Fallbacks: without records the blocks, and every result built from them, are as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksOf, buildDigest, pickAnswerCandidates, recordsOf, recordText } from '../src/digest.js';
import { aggregateIntent, buildMemory, coverage, moneyValues, passesFilters, ratingBound, ratingFor, ratingsOf, ratingValue,
  valueNotes } from '../src/facts.js';

const ORIGIN = 'https://example.com';
const QUESTION = 'Which hotel with a rating of 8 or more is cheapest for the stay of 1-4 March 2027, with its name, price for the stay and rating?';

const CARDS = [
  { name: 'Altona', area: '10th arr., Paris', score: '7.8', word: 'Good', reviews: '5,041', room: 'Twin Room', price: '€ 310' },
  { name: 'Angleterre Hotel', area: '18th arr., Paris', score: '8.2', word: 'Very Good', reviews: '4,821', room: 'Double Room', price: '€ 299' },
  { name: 'New Home Saint Germain', area: '5th arr., Paris', score: '8.1', word: 'Very Good', reviews: '15', room: 'Apartment', price: '€ 552', sponsored: true },
  { name: 'Hotel Mimosa Paris', area: '10th arr., Paris', score: '7.5', word: 'Good', reviews: '3,113', room: 'Double Room with Private External Bathroom', price: '€ 176' },
  { name: 'Nord Est Hotel', area: '10th arr., Paris', score: '8.6', word: 'Fabulous', reviews: '2,002', room: 'Superior Double Room', soldOut: true },
  { name: 'Hotel Marais Grands Boulevards', area: '3rd arr., Paris', score: '8.4', word: 'Very Good', reviews: '1,207', room: 'Classic Twin Room', price: '€ 385' },
];

/**
 * A results page as the page script reports it: filter blocks, the alert, then each card as scattered blocks (the
 * live shape), and, unless `records: false`, the detected records with the indices of their blocks.
 */
function resultsPage({ cards = CARDS, records = true, more = false, truncated = false, cutBlocks = false } = {}) {
  const blocks = [
    { t: 'h2', text: 'Filter by:' },
    { t: 'h2', text: 'Your budget (per night)' },
    { t: 'p', text: '€ 40 – € 800+' },
    { t: 'label', text: 'Wonderful: 9+ 1397', ref: '3' },
    { t: 'alert', text: `Paris: ${cards.length} properties found` },
    { t: 'h2', text: 'Browse the results for Paris' },
  ];
  const recordList = [];
  const controls = [{ id: '3', role: 'checkbox', label: 'Wonderful: 9+', enabled: true }];
  cards.forEach((card, i) => {
    const ref = String(10 + i);
    controls.push({ id: ref, role: 'link', label: card.name, href: `${ORIGIN}/hotel/${i}`, enabled: true });
    const own = [
      ...(card.sponsored ? [{ t: 'p', text: 'Sponsored' }] : []),
      { t: 'h3', text: `${card.name} Opens in new window`, ref },
      { t: 'a', text: `${card.area}Show on map` },
      { t: 'a', text: `Scored ${card.score} ${card.word} ${card.reviews} reviews` },
      { t: 'h4', text: card.room },
      { t: 'li', text: '1 double bed' },
      ...(card.soldOut ? [{ t: 'p', text: 'Sold out on our site for your dates' }]
        : [{ t: 'p', text: '3 nights, 2 adults' }, { t: 'p', text: `Price ${card.price}` }, { t: 'p', text: 'Includes taxes and fees' }]),
      { t: 'a', text: 'See availability' },
    ];
    const indices = cutBlocks && i > 1 ? [] : own.map((_, k) => blocks.length + k);
    if (!(cutBlocks && i > 1)) blocks.push(...own);
    recordList.push({
      id: `r${i + 1}`, list: 0, title: card.name, href: `${ORIGIN}/hotel/${i}`, ref,
      fields: [...(card.sponsored ? ['Sponsored'] : []), `${card.area} Show on map`, `Scored ${card.score}`,
        `${card.word} ${card.reviews} reviews`, card.room, '1 double bed',
        ...(card.soldOut ? ['Sold out on our site for your dates'] : ['3 nights, 2 adults', `Price ${card.price}`])],
      hints: { ...(card.price ? { price: card.price } : {}), rating: Number(card.score) },
      ...(card.sponsored ? { sponsored: true } : {}),
      ...(card.soldOut ? { unavailable: true } : {}),
      ...(i > 1 ? { offscreen: true } : {}),
      blocks: indices,
    });
  });
  blocks.push({ t: 'h2', text: 'Sign in, save money' });
  if (more) {
    blocks.push({ t: 'button', text: 'Load more results', ref: '99' });
    controls.push({ id: '99', role: 'button', label: 'Load more results', enabled: true });
  }
  const observation = {
    url: `${ORIGIN}/searchresults.html?ss=Paris&checkin=2027-03-01&checkout=2027-03-04`,
    title: 'Search results: Paris',
    text: `Paris: ${cards.length} properties found\n${cards.slice(0, 2).map(card => card.name).join('\n')}`,
    blocks,
    controls,
  };
  if (records) {
    observation.records = recordList;
    observation.recordLists = [{ list: 0, total: truncated ? cards.length + 20 : cards.length, kept: cards.length }];
    observation.recordsTruncated = truncated;
  }
  return observation;
}

test('a detected list replaces its scattered blocks with one block per record, in list order, where the list began', () => {
  const observation = resultsPage();
  const blocks = blocksOf(observation);
  const records = blocks.filter(block => block.rec);
  assert.equal(records.length, CARDS.length);
  assert.deepEqual(records.map(block => block.rec), CARDS.map((_, i) => `r${i + 1}`));
  // Nothing of a card is left as a stray block, and the blocks around the list are unchanged.
  assert.ok(!blocks.some(block => !block.rec && /See availability|Opens in new window|^Price €/.test(block.text)));
  const at = blocks.findIndex(block => block.rec);
  assert.equal(blocks[at - 1].text, 'Browse the results for Paris');
  assert.equal(blocks.at(-1).text, 'Sign in, save money');
  // One record is one line: the name first, then its fields, the price and the rating beside it.
  assert.equal(records[0].t, 'li');
  assert.equal(records[0].text, 'Altona · 10th arr., Paris Show on map · Scored 7.8 · Good 5,041 reviews · Twin Room · 1 double bed · 3 nights, 2 adults · Price € 310');
  assert.equal(records[0].ref, '10');
  assert.ok(records[2].offscreen && !records[0].offscreen);
});

test('without records, or with fewer than three, the blocks are exactly what they were', () => {
  const plain = resultsPage({ records: false });
  const before = blocksOf(plain);
  assert.deepEqual(before, blocksOf({ ...plain, records: [] }));
  const two = resultsPage();
  two.records = two.records.slice(0, 2);
  assert.deepEqual(blocksOf(two), before, 'a list of two records is not a list');
  assert.deepEqual(buildDigest({ ...plain }, QUESTION), buildDigest(two, QUESTION));
});

test('the digest keeps every record whole and in order; no price sits next to another card\'s name', () => {
  const { digest } = buildDigest(resultsPage(), QUESTION);
  const rows = digest.filter(block => block.t === 'li');
  assert.ok(rows.length >= 4, JSON.stringify(digest));
  assert.deepEqual(rows.map(row => row.text.split(' · ')[0]), CARDS.slice(0, rows.length).map(card => card.name));
  for (const row of rows) {
    const card = CARDS.find(item => row.text.startsWith(item.name));
    assert.ok(row.text.includes(`Scored ${card.score}`), row.text);
    if (card.price) assert.ok(row.text.includes(card.price), row.text);
    assert.ok(!row.text.endsWith('…'), 'never clipped');
  }
  assert.ok(!digest.some(block => /See availability [A-Z]/.test(block.text)), 'no button text merged into a name');
});

test('records cut by the page script\'s block cap still count, after the other blocks; a block two records share is not a row', () => {
  const observation = resultsPage({ cutBlocks: true });
  const records = blocksOf(observation).filter(block => block.rec);
  assert.equal(records.length, CARDS.length, 'records without blocks are still items');
  // A grid row around two tiles (one block both records claim) is never one record's text.
  const shared = resultsPage();
  shared.blocks.push({ t: 'li', text: 'Tile A · € 10 · Tile B · € 12' });
  const index = shared.blocks.length - 1;
  shared.records = [
    { id: 'a', list: 1, title: 'Tile A', fields: ['€ 10'], blocks: [index] },
    { id: 'b', list: 1, title: 'Tile B', fields: ['€ 12'], blocks: [index] },
    { id: 'c', list: 1, title: 'Tile C', fields: ['€ 14'], blocks: [] },
  ];
  const texts = blocksOf(shared).filter(block => block.rec).map(block => block.text);
  assert.deepEqual(texts, ['Tile A · € 10', 'Tile B · € 12', 'Tile C · € 14']);
});

test('a record that is one row block keeps the row\'s text, unless the row lacks a value the record holds', () => {
  const rows = ['Starter | 10 GB | 4.1/5 | $4 per month', 'Team | 100 GB | 4.6/5 | $12 per month', 'Scale | 5 TB | 4.8/5 | $79 per month'];
  const observation = {
    url: `${ORIGIN}/plans`, title: 'Plans', text: '', controls: [],
    blocks: [{ t: 'h1', text: 'Hosting plans' }, ...rows.map(text => ({ t: 'tr', text }))],
    records: rows.map((row, i) => ({ id: `r${i + 1}`, list: 0, title: row.split(' | ')[0], fields: row.split(' | ').slice(1), blocks: [i + 1] })),
  };
  assert.deepEqual(blocksOf(observation).slice(1).map(block => block.text), rows);
  // A tile whose rating came from an aria-label: the grouped row block has the stars only.
  const tiles = ['Larkspur 2P tent', 'Ridge 3P tent', 'Summit 1P bivy'];
  const grid = {
    url: `${ORIGIN}/tents`, title: 'Tents', text: '', controls: [],
    blocks: tiles.map(name => ({ t: 'li', text: `${name} · ★★★★½ · $189.99` })),
    records: tiles.map((name, i) => ({ id: `t${i}`, list: 0, title: name, fields: ['4.5 out of 5 stars', '$189.99'], blocks: [i] })),
  };
  assert.deepEqual(blocksOf(grid).map(block => block.text), tiles.map(name => `${name} · 4.5 out of 5 stars · $189.99`));
});

test('recordsOf normalizes page records: bounded, typed hints only, unknown keys and bad entries dropped', () => {
  const records = recordsOf({
    records: [
      { id: 'r1', list: 0, title: 'A', fields: ['x'.repeat(400), 7, ''], hints: { price: '€ 5', rating: '9', reviews: 12, junk: 1 }, blocks: [1, -1, 'x'], sponsored: true, evil: 1 },
      null, { title: '', fields: ['only one'] },
      ...Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, fields: [] })),
    ],
  });
  assert.equal(records.length, 60);
  assert.equal(records[0].fields[0].length, 160);
  assert.deepEqual(records[0].hints, { price: '€ 5', reviews: 12 });
  assert.deepEqual(records[0].blocks, [1]);
  assert.equal(records[0].sponsored, true);
  assert.equal(records[0].evil, undefined);
  assert.equal(recordText({ title: 'T', fields: ['a'.repeat(200), 'b'.repeat(200), 'Price € 9'] }), `T · ${'a'.repeat(200)} · Price € 9`);
});

test('ratings and rating bounds are read from text, never from review counts', () => {
  assert.deepEqual(ratingValue('Scored 7.8'), { value: 7.8 });
  assert.deepEqual(ratingValue('4.5 out of 5 stars'), { value: 4.5, scale: 5 });
  assert.deepEqual(ratingValue('8.4/10'), { value: 8.4, scale: 10 });
  assert.deepEqual(ratingValue('Rated 4.6 by diners'), { value: 4.6 });
  assert.equal(ratingValue('5,041 reviews'), null);
  assert.equal(ratingValue('3/4 nights'), null);
  assert.equal(ratingValue('Page 2 of 5'), null);
  assert.deepEqual(ratingBound('with a rating of 8 or more'), { min: 8, strict: false, span: [7, 26] });
  assert.equal(ratingBound('rated 8+').min, 8);
  assert.equal(ratingBound('4 stars or more').min, 4);
  assert.equal(ratingBound('an 8+ rating').min, 8);
  assert.equal(ratingBound('a score above 8').strict, true);
  assert.equal(ratingBound('a rating of 8'), null, 'a bare rating is no bound');
  const intent = aggregateIntent(QUESTION);
  assert.equal(intent.op, 'min');
  assert.equal(intent.measure, 'price');
  assert.equal(intent.ratingMin, 8);
  assert.equal(aggregateIntent('Which plan has a rating of at least 4.5?').measure, 'rating', '"at least" is the bound, not an extremum');
  assert.equal(aggregateIntent('Which restaurant is the highest rated?').measure, 'rating');
  assert.equal(passesFilters('Altona · Scored 7.8 · Price € 310', intent), false);
  assert.equal(passesFilters('Angleterre Hotel · Scored 8.2 · Price € 299', intent), true);
  assert.equal(passesFilters('Angleterre Hotel · Price € 299', intent, { rating: 8.2 }), true, 'the record hint is the fallback');
});

test('the fact memory reads each record as one named item; a sold-out record offers no price', () => {
  const observation = resultsPage();
  const memory = buildMemory([{ state: 0, step: 0, url: observation.url, title: observation.title, key: 'k', observation }], QUESTION, { finalKey: 'k' });
  const items = memory.states[0].lines.filter(line => line.item);
  assert.deepEqual(items.map(line => line.record).sort(), ['r2', 'r3', 'r6']);
  for (const line of items) assert.ok(!line.notes?.includes('unnamed_item') && !line.notes?.includes('decoy_name'), JSON.stringify(line));
  assert.ok(!items.some(line => line.text.startsWith('Nord Est Hotel')), 'the sold-out card is no item');
  assert.ok(pickAnswerCandidates(observation, QUESTION).some(candidate => candidate.text.startsWith('Nord Est Hotel')), 'but stays on the page');
  assert.deepEqual(coverage([{ observation }]).why, []);
  assert.deepEqual(coverage([{ observation: resultsPage({ truncated: true }) }]).why, ['records_cut']);
});

test('ratings as review sites print them: a grade before or glued to its score, a decimal before its review count', () => {
  assert.deepEqual(ratingValue('Scored 8.4'), { value: 8.4 });
  assert.deepEqual(ratingValue('Review score 8.4'), { value: 8.4 });
  assert.deepEqual(ratingValue('8.4 Very good'), { value: 8.4, scale: 10 });
  assert.deepEqual(ratingValue('8.4Very good'), { value: 8.4, scale: 10 });
  assert.deepEqual(ratingValue('Very good 8.4'), { value: 8.4, scale: 10 });
  assert.deepEqual(ratingValue('4.31 (5760 reviews)'), { value: 4.31, scale: 5 }, 'out of 5 up to 5');
  assert.deepEqual(ratingValue('8.7 (1,204 reviews)'), { value: 8.7, scale: 10 });
  assert.equal(ratingValue('Good 2.4 km from centre'), null, 'a distance after a grade word is no score');
  assert.equal(ratingValue('2,310 reviews'), null);
  // A star class beside a guest score: a bound above 5 reads the score, a bound of 5 or less the 5-point rating.
  const line = 'Harbour Loft · 4 out of 5 stars · Very good 8.2 · 640 reviews · US$ 238';
  assert.deepEqual(ratingsOf(line), [{ value: 4, scale: 5 }, { value: 8.2, scale: 10 }]);
  assert.equal(ratingFor(line, aggregateIntent('Which place rated 8 or more is cheapest?')).value, 8.2);
  assert.equal(ratingFor(line, aggregateIntent('Which place with 4 stars or more is cheapest?')).value, 4);
  assert.equal(ratingFor('Tour · 4.31 (5760 reviews) · € 18', aggregateIntent('Which tour rated 8 or more is cheapest?')), null,
    'a 5-point rating neither passes nor fails a bound of 8');
  assert.equal(passesFilters(line, aggregateIntent('Which place rated 8 or more is cheapest?')), true);
  // The page script's hint (the rating next to the review count) leads; its `ratings` list the others.
  assert.equal(ratingFor('Loft · US$ 238', aggregateIntent('Which place rated 8 or more is cheapest?'),
    { rating: 8.2, scale: 10, ratings: [{ value: 4, scale: 5 }, { value: 8.2, scale: 10 }] }).value, 8.2);
});

test('a price per stay stated twice ("4 nights, 2 adults € 344" and "Price € 344") is one price, not an ambiguous one', () => {
  const intent = aggregateIntent('Which stay is cheapest?');
  assert.deepEqual(valueNotes('Hostel Ribeira · 4 nights, 2 adults € 344 · Price € 344', intent), []);
  assert.ok(valueNotes('Hostel Ribeira · € 399 · € 344', intent).includes('ambiguous_value'), 'two amounts are');
  assert.deepEqual(moneyValues('4.7 out of 5 $ 45'), [45], 'the scale before a currency sign is no amount');
});

