// Regression: bench 2026-10-04-oversight slow-content 0/3. The host's expectation was only {"urlIncludes": "/slow"}
// (the bench prompt had dropped the textAbsent example), the provider reported done 0.5 on the page while it still
// showed "Loading reconciliation status…", and the run completed as verified after one click with the pre-load
// digest; next said answer_from_digest. The runtime now waits for a loading placeholder before completing, a late-load
// task never passes its expectation while one shows, and a placeholder is never auto-confirmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoConfirm, classifyIntent, isLoadingText, loadingBlocks, persistentPlaceholders } from '../src/digest.js';

const SLOW_LOADING = [
  { t: 'h1', text: 'Reconciliation status' },
  { t: 'p', text: 'The latest reconciliation result loads below.' },
  { t: 'p', text: 'Loading reconciliation status…' },
];

test('late intent covers the bench phrasings; placeholders are detected and never auto-confirmed', () => {
  assert.equal(classifyIntent('What text appears in the delayed section once it has loaded?'), 'late');
  assert.equal(classifyIntent('What text appears there once it has loaded?'), 'late');
  assert.equal(classifyIntent('A section loads after a short delay. What does it say?'), 'late');
  assert.equal(classifyIntent('What is the monthly price of the Pro plan?'), 'price');
  for (const text of ['Loading reconciliation status…', 'Loading', 'Please wait...', 'Fetching results…', '…']) {
    assert.equal(isLoadingText(text), true, text);
  }
  for (const text of ['Batch 7 reconciled: 1,284 records', 'The latest reconciliation result loads below.',
    'Loading times are shown in the table below for every region we serve today.']) {
    assert.equal(isLoadingText(text), false, text);
  }
  const answer = { method: 'provider', candidates: [{ text: 'Loading reconciliation status…', confidence: 0.97 },
    { text: 'Reconciliation status', confidence: 0.01 }] };
  const confirmed = autoConfirm(answer, { question: 'What does the reconciliation status say?' });
  assert.equal(confirmed.answer, null);
  assert.ok(confirmed.why.includes('answer:loading_text'));
});

// ---------------------------------------------------------------------------------------------------------------
// Persistent status text (live Google Flights run gf-week-window, 2026-10-06, traces 5566d511, add1024e, e5725476):
// every results page keeps a "Loading results" paragraph next to its rendered flight rows. The runtime waited all
// eight content waits per page (about 3.2 s at the default 400 ms), flagged content_loading, suggested
// textAbsent "Loading" (which then failed on the right page) and a step list stopped on the flag after its step passed.
// ---------------------------------------------------------------------------------------------------------------

const DAY_ROWS = day => [
  { t: 'h1', text: 'Flight search' },
  { t: 'p', text: 'Loading results' },
  { t: 'h3', text: 'Top flights' },
  { t: 'li', text: `10:40 AM – 11:45 AM · easyJet · Nonstop · €10${day}` },
  { t: 'li', text: `11:25 AM – 12:30 PM · Vueling · 1 stop · €13${day}` },
  { t: 'li', text: `6:00 AM – 9:25 AM · Air France · 1 stop · €14${day}` },
  { t: 'p', text: `Track prices departing 2026-10-${day}` },
];

test('persistentPlaceholders: same placeholder, unchanged rows and at least three rows; a lone placeholder keeps waiting', () => {
  const page = blocks => ({ blocks });
  const rows = DAY_ROWS(10);
  const placeholders = observation => loadingBlocks(observation);
  assert.equal(persistentPlaceholders(page(rows), page(rows), placeholders(page(rows))), true);
  // No earlier observation, or rows still arriving: not yet.
  assert.equal(persistentPlaceholders(null, page(rows), placeholders(page(rows))), false);
  const fewer = rows.filter(block => !block.text.startsWith('6:00'));
  assert.equal(persistentPlaceholders(page(fewer), page(rows), placeholders(page(rows))), false);
  // The slow fixture: a placeholder on an otherwise empty section is loading, however long it stays.
  assert.equal(persistentPlaceholders(page(SLOW_LOADING), page(SLOW_LOADING), placeholders(page(SLOW_LOADING))), false);
});

test('status text is only ever skipped on a page that carries rows: a hidden or once-persistent placeholder on an empty results page is loading', () => {
  // A screen-reader live region ("Loading results", 1px) is often the only text a real load shows next to text-less
  // skeleton rows; a text found persistent on one page is real loading on the next page that has nothing else yet.
  const empty = { blocks: [{ t: 'h1', text: 'Flight search' }, { t: 'p', text: 'Loading results', hidden: true }] };
  assert.equal(loadingBlocks(empty).length, 1);
  const visible = { blocks: [{ t: 'h1', text: 'Flight search' }, { t: 'p', text: 'Loading results' }] };
  assert.equal(loadingBlocks(visible, new Set(['Loading results'])).length, 1);
  const rows = { blocks: DAY_ROWS(10) };
  assert.deepEqual(loadingBlocks(rows, new Set(['Loading results'])), []);
  assert.deepEqual(loadingBlocks({ blocks: DAY_ROWS(10).map(block => ({ ...block, hidden: block.t === 'p' })) }), []);
});

