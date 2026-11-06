// Per-step answers of a step list and the call's aggregate answer (src/runtime.js #driveList, answerPlan, composeList
// listAnswer; src/facts.js buildMemory). Modelled on the 2026-10-08 live run: one fai_browser_run with five steps, one
// Google Flights date each, each with answerQuestion "cheapest flight departing before noon on <date>". Every step
// passed verification, yet no step's answer was auto-confirmed and the aggregate came back partial with memory_full:
// each page was seen in several states (the runtime's own "View more" click, the site's URL rewrite, half paints),
// the memory kept six items per state while the pages showed 9-14 priced rows, and the earlier steps' pages joined
// the aggregate. Fake bridge and scripted providers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, bridgeError } from '../src/result.js';
import { FACT_STATE_ITEMS } from '../src/facts.js';
import { FakeBridge, ORIGIN, clickProvider, link } from './runtime-fixtures.js';

const DAYS = ['11', '12', '13', '14', '15'];

/** The rows of one day: four top flights, six other flights, three more behind "View more flights". */
function flightRows(day) {
  const d = Number(day) - 10;
  const row = (times, airline, duration, stops, price) => `${times} · ${airline} · ${duration} · MRS–LHR · ${stops} · €${price + d}`;
  return {
    top: [
      row('6:10 AM – 7:50 AM', 'Ryanair', '1 hr 40 min', 'Nonstop', 44),
      row('11:55 AM – 1:35 PM', 'British Airways', '1 hr 40 min', 'Nonstop', 89),
      row('7:35 AM – 9:15 AM', 'easyJet', '1 hr 40 min', 'Nonstop', 96),
      row('12:20 PM – 1:25 PM', 'British Airways', '2 hr 5 min', 'Nonstop', 187),
    ],
    other: [
      row('6:30 AM – 9:30 AM', 'KLM', '4 hr', '1 stop AMS', 127),
      row('6:05 AM – 9:00 AM', 'Air France', '3 hr 55 min', '1 stop CDG', 128),
      row('10:15 AM – 12:50 PM', 'Vueling', '3 hr 35 min', '1 stop BCN', 79),
      // Cheapest of the day, but after noon: the window keeps it out.
      row('12:05 PM – 1:45 PM', 'Ryanair', '1 hr 40 min', 'Nonstop', 40),
      row('6:20 PM – 9:25 PM', 'Air France', '4 hr 5 min', '1 stop CDG', 128),
      row('9:45 PM – 9:10 AM+1', 'Lufthansa', '12 hr 25 min', '1 stop FRA', 142),
    ],
    more: [
      row('10:40 AM – 12:20 PM', 'easyJet', '1 hr 40 min', 'Nonstop', 74),
      row('11:25 AM – 5:05 PM', 'Vueling', '6 hr 40 min', '1 stop MAD', 88),
      row('9:30 AM – 2:55 PM', 'Air France', '5 hr 25 min', '1 stop CDG', 121),
    ],
    cheapestBeforeNoon: row('6:10 AM – 7:50 AM', 'Ryanair', '1 hr 40 min', 'Nonstop', 44),
  };
}

function flightsPage(day, expanded) {
  const rows = flightRows(day);
  const blocks = [
    { t: 'h1', text: 'Flight search' },
    { t: 'p', text: `Track prices from Marseille to London departing 2027-01-${day}` },
    { t: 'h3', text: 'Top flights' },
    { t: 'p', text: 'Ranked based on price and convenience. Prices include required taxes + fees for 1 adult.' },
    ...rows.top.map(text => ({ t: 'li', text })),
    { t: 'h3', text: 'Other flights' },
    ...rows.other.map(text => ({ t: 'li', text })),
    ...(expanded ? rows.more.map(text => ({ t: 'li', text })) : [{ t: 'button', text: 'View more flights', ref: '9' }]),
    { t: 'p', text: 'Prices are final prices and include all taxes and fees.' },
  ];
  return {
    title: 'Marseille to London | Flights',
    text: blocks.map(block => block.text).join('\n'),
    blocks,
    controls: expanded ? [] : [{ id: '9', role: 'button', label: 'View more flights', enabled: true, visible: true }],
  };
}

/**
 * A flights site: one results page per date at /flights/2027-01-<day>, reached by the URL the step names (the
 * runtime's own hop); its "View more flights" button adds three rows in place, a second state of the same page.
 */
class FlightsBridge {
  constructor() {
    this.path = '/';
    this.version = 0;
    this.expanded = false;
    this.executed = [];
  }

  get observation() {
    const day = /^\/flights\/2027-01-(\d\d)$/.exec(this.path)?.[1];
    const page = day ? flightsPage(day, this.expanded)
      : { title: 'Flights', text: 'Search flights', blocks: [{ t: 'h1', text: 'Flights' }, { t: 'p', text: 'Search flights' }], controls: [] };
    return {
      revision: `${this.path}#${this.version}`, documentId: 'doc', tabId: 1, url: ORIGIN + this.path,
      viewport: { width: 1280, height: 800, dpr: 1 }, consent: null, warnings: [], ...structuredClone(page),
    };
  }

  async observe() {
    return this.observation;
  }

  async execute(action, expectedRevision) {
    if (expectedRevision !== this.observation.revision) throw bridgeError('stale', 'Stale observation');
    this.executed.push(action);
    if (action.type === 'navigate_allowed_url') {
      this.path = new URL(action.url).pathname;
      this.expanded = false;
      this.version++;
    } else if (action.type === 'click' && action.target === '9') {
      this.expanded = true;
      this.version++;
    }
    return { observation: this.observation, settle: { reason: 'quiet', ms: 1 }, screenshot: Promise.resolve(null) };
  }
}

/** A provider that never navigates by itself and confirms the candidate holding `answers[part]` at 0.96. */
function chooser(answers, { hit = 0.96, miss = 0.4 } = {}) {
  const chooses = [];
  return {
    chooses,
    model: 'fake',
    async decide() {
      return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.05 } };
    },
    async choose({ question, candidates }) {
      chooses.push({ question, candidates: candidates.map(candidate => candidate.text) });
      const wanted = Object.entries(answers).find(([part]) => question.includes(part))?.[1];
      const found = wanted ? candidates.find(candidate => candidate.text.includes(wanted)) : null;
      const top = found ?? candidates[0];
      const p = found ? hit : miss;
      return { choice: top.id, confidence: p,
        probabilities: Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.id === top.id ? p : 0.01])) };
    },
  };
}

const flightSteps = () => DAYS.map(day => ({
  instruction: `Open ${ORIGIN}/flights/2027-01-${day} and read the flight list.`,
  expectation: { urlIncludes: `2027-01-${day}` },
  answerQuestion: `What is the cheapest flight departing before noon on ${day} January, with its departure time, airline and price?`,
}));

test('five date steps: each step gets its own auto-confirmed answer and the call lists them, one line per step', async () => {
  const bridge = new FlightsBridge();
  const provider = chooser(Object.fromEntries(DAYS.map(day => [`on ${day} January`, flightRows(day).cheapestBeforeNoon])));
  const runtime = new BrowserRuntime({ bridge, provider });
  const result = await runtime.run({ steps: flightSteps(), mode: 'reversible', capture: 'none', contentWaitMs: 0 });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.verification.passed, true);
  const lean = agentResult(result);
  assert.deepEqual(lean.stepResults.map(entry => entry.passed), [true, true, true, true, true]);
  // The runtime's own "View more flights" click ran on every page: each page is two states of the same list.
  assert.equal(bridge.executed.filter(action => action.type === 'click').length, 5, JSON.stringify(result.stepRuns.map(run => run.why)));
  for (const [index, day] of DAYS.entries()) {
    const entry = lean.stepResults[index];
    const rows = flightRows(day);
    assert.equal(entry.asked, true);
    assert.ok(entry.answer, `step ${index + 1} has no confirmed answer: ${JSON.stringify(result.stepRuns[index].why)}`);
    assert.ok(entry.answer.text.includes(rows.cheapestBeforeNoon), `step ${index + 1}: ${entry.answer.text}`);
    assert.equal(entry.answer.exact, false, 'the whole row: departure time, airline and price were asked');
    assert.equal(entry.candidates, undefined);
    const why = result.stepRuns[index].why;
    assert.ok(!why.some(code => code.includes('memory_full') || code.startsWith('answer:aggregate')), JSON.stringify(why));
  }
  // The call's answer: one "step N: <answer>" line per step, the steps by number, the lowest confidence of them.
  const answer = lean.verdict.answer;
  assert.ok(answer, JSON.stringify(lean.verdict));
  assert.deepEqual(answer.steps.map(step => step.i), [1, 2, 3, 4, 5]);
  assert.deepEqual(answer.text.split('\n').map(line => /^step (\d): /.exec(line)?.[1]), ['1', '2', '3', '4', '5']);
  for (const [index, day] of DAYS.entries()) {
    assert.ok(answer.steps[index].text.includes(flightRows(day).cheapestBeforeNoon), answer.steps[index].text);
    assert.equal(answer.steps[index].exact, false);
  }
  assert.equal(answer.exact, false);
  assert.ok(answer.confidence >= 0.9 && answer.confidence <= 1, String(answer.confidence));
  assert.deepEqual(answer.basis, ['steps:answers:5']);
  assert.equal(lean.next.kind, 'answer');
  assert.match(lean.next.text, /verdict\.answer\.text lists each step's auto-confirmed answer/);
  assert.ok(!lean.verdict.why.includes('aggregate:partial:memory_full'), lean.verdict.why.join(' '));
  assert.ok(lean.verdict.why.includes('steps:5/5'));
  // Each step's ranking saw its own day's rows only, never another day's.
  for (const [index, day] of DAYS.entries()) {
    const own = provider.chooses.filter(call => call.question.includes(`on ${day} January`));
    assert.ok(own.length >= 1, `step ${index + 1} ranked`);
    for (const call of own) {
      assert.ok(call.candidates.every(text => !/€\d+/.test(text) || text.includes(flightRows(day).top[0].slice(0, 10))
        || flightRows(day).other.some(row => text.includes(row)) || flightRows(day).more.some(row => text.includes(row))
        || flightRows(day).top.some(row => text.includes(row))), JSON.stringify(call.candidates));
    }
  }
});

test('steps without dates: an earlier step\'s page never joins a later step\'s own aggregate', async () => {
  // Three product pages, each with priced variants; the overall cheapest is on the first page. The second and third
  // steps ask about their own page: with the first page's rows in the aggregate, the deterministic first item would
  // be page one's and the provider's (right) choice would count as a disagreement.
  const variants = { a: [30, 45, 52], b: [50, 41, 60], c: [55, 48, 70] };
  const names = ['Brass', 'Steel', 'Copper'];
  const pages = { '/': { title: 'Shop', text: 'Lamps', controls: [link('1', 'Lamp A', '/shop/lamp-a')] } };
  for (const [id, prices] of Object.entries(variants)) {
    const letter = id.toUpperCase();
    pages[`/shop/lamp-${id}`] = {
      title: `Lamp ${letter}`, text: '', controls: [],
      blocks: [{ t: 'h1', text: `Lamp ${letter}` }, { t: 'h2', text: 'Variants' },
        ...prices.map((price, i) => ({ t: 'li', text: `${names[i]} finish · €${price}` })),
        { t: 'p', text: 'Prices include VAT.' }],
    };
  }
  const bridge = new FakeBridge({ pages });
  const cheapest = Object.fromEntries(Object.entries(variants).map(([id, prices]) => {
    const at = prices.indexOf(Math.min(...prices));
    return [`lamp ${id.toUpperCase()}`, `${names[at]} finish · €${prices[at]}`];
  }));
  const provider = chooser(cheapest);
  const runtime = new BrowserRuntime({ bridge, provider });
  const steps = ['a', 'b', 'c'].map(id => ({
    instruction: `Open ${ORIGIN}/shop/lamp-${id} and read the variants.`,
    expectation: { urlIncludes: `/shop/lamp-${id}` },
    answerQuestion: `Which variant of lamp ${id.toUpperCase()} is the cheapest, and what does it cost?`,
  }));
  const result = await runtime.run({ steps, capture: 'none' });
  assert.equal(result.status, 'completed', result.reason);
  const lean = agentResult(result);
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    const why = result.stepRuns[index].why;
    assert.ok(lean.stepResults[index].answer, `step ${index + 1}: ${JSON.stringify(why)}`);
    assert.ok(lean.stepResults[index].answer.text.includes(cheapest[`lamp ${id.toUpperCase()}`]), lean.stepResults[index].answer.text);
    assert.ok(!why.includes('answer:aggregate_disagrees') && !why.includes('answer:aggregate_partial'), JSON.stringify(why));
  }
  assert.equal(lean.verdict.answer.steps.length, 3);
  assert.equal(lean.next.kind, 'answer');
});

test('memory_full still fires when an earlier page held more items than the memory keeps', async () => {
  // Page 1 lists more priced rows than FACT_STATE_ITEMS, then "Next page" leads to the final page; the question
  // aggregates across both pages, so the dropped items make the aggregate partial and nothing is auto-confirmed.
  const rows = (page, count, from) => Array.from({ length: count }, (_, j) => ({ t: 'tr', text: `Lamp ${page}-${j} | €${from + j} | In stock` }));
  const pages = {
    '/catalog/1': { title: 'Catalog', text: '', controls: [link('1', 'Next page', '/catalog/2')],
      blocks: [{ t: 'h1', text: 'Catalog' }, { t: 'p', text: 'Page 1 of 2' }, ...rows(1, FACT_STATE_ITEMS + 5, 100), { t: 'a', text: 'Next page', ref: '1' }] },
    '/catalog/2': { title: 'Catalog', text: '', controls: [],
      blocks: [{ t: 'h1', text: 'Catalog' }, { t: 'p', text: 'Page 2 of 2' }, ...rows(2, 5, 200)] },
  };
  const bridge = new FakeBridge({ pages, path: '/catalog/1' });
  const provider = Object.assign(clickProvider(['Next page'], { fallback: 'done' }), {
    async choose({ candidates }) {
      return { choice: candidates[0].id, confidence: 0.97,
        probabilities: Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.id === candidates[0].id ? 0.97 : 0.01])) };
    },
  });
  const runtime = new BrowserRuntime({ bridge, provider });
  const result = await runtime.run('Open the next catalog page and read every lamp.', {
    expectation: { urlIncludes: '/catalog/2' }, capture: 'none',
    answerQuestion: 'Which lamp is the cheapest across both catalog pages, and what does it cost?',
  });
  assert.equal(result.status, 'completed', result.reason);
  const lean = agentResult(result);
  assert.equal(lean.answer.aggregate?.partial, true, JSON.stringify(lean.answer));
  assert.ok(lean.answer.aggregate.why.includes('memory_full'), JSON.stringify(lean.answer.aggregate));
  assert.ok(lean.verdict.why.includes('aggregate:partial:memory_full'), lean.verdict.why.join(' '));
  assert.equal(lean.verdict.answer, null);
  assert.ok(lean.verdict.why.includes('answer:aggregate_partial'), lean.verdict.why.join(' '));
});
