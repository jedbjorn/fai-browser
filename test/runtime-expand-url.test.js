// The runtime's own "Show more" click (completeList) on a page that rewrites its URL in place. Live (Google Flights,
// 2026-10-08): "View more flights" made the page history.replaceState its URL from /travel/flights?q=...2027-01-16 to
// /travel/flights/search?tfs=..., the host's `urlIncludes: "2027-01-16"` stopped matching, the expanded page was never
// adopted (more:unverified, more_offered) and the answer was not auto-confirmed. Generic fixture: a product list whose
// "Show more" rewrites the URL (replaceState or pushState) while the document stays; a real navigation to another
// page must still fail the URL expectation. No site logic in src/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, bridgeError } from '../src/result.js';
import { ORIGIN } from './runtime-fixtures.js';

const ROWS = ['Trail tent €187', 'Dome tent €132'];
const CHEAPER = 'Pop-up tent €58';
const QUESTION = 'Which tent is cheapest? Give the name and price.';

/** A catalogue page: heading, rows, an optional "Show more" button. */
function page({ url, title = 'Outdoor shop', heading = 'Product catalogue', rows, more = false, intro = 'Tents in stock today' }) {
  const blocks = [{ t: 'h2', text: heading }, { t: 'p', text: intro }, ...rows.map(text => ({ t: 'li', text }))];
  if (more) blocks.push({ t: 'button', text: 'Show more', ref: '9' });
  return {
    url, title, text: blocks.map(block => block.text).join('\n'), blocks,
    controls: more ? [{ id: '9', role: 'button', label: 'Show more', enabled: true, visible: true }] : [],
  };
}

/** The collapsed page, then after one click on "Show more" the expanded page (whatever URL it carries). */
class MoreBridge {
  constructor(collapsed, expanded) {
    this.pages = { collapsed, expanded };
    this.current = 'collapsed';
    this.executed = [];
  }

  get observation() {
    return { ...structuredClone(this.pages[this.current]), revision: `rev-${this.current}` };
  }

  async observe() {
    return this.observation;
  }

  async execute(action, expectedRevision) {
    if (expectedRevision !== `rev-${this.current}`) throw bridgeError('stale', 'Stale observation');
    this.executed.push(action);
    if (action.type === 'click' && action.target === '9') this.current = 'expanded';
    return { observation: this.observation, settle: { reason: 'quiet', ms: 1 }, screenshot: Promise.resolve(null) };
  }
}

const provider = () => ({
  model: 'x',
  requests: [],
  async decide() { return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } }; },
  async choose(request) { this.requests.push(request); return { choice: request.candidates[0].id, confidence: 0.97 }; },
});

async function run(collapsed, expanded, expectation) {
  const bridge = new MoreBridge(collapsed, expanded);
  const jev = provider();
  const runtime = new BrowserRuntime({ bridge, provider: jev });
  const result = await runtime.run('Read the tents listed.', { mode: 'reversible', capture: 'none', expectation, answerQuestion: QUESTION });
  return { result, lean: agentResult(result), bridge, provider: jev };
}

const COLLAPSED_URL = `${ORIGIN}/products?view=top`;

test('an expand click that rewrites the URL in place keeps the verified page: URL fields carried, text verified, answer confirmed', async () => {
  // replaceState to a canonical URL: same document, more rows, the button gone.
  const collapsed = page({ url: COLLAPSED_URL, rows: ROWS, more: true });
  const expanded = page({ url: `${ORIGIN}/products/all?sort=top&page=1`, rows: [...ROWS, CHEAPER] });
  const { result, lean, bridge, provider: jev } = await run(collapsed, expanded, { urlIncludes: 'view=top', textIncludes: 'Product catalogue' });
  assert.equal(result.status, 'completed', lean.verdict.why.join(' '));
  assert.deepEqual(bridge.executed.map(action => action.target), ['9'], 'the runtime clicked Show more once');
  assert.ok(lean.verdict.why.includes('more:expanded'), lean.verdict.why.join(' '));
  assert.ok(lean.verdict.why.includes('more:url_carried'), lean.verdict.why.join(' '));
  assert.ok(!lean.verdict.why.includes('more:unverified') && !lean.verdict.why.includes('answer:more_unverified'), lean.verdict.why.join(' '));
  assert.equal(result.observation.url, expanded.url, 'the expanded page is the final page');
  assert.equal(lean.verification.passed, true);
  assert.deepEqual(lean.verification.carried, ['urlIncludes']);
  assert.equal(lean.verification.hint, undefined);
  assert.match(jev.requests.at(-1).candidates[0].text, /Pop-up tent €58/, 'the ranking saw the whole list');
  assert.ok(lean.verdict.answer, `auto-confirmed: ${lean.verdict.why.join(' ')}`);
  assert.match(lean.verdict.answer.text, /Pop-up tent/);
  assert.ok(!(lean.answer?.aggregate?.why ?? []).includes('more_offered'));
  assert.equal(result.steps.at(-1).decision.reason, 'expand_more');
});

test('pushState to another path on the same origin counts the same way; urlEquals and urlMatches are carried too', async () => {
  const collapsed = page({ url: COLLAPSED_URL, rows: ROWS, more: true });
  const expanded = page({ url: `${ORIGIN}/products/view/top/expanded`, rows: [...ROWS, CHEAPER] });
  const { result, lean } = await run(collapsed, expanded, { urlEquals: COLLAPSED_URL, urlMatches: 'view=top$', titleIncludes: 'Outdoor' });
  assert.equal(result.status, 'completed', lean.verdict.why.join(' '));
  assert.ok(lean.verdict.why.includes('more:url_carried'), lean.verdict.why.join(' '));
  assert.deepEqual(lean.verification.carried, ['urlEquals', 'urlMatches']);
  assert.equal(result.observation.url, expanded.url);
  assert.ok(lean.verdict.answer, lean.verdict.why.join(' '));
});

test('a text condition the expanded page loses is not carried: the earlier page stays final and nothing is confirmed', async () => {
  const collapsed = page({ url: COLLAPSED_URL, rows: ROWS, more: true });
  // The URL is rewritten and the rows kept, but the intro line the host expected is gone.
  const expanded = page({ url: `${ORIGIN}/products/all?sort=top`, rows: [...ROWS, CHEAPER], intro: 'Tents' });
  const { result, lean } = await run(collapsed, expanded, { urlIncludes: 'view=top', textIncludes: 'in stock today' });
  assert.ok(lean.verdict.why.includes('more:unverified'), lean.verdict.why.join(' '));
  assert.ok(!lean.verdict.why.includes('more:url_carried'));
  assert.equal(result.observation.url, COLLAPSED_URL, 'the verified page from before the click stays final');
  assert.equal(lean.verification.carried, undefined);
  assert.equal(lean.verdict.answer ?? null, null);
});

test('a "Show more" that navigates to a different page never passes the URL expectation', async () => {
  const collapsed = page({ url: COLLAPSED_URL, rows: ROWS, more: true });
  const cases = [
    // Another page of the site: a new heading, its own rows.
    page({ url: `${ORIGIN}/products/all`, heading: 'All products', intro: 'Everything we sell', rows: ['Camp stove €40', CHEAPER, 'Head torch €18'] }),
    // The same heading, but the rows replaced (page 2 of the catalogue): not an expansion.
    page({ url: `${ORIGIN}/products?view=all&page=2`, rows: ['Camp stove €40', CHEAPER, 'Head torch €18'] }),
    // Another origin.
    page({ url: 'https://other.example/products?view=top', rows: [...ROWS, CHEAPER] }),
  ];
  for (const expanded of cases) {
    const { result, lean, bridge } = await run(collapsed, expanded, { urlIncludes: 'view=top', textIncludes: 'Product catalogue' });
    assert.deepEqual(bridge.executed.map(action => action.target), ['9'], expanded.url);
    assert.ok(lean.verdict.why.includes('more:unverified'), `${expanded.url}: ${lean.verdict.why.join(' ')}`);
    assert.ok(!lean.verdict.why.includes('more:url_carried'), expanded.url);
    assert.equal(result.observation.url, COLLAPSED_URL, `${expanded.url}: the earlier page stays final`);
    assert.equal(lean.verification.passed, true, 'verified as it was before the click');
    assert.equal(lean.verification.carried, undefined);
    assert.equal(lean.verdict.answer ?? null, null, `${expanded.url}: ${JSON.stringify(lean.verdict.answer)}`);
    assert.ok(lean.verdict.why.includes('answer:more_unverified'), lean.verdict.why.join(' '));
  }
});

test('without a URL field in the expectation nothing is carried: the expanded page passes or fails on its text as before', async () => {
  const collapsed = page({ url: COLLAPSED_URL, rows: ROWS, more: true });
  const expanded = page({ url: `${ORIGIN}/products/all?sort=top`, rows: [...ROWS, CHEAPER] });
  const { result, lean } = await run(collapsed, expanded, { textIncludes: 'Product catalogue' });
  assert.ok(lean.verdict.why.includes('more:expanded'), lean.verdict.why.join(' '));
  assert.ok(!lean.verdict.why.includes('more:url_carried'));
  assert.equal(lean.verification.carried, undefined);
  assert.equal(result.observation.url, expanded.url);
  assert.ok(lean.verdict.answer, lean.verdict.why.join(' '));
});
