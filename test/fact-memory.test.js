// Fact memory and aggregation (src/facts.js) and their use in the runtime's answer step: value parsing (currency
// with symbols and thousands separators, 12 h and 24 h times, counts), the question's aggregation intent and filters
// ("between 10:00 and 12:00", "in stock", a category column), the memory bounds (6 lines per state, 80 per run),
// redaction, coverage (pages left unread), and, at fixture level, each long-corpus task whose fact was lost before
// (flights, catalog, workspace) replayed through the real BrowserRuntime from page.js observations of its gold path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FACT_RUN_LINES, FACT_RUN_LINES_MAX, FACT_STATE_ITEMS, FACT_STATE_LINES, aggregateIntent, aggregateItems, answerScope, buildMemory,
  categoryCell, countValue, coverage, datesIn, itemValue, pageDate, sameDay, moneyCurrencies, moneyValues, passesFilters, priceUnit,
  runLineBudget, timeValues, traceFacts, valueNotes,
} from '../src/facts.js';
import { ORIGIN } from './runtime-fixtures.js';

// ------------------------------------------------------------------------------------------------ values

test('moneyValues: symbols, codes, thousands separators and decimals', () => {
  assert.deepEqual(moneyValues('€61'), [61]);
  assert.deepEqual(moneyValues('10:55Vueling VY 7713Nonstop · 1 h 40 min€61'), [61]);
  assert.deepEqual(moneyValues('Pro | $1,299.00 per year | $37 per month'), [1299, 37]);
  assert.deepEqual(moneyValues('Preis: €1.299,50'), [1299.5]);
  assert.deepEqual(moneyValues('£12.5 or 1 299 EUR'), [12.5, 299]);
  assert.deepEqual(moneyValues('1,250 USD and 99 euros'), [1250, 99]);
  assert.deepEqual(moneyValues('US$ 2,000'), [2000]);
  assert.deepEqual(moneyValues('Page 11 of 13 · 8 products'), []);
});

test('timeValues: 24 h with seconds, 12 h with and without minutes, glued text', () => {
  assert.deepEqual(timeValues('10:55Vueling VY 7713'), [655]);
  assert.deepEqual(timeValues('14:00:03 build started 14:01:47 migration'), [840, 841]);
  assert.deepEqual(timeValues('departs 2:30 pm, arrives 4:05 PM'), [870, 965]);
  assert.deepEqual(timeValues('opens 10 am, closes 12 a.m.'), [600, 0]);
  assert.deepEqual(timeValues('12:15 pm lunch'), [735]);
  assert.deepEqual(timeValues('version 1.10.3, €12.50, 3 of 8'), []);
});

test('countValue: the only number, else the one next to a question term', () => {
  assert.equal(countValue('fai-browser · 1,204 stars', new Set(['star'])), 1204);
  assert.equal(countValue('Repo 7 · 48 stars · 3 forks', new Set(['star'])), 48);
  assert.equal(countValue('€40 at 10:00, 12 seats', new Set(['seat'])), 12);
  assert.equal(countValue('no number here', new Set(['star'])), null);
});

// ------------------------------------------------------------------------------------------------ intent

test('aggregateIntent: extremum, measure and filters the question names', () => {
  const flights = aggregateIntent('Which flight departing between 10:00 and 12:00 is the cheapest over Mon 12 Oct to Sun 18 Oct?');
  assert.equal(flights.op, 'min');
  assert.equal(flights.measure, 'price');
  assert.deepEqual(flights.window, { from: 600, to: 720 });
  const tents = aggregateIntent('Which in-stock tent is the cheapest across all 13 catalog pages, and what does it cost?');
  assert.equal(tents.op, 'min');
  assert.equal(tents.stock, true);
  assert.ok(tents.terms.has('tent') && !tents.terms.has('cheapest'));
  assert.equal(aggregateIntent('What is the earliest departure after 2 pm?').measure, 'time');
  assert.deepEqual(aggregateIntent('What is the earliest departure after 2 pm?').window, { from: 840, to: 1440 });
  assert.equal(aggregateIntent('Which plan is the most expensive?').op, 'max');
  assert.equal(aggregateIntent('Which repository has the most stars?').measure, 'count');
  assert.equal(aggregateIntent('Which flights leave 9:00-11:30?').op, 'filter');
  assert.equal(aggregateIntent('Which lamps cost under €50?').priceMax, 50);
  assert.equal(aggregateIntent('What rollback token does the log of deploy #318 show?'), null);
  assert.equal(aggregateIntent('What is the default HTTP health-check timeout?'), null);
});

test('filters: time window, in stock, price bound and the category column', () => {
  const window = aggregateIntent('the cheapest flight between 10:00 and 12:00');
  assert.ok(passesFilters('10:55Vueling VY 7713Nonstop · 1 h 40 min€61', window));
  assert.ok(passesFilters('12:00 easyJet €70', window), 'inclusive');
  assert.ok(!passesFilters('12:05Ryanair RY 2145Nonstop · 1 h 40 min€52', window), 'just outside');
  assert.ok(!passesFilters('09:59 BA €40', window));
  assert.ok(!passesFilters('10:30 no price here', window), 'no value for the measure');
  const stock = aggregateIntent('Which in-stock tent is the cheapest?');
  assert.ok(passesFilters('Larkspur 2P tent | Tents | TN-1129 | €129 | In stock', stock));
  assert.ok(!passesFilters('Kestrel 3P tent | Tents | TN-1313 | €115 | Out of stock', stock));
  assert.ok(!passesFilters('Kestrel 3P tent — sold out — €115', stock));
  assert.ok(categoryCell('Larkspur 2P tent | Tents | TN-1129 | €129 | In stock', stock.terms));
  assert.ok(!categoryCell('Tent footprint 2P | Accessories | AC-0909 | €29 | In stock', stock.terms));
  const bound = aggregateIntent('Which lamps cost under €50?');
  assert.ok(passesFilters('Glim lamp €45', bound));
  assert.ok(!passesFilters('Kestrel lamp €55', bound));
});

// ------------------------------------------------------------------------------------------------ memory

const state = (i, blocks, extra = {}) => ({
  state: i, step: i, url: `${ORIGIN}/p${extra.path ?? i}`, title: `T${i}`, revision: `r${i}`, key: `r${i}`,
  observation: { url: `${ORIGIN}/p${extra.path ?? i}`, title: `T${i}`, revision: `r${i}`, blocks, controls: extra.controls ?? [] },
});

test('memory bounds: at most 6 non-item lines per state, a run budget that grows with the states; repeated lines are kept once', () => {
  const rows = (i, n) => [{ t: 'h1', text: 'Price list' }, ...Array.from({ length: n }, (_, j) => ({ t: 'tr', text: `Lamp ${i}-${j} | €${10 + j} | In stock` }))];
  // No aggregation ("cost" names no extremum): six lines per state. 20 states fit the run budget (12 per state).
  const states = Array.from({ length: 20 }, (_, i) => state(i, rows(i, 10)));
  const memory = buildMemory(states, 'What does each lamp cost?');
  assert.ok(memory.states.every(entry => entry.lines.length <= FACT_STATE_LINES));
  assert.equal(memory.states.reduce((sum, entry) => sum + entry.lines.length, 0), 20 * FACT_STATE_LINES);
  assert.equal(memory.dropped, 0);
  assert.equal(runLineBudget(20), 240);
  assert.equal(runLineBudget(3), FACT_RUN_LINES, 'the floor');
  assert.equal(runLineBudget(100), FACT_RUN_LINES_MAX, 'the cap');
  // Over the budget (10 states of 20 items and 2 other lines each) the lowest-scoring non-item lines go first, then
  // the lowest-scoring items, which count as unread.
  const crowded = buildMemory(Array.from({ length: 10 }, (_, i) => state(i, rows(i, 20))), 'Which lamp is the cheapest?');
  const total = crowded.states.reduce((sum, entry) => sum + entry.lines.length, 0);
  assert.equal(total, runLineBudget(10));
  assert.ok(crowded.dropped > 0 && crowded.droppedItems > 0);
  assert.equal(crowded.states.reduce((sum, entry) => sum + entry.droppedItems, 0), crowded.droppedItems);
  const same = buildMemory([state(0, rows(1, 3)), state(1, rows(1, 3), { path: 0 })], 'What does each lamp cost?');
  assert.equal(same.states[1].lines.length, 0, 'the second state repeats the first');
  // Aggregation items: up to 30 per state (a results page shows 10-20 rows) next to two other lines; a state with
  // more items than that counts as unread (memory_full), the final page's own state keeps every item.
  const many = buildMemory([state(0, rows(0, 35)), state(1, rows(1, 9))], 'Which lamp is the cheapest?');
  assert.equal(many.states[0].lines.filter(line => line.item).length, FACT_STATE_ITEMS);
  assert.equal(many.states[1].lines.filter(line => line.item).length, 9);
  assert.equal(many.droppedItems, 5);
  assert.deepEqual(many.states.map(entry => entry.droppedItems), [5, 0]);
  const final = buildMemory([state(0, rows(0, 9)), state(1, rows(1, 35))], 'Which lamp is the cheapest?', { finalKey: 'r1' });
  assert.equal(final.states[1].lines.filter(line => line.item).length, 35, 'the final page keeps all its items');
  assert.equal(final.droppedItems, 0);
});

test('memory redaction: supplied values are replaced in lines, context, URLs and titles', () => {
  const redact = value => String(value).split('Ada Moreno').join('[supplied:full_name]');
  const states = [state(0, [{ t: 'h2', text: 'Review for Ada Moreno' }, { t: 'li', text: 'Full name: Ada Moreno · draft reference DR-1' }])];
  states[0].url = `${ORIGIN}/review?name=Ada Moreno`;
  const memory = buildMemory(states, 'What is the draft reference for the full name?', { redact });
  const text = JSON.stringify(traceFacts(memory));
  assert.ok(!text.includes('Ada Moreno'), text);
  assert.ok(text.includes('[supplied:full_name]'));
});

test('aggregation: min over states, the category column, ties, and coverage of paginated lists', () => {
  const page = (n, rows) => state(n - 1, [{ t: 'p', text: `Page ${n} of 3` }, { t: 'tr', text: 'Product | Category | Price | Availability' },
    ...rows.map(row => ({ t: 'tr', text: row }))]);
  const pages = [
    page(1, ['Ridge tent | Tents | €249 | In stock', 'Tent pegs | Accessories | €9 | In stock']),
    page(2, ['Fern tent | Tents | €159 | In stock', 'Kestrel tent | Tents | €99 | Out of stock']),
    page(3, ['Lark tent | Tents | €1,129.00 | In stock', 'Tor tent | Tents | €145 | In stock']),
  ];
  const question = 'Which in-stock tent is the cheapest?';
  const memory = buildMemory(pages, question);
  assert.equal(memory.category, true);
  const summary = aggregateItems(memory);
  assert.equal(summary.code, 'min_price');
  assert.deepEqual(summary.items.map(item => item.line.value), [145, 159, 249, 1129]);
  assert.equal(summary.states, 3);
  assert.equal(summary.tie, false);
  assert.deepEqual(coverage(pages), { complete: true, why: [] });
  assert.deepEqual(coverage(pages.slice(0, 2)).why, ['pages_unread']);
  const more = [...pages.slice(0, 2), state(2, [{ t: 'p', text: 'Page 3 of 3' }, { t: 'a', text: 'Load more' }])];
  assert.deepEqual(coverage(more).why, ['more_offered']);
  const shown = [state(0, [{ t: 'h3', text: 'Flights · showing 4 of 8' }]), state(1, [{ t: 'h3', text: 'Next day · showing 4 of 8' }])];
  assert.deepEqual(coverage(shown).why, ['more_unread']);
  const tied = buildMemory([page(1, ['A tent | Tents | €100 | In stock']), page(2, ['B tent | Tents | €100 | In stock'])], question);
  assert.equal(aggregateItems(tied).tie, true);
});

// ------------------------------------------------------------------------------------------------ runtime (synthetic)

// ------------------------------------------------------------------------------------------------ page scope (E7)

// Google Flights' `tfs` carries the date base64-encoded; this is the fixture's encoding (fixtures/long/flights-live).
const tfs = iso => Buffer.from(`\x08\x1c\x10\x02\x1a\x1e\x12\x0a${iso}\x6a\x05\x12\x03MRS`, 'latin1').toString('base64url');
const dayPage = (iso, rows, { more = false, extra = [], path = 'search' } = {}) => ({
  url: `${ORIGIN}/${path}?tfs=${tfs(iso)}&hl=en`, title: 'Marseille to London | Flights',
  text: [`Track prices for Marseille to London, departing ${iso}`, ...rows].join('\n'),
  blocks: [{ t: 'p', text: `Track prices for Marseille to London, departing ${iso}` }, { t: 'h3', text: 'Top flights' },
    ...rows.map(text => ({ t: 'li', text })), ...extra],
  controls: [{ id: '1', role: 'button', label: 'Next day', enabled: true, visible: true },
    ...(more ? [{ id: '9', role: 'button', label: 'View more flights', enabled: true, visible: true }] : [])],
});
const OCT12 = ['10:40 AM – 12:20 PM easyJet Nonstop €58', '6:10 AM – 7:50 AM Ryanair Nonstop €44'];
const OCT13 = ['10:55 AM – 12:35 PM British Airways Nonstop €187', '11:25 AM – 5:05 PM Vueling 1 stop €132'];

test('pageDate: the page\'s own "departing" sentence, else a single date in the title, else one in the URL (base64 too)', () => {
  assert.deepEqual(datesIn('Tue, Oct 13, 2026 and 14 October and 2026-10-15').map(d => d.md), ['10-13', '10-14', '10-15']);
  assert.deepEqual(datesIn('10:40 AM, Oct 10:30, version 2.10.3'), []);
  assert.equal(pageDate(dayPage('2026-10-13', OCT13)).md, '10-13');
  assert.equal(pageDate(dayPage('2026-10-13', OCT13)).from, 'text');
  assert.deepEqual(pageDate({ url: `${ORIGIN}/s?tfs=${tfs('2026-10-11')}`, title: 'Flights', blocks: [{ t: 'p', text: 'Top flights' }] }),
    { md: '10-11', year: '2026', from: 'url' });
  assert.equal(pageDate({ url: `${ORIGIN}/x`, title: 'Flights on Sat 17 Oct', blocks: [] }).md, '10-17');
  assert.equal(pageDate({ url: `${ORIGIN}/x`, title: 'Oct 12 or Oct 13', blocks: [] }), null, 'two dates are no key');
  assert.equal(pageDate({ url: `${ORIGIN}/catalog?p=3`, title: 'Catalog', blocks: [{ t: 'p', text: 'Page 3 of 13' }] }), null);
  // The old fixture's wording, and the content winning over a URL that changed first.
  assert.equal(pageDate({ url: `${ORIGIN}/x?d=2026-10-14`, blocks: [{ t: 'h3', text: 'All 8 departures on Tue 13 Oct' }] }).md, '10-13');
  assert.ok(sameDay({ md: '10-13', year: null }, { md: '10-13', year: '2026' }));
  assert.ok(!sameDay({ md: '10-13', year: '2025' }, { md: '10-13', year: '2026' }));
});

test('answerScope: another day\'s states are out, a span keeps them, a superseded half-rendered revision collapses', () => {
  const states = [dayPage('2026-10-12', OCT12), dayPage('2026-10-13', OCT13)].map((observation, i) => ({
    state: i, step: i, url: observation.url, observation, key: `k${i}` }));
  const final = states[1].observation;
  const named = answerScope(states, final, { question: 'Which flight between 10:00 and 12:00 on Tue 13 Oct is cheapest?' });
  assert.deepEqual(named.excluded, [0]);
  assert.equal(named.target.from, 'question');
  const own = answerScope(states, final, { question: 'Which flight between 10:00 and 12:00 is cheapest?', instruction: 'Open the next day' });
  assert.deepEqual(own.excluded, [0], 'no date named: the final page\'s own day');
  for (const question of ['Which flight between 10:00 and 12:00 is the cheapest over Mon 12 Oct to Tue 13 Oct?',
    'Which flight between 10:00 and 12:00 is the cheapest on any day this week?']) {
    assert.deepEqual(answerScope(states, final, { question }).excluded, [], question);
  }
  assert.deepEqual(answerScope(states, final, { question: 'Which is cheapest?', instruction: 'Check each day from Mon 12 Oct' }).excluded, []);
  // Pages without a date key are never scoped (a catalog's pages, the adversarial table).
  const plain = [state(0, [{ t: 'tr', text: 'A tent | €9' }]), state(1, [{ t: 'tr', text: 'B tent | €19' }])];
  assert.deepEqual(answerScope(plain, plain[1].observation, { question: 'Which tent is the cheapest?' }).states.length, 2);
  // Same URL, no action in between: the first paint is superseded by the settled page.
  const half = { ...dayPage('2026-10-13', []), blocks: [{ t: 'h3', text: 'Top options' }, { t: 'p', text: '10:47 AM – 4:05 PM' }] };
  const twice = [{ state: 0, step: 1, url: half.url, observation: half }, { state: 1, step: 1, url: final.url, observation: final }];
  const settled = answerScope(twice, final, { question: 'Which flights depart between 10:00 and 12:00?' });
  assert.deepEqual(settled.collapsed, [0]);
  assert.deepEqual(settled.states.map(s => s.state), [1]);
});

test('answerScope review: a title or URL date is not the data\'s day; loose multi-day questions keep every state', () => {
  const at = (observation, i) => ({ state: i, step: i, url: observation.url, observation });
  const page = (url, title, lines) => ({ url, title, blocks: lines.map(text => ({ t: 'li', text })) });
  // Three product pages whose titles carry their publication dates: a comparison across them loses none.
  const products = ['Oct 3', 'Oct 5', 'Oct 9'].map((day, i) => at(page(`${ORIGIN}/tent${i}`, `Tent ${i} review – ${day}, 2026`,
    [`Tent ${i} €${100 + i}`]), i));
  assert.deepEqual(answerScope(products, products[2].observation, { question: 'Which tent is cheapest?' }).excluded, []);
  // A date in a tracking parameter, or base64 that decodes to one, on a non-flights site.
  const tracked = [0, 1].map(i => at(page(`${ORIGIN}/item${i}?utm_date=2026-10-0${i + 1}`, 'Shop', [`Item €${i + 5}`]), i));
  assert.deepEqual(answerScope(tracked, tracked[1].observation, { question: 'Which item is cheapest?' }).excluded, []);
  // Several days named loosely: never scoped to one.
  const days = [dayPage('2026-10-12', OCT12), dayPage('2026-10-13', OCT13)].map(at);
  for (const question of ['Which flight is cheapest from the 12th to the 13th?', 'Which flight is cheapest on any day?',
    'Which flight is cheapest on Monday or Tuesday?', 'Which day has the cheapest flight?', 'Cheapest flight on Oct 12-13?',
    'Cheapest flight on 12 or 13 October?', 'Which flight is cheapest on Monday and Tuesday?']) {
    assert.deepEqual(answerScope(days, days[1].observation, { question, instruction: 'Open the next day' }).excluded, [], question);
  }
  // A time range is not a day range.
  assert.deepEqual(answerScope(days, days[1].observation, { question: 'Which flight between 10:00 and 12:00 is cheapest?' }).excluded, [0]);
  // The question names a day no page showed (the run ended on another day): nothing is excluded, and it is a mismatch.
  const other = answerScope(days, days[1].observation, { question: 'Which flight on Wed 14 Oct between 10:00 and 12:00 is cheapest?' });
  assert.deepEqual(other.excluded, []);
  assert.equal(other.mismatch, true);
  assert.equal(answerScope(days, days[1].observation, { question: 'Which flight on Tue 13 Oct is cheapest?' }).mismatch, false);
});

test('answerScope review: a later revision that lost rows (a transient re-render) does not supersede the fuller one', () => {
  const full = dayPage('2026-10-13', [...OCT13, '10:40 AM – 12:20 PM easyJet Nonstop €58']);
  const thin = { ...dayPage('2026-10-13', OCT13.slice(0, 1)), url: full.url };
  const final = dayPage('2026-10-13', OCT13, { path: 'other' });
  const states = [{ state: 0, step: 1, url: full.url, observation: full }, { state: 1, step: 1, url: thin.url, observation: thin },
    { state: 2, step: 2, url: final.url, observation: final }];
  const scope = answerScope(states, final, { question: 'Which flight between 10:00 and 12:00 is cheapest?' });
  assert.deepEqual(scope.collapsed, [], 'the fuller first revision stays');
});

// ------------------------------------------------------------------------------------------------ adversarial (review)

test('valueNotes: what makes an item\'s value unsafe to order by', () => {
  const price = aggregateIntent('Which tent is the cheapest?');
  assert.deepEqual(valueNotes('Alpha tent | €120–€180', price), ['ambiguous_value'], 'range');
  assert.deepEqual(valueNotes('Alpha tent | Was €199 Now €119', price), ['ambiguous_value'], 'struck-through old price');
  assert.deepEqual(valueNotes('Alpha tent | from €94', price), ['approximate_value']);
  assert.deepEqual(valueNotes('Alpha tent | €94+', price), ['approximate_value']);
  assert.deepEqual(valueNotes('Alpha tent | 1 299 €', price), ['ambiguous_value'], 'split by a plain space');
  assert.deepEqual(valueNotes('Alpha tent | €1.299,00', price), []);
  assert.deepEqual(valueNotes('Larkspur 2P tent | Tents | TN-1129 | €129 | In stock', price), []);
  assert.deepEqual(valueNotes('Shipping €4.99', price), ['unnamed_item']);
  assert.deepEqual(valueNotes('Tent pegs | €9', price), ['decoy_name']);
  assert.deepEqual(valueNotes('10:55Vueling VY 7713Nonstop · 1 h 40 min€61', aggregateIntent('Which flight between 10:00 and 12:00 is the cheapest?')), []);
  const stock = aggregateIntent('Which in-stock tent is the cheapest?');
  assert.deepEqual(valueNotes('Alpha tent €79', stock), ['stock_unknown']);
  const arrival = aggregateIntent('Which flight arrives latest?');
  assert.deepEqual(valueNotes('Alpha flight 08:00 → 23:00', arrival, 'Which flight arrives latest?'), ['ambiguous_value']);
  assert.deepEqual(valueNotes('Alpha flight 08:00 → 23:00', aggregateIntent('Which flight departs latest?'), 'Which flight departs latest?'), []);
  assert.deepEqual(valueNotes('Delta train departs 00:20 (+1)', aggregateIntent('Which train departs latest?'), 'Which train departs latest?'), ['ambiguous_value']);
  assert.deepEqual(moneyCurrencies('£80 or US$ 85, 90 EUR'), ['gbp', 'usd', 'eur']);
  assert.equal(priceUnit('€90 per person'), 'person');
  assert.equal(priceUnit('€150 total'), 'total');
  assert.equal(priceUnit('€150'), 'none');
});

test('time window across midnight: both sides pass, after-midnight times order last', () => {
  const intent = aggregateIntent('Which train between 22:00 and 02:00 is the latest?');
  assert.deepEqual(intent.window, { from: 1320, to: 120, wrap: true });
  assert.ok(passesFilters('Charlie train 23:10 | €40', intent));
  assert.ok(passesFilters('Delta train 01:20 | €45', intent));
  assert.ok(!passesFilters('Bravo train 03:00 | €15', intent));
  assert.ok(!passesFilters('Alpha train 21:30 | €20', intent));
  assert.ok(itemValue('Delta train 01:20', intent) > itemValue('Charlie train 23:10', intent));
  assert.equal(timeValues('12:00 PM')[0], 720);
  assert.equal(timeValues('12:00 AM')[0], 0);
});

test('bounds under a 40-state run: memory, trail, trace facts and their size', () => {
  const rows = i => [{ t: 'p', text: `Page ${i + 1} of 40` }, ...Array.from({ length: 12 }, (_, j) => ({ t: 'tr', text: `Lamp ${i}-${j} ${'detail '.repeat(30)}| €${100 + i * 10 + j} | In stock` }))];
  const states = Array.from({ length: 40 }, (_, i) => state(i, rows(i)));
  const memory = buildMemory(states, 'Which lamp is the cheapest?');
  const total = memory.states.reduce((sum, entry) => sum + entry.lines.length, 0);
  assert.ok(total <= FACT_RUN_LINES_MAX, String(total));
  assert.ok(memory.states.every(entry => entry.lines.filter(line => line.item).length <= FACT_STATE_ITEMS));
  assert.ok(memory.droppedItems > 0, 'items fell off: the aggregate is partial (memory_full)');
  const facts = JSON.stringify(traceFacts(memory));
  // At most 400 lines of at most 200 characters plus context and fields (about 330 bytes a line): bounded whatever
  // the run length.
  assert.ok(facts.length < 160_000, String(facts.length));
  const longer = buildMemory(Array.from({ length: 60 }, (_, i) => state(i, rows(i))), 'Which lamp is the cheapest?');
  assert.ok(traceFacts(longer).length <= 40);
  assert.ok(JSON.stringify(traceFacts(longer)).length < 160_000);
});

