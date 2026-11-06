// Late changes after quiet button clicks, host act() re-resolve and picker textbox clicks, on fixtures/stepper.html in
// headless Chromium with extension/page.js (test/helpers/page-bridge.js) and scripted providers. The fixture's date
// arrows re-render (URL, date and results) ?delay= ms after a click that settles at once, as Google Flights does
// (live run 2026-10-06: the arrow click settled in ~120 ms, the page changed 1-5 s later).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { PageBridge } from './helpers/page-bridge.js';

const STEPPER = await readFile(new URL('../fixtures/stepper.html', import.meta.url), 'utf8');
const NEXT_ARROW = 'next-value button after "Departure" (unlabelled)';

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function open(t, delay, body = STEPPER) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body }));
  await page.goto(`https://example.com/flights?delay=${delay}`);
  return { page, bridge: new PageBridge(page, { level: 'reversible' }) };
}

/** Clicks the action labelled `label` once, then reports done (high when the page shows `doneText`). */
function clicker(label, doneText) {
  const calls = [];
  return {
    calls,
    model: 'fake',
    async decide(observation, actions) {
      calls.push(observation.url);
      const done = { probability: observation.text.includes(doneText) ? 0.9 : 0.05 };
      const target = calls.length === 1 ? actions.find(action => action.label === label) : null;
      return target ? { actionId: target.id, confidence: 0.9, done } : { actionId: 'handoff', confidence: 0.5, done };
    },
  };
}

test('E4b: a quiet arrow click whose page changes 1.2 s later is waited for (settle late_change), not decided on stale',
  async t => {
    const { bridge } = await open(t, 1200);
    const provider = clicker(NEXT_ARROW, 'departing 2026-10-11');
    const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow next to Departure once', {
      mode: 'reversible', capture: 'none', expectation: { textIncludes: 'departing 2026-10-11' },
      reobserveDelayMs: 100, lateChangeMs: 2000 });
    assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
    assert.equal(result.steps.length, 1, 'one click: the late change was seen, no second arrow click');
    const [step] = result.steps;
    assert.equal(step.settle, 'late_change');
    assert.equal(step.changed, true);
    assert.ok(step.action.toUrl.includes('date=2026-10-11'), step.action.toUrl);
    assert.ok(result.verdict.why.includes('late_change'), result.verdict.why.join(','));
    assert.ok(step.ms.settle >= 900, `settle ${step.ms.settle} ms`);
  });

test('E4b: without the late-change wait the same run sees an unchanged page (the live failure)', async t => {
  const { bridge } = await open(t, 1200);
  const provider = clicker(NEXT_ARROW, 'departing 2026-10-11');
  const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow next to Departure once', {
    mode: 'reversible', capture: 'none', expectation: { textIncludes: 'departing 2026-10-11' },
    reobserveDelayMs: 100, lateChangeMs: 0 });
  assert.notEqual(result.status, 'completed');
  assert.equal(result.steps[0].settle, 'quiet');
  assert.equal(result.steps[0].changed, false);
});

test('E4b: an arrow click that only scrolled the arrow into view still waits for the late change', async t => {
  // Live run 2026-10-06 (flights-live-form-arrows): the arrow sat below the fold, the click scrolled it into view, the
  // scroll moved the revision, the step counted as changed and the late-change wait never ran: two clicks per day.
  const { bridge } = await open(t, 1200, STEPPER.replace('<body>', '<body><div style="height:1600px">Search</div>'));
  // Clicks the arrow while the page still shows the old day (the live run's Jev), so a missed late change shows up as
  // a second click.
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      const arrow = actions.find(action => action.label === NEXT_ARROW);
      const moved = observation.text.includes('departing 2026-10-11');
      return arrow && !moved ? { actionId: arrow.id, confidence: 0.9, done: { probability: 0.05 } }
        : { actionId: 'handoff', confidence: 0.5, done: { probability: moved ? 0.9 : 0.05 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow next to Departure once', {
    mode: 'reversible', capture: 'none', expectation: { textIncludes: 'departing 2026-10-11' },
    reobserveDelayMs: 100, lateChangeMs: 2000 });
  assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
  assert.equal(result.steps.filter(step => step.type === 'click' || step.action?.type === 'click').length, 1,
    'one click: the scroll was not read as the change');
  assert.equal(result.steps[0].settle, 'late_change');
});

test('E4b: a late change that lands on a loading placeholder is waited out before the next decision', async t => {
  // Live run 2026-10-06 (flights-live-form-arrows, fix 3): the late change caught the first paint ("Loading results"
  // where the rows go, the rows a moment later) and Jev split between the arrow again and a wait (low_confidence).
  const body = STEPPER.replace("history.pushState({}, '', `?${params}`);\n      render();",
    "history.pushState({}, '', `?${params}`);\n"
    + "      document.getElementById('results').innerHTML = '<li>Loading results…</li>';\n"
    + '      setTimeout(render, 1500);');
  assert.notEqual(body, STEPPER, 'the fixture patch applied');
  const { bridge } = await open(t, 1200, body);
  const seen = [];
  // Clicks the arrow on the old day and again while the placeholder shows (the live split), so a decision made on the
  // first paint shows up as a second click.
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      seen.push(observation.text.includes('Loading results'));
      const arrow = actions.find(action => action.label === NEXT_ARROW);
      const moved = observation.text.includes('11:15 AM departing 2026-10-11');
      return arrow && !moved ? { actionId: arrow.id, confidence: 0.9, done: { probability: 0.05 } }
        : { actionId: 'handoff', confidence: 0.5, done: { probability: 0.9 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow next to Departure once', {
    mode: 'reversible', capture: 'none', expectation: { textIncludes: '11:15 AM departing 2026-10-11' },
    reobserveDelayMs: 100, lateChangeMs: 2000 });
  assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
  assert.equal(result.steps.length, 1, 'one click: no decision was made on the first paint');
  assert.equal(result.steps[0].settle, 'late_change');
  assert.ok(result.verdict.why.includes('content_wait'), result.verdict.why.join(','));
  assert.ok(!seen.includes(true), 'no decision saw the placeholder');
});

// A results page with its Departure calendar open: Done closes the dialog at once and the new day's results land
// 1.2 s later (flights-live). With `fillsField`, Done also writes the day into the empty Departure field (a search
// form; field values are never observed, only whether a field is filled).
const pickerPage = fillsField => `<!doctype html><title>Results</title>
  <input id="dep" aria-label="Departure" readonly value="${fillsField ? '' : 'Mon, Oct 12'}">
  <div id="cal" role="dialog" aria-modal="true" aria-label="Departure date"><h3>October 2026</h3>
    <button type="button" aria-pressed="true">12</button><button type="button">13</button>
    <button type="button" id="done">Done</button></div>
  <p id="out">Flights departing 2026-10-12</p>
  <script>document.getElementById('done').onclick = () => {
    document.getElementById('cal').hidden = true;
    ${fillsField ? "document.getElementById('dep').value = 'Tue, Oct 13';" : ''}
    setTimeout(() => {
      history.pushState(null, '', '?date=2026-10-13');
      document.getElementById('out').textContent = 'Flights departing 2026-10-13';
    }, 1200);
  };</script>`;

test('E4e: after a late change the runtime waited out, the next decision is offered no wait', async t => {
  const { bridge } = await open(t, 1200);
  const offers = [];
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      offers.push(actions.map(action => action.type));
      const arrow = actions.find(action => action.label === NEXT_ARROW);
      return offers.length === 1 ? { actionId: arrow.id, confidence: 0.9 } : { actionId: 'handoff', confidence: 0.9 };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow, then read the results', {
    mode: 'reversible', capture: 'none', reobserveDelayMs: 100, lateChangeMs: 2000, maxActions: 2 });
  assert.equal(result.steps[0].settle, 'late_change');
  assert.ok(offers[0].includes('wait'), 'the first decision is offered a wait');
  assert.ok(!offers[1].includes('wait'), offers[1].join(','));
  assert.ok(result.verdict.why.includes('wait_excluded'), result.verdict.why.join(','));
});

test('E4d: a calendar Done that only closed its dialog waits for the late results (settle late_change)', async t => {
  const { bridge } = await open(t, 0, pickerPage(false));
  const provider = clicker('Done', 'departing 2026-10-13');
  const result = await new BrowserRuntime({ bridge, provider }).run('Click Done in the Departure calendar', {
    mode: 'reversible', capture: 'none', expectation: { textIncludes: 'departing 2026-10-13' },
    reobserveDelayMs: 100, lateChangeMs: 2000 });
  assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].settle, 'late_change');
  assert.ok(result.steps[0].action.toUrl.includes('date=2026-10-13'), result.steps[0].action.toUrl);
});

test('E4d: a calendar Done that also filled the form field changed the page: no late-change wait', async t => {
  const { bridge } = await open(t, 0, pickerPage(true));
  const provider = clicker('Done', 'never shown');
  const started = Date.now();
  const result = await new BrowserRuntime({ bridge, provider }).run('Click Done in the Departure calendar', {
    mode: 'reversible', capture: 'none', reobserveDelayMs: 100, lateChangeMs: 2000, maxActions: 1 });
  assert.notEqual(result.steps[0].settle, 'late_change');
  assert.ok(!result.verdict.why.includes('late_change:none'), result.verdict.why.join(','));
  assert.ok(Date.now() - started < 1100, `${Date.now() - started} ms`);
});

test('E4b: a plain button that really changes nothing, with no sign of pending work, is not waited for', async t => {
  const { bridge } = await open(t, 1200);
  // The Return field's calendar icon has no handler: nothing ever changes. It is no stepper arrow, opens no picker and
  // sits in no dialog, so the 3 s late-change wait is not paid at all.
  const calls = [];
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      calls.push(1);
      const icon = actions.find(action => action.label === 'unlabelled button next to "Return"');
      return calls.length <= 2 ? { actionId: icon.id, confidence: 0.9 } : { actionId: 'handoff', confidence: 0.9 };
    },
  };
  const started = Date.now();
  const result = await new BrowserRuntime({ bridge, provider }).run('Open the return calendar', {
    mode: 'reversible', capture: 'none', reobserveDelayMs: 0, maxActions: 2 });
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every(step => step.settle !== 'late_change'));
  assert.ok(!result.verdict.why.includes('late_change:none'), result.verdict.why.join(','));
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
});

test('E4b: a plain button that disabled itself (work pending) gets one short look, which sees the late result',
  async t => {
    const body = '<!doctype html><body><main><h1>Report</h1><button type="button" id="r">Refresh totals</button>'
      + '<p id="o">Totals not loaded</p></main><script>const r = document.getElementById("r"); r.onclick = () => {'
      + 'r.disabled = true; setTimeout(() => { document.getElementById("o").textContent = "Total: 42 orders";'
      + ' r.disabled = false; }, 450); };</script>';
    const { bridge } = await open(t, 0, body);
    const provider = clicker('Refresh totals', 'Total: 42');
    const started = Date.now();
    const result = await new BrowserRuntime({ bridge, provider }).run('Refresh the totals', {
      mode: 'reversible', capture: 'none', reobserveDelayMs: 0, expectation: { textIncludes: 'Total: 42' } });
    assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
    assert.equal(result.steps[0].settle, 'late_change');
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
  });

test('E4b: an arrow that really changes nothing costs one bounded wait per call, then no more', async t => {
  // The next-day arrow's handler does nothing here: a full wait (it is a stepper arrow) that sees no change.
  const { bridge } = await open(t, 1200, STEPPER.replace('setTimeout(() => go(day + 1), delay)', 'null'));
  const calls = [];
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      calls.push(1);
      const arrow = actions.find(action => action.label === NEXT_ARROW);
      return calls.length <= 2 ? { actionId: arrow.id, confidence: 0.9 } : { actionId: 'handoff', confidence: 0.9 };
    },
  };
  const started = Date.now();
  const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow', {
    mode: 'reversible', capture: 'none', reobserveDelayMs: 0, lateChangeMs: 600, maxActions: 2 });
  assert.equal(result.steps.length, 2);
  assert.ok(result.verdict.why.includes('late_change:none'));
  assert.ok(Date.now() - started < 600 * 2 + 2500, 'the second click did not wait again');
});

test('E4b: the fifth arrow click in a call still waits for its late change (re-observes that saw one are not spent)',
  async t => {
    // Live run 2026-10-06 (flights-live-form-arrows): days 13 to 16 each waited out their late change, and the fifth
    // arrow (to Sat 17) found the four rung 1c re-observes per run spent: no wait, three more clicks, no_progress.
    const { bridge } = await open(t, 300);
    const provider = {
      model: 'fake',
      async decide(observation, actions) {
        const arrow = actions.find(action => action.label === NEXT_ARROW);
        const there = observation.text.includes('departing 2026-10-16');
        return arrow && !there ? { actionId: arrow.id, confidence: 0.9, done: { probability: 0.05 } }
          : { actionId: 'handoff', confidence: 0.5, done: { probability: there ? 0.9 : 0.05 } };
      },
    };
    const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow until 16 Oct', {
      mode: 'reversible', capture: 'none', expectation: { textIncludes: 'departing 2026-10-16' },
      reobserveDelayMs: 50, lateChangeMs: 1000, maxActions: 8 });
    assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
    assert.deepEqual(result.steps.map(step => step.settle), Array(6).fill('late_change'), 'one click per day');
    assert.equal(result.steps.at(-1).moved, undefined, 'the click itself changed no content');
  });

test('E4b: a button that fills a live region changed the page: no late-change wait (QA spa-project-owner)', async t => {
  // The project details render into an aria-live region, which the semantic revision leaves out: the click looked
  // like a no-op and paid the 3 s wait before the expectation was even checked.
  const body = '<!doctype html><body><main><h1>Projects</h1><button type="button" id="h">Halyard</button>'
    + '<div id="d" aria-live="polite"></div></main><script>document.getElementById("h").onclick = () => {'
    + 'document.getElementById("d").innerHTML = "<h2>Project details</h2><p>Owner: Rosa Okonkwo</p>"; };</script>';
  const { bridge } = await open(t, 0, body);
  const provider = clicker('Halyard', 'Owner: Rosa');
  const started = Date.now();
  const result = await new BrowserRuntime({ bridge, provider }).run('Click Halyard and read the owner', {
    mode: 'reversible', capture: 'none', expectation: { textIncludes: 'Project details' } });
  assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].moved, 'blocks', 'the step names what changed: the live region\'s blocks');
  assert.ok(!result.verdict.why.some(code => code.startsWith('late_change')), result.verdict.why.join(','));
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
});

test('E4c: a host act on an offer the late change made stale runs the same control on the fresh page', async t => {
  const { page, bridge } = await open(t, 600);
  const runtime = new BrowserRuntime({ bridge });
  const first = await runtime.observe({ mode: 'reversible' });
  const arrow = first.actions.find(action => action.label === NEXT_ARROW);
  const clicked = await runtime.act(arrow.id, { revision: first.observation.revision });
  assert.equal(clicked.status, 'checkpoint');
  // The host looks again before the late change lands, then acts on that offer after it landed.
  const second = await runtime.observe({ mode: 'reversible' });
  assert.ok(second.observation.text.includes('departing 2026-10-10'));
  await page.waitForURL(/date=2026-10-11/);
  const again = second.actions.find(action => action.label === NEXT_ARROW);
  const result = await runtime.act(again.id, { revision: second.observation.revision });
  assert.equal(result.status, 'checkpoint', `${result.code}: ${result.reason}`);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
  assert.ok(result.verdict.why.includes('act:stale_reresolve'));
  await page.waitForURL(/date=2026-10-12/);
});

test('E5: the read-only Departure textbox is offered as a click and the click opens the date dialog', async t => {
  const { bridge } = await open(t, 1200);
  const runtime = new BrowserRuntime({ bridge });
  const { observation, actions } = await runtime.observe({ mode: 'reversible' });
  const departure = actions.find(action => action.type === 'click' && action.label === 'Departure');
  assert.ok(departure, actions.map(action => `${action.type}:${action.label}`).join(' | '));
  assert.equal(departure.opens, true);
  const result = await runtime.act(departure.id, { revision: observation.revision, expectation: { textIncludes: 'Choose a date' } });
  assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
});

// A live-region clock: every observe reads another time, the semantic revision stays (live regions are left out).
class ClockBridge {
  constructor() {
    this.observes = 0;
    this.clicks = 0;
  }

  page(tick = true) {
    if (tick) this.observes++;
    return { url: 'https://example.com/flights', title: 'Flights', revision: 'r1', text: 'Departure\nTop flights',
      blocks: [{ t: 'p', text: 'Top flights' }, { t: 'p', text: `Updated ${this.observes}s ago` }],
      controls: [{ id: '1', role: 'button', label: 'next-value button after "Departure"', unnamed: true, enabled: true, visible: true }] };
  }

  async observe() {
    return this.page();
  }

  async execute() {
    this.clicks++;
    // The settle observation reads the same second as the decision's; the re-observe after it, the next.
    return { observation: this.page(false), settle: { reason: 'quiet', ms: 1 }, screenshot: Promise.resolve(null) };
  }
}

test('rung 1c: a live-region clock that reads as a late change on every click spends a bounded number of re-observes', async t => {
  const bridge = new ClockBridge();
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      const arrow = actions.find(action => action.target === '1' || action.label?.startsWith('next-value'));
      return bridge.clicks < 15 && arrow ? { actionId: arrow.id, confidence: 0.9, done: { probability: 0.05 } }
        : { actionId: 'handoff', confidence: 0.5, done: { probability: 0.9 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow next to Departure until the end of the week', {
    mode: 'reversible', capture: 'none', reobserveDelayMs: 0, lateChangeMs: 0, maxSteps: 20 });
  const extra = bridge.observes - bridge.clicks - 1;
  // The arrow changes nothing but the clock: the first repeat of that no-change click ends the run (no_progress:repeat).
  // Stopping there is right: the arrow moved nothing the host asked for, and the old third click saw nothing more.
  assert.equal(bridge.clicks, 2, `${bridge.clicks} clicks ${result.code} ${result.verdict?.why}`);
  assert.equal(result.code, 'no_progress');
  assert.ok(result.verdict.why.includes('no_progress:repeat'), result.verdict.why.join(' '));
  t.diagnostic(`${bridge.clicks} clicks, ${bridge.observes} observes, ${result.code}, ${result.verdict?.why}, ${result.steps.map(step => step.moved + '/' + step.settle)}`);
  assert.ok(extra <= 12, `${extra} re-observes over ${bridge.clicks} clicks`);
});

test('lateLook: a short look that saw nothing is not repeated on the next clicks of the call', async () => {
  let clicks = 0;
  const page = () => ({ url: 'https://example.com/form', title: 'Form', revision: 'r1', text: 'Form',
    blocks: [{ t: 'p', text: 'Form' }, { t: 'p', text: 'Loading…' }],
    controls: [{ id: '1', role: 'button', label: 'Apply', enabled: true, visible: true }] });
  const bridge = {
    async observe() { return page(); },
    async execute() { clicks++; return { observation: page(), settle: { reason: 'quiet', ms: 1 }, screenshot: Promise.resolve(null) }; },
  };
  const provider = { model: 'fake', async decide(observation, actions) {
    const apply = actions.find(action => action.label === 'Apply');
    return clicks < 3 && apply ? { actionId: apply.id, confidence: 0.9, done: { probability: 0.05 } }
      : { actionId: 'handoff', confidence: 0.5, done: { probability: 0.9 } };
  } };
  const started = Date.now();
  await new BrowserRuntime({ bridge, provider }).run('Click Apply', { mode: 'reversible', capture: 'none', reobserveDelayMs: 0 });
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms for ${clicks} clicks`);
});

// changed ||= moved: a clock that ticks between the decision and the settle observation moves the blocks on every
// click. A one-for-one block replacement under an unchanged revision (live region, off-screen rotation) is churn,
// not progress: the arrow that does nothing still stops (no_progress), not at maxActions.
test('rung 1c: a live-region tick in the settle observation does not count a no-change click as progress', async () => {
  const bridge = new ClockBridge();
  bridge.execute = async function execute() {
    this.clicks++;
    return { observation: this.page(true), settle: { reason: 'quiet', ms: 1 }, screenshot: Promise.resolve(null) };
  };
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      const arrow = actions.find(action => action.target === '1' || action.label?.startsWith('next-value'));
      return bridge.clicks < 15 && arrow ? { actionId: arrow.id, confidence: 0.9, done: { probability: 0.05 } }
        : { actionId: 'handoff', confidence: 0.5, done: { probability: 0.9 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Click the next-day arrow next to Departure until the end of the week', {
    mode: 'reversible', capture: 'none', reobserveDelayMs: 0, lateChangeMs: 0, maxSteps: 20, maxActions: 12 });
  assert.equal(result.code, 'no_progress', `${bridge.clicks} clicks ${result.code} ${result.verdict?.why}`);
  assert.ok(bridge.clicks <= 3, `${bridge.clicks} clicks`);
});
