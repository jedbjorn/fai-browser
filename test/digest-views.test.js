// Derived views on the daemon side: the digest accepts chart blocks and keyed grid rows (src/digest.js), and the page
// script's unreadable_region warning reaches the receipt as one fixed code per kind (src/runtime.js unreadableWarnings).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_TYPES, blocksOf, buildDigest, pickAnswerCandidates } from '../src/digest.js';
import { BrowserRuntime, unreadableWarnings } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FakeBridge, clickProvider } from './runtime-fixtures.js';

const CHART = 'Price graph: 14 bars read from their heights, lowest Oct 10 ≈€87, highest Oct 12 ≈€150: Oct 6 ≈€121, Oct 7 ≈€98';
const FLIGHTS = {
  url: 'https://fixture.test/flights',
  title: 'Marseille to London',
  text: '',
  controls: [],
  blocks: [
    { t: 'h1', text: 'Flight search' },
    { t: 'h2', text: 'Price insights' },
    { t: 'chart', text: CHART },
    { t: 'h2', text: 'Top departing flights' },
    { t: 'li', text: '10:25 AM – 11:40 AM · Air France · Nonstop · €121' },
    { t: 'li', text: '6:25 AM – 7:25 AM · Ryanair · 1 stop · €87' },
    { t: 'h2', text: 'Date grid' },
    { t: 'tr', text: 'Depart | Oct 17 | Oct 18' },
    { t: 'tr', text: 'Oct 10 × Oct 17: €312; Oct 10 × Oct 18: €298' },
    { t: 'tr', text: 'Oct 11 × Oct 17: €287; Oct 11 × Oct 18: €264' },
    { t: 'h2', text: 'Plans' },
    { t: 'tr', text: 'Plan | Monthly' },
    { t: 'tr', text: 'Growth | $48' },
  ],
};

test('chart is a block type the digest keeps, weighted like a content block', () => {
  assert.ok(BLOCK_TYPES.includes('chart'));
  assert.equal(blocksOf(FLIGHTS).find(block => block.t === 'chart')?.text, CHART);
  const { digest } = buildDigest(FLIGHTS, 'Which day in the price graph is cheapest?', { maxBlocks: 4 });
  assert.ok(digest.some(block => block.t === 'chart'), JSON.stringify(digest));
  const [top] = pickAnswerCandidates(FLIGHTS, 'What is the cheapest price in the price graph?');
  assert.equal(top.t, 'chart');
});

test('a keyed grid row comes without its table header; a plain row still brings it', () => {
  const keyed = buildDigest(FLIGHTS, 'Oct 11 return Oct 18', { maxBlocks: 2 }).digest.map(block => block.text);
  assert.ok(keyed.includes('Oct 11 × Oct 17: €287; Oct 11 × Oct 18: €264'));
  assert.ok(!keyed.includes('Depart | Oct 17 | Oct 18'), JSON.stringify(keyed));
  const plain = buildDigest(FLIGHTS, 'Growth', { maxBlocks: 3 }).digest.map(block => block.text);
  assert.ok(plain.includes('Growth | $48'));
  assert.ok(plain.includes('Plan | Monthly'));
});

test('unreadableWarnings: one fixed code per known kind, in first-seen order; never page text', () => {
  assert.deepEqual(unreadableWarnings({ unreadable: [
    { kind: 'canvas', label: 'Date grid', reason: 'pixels_only' },
    { kind: 'chart', label: 'Price graph' },
    { kind: 'canvas', label: 'Seat map' },
    { kind: '<script>', label: 'x' },
  ] }), ['unreadable_region:canvas', 'unreadable_region:chart']);
  assert.deepEqual(unreadableWarnings({}), ['unreadable_region']);
});

test('the page script unreadable_region warning reaches the run receipt by kind', async () => {
  const pages = { '/': {
    title: 'Flights', text: 'Date grid', controls: [], warnings: ['unreadable_region'],
    unreadable: [{ kind: 'canvas', label: 'Date grid', reason: 'pixels_only', bounds: { x: 0, y: 0, width: 900, height: 130 } }],
  } };
  const bridge = new FakeBridge({ pages, path: '/' });
  const result = await new BrowserRuntime({ bridge, provider: clickProvider([], { fallback: 'done' }) })
    .run('Read the date grid.', { expectation: { textIncludes: 'Date grid' } });
  assert.ok(result.warnings.includes('unreadable_region:canvas'), JSON.stringify(result.warnings));
  assert.ok(agentResult(result).warnings.includes('unreadable_region:canvas'));
});
