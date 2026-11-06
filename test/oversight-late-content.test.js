// Regression: bench 2026-10-04-oversight slow-content 0/3. The host's expectation was only {"urlIncludes": "/slow"}
// (the bench prompt had dropped the textAbsent example), the provider reported done 0.5 on the page while it still
// showed "Loading reconciliation status…", and the run completed as verified after one click with the pre-load
// digest; next said answer_from_digest. The runtime now waits for a loading placeholder before completing, a late-load
// task never passes its expectation while one shows, and a placeholder is never auto-confirmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { autoConfirm, classifyIntent, isLoadingText, loadingBlocks, persistentPlaceholders } from '../src/digest.js';
import { FakeBridge, PAGES, link } from './runtime-fixtures.js';

const SLOW_LOADING = [
  { t: 'h1', text: 'Reconciliation status' },
  { t: 'p', text: 'The latest reconciliation result loads below.' },
  { t: 'p', text: 'Loading reconciliation status…' },
];
const SLOW_LOADED = [
  { t: 'h1', text: 'Reconciliation status' },
  { t: 'p', text: 'The latest reconciliation result loads below.' },
  { t: 'p', text: 'Batch 7 reconciled: 1,284 records' },
];

/** The fixture /slow page: the placeholder shows for `loadingObserves` observations after arrival (forever with Infinity). */
class SlowBridge extends FakeBridge {
  constructor(loadingObserves) {
    super({
      pages: {
        ...PAGES,
        '/': { title: 'Home', text: 'Welcome', controls: [link('7', 'Reconciliation status', '/slow')] },
        '/slow': { title: 'Reconciliation status', text: '', controls: [], blocks: SLOW_LOADING },
      },
    });
    this.loadingObserves = loadingObserves;
    this.slowSeen = 0;
  }

  get observation() {
    const observation = super.observation;
    if (this.path === '/slow' && this.slowSeen > this.loadingObserves) {
      observation.blocks = SLOW_LOADED.map(block => ({ ...block }));
      observation.text = SLOW_LOADED.map(block => block.text).join('\n');
      observation.revision += ':loaded';
    }
    return observation;
  }

  async observe(signal, options) {
    if (this.path === '/slow') this.slowSeen++;
    return super.observe(signal, options);
  }
}

/** The bench provider: click the link at done 0.08, then done 0.5 on /slow (the run-1 trace), choosing handoff. */
function benchProvider() {
  const calls = [];
  return {
    calls,
    model: 'fake',
    async decide(observation, actions) {
      calls.push(observation);
      const slow = new URL(observation.url).pathname === '/slow';
      const click = actions.find(action => action.label === 'Reconciliation status');
      return { actionId: slow ? 'handoff' : click.id, confidence: 0.9, done: { probability: slow ? 0.5 : 0.08 } };
    },
  };
}

const RUN = {
  allowedOrigins: ['https://example.com'],
  expectation: { urlIncludes: '/slow' },
  answerQuestion: 'What text appears in the delayed section once it has loaded?',
  maxActions: 2,
  contentWaitMs: 0,
};
const INSTRUCTION = 'Open /slow, wait for the delayed section to finish loading, read its text, and stop on /slow.';

test('slow-content: the run waits for the placeholder and completes on the loaded text without an extra decision',
  async () => {
    const bridge = new SlowBridge(2);
    const provider = benchProvider();
    const runtime = new BrowserRuntime({ bridge, provider });
    const result = await runtime.run(INSTRUCTION, RUN);
    assert.equal(result.status, 'completed');
    assert.equal(result.code, 'expectation_passed');
    const lean = agentResult(result);
    assert.ok(lean.page.digest.includes('Batch 7 reconciled: 1,284 records'), lean.page.digest.join(' / '));
    assert.ok(!lean.page.digest.some(line => /Loading/.test(line)));
    assert.ok(lean.verdict.why.includes('content_wait'));
    assert.ok(!lean.verdict.why.includes('content_loading'));
    // Every provider decision on /slow saw the loaded page; the waits cost no decision.
    assert.ok(provider.calls.filter(o => o.url.endsWith('/slow')).every(o => !loadingBlocks(o).length));
    assert.equal(result.cost.decisions, 2);
  });

test('slow-content: a placeholder that never goes fails a late-load expectation and is never verified', async () => {
  const bridge = new SlowBridge(Infinity);
  const runtime = new BrowserRuntime({ bridge, provider: benchProvider() });
  const result = await runtime.run(INSTRUCTION, { ...RUN, retry: false });
  assert.notEqual(result.status, 'completed');
  assert.equal(result.verification.passed, false);
  const lean = agentResult(result);
  assert.notEqual(lean.verdict.kind, 'verified');
  assert.equal(lean.verdict.answer, null);
  assert.ok(lean.verdict.why.includes('content_loading'));
  assert.notEqual(lean.next.kind, 'answer_from_digest');
  assert.equal(lean.verdict.suggested?.expectation?.textAbsent, 'Loading');
});

test('a completed run whose final page still shows a placeholder is likely, not verified, and says rerun', async () => {
  const bridge = new SlowBridge(Infinity);
  const runtime = new BrowserRuntime({ bridge, provider: benchProvider() });
  // No late-load words in the question or instruction: the expectation passes, the receipt still flags the page.
  const result = await runtime.run('Open the Reconciliation status page and stop there.', {
    ...RUN, answerQuestion: 'What does the reconciliation status say?', retry: false,
  });
  assert.equal(result.status, 'completed');
  const lean = agentResult(result);
  assert.equal(lean.verdict.kind, 'likely');
  assert.equal(lean.verdict.answer, null);
  assert.ok(lean.verdict.why.includes('content_loading'));
  assert.equal(lean.next.kind, 'rerun');
  assert.deepEqual(lean.verdict.suggested.expectation, { urlIncludes: '/slow', textAbsent: 'Loading' });
  assert.match(lean.next.text, /loading placeholder/);
});

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

test('a step list whose last page still shows a placeholder checks the call\'s own expectation; a mismatch fails the call', async () => {
  const step = { instruction: 'Open the Reconciliation status page and stop there.', expectation: { urlIncludes: '/slow' },
    answerQuestion: 'What does the reconciliation status say?' };
  const options = { ...RUN, expectation: undefined, answerQuestion: undefined, retry: false };
  const failed = agentResult(await new BrowserRuntime({ bridge: new SlowBridge(Infinity), provider: benchProvider() })
    .run({ ...options, steps: [step], expectation: { urlIncludes: '/settings' } }));
  assert.ok(failed.verdict.why.includes('steps:final_expectation_failed'));
  assert.equal(failed.verification.passed, false);
  assert.equal(failed.code, 'expectation_failed');
  // The call's expectation holds there: the receipt is the single run's (likely, content_loading), not a failure.
  const held = agentResult(await new BrowserRuntime({ bridge: new SlowBridge(Infinity), provider: benchProvider() })
    .run({ ...options, steps: [step], expectation: { urlIncludes: '/slow' } }));
  assert.ok(held.verdict.why.includes('content_loading'));
  assert.ok(!held.verdict.why.includes('steps:final_expectation_failed'));
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

/** Day pages /day/10../day/13 with persistent status text and a link to the next day. */
class StatusBridge extends FakeBridge {
  constructor({ hidden = false } = {}) {
    const pages = { ...PAGES };
    for (const day of [10, 11, 12, 13]) {
      const blocks = DAY_ROWS(day).map(block => (hidden && block.text === 'Loading results' ? { ...block, hidden: true } : block));
      pages[`/day/${day}`] = { title: `Flights 2026-10-${day}`, text: '', blocks,
        controls: day < 13 ? [link('1', 'Next day', `/day/${day + 1}`)] : [] };
    }
    super({ pages, path: '/day/10' });
  }
}

/** Clicks Next day until the page shows the wanted day, then done 0.9 (the live done was 0.83-0.89). */
function dayProvider(target) {
  return {
    model: 'fake',
    async decide(observation, actions) {
      const day = Number(new URL(observation.url).pathname.split('/').pop());
      if (day >= target) return { actionId: 'done', confidence: 0.9, done: { probability: 0.9 } };
      return { actionId: actions.find(action => action.label === 'Next day').id, confidence: 0.9, done: { probability: 0.05 } };
    },
  };
}

const DAY_RUN = { allowedOrigins: ['https://example.com'], answerQuestion: 'Which flights depart between 10:00 and 12:00?',
  maxActions: 3, contentWaitMs: 0, retry: false };

test('persistent status text: two settle waits instead of eight, no content_loading, no textAbsent suggestion', async () => {
  const bridge = new StatusBridge();
  const result = await new BrowserRuntime({ bridge, provider: dayProvider(11) })
    .run('Go to the next day and read the flights', { ...DAY_RUN, expectation: { urlIncludes: '/day/11' } });
  assert.equal(result.status, 'completed', result.code);
  const lean = agentResult(result);
  assert.ok(lean.verdict.why.includes('content_status:persistent'), lean.verdict.why.join(','));
  assert.ok(!lean.verdict.why.includes('content_loading'));
  assert.equal(lean.verdict.suggested, null);
  assert.notEqual(lean.next.kind, 'rerun');
  // Observes: the start page and two re-observes after two quiet waits (a visible placeholder, PERSISTENT_QUIET_WAITS;
  // the click returns the landing page). Eight waits before the fix: 9 observes.
  assert.equal(bridge.observes, 3);
  assert.equal(result.cost.decisions, 2);
});

test('persistent status text marked hidden by the page script costs no wait at all', async () => {
  const bridge = new StatusBridge({ hidden: true });
  const result = await new BrowserRuntime({ bridge, provider: dayProvider(11) })
    .run('Go to the next day and read the flights', { ...DAY_RUN, expectation: { urlIncludes: '/day/11' } });
  assert.equal(result.status, 'completed', result.code);
  const lean = agentResult(result);
  assert.ok(!lean.verdict.why.some(code => /^content_(wait|loading|status)/.test(code)), lean.verdict.why.join(','));
  assert.equal(bridge.observes, 1);
  // Next to the page's rows only (a hidden placeholder alone is loading: the next test).
  assert.deepEqual(loadingBlocks({ blocks: DAY_ROWS(10).map(block => ({ ...block, hidden: block.t === 'p' })) }), []);
});

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

test('a step list goes on past a step whose expectation passed on a page that still shows a placeholder', async () => {
  // Trace e5725476: step 1 passed (expectation_passed) but the list stopped on content_loading, 0/4. Here the page
  // has no rows, so the placeholder stays a placeholder (content_loading), and the list still goes on.
  const steps = [
    { instruction: 'Open the Reconciliation status page.', expectation: { urlIncludes: '/slow' } },
    { instruction: 'Stay on this page.', expectation: { urlIncludes: '/slow' } },
  ];
  const result = await new BrowserRuntime({ bridge: new SlowBridge(Infinity), provider: benchProvider() })
    .run({ ...RUN, expectation: undefined, answerQuestion: undefined, retry: false, steps });
  const lean = agentResult(result);
  assert.deepEqual(lean.stepResults.map(entry => entry.status), ['completed', 'completed']);
  assert.ok(lean.verdict.why.includes('steps:2/2'), lean.verdict.why.join(','));
});

test('persistent status text on a run that never waited: the receipt compares the earlier observation of the page', async () => {
  // Traces 5512c8dd and faba5dfb: no content wait ran (the expectation failed), yet the receipt flagged
  // content_loading for the status text that sat on every observation of the page.
  const bridge = new StatusBridge();
  let decisions = 0;
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      decisions++;
      // Two scrolls: a visible placeholder needs two earlier unchanged observations of the page (PERSISTENT_QUIET_WAITS).
      if (decisions <= 2) return { actionId: actions.find(action => action.type === 'scroll').id, confidence: 0.9, done: { probability: 0.1 } };
      return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.1 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider })
    .run('Read the flights on this page', { ...DAY_RUN, expectation: { textIncludes: 'Departing flights' } });
  const lean = agentResult(result);
  assert.ok(lean.verdict.why.includes('content_status:persistent'), lean.verdict.why.join(','));
  assert.ok(!lean.verdict.why.includes('content_loading'));
  assert.ok(!lean.verdict.suggested?.expectation?.textAbsent);
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

test('a visible placeholder next to stale rows that resolves on the second wait is waited for, and the fresh rows are read', async () => {
  // 3+ text rows (the previous search's) plus a visible "Loading…": one quiet wait is not enough to call it status text.
  const stale = [{ t: 'h1', text: 'Results' }, { t: 'p', text: 'Loading…' },
    ...['Ridge €101', 'Ridge €102', 'Ridge €103'].map(text => ({ t: 'li', text }))];
  const fresh = [{ t: 'h1', text: 'Results' }, ...['Fresh €201', 'Fresh €202', 'Fresh €203'].map(text => ({ t: 'li', text }))];
  class StaleBridge extends FakeBridge {
    async observe(signal, options) {
      const observation = await super.observe(signal, options);
      if (this.path !== '/results') return observation;
      this.seen = (this.seen ?? 0) + 1;
      // The landing observation (the click's) and the first wait still stale; the second wait has the fresh rows.
      this.pages['/results'].blocks = this.seen >= 2 ? fresh : stale;
      return this.observation;
    }
  }
  const pages = { ...PAGES,
    '/start': { title: 'Search', text: 'Search', controls: [link('1', 'Results', '/results')] },
    '/results': { title: 'Results', text: '', blocks: stale, controls: [] } };
  const bridge = new StaleBridge({ pages, path: '/start' });
  const jev = { model: 'fake', async decide(observation, actions) {
    if (new URL(observation.url).pathname === '/start') {
      return { actionId: actions.find(action => action.label === 'Results').id, confidence: 0.9, done: { probability: 0.05 } };
    }
    return { actionId: 'done', confidence: 0.9, done: { probability: 0.9 } };
  } };
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open Results and read the prices', {
    allowedOrigins: ['https://example.com'], answerQuestion: 'What are the prices?', expectation: { urlIncludes: '/results' },
    maxActions: 3, contentWaitMs: 0, retry: false });
  const lean = agentResult(result);
  assert.ok(!lean.verdict.why.includes('content_status:persistent'), lean.verdict.why.join(','));
  assert.ok(bridge.seen >= 2, `observes of /results: ${bridge.seen}`);
  assert.match(JSON.stringify(result.observation.blocks), /Fresh €201/);
});
