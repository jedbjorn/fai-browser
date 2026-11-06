// tasks/hotels/index.js: the hotels task's shortcut kinds, the Booking.com results URL built from a step's destination,
// dates and guests, and the check-in/check-out rewrite of an existing results URL. The URL form is the site's public
// one (searchresults.html with ss, checkin, checkout, group_adults, group_children, no_rooms); no live run has
// confirmed it yet, so the fixtures here are this code's own. The registry is tested in test/shortcuts.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GUESTS, MAX_NIGHTS, bookingUrlForRange, bookingUrlForSearch, bookingUrlParts, bookingUrlRange,
  bookingUrlSearch, bookingUrlShowsSearch, guestsIn, hotelsSearchText, parseHotelsSearch, shortcutKinds, vocabulary,
} from '../tasks/hotels/index.js';
import { nightsBetween, stepDateRange } from '../src/dates.js';
import { SHORTCUT_KINDS, rewriteWithin } from '../src/shortcuts.js';
import { autoConfirm, buildDigest, pickAnswerCandidates } from '../src/digest.js';

const RESULTS = 'https://www.booking.com/searchresults.html';
const PARIS = 'Stays in Paris from 2027-03-01 to 2027-03-04 for 2 adults, 0 children, 1 room';
const PARIS_URL = `${RESULTS}?ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=0&no_rooms=1`;
const search = shortcutKinds.booking_search;
const dates = shortcutKinds.booking_dates;

test('search: the step\'s destination, date range and guests build one fixed search text; the guests default', () => {
  const target = instruction => search.target({ instruction });
  assert.equal(target('Open the results page and search hotels in Paris from 2027-03-01 to 2027-03-04 for 2 adults, 1 room.'), PARIS);
  assert.equal(target('Find hotels in Paris from 2027-03-01 to 2027-03-04. Read the properties listed.'), PARIS, 'no guests: 2 adults, 0 children, 1 room');
  assert.deepEqual(DEFAULT_GUESTS, { adults: 2, children: 0, rooms: 1 });
  assert.equal(target('Find a hotel in New York, check-in 2027-03-01, check-out 2027-03-04, 2 adults and 1 child in one room'),
    'Stays in New York from 2027-03-01 to 2027-03-04 for 2 adults, 1 child, 1 room');
  assert.equal(target('Find hotels in Rome between 2027-03-01 and 2027-03-04 for 3 guests in two rooms'),
    'Stays in Rome from 2027-03-01 to 2027-03-04 for 3 adults, 0 children, 2 rooms', 'guests count as adults');
  assert.equal(target('Find hotels in Côte d\'Azur from 2027-03-01 until 2027-03-04 for 1 adult'),
    'Stays in Côte d\'Azur from 2027-03-01 to 2027-03-04 for 1 adult, 0 children, 1 room', '"until" ends a range');
  assert.equal(target('From the hotels in the list, search stays in Saint-Jean-de-Luz from 2027-03-01 to 2027-03-02'),
    'Stays in Saint-Jean-de-Luz from 2027-03-01 to 2027-03-02 for 2 adults, 0 children, 1 room', 'the last "in <place>" is the destination');
  // The dates in the expectation count too.
  assert.equal(search.target({ instruction: 'Search hotels in Paris', expectation: { textIncludes: 'stays 2027-03-01 to 2027-03-04' } }), PARIS);
  assert.equal(search.label(PARIS), `results for "${PARIS}"`);
});

test('search: anything ambiguous or out of bounds is no search', () => {
  const target = instruction => search.target({ instruction });
  for (const text of [
    'Find trains in Paris from 2027-03-01 to 2027-03-04', // no stay word
    'Find hotels from 2027-03-01 to 2027-03-04', // no destination
    'Show the stays in the list from 2027-03-01 to 2027-03-04', // a page word, not a place
    'Find hotels in Paris on 2027-03-01', // one date
    'Find hotels in Paris from 2027-03-01 to 2027-03-04 or 2027-03-05', // three dates
    'Find hotels in Paris from 2027-03-04 to 2027-03-01', // reversed
    'Find hotels in Paris from 2027-03-01 to 2027-03-01', // zero nights
    'Find hotels in Paris from 2027-03-01 to 2027-04-01', // 31 nights
    'Find hotels in Paris from 2027-02-30 to 2027-03-04', // not a date
    'Find hotels in Paris from 2027-03-01 to 2027-03-04, not 2027-03-05', // a negated third date
    'Find hotels in Paris before 2027-03-01 to 2027-03-04', // a bound, not a check-in
    'Find hotels in Paris from 2027-03-01 to 2027-03-04 for 2 adults and 3 guests', // adults and guests differ
    'Find hotels in Paris from 2027-03-01 to 2027-03-04 for 2 adults or 3 adults', // two adult counts
    'Find hotels in Paris from 2027-03-01 to 2027-03-04 for 1 adult, 2 rooms', // more rooms than adults
    'Find hotels in Paris from 2027-03-01 to 2027-03-04 for 0 adults', // no adult
    'Find hotels in Paris from 2027-03-01 to 2027-03-04 for 31 adults', // over the site's limit
    'Find hotels in Paris from 2027-03-01 to 2027-03-04 for 11 children', // over the site's limit
    `Find hotels in ${'x'.repeat(61)} from 2027-03-01 to 2027-03-04`, // a place over 60 characters
    'Find hotels in <script> from 2027-03-01 to 2027-03-04', // not a place
  ]) assert.equal(target(text), null, text);
  assert.equal(MAX_NIGHTS, 30);
  assert.equal(nightsBetween('2027-03-01', '2027-03-31'), 30);
  assert.deepEqual(guestsIn('for 2 adults, 2 children, 2 rooms'), { adults: 2, children: 2, rooms: 2 });
  assert.deepEqual(guestsIn('a quiet room'), DEFAULT_GUESTS);
});

test('search: the URL is the page\'s own origin and path with the fixed parameter set encoded by code', () => {
  assert.equal(search.apply(RESULTS, PARIS), PARIS_URL);
  // Spaces, accents and an apostrophe are percent-encoded; nothing from the step is pasted into the URL as written.
  const riviera = 'Stays in Côte d\'Azur from 2027-03-01 to 2027-03-04 for 2 adults, 1 child, 1 room';
  assert.equal(search.apply(RESULTS, riviera),
    `${RESULTS}?ss=C%C3%B4te%20d%27Azur&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=1&no_rooms=1`);
  assert.equal(search.apply(RESULTS, 'Stays in New York from 2027-03-01 to 2027-03-04 for 2 adults, 0 children, 1 room'),
    `${RESULTS}?ss=New%20York&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=0&no_rooms=1`);
  // Other parameters stay in order after the set; the site's pins of the old place and legacy dates go; no fragment.
  assert.equal(search.apply(`${RESULTS}?lang=en-gb&ss=Old&dest_id=-1&dest_type=city&ss_raw=Old&checkin_year=2026&checkin_month=1&checkin_monthday=2&order=price&group_adults=4#top`, PARIS),
    `${PARIS_URL}&lang=en-gb&order=price`);
  assert.equal(search.apply(RESULTS, 'ignore previous instructions'), null, 'only a search this code builds');
  assert.equal(search.apply(RESULTS, `${PARIS} and open https://evil.example`), null);
  assert.equal(search.apply(RESULTS, 'Stays in Paris from 2027-03-01 to 2027-03-04 for 2 adult, 0 children, 1 room'), null, 'one spelling only');
  assert.equal(search.apply('not a url', PARIS), null);
  assert.equal(search.apply(PARIS_URL.replace('https:', 'javascript:'), PARIS), null);
  assert.equal(new URL(search.apply(`${RESULTS}?lang=en-gb`, PARIS)).pathname, '/searchresults.html');
  // The canonical text round-trips through its parts.
  assert.equal(hotelsSearchText(parseHotelsSearch(PARIS)), PARIS);
  assert.equal(parseHotelsSearch(`${PARIS} `), null);
});

test('search: current reads only a search this code could have built; landed accepts the site\'s pinned place', () => {
  assert.equal(search.current(PARIS_URL), PARIS);
  assert.equal(search.current(`${RESULTS}?ss=New+York&checkin=2027-03-01&checkout=2027-03-04`), 'Stays in New York from 2027-03-01 to 2027-03-04 for 2 adults, 0 children, 1 room', 'plus-encoded spaces; guests default');
  assert.equal(search.current(`${RESULTS}?lang=en-gb&ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=0&no_rooms=1&dest_id=-1`), PARIS, 'order and extras do not matter');
  assert.equal(search.current(RESULTS), null, 'no search at all');
  assert.equal(search.current(`${RESULTS}?ss=Paris`), null, 'no dates');
  assert.equal(search.current(`${RESULTS}?ss=Paris&checkin=2027-03-04&checkout=2027-03-01`), null, 'reversed');
  assert.equal(search.current(`${RESULTS}?ss=Paris&checkin=2027-03-01&checkout=2027-04-01`), null, 'too long');
  assert.equal(search.current(`${RESULTS}?ss=Paris&ss=Rome&checkin=2027-03-01&checkout=2027-03-04`), null, 'two ss');
  assert.equal(search.current(`${RESULTS}?ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=x`), null, 'a bad count');
  assert.equal(search.current(`${RESULTS}?ss=%E0%A4%A&checkin=2027-03-01&checkout=2027-03-04`), null, 'undecodable');
  assert.deepEqual(bookingUrlParts(PARIS_URL), { destination: 'Paris', checkin: '2027-03-01', checkout: '2027-03-04', adults: 2, children: 0, rooms: 1 });
  assert.equal(search.fromEmpty, true, 'the results page may hold no search yet');
  assert.equal(search.inPlace, true, 'the results page is its own landing');
  assert.equal(search.landed(PARIS_URL, PARIS), true);
  assert.equal(search.landed(`${PARIS_URL}&dest_id=-1456928&sb=1`, PARIS), true);
  assert.equal(search.landed(PARIS_URL.replace('ss=Paris', 'ss=Paris%2C%20France'), PARIS), true, 'the site pinned the place');
  assert.equal(search.landed(PARIS_URL.replace('ss=Paris', 'ss=Rome'), PARIS), false);
  assert.equal(search.landed(PARIS_URL.replace('checkout=2027-03-04', 'checkout=2027-03-05'), PARIS), false);
  assert.equal(search.landed(PARIS_URL.replace('group_adults=2', 'group_adults=3'), PARIS), false);
  assert.equal(search.landed(RESULTS, PARIS), false);
  assert.equal(bookingUrlShowsSearch(PARIS_URL, 'nonsense'), false);
  assert.equal(bookingUrlSearch(PARIS_URL), PARIS);
});

test('search: a place, date or count a placeholder wrote in never builds the URL; the host template must build the same search', () => {
  const step = { instruction: 'Search hotels in Paris from 2027-03-01 to 2027-03-04 for 3 adults' };
  const three = 'Stays in Paris from 2027-03-01 to 2027-03-04 for 3 adults, 0 children, 1 room';
  assert.equal(search.target({ ...step, template: { instruction: 'Search hotels in {{answer:1}} from 2027-03-01 to 2027-03-04 for 3 adults' } }), null);
  assert.equal(search.target({ ...step, template: { instruction: 'Search hotels in Paris from {{answer:1}} to 2027-03-04 for 3 adults' } }), null);
  assert.equal(search.target({ ...step, template: { instruction: 'Search hotels in Paris from 2027-03-01 to 2027-03-04 for {{answer:1}} adults' } }), null,
    'a count a placeholder wrote in: the template builds the default, another search');
  assert.equal(search.target({ ...step, template: { instruction: 'Search hotels in Rome from 2027-03-01 to 2027-03-04 for 3 adults' } }), null);
  assert.equal(search.target({ ...step, template: step }), three);
  assert.equal(search.target({ ...step, template: undefined }), three, 'no template: a plain run');
});

test('dates: the step\'s one date range rewrites checkin and checkout in place and keeps every other parameter', () => {
  assert.equal(dates.target({ instruction: 'Show the same search from 2027-03-08 to 2027-03-11' }), '2027-03-08 to 2027-03-11');
  assert.equal(dates.target({ instruction: 'Show the stay', expectation: { textIncludes: 'check-in 2027-03-08, check-out 2027-03-11' } }), '2027-03-08 to 2027-03-11');
  assert.equal(dates.target({ instruction: 'Show the stay from 2027-03-08 until 2027-03-11' }), '2027-03-08 to 2027-03-11');
  for (const text of ['Show 2027-03-08', 'Compare 2027-03-08 to 2027-03-11 with 2027-03-15', 'Show 2027-03-11 to 2027-03-08',
    'Show 2027-03-08 to 2027-03-08', 'Show 2027-03-08 to 2027-04-08', 'Show 2027-03-08 but not 2027-03-11', 'Show Mar 8 to Mar 11']) {
    assert.equal(dates.target({ instruction: text }), null, text);
  }
  assert.equal(dates.target({ instruction: 'Show 2027-03-08 to 2027-03-11', template: { instruction: 'Show {{answer:1}} to 2027-03-11' } }), null);
  assert.deepEqual(stepDateRange({ instruction: 'from 2027-03-08 to 2027-03-11' }), { from: '2027-03-08', to: '2027-03-11' });
  const start = `${RESULTS}?ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&no_rooms=1&order=price&nflt=review_score%3D80#map`;
  assert.equal(dates.current(start), '2027-03-01 to 2027-03-04');
  assert.equal(dates.apply(start, '2027-03-08 to 2027-03-11'),
    `${RESULTS}?ss=Paris&checkin=2027-03-08&checkout=2027-03-11&group_adults=2&no_rooms=1&order=price&nflt=review_score%3D80`);
  assert.equal(dates.apply(`${RESULTS}?checkout=2027-03-04&checkin=2027-03-01&checkin_year=2027&checkin_month=3&ss=Paris`, '2027-03-08 to 2027-03-11'),
    `${RESULTS}?checkout=2027-03-11&checkin=2027-03-08&ss=Paris`, 'order kept, legacy split dates dropped');
  assert.equal(dates.apply(start, '2027-03-01 to 2027-03-04'), start.replace('#map', ''), 'the same range is the same URL');
  for (const bad of ['2027-03-11 to 2027-03-08', '2027-03-08 to 2027-04-08', '2027-03-08', '2027-02-30 to 2027-03-02', 'x to y', '', null]) {
    assert.equal(dates.apply(start, bad), null, String(bad));
  }
  assert.equal(dates.apply(`${RESULTS}?ss=Paris`, '2027-03-08 to 2027-03-11'), null, 'no dates to rewrite');
  assert.equal(dates.apply(`${PARIS_URL}&checkin=2027-03-02`, '2027-03-08 to 2027-03-11'), null, 'two checkin parameters');
  assert.equal(dates.apply('not a url', '2027-03-08 to 2027-03-11'), null);
  assert.equal(bookingUrlRange(`${RESULTS}?checkin=2027-03-04&checkout=2027-03-01`), null);
  assert.equal(bookingUrlForRange(start, '2027-03-08 to 2027-03-11'), dates.apply(start, '2027-03-08 to 2027-03-11'));
  assert.equal(dates.label('2027-03-08 to 2027-03-11'), 'results for 2027-03-08 to 2027-03-11');
  assert.equal(dates.fromEmpty, undefined, 'the URL must hold a stay to move');
});

test('same origin: both kinds only ever rewrite the query of the page\'s own origin and path', () => {
  assert.equal(rewriteWithin(search, RESULTS, PARIS), PARIS_URL);
  assert.equal(rewriteWithin(search, `${RESULTS}?lang=en-gb&dest_id=-1&ss=Old`, PARIS), `${PARIS_URL}&lang=en-gb`);
  assert.equal(rewriteWithin(search, 'https://www.booking.com/', PARIS), null, 'the start page is not the results page');
  assert.equal(search.apply('https://www.booking.com/', PARIS), null, 'the kind itself builds the results path only');
  assert.equal(rewriteWithin(search, 'https://www.booking.com/hotel/fr/x.html', PARIS), null);
  assert.equal(search.current('https://www.booking.com/hotel/fr/x.html?ss=Paris&checkin=2027-03-01&checkout=2027-03-04'), null);
  // The localized results path is the results page too.
  assert.equal(search.apply('https://www.booking.com/searchresults.en-gb.html', PARIS), PARIS_URL.replace('searchresults.html', 'searchresults.en-gb.html'));
  assert.equal(search.apply('https://www.booking.com/searchresults.evil.html', PARIS), null);
  assert.equal(rewriteWithin(dates, PARIS_URL, '2027-03-08 to 2027-03-11'), PARIS_URL.replace('checkin=2027-03-01&checkout=2027-03-04', 'checkin=2027-03-08&checkout=2027-03-11'));
  assert.equal(rewriteWithin(dates, 'https://www.booking.com/', '2027-03-08 to 2027-03-11'), null);
  assert.equal(rewriteWithin(dates, 'javascript:alert(1)', '2027-03-08 to 2027-03-11'), null);
  for (const kind of [search, dates]) {
    const value = kind === search ? PARIS : '2027-03-08 to 2027-03-11';
    const url = rewriteWithin(kind, `${RESULTS}?ss=Rome&checkin=2027-05-01&checkout=2027-05-03`, value);
    assert.equal(new URL(url).origin, 'https://www.booking.com');
    assert.equal(new URL(url).pathname, '/searchresults.html');
    assert.equal(kind.current(url), value);
  }
});

test('registry: the task\'s kinds are the ones a profile names through src/shortcuts.js, and its nouns reach the core', () => {
  assert.deepEqual(Object.keys(shortcutKinds), ['booking_search', 'booking_dates']);
  for (const id of Object.keys(shortcutKinds)) assert.equal(SHORTCUT_KINDS[id], shortcutKinds[id], id);
  assert.deepEqual([...vocabulary.askNouns], ['hotels?', 'propert(?:y|ies)', 'nights?', 'totals?']);
});

// ------------------------------------------------------------------------------------------------ results digest

// A results page shaped like Booking.com's: one card per property with its name, rating, review count and the price
// for the stay; a sponsored card first, a sold-out card without a price, filters and sort controls around them.
const CARDS = [
  'Sponsored · Hôtel Saint-Marcel · Latin Quarter, Paris · Scored 8.1 · Very good · 1,204 reviews · Double Room · 3 nights, 2 adults · €510 · Includes taxes and charges · See availability',
  'Hôtel du Nord · 10th arr., Paris · Scored 8.6 · Fabulous · 2,345 reviews · Standard Double Room · Free cancellation · 3 nights, 2 adults · €420 · Includes taxes and charges · See availability',
  'Le Petit Belloy · Latin Quarter, Paris · Scored 7.9 · Good · 988 reviews · Classic Room · 3 nights, 2 adults · €366 · +€12 taxes and charges · See availability',
  'Hôtel Lumière · Montmartre, Paris · Scored 9.1 · Wonderful · 3,110 reviews · Deluxe Room · Breakfast included · 3 nights, 2 adults · €645 · Includes taxes and charges · See availability',
  'Hôtel de la Gare · Gare du Nord, Paris · Scored 8.3 · Very good · 1,560 reviews · You missed it! · Sold out on Booking.com for your dates · See availability',
  'Maison Clément · Le Marais, Paris · Scored 8.8 · Fabulous · 712 reviews · Superior Room · Genius · 3 nights, 2 adults · €399 · Includes taxes and charges · See availability',
];
const HOTEL_RESULTS = {
  url: 'https://stays.test/searchresults.html?ss=Paris&checkin=2027-03-01&checkout=2027-03-04&group_adults=2&group_children=0&no_rooms=1',
  title: 'Booking.com: Hotels in Paris. Book your hotel now!',
  text: '',
  controls: [],
  blocks: [
    ...['Skip to main content', 'Stays', 'Flights', 'Car rentals', 'Register', 'Sign in'].map((text, i) => ({ t: 'button', text, ref: String(i + 1) })),
    { t: 'p', text: 'Paris · Wed, 1 Mar – Sat, 4 Mar · 2 adults · 0 children · 1 room' },
    { t: 'button', text: 'Search', ref: '7' },
    { t: 'h2', text: 'Filter by:' },
    ...['Your budget (per night)', 'Review score', 'Free cancellation', 'Breakfast included', 'Property type', 'Neighbourhood']
      .map((text, i) => ({ t: 'button', text, ref: String(i + 8) })),
    { t: 'h1', text: 'Paris: 1,842 properties found' },
    { t: 'button', text: 'Sort by: Our top picks', ref: '14' },
    { t: 'button', text: 'Show on map', ref: '15' },
    ...CARDS.map(text => ({ t: 'li', text })),
    { t: 'button', text: 'Load more results', ref: '16', offscreen: true },
    { t: 'p', text: 'Prices are the total for the stay including taxes and charges unless stated otherwise. Genius prices need a signed-in account.', offscreen: true },
  ],
};
const HOTEL_QUESTION = 'Which hotel with a rating of 8 or more is cheapest for the stay, with its name, price for the stay and rating?';

test('stay results: every property card survives in the digest, whole and in order, the sponsored and sold-out ones too', () => {
  const { digest } = buildDigest(HOTEL_RESULTS, HOTEL_QUESTION);
  const texts = digest.map(block => block.text);
  assert.ok(texts.length <= 25 && texts.join('').length <= 1500, `${texts.length} blocks, ${texts.join('').length} chars`);
  const at = CARDS.map(text => texts.indexOf(text));
  assert.ok(at.every(index => index >= 0), JSON.stringify(texts));
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.ok(!digest.some(block => block.t === 'li' && block.text.endsWith('…')), 'no card clipped: a clipped card loses its price');
  assert.ok(texts.indexOf('Paris: 1,842 properties found') < at[0], 'the heading before its rows');
  // Every card with a price is a candidate for the price question; the sold-out card has none, so it is in the digest
  // for the host to see but never the cheapest.
  const candidates = pickAnswerCandidates(HOTEL_RESULTS, HOTEL_QUESTION);
  const priced = CARDS.filter(text => /€\d/.test(text));
  assert.equal(priced.length, 5);
  assert.ok(priced.every(text => candidates.some(candidate => candidate.text === text)), 'every priced card is a candidate');
  assert.ok(!candidates.some(candidate => candidate.text === CARDS[4]), 'the sold-out card is not a price candidate');
});

test('stay results: a "cheapest with its name, price and rating" question keeps the whole card, not the price alone', () => {
  const ranked = (...pairs) => ({ method: 'provider', candidates: pairs.map(([text, confidence]) => ({ text, confidence })) });
  const { answer, why } = autoConfirm(ranked([CARDS[1], 0.96], [CARDS[5], 0.02]), { question: HOTEL_QUESTION });
  assert.ok(answer, String(why));
  assert.equal(answer.text, CARDS[1], 'the card carries the name, the price and the rating');
  assert.equal(answer.exact, false, 'a compound line: the host replies with the parts asked');
  assert.ok(answer.basis.includes('value:multi_part_line'), answer.basis.join(','));
  // The price alone never confirms for the same question.
  const price = autoConfirm(ranked(['€420', 0.96], ['x', 0.02]), { question: HOTEL_QUESTION });
  assert.equal(price.answer, null);
  assert.deepEqual(price.why, ['answer:multi_part']);
  // A single-part question still cuts the price out of the card.
  const single = autoConfirm(ranked([CARDS[1], 0.96], [CARDS[5], 0.02]), { question: 'What does Hôtel du Nord cost for the stay?' });
  assert.equal(single.answer?.text, '€420');
});
