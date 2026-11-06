// A call that only performs actions asks nothing: no auto-confirmed answer (gf-date-grid live run, call 4).
// The host's instruction "Click the 'Where to?' field, type London, and choose the London option" with no
// answerQuestion ended verified, and the trip card the ranking put first was auto-confirmed with next.kind "answer".
// The fixture is synthetic: a destination link, then a page whose top block is a suggested-trip card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const CARD = 'Marseille London Nov 9 — Nov 18 Nonstop from €34';
const PAGES = {
  '/': {
    title: 'Flights', text: 'Flights. Where to?',
    blocks: [{ t: 'h1', text: 'Flights' }],
    controls: [{ id: '1', role: 'link', label: 'London, United Kingdom', href: `${ORIGIN}/to`, enabled: true }],
  },
  '/to': {
    title: 'Flights to the destination', text: `Destination set. ${CARD}. Explore more trips.`,
    blocks: [{ t: 'h1', text: 'Destination set' }, { t: 'p', text: CARD }, { t: 'p', text: 'Marseille Dublin Dec 2 — Dec 6 1 stop from €88' }, { t: 'p', text: 'Explore more trips' }],
    controls: [],
  },
};

function jev() {
  return {
    model: 'fake',
    async decide(observation, actions) {
      const link = actions.find(action => action.label === 'London, United Kingdom');
      if (link && new URL(observation.url).pathname === '/') return { actionId: link.id, confidence: 0.9, done: { probability: 0.1 } };
      return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.95 } };
    },
    async confirm() {
      return { done: { probability: 0.95 }, guards: { blocked: 0.01, injection: 0.01 } };
    },
    async choose(request) {
      const card = request.candidates.find(candidate => String(candidate.text).includes('€34'));
      return { choice: (card ?? request.candidates[0]).id, confidence: 0.93 };
    },
  };
}

async function run(instruction, options = {}) {
  const bridge = new FakeBridge({ pages: PAGES, path: '/' });
  const raw = await new BrowserRuntime({ bridge, provider: jev() }).run(instruction, {
    expectation: { textIncludes: 'Destination set' }, maxActions: 3, capture: 'none', ...options });
  return agentResult(raw);
}

const ACTIONS = "One way is now selected. Click the 'Where to?' field, type London, and choose the London option";

test('action-only instruction: the trip card stays a candidate, never an auto-confirmed answer', async () => {
  const result = await run(ACTIONS);
  assert.equal(result.status, 'completed');
  assert.equal(result.verdict.answer, null);
  assert.ok(!result.next.text.includes('verdict.answer.text'), result.next.text);
  assert.ok(result.verdict.why.includes('answer:not_asked'), result.verdict.why.join(' '));
});

test('the same run with an answerQuestion, or an instruction that asks, still auto-confirms', async () => {
  const asked = await run(ACTIONS, { answerQuestion: 'What is the cheapest flight from Marseille?' });
  assert.equal(asked.next.kind, 'answer', asked.verdict.why.join(' '));
  assert.ok(asked.verdict.answer?.text.includes('€34'));
  for (const instruction of ['Choose the London option and tell me the cheapest flight from Marseille.',
    'Choose the London option. Which Marseille flight is suggested?']) {
    const read = await run(instruction);
    assert.equal(read.next.kind, 'answer', `${instruction}: ${read.verdict.why.join(' ')}`);
  }
});

test('list step without answerQuestion that only performs actions: no auto-confirmed answer', async () => {
  const bridge = new FakeBridge({ pages: PAGES, path: '/' });
  const steps = [{ instruction: ACTIONS, expectation: { textIncludes: 'Destination set' }, maxActions: 3 }];
  const raw = await new BrowserRuntime({ bridge, provider: jev() }).run({ steps, capture: 'none' });
  const result = agentResult(raw);
  assert.equal(result.verdict.answer, null, result.verdict.why.join(' '));
  assert.ok(!result.next.text.includes('verdict.answer.text'), result.next.text);
});

// gf-date-grid call 1: Jev clicked the same "Search" box three times on a page that never changed; the run ended
// no_progress only after the third. The first repeat of an identical no-change click ends it now.
test('a repeated click that changed nothing ends the run at the first repeat (no_progress)', async () => {
  const pages = { '/': { title: 'Search', text: 'Search the web.', blocks: [{ t: 'h1', text: 'Search the web' }],
    // A lateHref to the same page: the fake keeps the revision, as Google's search box did.
    controls: [{ id: '8', role: 'combobox', label: 'Search', enabled: true, lateHref: `${ORIGIN}/` }] } };
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      return { actionId: actions.find(action => action.label === 'Search').id, confidence: 0.84, done: { probability: 0.01 } };
    },
  };
  const raw = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/' }), provider })
    .run('Set up a one-way search from Marseille to London.', { expectation: { urlIncludes: '/travel/flights' },
      maxActions: 8, capture: 'none', mode: 'reversible' });
  const result = agentResult(raw);
  assert.equal(result.code, 'no_progress', `${raw.steps.length} ${result.verdict.why.join(' ')} ${raw.steps.map(s => s.changed + ':' + s.moved).join(' ')}`);
  assert.equal(raw.steps.length, 2, raw.steps.map(step => step.action?.label).join(' '));
  assert.ok(result.verdict.why.includes('no_progress:repeat'), result.verdict.why.join(' '));
});

// instructionAsks, the auto-confirm gate of an instruction-only call: a false positive auto-confirms a value nobody
// asked for (the worst failure), a false negative costs a host turn. Each pair below failed the first version.
const ASKS = [
  'find the cheapest fare', 'get the phone number', 'note the order number', 'Open Pricing. The Pro price?',
  'Open the pricing page and read the Pro price', 'Open Pricing and give me the price', 'Open the cart and report the total',
  'check whether the item is in stock', 'see if there are seats', 'confirm the delivery date', 'look up the opening hours',
  'show me the plans', 'list the plans', 'count the results', 'compare the plans',
  "Don't click Pro; read the store's price", 'Open Orders. What is the newest order number',
];
const ACTS = [
  'get to Settings', 'find the Search box and click it', 'Find the Search box.', 'note: do not book', 'Note: do not book',
  'click the Where to? field and choose London', 'Click “Where to?” and choose London', 'Click `Where to?` and choose London',
  'Click [Where to?] and choose London', 'Click "Where to?" then London', 'click Search, then what?',
  'Open https://example.test/search?q=1 and click Next', 'When the page loads, click Next', 'Confirm the booking',
  'Click Compare', ACTIONS,
];

test('instructionAsks: read requests in any phrasing ask; actions, labels, URLs and "then what?" do not', async () => {
  const { instructionAsks } = await import('../src/runtime.js');
  for (const text of ASKS) assert.equal(instructionAsks(text), true, text);
  for (const text of ACTS) assert.equal(instructionAsks(text), false, text);
});

test('an action-only call whose URL has a query string gets no auto-confirmed answer', async () => {
  const result = await run('Click London, United Kingdom on https://example.test/?from=home');
  assert.equal(result.verdict.answer, null);
  assert.ok(result.verdict.why.includes('answer:not_asked'), result.verdict.why.join(' '));
});
