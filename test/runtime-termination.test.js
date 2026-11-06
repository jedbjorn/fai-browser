// Termination rules for chained hops (src/runtime.js #loop, Session.earlyEnd/endOnPass/notePrepass/prepassOk) and the
// caps for long step lists (src/steps.js): a list step ends on its own passing expectation after its own action
// whatever done says; a bounded imperative ends once its named actions are done and the expectation passes; a
// pre-passing expectation counts only after an action changed the page; the control whose click made the expectation
// pass is not offered again on that page. Fake bridge and scripted providers; the same rules on the real fixture pages
// are in test/termination-fixtures.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, namedUrls, sameNamedPage, urlHopRefused } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { guardrailPolicy } from '../src/guardrails.js';
import { actionHops, boundedImperative, hopsDone, hopsDoneInOrder } from '../src/oversight.js';
import {
  LIST_DEFAULT_ACTIONS, LIST_MAX_ACTIONS, MAX_STEPS, listActionBudget, listTimeoutMs, validateSteps,
} from '../src/steps.js';
import { FakeBridge, ORIGIN, PAGES, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, type: 'button', enabled: true, ...extra });

// Catalog pages /c1../c6, each "Page N of 6" with a Next page link to the next one.
const CATALOG = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`/c${i + 1}`, {
  title: `Catalog page ${i + 1}`, text: `Page ${i + 1} of 6. Tents: Ridge ${100 + i}`,
  controls: i < 5 ? [link('1', 'Next page', `/c${i + 2}`)] : [],
}]));

/**
 * A done-aware provider: clicks the first offered action whose label is in `labels`, reports `done` (a number or a
 * function of the page path), and, unless `confirm: false`, has the slim guards request answering `guards`.
 */
function provider(labels, { done = 0.3, confirm = true, guards = { blocked: 0.01, injection: 0.01 }, choose } = {}) {
  const calls = { decide: [], confirm: [], offered: [] };
  const out = {
    model: 'fake',
    calls,
    async decide(observation, actions) {
      const path = new URL(observation.url).pathname;
      calls.decide.push(path);
      calls.offered.push(actions.map(action => action.label ?? action.type));
      const action = labels.map(label => actions.find(a => a.label === label)).find(Boolean);
      const p = typeof done === 'function' ? done(path, observation) : done;
      return { actionId: action?.id ?? 'handoff', confidence: 0.9, done: { probability: p } };
    },
  };
  if (confirm) {
    out.confirm = async observation => {
      calls.confirm.push(new URL(observation.url).pathname);
      const value = typeof guards === 'function' ? guards(calls.confirm.length - 1) : guards;
      if (value instanceof Error) throw value;
      return { done: { probability: 0.3 }, guards: value };
    };
  }
  if (choose) out.choose = choose;
  return out;
}

const kinds = result => result.cost.requests.map(entry => entry.kind);
const NEXT = n => ({ instruction: 'Click Next page.', expectation: { textIncludes: `Page ${n} of 6` }, maxActions: 3 });

// ---------------------------------------------------------------------------------------------------------------
// Hop helpers
// ---------------------------------------------------------------------------------------------------------------

test('boundedImperative: one or two named actions that do not loop; hopsDone matches labels, titles and paths', () => {
  assert.deepEqual(boundedImperative('Click Next page.'), ['Next']);
  assert.deepEqual(boundedImperative('On the flights page, click the "Date grid" button.'), ['"Date grid"']);
  assert.deepEqual(boundedImperative('Open About, then Members'), ['About', 'Members']);
  for (const open of ['Go through all 13 pages using Next page.', 'Click Next page until page 5.',
    'On every day click Show more.', 'Open About, then Members, then Team.', 'Read the price on this page.', '']) {
    assert.equal(boundedImperative(open), null, open);
  }
  assert.equal(hopsDone(['Next'], []), false, 'nothing done yet');
  assert.equal(hopsDone(['Next'], ['next page ›']), true, 'a stopword-only hop matches on its own word');
  assert.equal(hopsDone(['Tue 13 Oct day', 'Show 4 more flights'], ['tue 13 oct', 'show 4 more flights']), true);
  assert.equal(hopsDone(['About', 'Members'], ['about']), false, 'every hop must be done');
  assert.equal(hopsDone(['members list'], ['about', '/about']), false);
});

// ---------------------------------------------------------------------------------------------------------------
// List steps end on their own pass
// ---------------------------------------------------------------------------------------------------------------

test('list step: ends on its own passing expectation after one click although done stays low (no overshoot)', async () => {
  const jev = provider(['Next page'], { done: 0.35 });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const raw = await new BrowserRuntime({ bridge, provider: jev }).run({ steps: [NEXT(2), NEXT(3), NEXT(4)], capture: 'none' });
  const result = agentResult(raw);
  assert.equal(result.status, 'completed');
  assert.equal(result.page.url, `${ORIGIN}/c4`);
  assert.equal(result.steps.length, 3, 'one click per step');
  assert.deepEqual(jev.calls.decide, ['/c1', '/c2', '/c3'], 'no terminal decide on a page that passes');
  assert.deepEqual(jev.calls.confirm, ['/c2', '/c3', '/c4'], 'each step end gets the page guards');
  assert.deepEqual(kinds(raw), ['decide', 'step_guards', 'decide', 'step_guards', 'decide', 'step_guards']);
  assert.ok(result.verdict.why.includes('step:expectation_end'));
  assert.ok(result.stepResults.every(step => step.code === 'expectation_passed'));
});

test('list step: a provider without the slim guards request keeps the done-gated terminal decide', async () => {
  const jev = provider(['Next page'], { done: path => (path === '/c2' ? 0.9 : 0.2), confirm: false });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run({ steps: [NEXT(2)], capture: 'none' });
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(jev.calls.decide, ['/c1', '/c2'], 'the guards come from the terminal decide');
});

test('list step: a blocked score on the end-of-step guards marks the page and stops the list (confirm_page)', async () => {
  const jev = provider(['Next page'], { guards: n => (n === 0 ? { blocked: 0.9, injection: 0 } : { blocked: 0, injection: 0 }) });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev })
    .run({ steps: [NEXT(2), NEXT(3)], capture: 'none' }));
  assert.ok(result.verdict.why.includes('guard:blocked_page'));
  assert.deepEqual(result.stepResults.map(step => step.code), ['expectation_passed', 'not_run']);
  assert.equal(result.next.kind, 'confirm_page');
  assert.equal(result.page.url, `${ORIGIN}/c2`);
});

test('list step: a failed guards request falls back to the terminal decide', async () => {
  const jev = provider(['Next page'], { done: path => (path === '/c2' ? 0.9 : 0.2), guards: () => new Error('HTTP 502') });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const raw = await new BrowserRuntime({ bridge, provider: jev }).run({ steps: [NEXT(2)], capture: 'none' });
  assert.equal(raw.code, 'expectation_passed');
  assert.deepEqual(kinds(raw), ['decide', 'step_guards', 'decide']);
  assert.equal(raw.cost.requests[1].error, 'provider_error');
});

test('list step with a question: the answer ranking runs next to the end-of-step guards, no terminal decide', async () => {
  const chooses = [];
  const jev = provider(['Next page'], {
    choose: async (question, candidates) => {
      chooses.push(question);
      const index = candidates.findIndex(candidate => /Ridge 101/.test(candidate.text));
      return { choice: `c${Math.max(0, index)}`, probabilities: Object.fromEntries(candidates.map((_, i) => [`c${i}`, i === index ? 0.97 : 0.01])) };
    },
  });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const raw = await new BrowserRuntime({ bridge, provider: jev }).run({ steps: [
    { ...NEXT(2), answerQuestion: 'Which tent is on this page?' }], capture: 'none' });
  assert.equal(raw.code, 'expectation_passed');
  assert.deepEqual(jev.calls.decide, ['/c1']);
  assert.ok(kinds(raw).includes('step_guards'));
  assert.ok(!kinds(raw).slice(1).includes('decide'));
});

// ---------------------------------------------------------------------------------------------------------------
// Bounded imperatives (single runs)
// ---------------------------------------------------------------------------------------------------------------

test('single run: a bounded imperative ends once its named click is done and the expectation passes', async () => {
  const jev = provider(['Next page'], { done: 0.35 });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run('Click Next page.', {
    expectation: { textIncludes: 'Page 2 of 6' }, maxActions: 4, capture: 'none' }));
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.page.url, `${ORIGIN}/c2`);
  assert.ok(result.verdict.why.includes('early_end:named_actions'));
});

test('single run: an open-ended instruction keeps done gating (a pass with low done continues)', async () => {
  const jev = provider(['Next page'], { done: path => (path === '/c4' ? 0.9 : 0.2) });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Go through every page with Next page up to page 4.', {
    expectation: { textIncludes: 'of 6' }, maxActions: 6, capture: 'none' });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.page.url, `${ORIGIN}/c4`);
  assert.deepEqual(jev.calls.confirm, [], 'no early end');
});

test('single run: a bounded imperative whose named targets are not all done continues (loose expectation)', async () => {
  // "Open the members list" names a page the About click does not reach; About's text passes the loose check.
  const jev = provider(['About', 'Members'], { done: path => (path === '/members' ? 0.9 : 0.05) });
  const result = await new BrowserRuntime({ bridge: new FakeBridge(), provider: jev }).run('Open the members list',
    { expectation: { textIncludes: 'a' } });
  assert.equal(result.page.url, `${ORIGIN}/members`);
  assert.deepEqual(jev.calls.decide, ['/', '/about', '/members']);
});

// ---------------------------------------------------------------------------------------------------------------
// Pre-passing expectations and toggles
// ---------------------------------------------------------------------------------------------------------------

function togglePages() {
  return {
    '/fares': {
      title: 'Flights', text: 'Price insights. Date grid',
      controls: [button('1', 'Date grid', { toggles: true }), button('2', 'Price graph'), link('3', 'Help', '/help')],
    },
  };
}

/** A FakeBridge whose "Date grid" button opens and closes a grid (text "Lowest fare: €38"). */
class ToggleBridge extends FakeBridge {
  constructor() {
    super({ pages: togglePages(), path: '/fares' });
    this.open = false;
  }

  get observation() {
    const base = super.observation;
    return this.open ? { ...base, text: `${base.text}\nLowest fare: €38 on Sat 17` } : base;
  }

  async execute(action, expectedRevision, options) {
    if (action.type === 'click' && action.target === '1' && expectedRevision === this.observation.revision) {
      this.open = !this.open;
    }
    return super.execute(action, expectedRevision, options);
  }
}

const GRID = 'Click the "Date grid" button to open the date grid.';
const OPEN = { expectation: { textIncludes: 'Date grid' }, mode: 'reversible', maxActions: 4, capture: 'none' };

test('pre-passing: a start-page pass is recorded and never completes the run before the named click', async () => {
  const jev = provider(['Date grid'], { done: 0.7 });
  const bridge = new ToggleBridge();
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run(GRID, OPEN));
  assert.equal(result.status, 'completed');
  assert.ok(result.warnings.includes('expectation_prepassing'));
  assert.ok(result.verdict.why.includes('expectation_prepassing'));
  assert.equal(result.steps.length, 1, 'the toggle ran once');
  assert.equal(bridge.open, true, 'the grid is open at the end');
});

test('pre-passing: the toggle that made the expectation count is not offered again on that page', async () => {
  // Open-ended ("every"), so the opened grid gets a decide: Jev would click the toggle again (and close the grid).
  const jev = provider(['Date grid'], { done: 0.45 });
  const bridge = new ToggleBridge();
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run(`${GRID} Read every fare.`, OPEN));
  assert.equal(bridge.open, true);
  assert.equal(result.steps.length, 1);
  assert.ok(jev.calls.offered[0].includes('Date grid'));
  assert.ok(!jev.calls.offered[1].includes('Date grid'), 'excluded from the next offer');
  assert.ok(jev.calls.offered[1].includes('Price graph'), 'other controls stay offered');
  assert.ok(result.verdict.why.includes('toggle_excluded'));
  assert.equal(result.code, 'handoff_expectation_passed');
});

test('pre-passing: a click that changes nothing never makes the pass count', async () => {
  // "Price graph" does nothing in this fake: the revision stays, so the pre-passing check still does not count.
  const jev = provider(['Price graph'], { done: 0.9 });
  const bridge = new ToggleBridge();
  bridge.execute = async function execute(action, expectedRevision) {
    this.executions.push({ action, expectedRevision });
    return { observation: this.observation, settle: { reason: 'quiet', ms: 1 }, screenshot: Promise.resolve(null) };
  };
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Click the Price graph button.', { ...OPEN, maxActions: 2 });
  assert.notEqual(result.status, 'completed');
  assert.equal(result.verification.passed, false);
});

test('pre-passing: not gated for a task that names no action, or whose named page is the start page', async () => {
  const read = provider([], { done: 0.9 });
  const members = await new BrowserRuntime({ bridge: new FakeBridge({ path: '/members' }), provider: read })
    .run('Read the names on this page.', { expectation: { textIncludes: 'Grace' } });
  assert.equal(members.code, 'expectation_passed');
  assert.equal(members.steps.length, 0);
  assert.ok(!(members.warnings ?? []).includes('expectation_prepassing'));
  const about = await new BrowserRuntime({ bridge: new FakeBridge({ path: '/about' }), provider: provider([], { done: 0.9 }) })
    .run('Open About', { expectation: { urlIncludes: '/about' } });
  assert.equal(about.code, 'expectation_passed');
  assert.equal(about.steps.length, 0, 'already there');
});

// ---------------------------------------------------------------------------------------------------------------
// Caps for chaining
// ---------------------------------------------------------------------------------------------------------------

test('caps: 15 steps per list, a list budget of the steps summed up to 60 (120 when asked), 6 s per step of time', async () => {
  assert.equal(MAX_STEPS, 15);
  const step = { instruction: 'Click Next page.', expectation: { urlIncludes: '/c' } };
  assert.equal(validateSteps(Array(15).fill(step)).length, 15);
  assert.throws(() => validateSteps(Array(16).fill(step)), /1 to 15 steps/);
  assert.equal(listActionBudget(Array(15).fill(step)), LIST_DEFAULT_ACTIONS, '15 x 8 capped at 60');
  assert.equal(listActionBudget([{ ...step, maxActions: 3 }, { ...step, maxActions: 4 }]), 7);
  assert.equal(LIST_MAX_ACTIONS, 120);
  assert.deepEqual([1, 5, 8, 15, 30].map(listTimeoutMs), [45_000, 45_000, 48_000, 90_000, 120_000]);
  // The runtime: 120 accepted for a list, 121 refused.
  const pages = { ...PAGES, '/': { ...PAGES['/'], controls: [link('1', 'About', '/about')] } };
  const ok = await new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider: provider(['About']) })
    .run({ steps: [{ instruction: 'Open About', expectation: { urlIncludes: '/about' } }], maxActions: 120, capture: 'none' });
  assert.equal(ok.code, 'expectation_passed');
  await assert.rejects(new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider: provider(['About']) })
    .run({ steps: [{ instruction: 'Open About', expectation: { urlIncludes: '/about' } }], maxActions: 121 }), /maxActions/);
});

test('caps: a 15-step list runs in one call with every stepResult, inside the default list budget', async () => {
  const pages = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`/s${i}`, {
    title: `Stop ${i}`, text: `Stop ${i} of 15`, controls: i < 15 ? [link('1', 'Next stop', `/s${i + 1}`)] : [] }]));
  const jev = provider(['Next stop'], { done: 0.3 });
  const steps = Array.from({ length: 15 }, (_, i) => ({ instruction: 'Click Next stop.', expectation: { urlIncludes: `/s${i + 1}` }, maxActions: 2 }));
  const raw = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/s0' }), provider: jev }).run({ steps, capture: 'none' });
  const result = agentResult(raw);
  assert.equal(result.status, 'completed');
  assert.equal(result.stepResults.length, 15);
  assert.equal(result.steps.length, 15);
  assert.equal(result.page.url, `${ORIGIN}/s15`);
  assert.equal(raw.cost.decisions, 15);
});

// ---------------------------------------------------------------------------------------------------------------
// Review: early-end false positives (the hop matcher and the bounded-imperative classifier)
// ---------------------------------------------------------------------------------------------------------------

test('hop matcher: whole words in order, one action per hop; loop and repeat wording is never bounded', () => {
  assert.equal(hopsDone(['Art'], ['start']), false, 'no substring inside another word');
  assert.equal(hopsDone(['Pro'], ['products']), true, 'a word prefix still matches');
  assert.equal(hopsDone(['Plan'], ['/plans']), true);
  assert.equal(hopsDone(['Page 1'], ['page 13']), false, 'numbers match exactly');
  assert.equal(hopsDoneInOrder(['Next', 'Next'], [['next page']]), false, 'a hop named twice needs two clicks');
  assert.equal(hopsDoneInOrder(['Next', 'Next'], [['next page'], ['next page']]), true);
  assert.equal(hopsDoneInOrder(['Settings', 'Billing'], [['settings', 'settings and billing']]), false,
    'an intermediate page that mentions the next hop does not do it');
  assert.equal(hopsDoneInOrder(['Settings', 'Billing'], [['billing'], ['settings']]), false, 'in order');
  assert.equal(hopsDoneInOrder(['Settings', 'Billing'], [['settings'], ['payment', '/settings/invoices']]), false,
    'a page reached by a link whose text differs from the name is not done (falls back to done gating)');
  for (const open of ['Click Next twice.', 'Click Next, then Next again.', 'Click Next page 3 times.',
    'Keep clicking Next page.', 'Click Show more while it is shown.', 'Click Next page until you see Tent X.',
    'Scroll and find the Tent X price.', 'Click through the pages to find Tent X.', 'Browse the catalog.']) {
    assert.equal(boundedImperative(open), null, open);
  }
  // List steps use the hop matcher alone: a repeat word makes a hop that no action completes (done gating).
  assert.equal(hopsDoneInOrder(actionHops('Click Next page twice.'), [['next page'], ['next page']]), false);
  assert.equal(hopsDoneInOrder(actionHops('Click Next page until you see Tent X.'), [['next page', 'catalog page 2']]), false);
  assert.deepEqual(actionHops("Click 'Date grid' to open the date grid."), ["'Date grid'"], 'a purpose clause is no hop');
});

const SETTINGS = {
  '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'Settings', '/settings')] },
  '/settings': { title: 'Settings and billing', text: 'Profile. Billing overview.',
    controls: [link('2', 'Billing', '/settings/billing')] },
  '/settings/billing': { title: 'Billing', text: 'Billing. Invoices.', controls: [] },
};

test('early end: "Open Settings, then Billing" does not end on the Settings page whose text and title say billing', async () => {
  const jev = provider(['Settings', 'Billing'], { done: 0.3 });
  const bridge = new FakeBridge({ pages: SETTINGS, path: '/' });
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run('Open Settings, then Billing.',
    { expectation: { textIncludes: 'Billing' }, maxActions: 4, capture: 'none' }));
  assert.equal(result.page.url, `${ORIGIN}/settings/billing`);
  assert.equal(result.steps.length, 2);
  assert.ok(result.verdict.why.includes('early_end:named_actions'));
  // The same as a list step.
  const step = agentResult(await new BrowserRuntime({ bridge: new FakeBridge({ pages: SETTINGS, path: '/' }),
    provider: provider(['Settings', 'Billing'], { done: 0.3 }) }).run({ steps: [{ instruction: 'Open Settings, then Billing.',
    expectation: { textIncludes: 'Billing' }, maxActions: 4 }], capture: 'none' }));
  assert.equal(step.page.url, `${ORIGIN}/settings/billing`);
});

test('early end: "Click Next, then Next" with a loose expectation needs both clicks', async () => {
  const jev = provider(['Next page'], { done: 0.3 });
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run({ steps: [
    { instruction: 'Click Next page, then Next page.', expectation: { textIncludes: 'of 6' }, maxActions: 4 }], capture: 'none' }));
  assert.equal(result.page.url, `${ORIGIN}/c3`);
  assert.equal(result.steps.length, 2);
  assert.ok(result.verdict.why.includes('step:expectation_end'));
});

test('early end: a list step that names nothing ends only when its action made the expectation pass', async () => {
  // "Tents" passes on every catalog page: the click after a pass proves nothing, so done gating decides on /c2.
  const loose = provider(['Next page'], { done: path => (path === '/c3' ? 0.9 : 0.3) });
  const raw = await new BrowserRuntime({ bridge: new FakeBridge({ pages: CATALOG, path: '/c1' }), provider: loose })
    .run({ steps: [{ instruction: 'Read the tent.', expectation: { textIncludes: 'Tents' }, maxActions: 4 }], capture: 'none' });
  assert.ok(!raw.verdict.why.includes('step:expectation_end'));
  assert.deepEqual(loose.calls.decide.slice(0, 2), ['/c1', '/c2'], 'the landing page got the done-gated decide');
  // An expectation the click made pass ends the step there.
  const flip = provider(['Next page'], { done: 0.3 });
  const ended = await new BrowserRuntime({ bridge: new FakeBridge({ pages: CATALOG, path: '/c1' }), provider: flip })
    .run({ steps: [{ instruction: 'Read the tent.', expectation: { textIncludes: 'Ridge 101' }, maxActions: 4 }], capture: 'none' });
  assert.ok(ended.verdict.why.includes('step:expectation_end'));
  assert.equal(ended.steps.length, 1);
});

test('toggle exclusion keeps a button the instruction names again, and never a different page\'s same-label control', async () => {
  const pages = { '/g': { title: 'Grid', text: 'Fares', controls: [button('1', 'Show more'), button('2', 'Other')] } };
  const jev = provider(['Show more'], { done: 0.3 });
  const bridge = new FakeBridge({ pages, path: '/g' });
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run('Click Show more, then click Show more.',
    { expectation: { changedSinceStart: true }, mode: 'reversible', maxActions: 4, capture: 'none' }));
  assert.equal(bridge.executions.length, 2, 'the second named click was offered and ran');
  assert.ok(jev.calls.offered[1].includes('Show more'));
  assert.ok(result.verdict.why.includes('early_end:named_actions'));
});

test('pre-passing: a read of a line already on the page needs no action; URL checks and why stay page-text free', async () => {
  const pages = { '/f': { title: 'Flights', text: 'Lowest fare €121. Date grid', controls: [button('1', 'Date grid')] } };
  const read = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/f' }), provider: provider([], { done: 0.9 }) })
    .run('Read the Lowest fare line.', { expectation: { textIncludes: 'Lowest fare' }, capture: 'none' });
  assert.equal(read.code, 'expectation_passed');
  assert.equal(read.steps.length, 0);
  assert.ok(!(read.warnings ?? []).includes('expectation_prepassing'));
  // A URL field next to the text check: never gated.
  const url = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/f' }), provider: provider([], { done: 0.9 }) })
    .run('Click the Date grid button.', { expectation: { textIncludes: 'Date grid', urlIncludes: '/f' }, capture: 'none' });
  assert.ok(!(url.warnings ?? []).includes('expectation_prepassing'));
  // Gated: the why code is fixed text, no page text.
  const gated = agentResult(await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/f' }),
    provider: provider(['Date grid'], { done: 0.9 }) }).run('Click the Date grid button.',
    { expectation: { textIncludes: 'Lowest fare' }, mode: 'reversible', capture: 'none' }));
  assert.ok(gated.verdict.why.includes('expectation_prepassing'));
  assert.ok(gated.verdict.why.every(code => !/Lowest|€|121/.test(code)), JSON.stringify(gated.verdict.why));
});

// ---------------------------------------------------------------------------------------------------------------
// Explicit-URL hop (E2) and the vacuous handoff pass (E6): live Google Flights run gf-week-window, 2026-10-06.
// ---------------------------------------------------------------------------------------------------------------

// Per-day result pages whose live URL carries a parameter the site adds itself (`&tfu=`), like Google Flights.
const DAYS = Object.fromEntries([10, 11, 12].map(day => [`/day/${day}`, {
  url: `${ORIGIN}/day/${day}?tfs=D${day}&tfu=k`,
  title: `Flights 2026-10-${day}`, text: `Track prices departing 2026-10-${day}`,
  controls: [link('1', 'Change dates', `/dates`)],
}]));
const DAY_URL = day => `${ORIGIN}/day/${day}?tfs=D${day}`;
const daysBridge = (path = '/day/10') => new FakeBridge({ pages: { ...PAGES, ...DAYS, '/logout': { title: 'Signed out', text: 'Bye', controls: [] } }, path });

test('E2: "Open <allowed URL>" navigates without a decision; the trace records decision.by "url"', async () => {
  // Trace 29abd78a: Jev judged the Oct 11 URL the page it was on (handoff 0.36, navigate 0.25) and the run failed.
  const bridge = daysBridge();
  const jev = provider([], { done: path => (path === '/day/11' ? 0.9 : 0.81) });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run(`Open ${DAY_URL(11)} and read the flights.`, {
    allowedOrigins: [ORIGIN], allowedUrls: [DAY_URL(11)], expectation: { urlIncludes: 'tfs=D11' }, maxActions: 3, retry: false,
  });
  assert.equal(result.status, 'completed', result.code);
  assert.equal(result.steps[0].action.type, 'navigate_allowed_url');
  assert.equal(result.steps[0].decision.by, 'url');
  assert.equal(result.steps[0].decision.reason, 'named_url');
  assert.ok(!jev.calls.decide.includes('/day/10'), 'no decision on the page the hop left');
  assert.ok(agentResult(result).verdict.why.includes('url:direct'));
});

test('E2: a literal same-site URL hops too; the current page (plus the site\'s own parameters) does not', async () => {
  const literal = await new BrowserRuntime({ bridge: daysBridge(), provider: provider([], { done: 0.9 }) })
    .run(`Navigate to ${DAY_URL(12)}.`, { allowedOrigins: [ORIGIN], expectation: { urlIncludes: 'tfs=D12' }, maxActions: 3, retry: false });
  assert.equal(literal.status, 'completed', literal.code);
  assert.equal(literal.steps[0].decision.by, 'url');
  // Already there: "&tfu=k" is the site's own parameter, so the named URL is the current page and nothing hops.
  const here = await new BrowserRuntime({ bridge: daysBridge('/day/11'), provider: provider([], { done: 0.9 }) })
    .run(`Open ${DAY_URL(11)} and read the flights.`, { allowedOrigins: [ORIGIN], allowedUrls: [DAY_URL(11)],
      expectation: { urlIncludes: 'tfs=D11' }, maxActions: 3, retry: false });
  assert.equal(here.status, 'completed', here.code);
  assert.equal(here.steps.length, 0);
  assert.equal(sameNamedPage(DAY_URL(11), `${DAY_URL(11)}&tfu=k`), true);
  assert.equal(sameNamedPage(DAY_URL(11), `${DAY_URL(10)}&tfu=k`), false);
});

test('E2 guardrails: no hop without a navigation verb, off the granted origins, or to a sign-out or submit URL', async () => {
  const cases = [
    [`Compare this page with ${DAY_URL(11)}.`, { allowedUrls: [DAY_URL(11)] }],
    ['Open https://other.example.org/day/11 and read it.', {}],
    [`Open ${ORIGIN}/logout now.`, { allowedUrls: [`${ORIGIN}/logout`] }],
  ];
  for (const [instruction, extra] of cases) {
    const jev = provider([], { done: 0.1 });
    const result = await new BrowserRuntime({ bridge: daysBridge(), provider: jev })
      .run(instruction, { allowedOrigins: [ORIGIN], expectation: { urlIncludes: '/nowhere' }, maxActions: 3, retry: false, ...extra });
    assert.ok(!result.steps.some(step => step.decision?.by === 'url'), instruction);
    assert.ok(jev.calls.decide.length >= 1, instruction);
  }
  assert.deepEqual(namedUrls(`Open ${DAY_URL(11)}, then go to ${DAY_URL(12)}. See https://x.test/a too.`), [DAY_URL(11), DAY_URL(12)]);
  assert.equal(urlHopRefused(`${ORIGIN}/account/sign-out`), true);
  assert.equal(urlHopRefused(`${ORIGIN}/form?submit=1`), true);
  assert.equal(urlHopRefused(DAY_URL(11)), false);
});

test('E2: a step list of "Open <URL>" steps visits every day', async () => {
  // Calls 11-19 of the live run: one list call instead of nine host turns.
  const steps = [11, 12].map(day => ({ instruction: `Open ${DAY_URL(day)} and read the flights.`,
    expectation: { urlIncludes: `tfs=D${day}` } }));
  const result = await new BrowserRuntime({ bridge: daysBridge(), provider: provider([], { done: 0.9 }) })
    .run({ steps, allowedOrigins: [ORIGIN], allowedUrls: steps.map((_, i) => DAY_URL(11 + i)), retry: false });
  const lean = agentResult(result);
  assert.deepEqual(lean.stepResults.map(entry => entry.status), ['completed', 'completed']);
  assert.deepEqual(result.steps.map(step => step.decision.by), ['url', 'url']);
});

test('E6: a handoff at done 0.04 on a page where a start-page-passing expectation still passes goes to the host', async () => {
  // Trace 9041bc2c: urlIncludes "/travel/flights" passed on the landing page; Jev followed a marketing link, handed
  // off at done 0.04, and the run completed as handoff_expectation_passed.
  const pages = { ...PAGES,
    '/travel/flights': { title: 'Flights', text: 'Search flights', controls: [link('1', 'London', '/travel/flights/london')] },
    '/travel/flights/london': { title: 'Flights to London', text: 'Cheap flights to London', controls: [] } };
  const run = (bridge, jev, instruction) => new BrowserRuntime({ bridge, provider: jev }).run(instruction, {
    allowedOrigins: [ORIGIN], expectation: { urlIncludes: '/travel/flights' }, maxActions: 3, retry: false });
  const jev = provider(['London'], { done: 0.04 });
  const result = await run(new FakeBridge({ pages, path: '/travel/flights' }), jev,
    'Set one-way from Marseille to London and list the flights for each day.');
  assert.equal(result.status, 'needs_host');
  assert.equal(result.code, 'handoff');
  const lean = agentResult(result);
  assert.ok(lean.verdict.why.includes('expectation:prepassing'), lean.verdict.why.join(','));
  assert.ok(lean.verdict.why.includes('expectation:url_start'));
  assert.ok(lean.warnings.includes('expectation_prepassing'));
  assert.match(lean.next.text, /already passed on the start page \(expectation:prepassing\)/);
  assert.ok(!lean.verdict.suggested?.expectation, 'the vacuous expectation is never suggested again');
  // A read on the start page itself (no action) keeps its pass.
  const read = await run(new FakeBridge({ pages, path: '/travel/flights' }), provider([], { done: 0.04 }), 'Read the search form.');
  assert.equal(read.code, 'handoff_expectation_passed');
});

test('E6: a join run that bounced between two pages under urlIncludes "/" without the answer stays a handoff', async () => {
  // Host suite billing-office-hours, condition R (live-fixes2-2026-10-06-host, trace 01c9a2d8): the host sent
  // urlIncludes "/" (true on every page); Jev went About, Contact, About, Contact at done 0.02-0.11 and handed off on
  // the Contact page, which lists the offices but not their hours (those are on /offices/<city>). The handoff was
  // right: without E6 it was handoff_expectation_passed, a verified completion of a run that never found the answer.
  const pages = {
    '/': { title: 'Home', text: 'Northwind Ledger', controls: [link('1', 'About', '/about'), link('2', 'Contact', '/contact')] },
    '/about': { title: 'About', text: 'Elif Demir — Billing and plans', controls: [link('1', 'Contact', '/contact')] },
    '/contact': { title: 'Contact', text: 'Offices: Lisbon (Elif Demir), Oslo, Auckland',
      controls: [link('1', 'About', '/about'), link('2', 'Lisbon office', '/offices/lisbon')] },
    '/offices/lisbon': { title: 'Lisbon office', text: 'Opening hours 09:00–17:30', controls: [] },
  };
  const route = ['About', 'Contact', 'About', 'Contact'];
  const jev = { model: 'fake', async decide(observation, actions) {
    const label = route.shift();
    const action = label && actions.find(entry => entry.label === label);
    return { actionId: action?.id ?? 'handoff', confidence: 0.9, done: { probability: 0.09 } };
  } };
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/' }), provider: jev }).run(
    'On the About page find the team member who handles billing and plans. Then on the Contact page find the office '
    + 'that person leads and its opening hours.', { allowedOrigins: [ORIGIN], expectation: { urlIncludes: '/' },
      answerQuestion: 'What are the opening hours of the office led by the team member who handles billing and plans?',
      maxActions: 12, retry: false });
  assert.equal(result.status, 'needs_host');
  assert.equal(result.code, 'handoff');
  const lean = agentResult(result);
  assert.ok(lean.verdict.why.includes('expectation:prepassing'), lean.verdict.why.join(','));
  assert.equal(lean.verdict.answer ?? null, null);
});

test('E2: a URL a placeholder wrote into a step instruction (page text) never hops', async () => {
  // Step 1's answer is page text; filled into "Open {{answer:1}}" it would let the page pick where the tab goes.
  const pages = { ...PAGES,
    '/start': { title: 'Start', text: `Next stop: visit ${ORIGIN}/secret/area`, controls: [link('1', 'Home', '/')] },
    '/secret/area': { title: 'Secret', text: 'You are here', controls: [] } };
  const jev = { model: 'fake',
    async decide() { return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.9 } }; },
    async choose(request) {
      const pick = request.candidates.find(candidate => candidate.text.includes('/secret')) ?? request.candidates[0];
      return { choice: pick.id, confidence: 0.95 };
    } };
  const steps = [
    { instruction: 'Read the next stop.', answerQuestion: 'What is the next stop?', expectation: { textIncludes: 'Next stop' } },
    { instruction: 'Open {{answer:1}} and read it.', expectation: { textIncludes: 'here' } },
  ];
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/start' }), provider: jev })
    .run({ steps, allowedOrigins: [ORIGIN], retry: false });
  assert.ok(!result.steps.some(step => step.decision?.by === 'url'), JSON.stringify(result.steps.map(step => step.action?.url)));
  // The host's own URL in a step with a placeholder elsewhere still hops.
  assert.deepEqual(namedUrls('Open "visit https://example.com/secret/area" and read it.', 'Open {{answer:1}} and read it.'), []);
  assert.deepEqual(namedUrls(`Open ${DAY_URL(11)} and find "x".`, `Open ${DAY_URL(11)} and find {{answer:1}}.`), [DAY_URL(11)]);
});

test('E2: a URL the instruction says not to open, a later URL after other work, and hash or camelCase sign-outs never hop', async () => {
  assert.deepEqual(namedUrls(`Do not open ${DAY_URL(11)}; read this page.`), []);
  // A bracket the URL opened is part of it; one that only closes the sentence's own is not.
  assert.deepEqual(namedUrls('Open https://en.wikipedia.org/wiki/Chromium_(web_browser) and stop there.'),
    ['https://en.wikipedia.org/wiki/Chromium_(web_browser)']);
  assert.deepEqual(namedUrls('Read the page (open https://x.test/a).'), ['https://x.test/a']);
  assert.deepEqual(namedUrls('Open https://x.test/wiki/Tab_(interface)).'), ['https://x.test/wiki/Tab_(interface)']);
  assert.deepEqual(namedUrls(`Never visit ${DAY_URL(11)}.`), []);
  assert.deepEqual(namedUrls(`Don't go to ${DAY_URL(11)}.`), []);
  assert.equal(urlHopRefused(`${ORIGIN}/#/logout`), true);
  assert.equal(urlHopRefused(`${ORIGIN}/app?do=deleteAccount`, guardrailPolicy({ mode: 'read-only' })), true);
  // "Open A, click Change dates, then open B": only A hops; B is the provider's once the work on A is done.
  const jev = provider([], { done: 0.1 });
  const result = await new BrowserRuntime({ bridge: daysBridge(), provider: jev })
    .run(`Open ${DAY_URL(11)}, click Change dates, then open ${DAY_URL(12)}.`, {
      allowedOrigins: [ORIGIN], expectation: { urlIncludes: '/nowhere' }, maxActions: 4, retry: false });
  assert.deepEqual(result.steps.filter(step => step.decision?.by === 'url').map(step => step.action.url), [DAY_URL(11)]);
  assert.ok(jev.calls.decide.includes('/day/11'), jev.calls.decide.join(','));
});

// The opening URL hop is not the task (gf-date-grid live run, 2026-10-06): "Open <flights URL> directly. Set trip type
// to One way, ..., read the grid" with urlIncludes "/travel/flights" ended completed/expectation_passed after the hop
// alone. When the instruction names more after the open clause, the landing page counts as a start page.
test('url:direct: a pass on the landing page of the opening hop does not end a run that names more to do', async () => {
  const bridge = daysBridge();
  const jev = provider([], { done: 0.2 });
  const raw = await new BrowserRuntime({ bridge, provider: jev }).run(
    `Open ${DAY_URL(11)} directly. Click Change dates, set the return to the 14th and read the cheapest fare.`, {
      allowedOrigins: [ORIGIN], allowedUrls: [DAY_URL(11)], expectation: { urlIncludes: 'tfs=D11' }, maxActions: 4, retry: false,
    });
  const result = agentResult(raw);
  assert.ok(result.verdict.why.includes('url:direct'));
  assert.ok(jev.calls.decide.includes('/day/11'), 'the landing page gets a provider decision');
  assert.notEqual(raw.code, 'expectation_passed');
  assert.ok(result.verdict.why.includes('expectation:prepassing'), result.verdict.why.join(' '));
  assert.ok(result.warnings.includes('expectation_prepassing'));
  assert.notEqual(result.verification?.passed && result.status === 'completed', true);
  assert.match(result.next.text, /only the result page passes/);
  assert.match(result.next.text, /opening URL/);
});

test('url:direct: "Open <URL>" alone, or plus a question to read there, still ends verified after the hop', async () => {
  for (const instruction of [`Open ${DAY_URL(11)}.`, `Open ${DAY_URL(11)}. What text appears there once it has loaded?`,
    `Open ${DAY_URL(11)} and read the flights.`]) {
    const jev = provider([], { done: 0.9 });
    const raw = await new BrowserRuntime({ bridge: daysBridge(), provider: jev }).run(instruction, {
      allowedOrigins: [ORIGIN], allowedUrls: [DAY_URL(11)], expectation: { urlIncludes: 'tfs=D11' }, maxActions: 3, retry: false,
    });
    assert.equal(raw.status, 'completed', `${instruction}: ${raw.code}`);
    assert.equal(raw.verification.passed, true, instruction);
    assert.equal(raw.steps.length, 1, instruction);
    assert.ok(!agentResult(raw).verdict.why.includes('expectation:prepassing'), instruction);
  }
});
