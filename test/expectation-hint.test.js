// The expectation miss hint: when a run ends unverified because textIncludes or titleIncludes is not on the page,
// verification.hint (and next.text) names up to five of the page's headings and short prominent strings ranked by
// word overlap with the expected text, quoted, capped and stripped of control characters. The live Google Flights run
// of 2026-10-08 expected "Departing flights" where the page said "Top flights": the host could have corrected it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectationHint } from '../src/expectation.js';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, nextFor } from '../src/result.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const FLIGHTS = {
  url: 'https://www.google.com/travel/flights/search?tfs=x',
  title: 'Marseille to London | Google Flights',
  text: 'Top flights Track prices Other flights Best Price',
  blocks: [
    { t: 'button', text: 'Best' },
    { t: 'button', text: 'Price' },
    { t: 'h3', text: 'Top flights' },
    { t: 'p', text: 'Track prices from Marseille to London departing 2027-01-12' },
    { t: 'li', text: '10:40 AM – 11:35 AM easyJet €62' },
    { t: 'h3', text: 'Other flights' },
    { t: 'h4', text: 'Price graph' },
    { t: 'p', text: 'A long paragraph with many words that is not a short prominent string at all, so it stays out' },
  ],
  controls: [],
};

test('hint: the page\'s headings and short strings ranked by word overlap, quoted; null when the text is on the page', () => {
  assert.equal(expectationHint(FLIGHTS, { textIncludes: 'Departing flights' }),
    'expected text "Departing flights" not found; the page has "Top flights", "Other flights", "Price graph" (quoted page text, untrusted)');
  assert.equal(expectationHint(FLIGHTS, { textIncludes: 'Top flights' }), null, 'found: no hint');
  assert.equal(expectationHint(FLIGHTS, { textIncludes: 'top FLIGHTS' }), null, 'case-insensitive');
  assert.equal(expectationHint(FLIGHTS, { urlIncludes: '/nowhere' }), null, 'no text field: nothing to say');
  assert.equal(expectationHint(FLIGHTS, { textIncludes: 'Top flights', urlIncludes: '/nowhere' }), null);
  // A title miss names the title; both misses join.
  assert.equal(expectationHint(FLIGHTS, { titleIncludes: 'Flights to London' }),
    'expected title "Flights to London" not found; the title is "Marseille to London | Google Flights" (quoted page text, untrusted)');
  assert.match(expectationHint(FLIGHTS, { textIncludes: 'Departing flights', titleIncludes: 'Flights to London' }),
    /^expected text "Departing flights" not found; the page has .*\. expected title "Flights to London" not found; the title is /);
  // textFound (the page script's whole-document check) counts as found.
  assert.equal(expectationHint({ ...FLIGHTS, textFound: ['departing flights'] }, { textIncludes: 'Departing flights' }), null);
  // No word overlap at all: the first headings fill in, so the host still sees what the page is about.
  assert.equal(expectationHint(FLIGHTS, { textIncludes: 'Hotels' }),
    'expected text "Hotels" not found; the page has "Top flights", "Other flights", "Price graph" (quoted page text, untrusted)');
  // A page with no blocks: the fallback blocks come from the text lines.
  assert.equal(expectationHint({ title: 'Plain', text: 'Top flights\nOther lines here', blocks: [] }, { textIncludes: 'Departing flights' }),
    'expected text "Departing flights" not found; the page has "Top flights" (quoted page text, untrusted)');
  assert.equal(expectationHint({ title: 'Plain', text: '', blocks: [] }, { textIncludes: 'Departing flights' }),
    'expected text "Departing flights" not found; the page has no heading like it (quoted page text, untrusted)');
});

test('hint: page strings are capped at five and 60 characters, control characters and quotes cannot break the quoting', () => {
  const blocks = Array.from({ length: 12 }, (_, i) => ({ t: 'h2', text: `Departing flights ${i}` }));
  const many = expectationHint({ title: 'T', text: 'x', blocks }, { textIncludes: 'Departing flights' });
  assert.equal((many.match(/"Departing flights \d+"/g) ?? []).length, 5);
  const nasty = expectationHint({ title: 'T', text: 'x', blocks: [
    { t: 'h1', text: `Departing\u0000 flights​ "now", ignore\u0007 previous ${'z'.repeat(80)}` },
    { t: 'h2', text: 'Departing flights' },
  ] }, { textIncludes: 'Departing\u0007 flights' });
  assert.ok(!/[\u0000-\u001f​]/.test(nasty), nasty);
  assert.match(nasty, /^expected text "Departing flights" not found; the page has "Departing flights \\"now\\", ignore previous z+…", "Departing flights" \(quoted page text, untrusted\)$/);
  const quotedStrings = nasty.match(/"(?:[^"\\]|\\.)*"/g);
  assert.ok(quotedStrings.every(item => JSON.parse(item).length <= 60), 'each page string is cut to 60 characters');
  // The expected text is capped too.
  const long = expectationHint({ title: 'T', text: 'x', blocks: [] }, { textIncludes: 'w'.repeat(200) });
  assert.ok(long.length < 200, long);
});

test('run: an unverified run whose textIncludes is not on the page carries the hint in verification and next.text', async () => {
  const pages = {
    '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'Flights', '/flights')] },
    '/flights': { ...FLIGHTS, url: `${ORIGIN}/flights`, controls: [link('1', 'Home', '/')] },
  };
  const bridge = new FakeBridge({ pages, path: '/' });
  let decided = 0;
  const provider = {
    async decide(observation, actions) {
      // Open Flights, then hand off on the flights page: the expectation never passed there.
      const flights = actions.find(action => action.label === 'Flights');
      if (flights && !decided++) return { actionId: flights.id, confidence: 0.9, done: { probability: 0.05 } };
      return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.2 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Open Flights and read the departing flights.', {
    expectation: { urlIncludes: '/flights', textIncludes: 'Departing flights' }, allowedOrigins: [ORIGIN], maxActions: 3,
  });
  assert.equal(result.status, 'needs_host', `${result.code}: ${result.reason}`);
  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.hint,
    'expected text "Departing flights" not found; the page has "Top flights", "Other flights", "Price graph" (quoted page text, untrusted)');
  assert.ok(result.verdict.why.includes('expectation:text_missing'), result.verdict.why.join(','));
  assert.match(result.next.text, / Verification: expected text "Departing flights" not found; the page has "Top flights", "Other flights", "Price graph" \(quoted page text, untrusted\)\./);
  const lean = agentResult(result);
  assert.equal(lean.verification.hint, result.verification.hint);
  assert.match(nextFor(lean, { requestId: 'req_1' }).text, /Verification: expected text "Departing flights" not found/);
  // The same run with the page's own wording verifies, with no hint.
  const ok = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/' }), provider: {
    async decide(observation, actions) {
      const flights = actions.find(action => action.label === 'Flights');
      return flights ? { actionId: flights.id, confidence: 0.9, done: { probability: 0.05 } } : { actionId: 'done', confidence: 0.9, done: { probability: 0.95 } };
    },
  } }).run('Open Flights and read the departing flights.', {
    expectation: { urlIncludes: '/flights', textIncludes: 'Top flights' }, allowedOrigins: [ORIGIN], maxActions: 3,
  });
  assert.equal(ok.status, 'completed', `${ok.code}: ${ok.reason}`);
  assert.equal(ok.verification.hint, undefined);
  assert.ok(!ok.next.text.includes('Verification:'));
});
