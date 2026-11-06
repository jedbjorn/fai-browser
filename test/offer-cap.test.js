// Offering on busy pages (live failure 2026-10-05, Google Flights "Price graph"): accessible names for controls
// (extension/page.js labelOf, describeUnnamed), the observe listing cap by level and relevance (src/relevance.js
// capOffer, src/result.js leanObserve), the controls_capped:<n> warning, act() on an action the listing left out, and
// the slim option cap composing with the listing cap. Page-script cases run in headless Chromium (CHROMIUM_PATH).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { BrowserRuntime, cappedWarning, legalActions, offeredActions } from '../src/runtime.js';
import { DEFAULT_OPTION_CAP, OFFER_CAPS, capActions, capOffer, offerCap, relevanceHints } from '../src/relevance.js';
import { agentResult, leanObserve } from '../src/result.js';
import { observeText } from '../src/mcp.js';
import { FakeBridge, link } from './runtime-fixtures.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const FLIGHTS = await readFile(new URL('../fixtures/flights.html', import.meta.url), 'utf8');
const INTERACTIVE = { requested: 'interactive', granted: 'interactive', effective: 'interactive' };
const nonTerminal = actions => actions.filter(action => action.type !== 'done' && action.type !== 'handoff');

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function load(t, html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = (page, options = { allow: ['controls', 'submit_safe'] }) => page.evaluate(o => __faiPage.observe(o), options);
const doc = body => `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>${body}</body></html>`;

// --------------------------------------------------------------------------------------------- accessible names

test('labels follow the accessible-name computation: labelledby, aria-label, <label>, value, text, icons, title, placeholder', async t => {
  const page = await load(t, doc(`
    <span id="pax">Passengers</span><button aria-labelledby="pax count" aria-label="ignored"><span id="count">1</span></button>
    <label for="from">Where from?</label><input id="from" value="Marseille">
    <label>Where to? <input id="to" value="London"></label>
    <input id="when" placeholder="Departure">
    <button title="Change appearance"><span style="display:inline-block;width:10px;height:10px"></span></button>
    <input type="button" value="Swap">
    <button><svg width="10" height="10" aria-hidden="true"><title>Google apps</title><rect width="10" height="10"/></svg></button>
    <button><img alt="Notifications" width="10" height="10" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>
    <span role="button" aria-label="" tabindex="0"><span role="link" aria-label="Learn more about tracked prices" tabindex="0"><i style="display:inline-block;width:10px;height:10px"></i></span></span>
    <div role="button" tabindex="0">Price graph</div>
    <span id="dates">Track prices - Any dates</span><button role="switch" aria-checked="false" aria-labelledby="dates"><i></i></button>`));
  const { controls } = await observe(page);
  const labels = controls.map(control => control.label);
  for (const expected of ['Passengers 1', 'Where from?', 'Where to?', 'Departure', 'Change appearance', 'Swap', 'Google apps',
    'Notifications', 'Price graph', 'Track prices - Any dates']) {
    assert.ok(labels.includes(expected), `${expected} in ${JSON.stringify(labels)}`);
  }
  // The span role=button has no name and no text of its own: its nested link's aria-label names it (both are listed).
  assert.equal(controls.filter(control => control.label === 'Learn more about tracked prices').length, 2);
  assert.ok(controls.every(control => control.label && !control.unnamed));
});

test('a control with no name gets a descriptor: kind, position and context, never an empty label', async t => {
  const page = await load(t, doc(`
    <h2>Search</h2>
    <div><input aria-label="Departure" value="Sun, Jan 31"><div><button aria-hidden="true" tabindex="-1"><i></i></button></div>
      <div><button aria-hidden="true" tabindex="-1"><i></i></button></div></div>
    <fieldset><legend>Travel dates</legend><input type="date"><input type="date"></fieldset>
    <h2>Display currency</h2><p>Prices in euros.</p><section><p><button><i></i></button></p></section>`));
  const { controls } = await observe(page);
  const unnamed = controls.filter(control => control.unnamed);
  assert.deepEqual(unnamed.map(control => control.label), [
    'unlabelled button 1 of 2 next to "Departure"',
    'unlabelled button 2 of 2 next to "Departure"',
    'unlabelled date field 1 of 2 next to "Travel dates"',
    'unlabelled date field 2 of 2 next to "Travel dates"',
    'unlabelled button next to "Display currency"',
  ]);
  assert.ok(controls.every(control => control.label.length > 0));
  // The runtime offers them with these labels too (no `click button ""`).
  const offered = legalActions({ ...(await observe(page)), url: 'https://example.com/' }, { mode: 'interactive' });
  assert.ok(nonTerminal(offered).every(action => action.label));
});

test('calendar day cells named by a number read their weekday, month and year from the grid heading', async t => {
  const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<button type="button">${from + i} <span>€${40 + i}</span></button>`).join('');
  const page = await load(t, doc(`
    <div role="dialog" aria-label="Departure date">
      <div class="month"><h3>October 2026</h3><div class="grid">${days(1, 31)}</div></div>
      <div class="month"><h3>November 2026</h3><div class="grid">${days(1, 30)}</div></div>
      <button type="button">Done</button>
    </div>
    <div><button type="button">3 stops</button><button type="button">12 results</button></div>`));
  const { controls } = await observe(page);
  const label = text => controls.find(control => control.label.startsWith(text))?.label;
  assert.equal(label('Wednesday 14 October'), 'Wednesday 14 October 2026 €53');
  assert.equal(label('Sunday 1 November'), 'Sunday 1 November 2026 €40');
  // A few numbered buttons outside a month grid keep their own text.
  assert.ok(label('3 stops') && label('12 results') && label('Done'));
});

test('calendar day cells keep their number when the month cannot be established from the page with certainty', async t => {
  const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<button type="button">${from + i}</button>`).join('');
  const page = await load(t, doc(`
    <section id="rolling"><h3>October 2026</h3><div>${days(28, 30)}${days(1, 25)}</div></section>
    <section id="row"><div><h3>December 2026</h3><h3>January 2027</h3></div>
      <div><div>${days(1, 31)}</div></div><div><div>${days(1, 31)}</div></div></section>
    <section id="word"><h3>Marathon 2026</h3><div>${days(1, 31)}</div></section>
    <section id="short"><h3>February 2026</h3><div>${days(1, 30)}</div></section>
    <section id="fr"><h3>octobre 2026</h3><div>${days(1, 31)}</div></section>`));
  const { controls } = await observe(page);
  // A rolling grid that starts in the previous month, two grids under one row of headings, a heading word that only
  // starts like a month, a grid longer than its month, a month name in another language: no guessed dates.
  assert.deepEqual(controls.filter(control => !/^\d+$/.test(control.label)).map(control => control.label), []);
});

// gf-date-grid live run: the heading reads a bare "October" (no year) and the cells stayed "6", "7", "8". One month's days
// in order under one English month heading with no year at that level read "9 October", the weekday only from the
// grid's own header row for that column; the year is never taken from the clock.
test('calendar day cells under a year-less month heading read day and month, the weekday only from the header row', async t => {
  const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<button type="button">${from + i} <span>€${40 + i}</span></button>`).join('');
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // October 2026 starts on a Thursday: three empty cells, then 1..31 in rows of seven.
  const cells = [null, null, null, ...Array.from({ length: 31 }, (_, i) => i + 1)];
  const rows = Array.from({ length: Math.ceil(cells.length / 7) }, (_, r) => `<tr>${cells.slice(r * 7, r * 7 + 7)
    .map(day => `<td>${day ? `<button type="button">${day} <span>€${40 + day}</span></button>` : ''}</td>`).join('')}</tr>`).join('');
  const page = await load(t, doc(`
    <div role="dialog" aria-label="Departure date">
      <div class="month"><h3>October</h3><table><thead><tr>${weekdays.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="month"><h3>November</h3><div class="grid">${days(1, 30)}</div></div>
    </div>`));
  const { controls } = await observe(page);
  const labels = controls.map(control => control.label);
  assert.ok(labels.includes('Friday 9 October €49'), labels.join(' | '));
  assert.ok(labels.includes('1 November €40'), labels.join(' | '));
  assert.ok(!labels.some(label => /20\d\d/.test(label)), 'no year from the clock');
});

test('year-less month headings keep the refusals: rolling grids, two months in one row, other languages, wrong lengths', async t => {
  const days = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<button type="button">${from + i}</button>`).join('');
  const page = await load(t, doc(`
    <section id="rolling"><h3>October</h3><div>${days(28, 30)}${days(1, 25)}</div></section>
    <section id="row"><div><h3>December</h3><h3>January</h3></div>
      <div><div>${days(1, 31)}</div></div><div><div>${days(1, 31)}</div></div></section>
    <section id="prefix"><h3>Oct</h3><div>${days(1, 31)}</div></section>
    <section id="word"><h3>Mayday</h3><div>${days(1, 31)}</div></section>
    <section id="short"><h3>April</h3><div>${days(1, 31)}</div></section>
    <section id="fr"><h3>octobre</h3><div>${days(1, 31)}</div></section>
    <section id="year"><h3>March</h3><h4>Season 2027</h4><div>${days(1, 31)}</div></section>`));
  const { controls } = await observe(page);
  assert.deepEqual(controls.filter(control => !/^\d+$/.test(control.label)).map(control => control.label), []);
});

test('a synthesized label never loosens a risk class: an unnamed button next to "Delete account" is refused', async t => {
  const page = await load(t, doc('<div><h3>Delete account</h3><button><i></i></button></div>'));
  const { controls } = await observe(page);
  const button = controls.find(control => control.unnamed);
  assert.equal(button.label, 'unlabelled button next to "Delete account"');
  assert.equal(button.risk, 'delete');
});

test('the runtime never offers an empty label from an observation without descriptors', () => {
  const observation = { revision: 'r', url: 'https://example.com/', controls: [{ id: '7', role: 'button', label: '', enabled: true }] };
  const [action] = legalActions(observation, { mode: 'reversible' });
  assert.equal(action.label, 'unlabelled button 7');
});

test('descriptor context drops double quotes', async t => {
  const page = await load(t, doc('<div><h3>Say "hi" “there”</h3><button><i></i></button></div>'));
  const { controls } = await observe(page);
  assert.equal(controls.find(control => control.unnamed).label, 'unlabelled button next to "Say hi there"');
});

// --------------------------------------------------------------------------------------------- consent names

const COOKIE_DIALOG = inner => doc(`<div role="dialog" style="position:fixed;bottom:0;left:0;right:0;background:#fff">
  <p>We use cookies to improve the site.</p>${inner}</div><p>Body</p>`);

test('consent: a visible "Accept all" named by aria-labelledby "Cookie preferences" is still the accept button', async t => {
  const page = await load(t, COOKIE_DIALOG(`<span id="pref">Cookie preferences</span>
    <button aria-labelledby="pref">Accept all</button><button>Reject all</button>`));
  const observation = await observe(page);
  assert.ok(observation.consent, 'the dialog is a consent dialog');
  const accept = observation.controls.find(control => control.label === 'Cookie preferences');
  assert.equal(accept.risk, 'consent_accept');
  assert.equal(observation.consent.buttons.find(button => button.id === accept.id).kind, 'accept');
  assert.equal(observation.consent.buttons.find(button => button.label === 'Reject all').kind, 'reject');
});

test('consent: an "Accept all" labelled by "Reject all" is never the reject button', async t => {
  const page = await load(t, COOKIE_DIALOG(`<span id="rej">Reject all</span>
    <button aria-labelledby="rej">Accept all</button><button>Manage settings</button>`));
  const observation = await observe(page);
  const accept = observation.controls.find(control => control.label === 'Reject all');
  assert.equal(accept.risk, 'consent_accept');
  assert.ok(observation.consent);
  assert.ok(!observation.consent.buttons.some(button => button.kind === 'reject'), JSON.stringify(observation.consent.buttons));
  // The runtime's reject-first step has nothing to click, and the accept button is not offered below full.
  const offered = legalActions({ ...observation, url: 'https://example.com/' }, { mode: 'interactive' });
  assert.ok(!offered.some(action => action.target === accept.id));
});

// --------------------------------------------------------------------------------------------- cost on big pages

test('descriptors stay cheap on a 40k-element page with 150 unnamed buttons', async t => {
  const build = named => {
    const sections = [];
    for (let s = 0; s < 150; s++) {
      sections.push(`<section>${'<div><span>x</span><span>y</span></div>'.repeat(88)}`
        + `<button>${named ? `Go ${s}` : '<i style="display:inline-block;width:8px;height:8px"></i>'}</button></section>`);
    }
    // No name near the buttons: the context search climbs to <main> (40k elements) and falls back to the heading.
    return doc(`<h1>Results</h1><main><div><div>${sections.join('')}</div></div></main>`);
  };
  const time = async html => {
    const page = await load(t, html);
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await page.evaluate(() => { const start = performance.now(); __faiPage.observe({ blocks: false }); return performance.now() - start; }));
    const count = await page.evaluate(() => document.getElementsByTagName('*').length);
    return { ms: runs.sort((a, b) => a - b)[2], count };
  };
  const named = await time(build(true));
  const unnamed = await time(build(false));
  assert.ok(unnamed.count > 40_000, `${unnamed.count} elements`);
  assert.ok(unnamed.ms < named.ms * 2 + 100, `unnamed ${unnamed.ms.toFixed(0)} ms vs named ${named.ms.toFixed(0)} ms`);
});

// --------------------------------------------------------------------------------------------- comboboxes

test('a combobox that takes no text (div role=combobox) is offered as a click, with its label classes', () => {
  const observation = { revision: 'r', url: 'https://example.com/', controls: [
    { id: '1', role: 'combobox', label: 'Round trip', enabled: true, editable: false },
    { id: '2', role: 'combobox', label: 'Buy now', enabled: true, editable: false },
    { id: '3', role: 'combobox', label: 'Where from?', type: 'text', enabled: true, editable: true },
  ] };
  const offered = nonTerminal(legalActions(observation, { mode: 'interactive' }));
  // The editable combobox ("Where from?") takes fills of supplied values and, with none, is still clicked open.
  assert.deepEqual(offered.filter(action => action.target).map(action => [action.type, action.label, Boolean(action.opens)]),
    [['click', 'Round trip', false], ['click', 'Where from?', true]]);
  // An observation without `editable` (an older page script) keeps the text-entry reading: a picker click only.
  const old = { ...observation, controls: [{ id: '1', role: 'combobox', label: 'Round trip', enabled: true }] };
  assert.deepEqual(nonTerminal(legalActions(old, { mode: 'interactive' })).filter(action => action.target)
    .map(action => [action.type, Boolean(action.opens)]), [['click', true]]);
});

// --------------------------------------------------------------------------------------------- the fixture page

async function flights(t) {
  const page = await load(t, FLIGHTS);
  const observation = { ...(await observe(page)), url: 'https://example.com/' };
  return observation;
}

/** The observe pipeline without a daemon: offered actions, the listing at `level`, the lean result. */
function listing(observation, { level = 'interactive', instruction } = {}) {
  const config = { mode: level, instruction };
  const hints = instruction ? relevanceHints({ instruction }) : null;
  const offer = offeredActions(observation, { ...config, ...(hints ? { hints } : {}) });
  const actions = nonTerminal(offer.actions);
  const listed = capOffer(actions, level, hints);
  const warning = cappedWarning(observation, offer.dropped + listed.dropped);
  const page = { ...observation, warnings: [...observation.warnings.filter(code => code !== 'controls_capped'), ...(warning ? [warning] : [])] };
  const lean = leanObserve({ revision: observation.revision, page, actions,
    offer: { cap: listed.cap, listed: listed.actions.map(action => action.id), dropped: listed.dropped },
    permissions: { ...INTERACTIVE, effective: level } });
  return { actions, listed, lean };
}

const listedLabels = lean => lean.actions.map(action => action.description);

test('flights fixture: about 90 controls, every one named, "Date grid", "Price graph" and the date steppers offered', async t => {
  const observation = await flights(t);
  assert.ok(observation.controls.length >= 90 && observation.controls.length < 100, `${observation.controls.length} controls`);
  assert.ok(!observation.warnings.includes('controls_capped'), 'the page script keeps every control');
  assert.ok(observation.controls.every(control => control.label));
  const { actions, lean } = listing(observation);
  assert.ok(actions.length > OFFER_CAPS.interactive, `${actions.length} offered`);
  const lines = listedLabels(lean);
  for (const label of ['click button "Date grid"', 'click button "Price graph"', 'click button "Passengers 1"',
    'click button "unlabelled button 1 of 2 next to \\"Departure\\""', 'click button "unlabelled button 2 of 2 next to \\"Return\\""',
    'click button "Learn more about tracked prices"', 'click button "Track prices from Marseille to London - Any dates"',
    'click combobox "Round trip"']) {
    assert.ok(lines.includes(label), label);
  }
  assert.ok(!lines.some(line => / ""(?: |$)/.test(line)), 'no empty label is listed');
});

test('flights fixture: over the interactive cap the listing keeps 80 controls plus page actions and warns with the count', async t => {
  const observation = await flights(t);
  const { actions, lean } = listing(observation);
  const dropped = actions.length - lean.actions.length;
  assert.ok(dropped > 0);
  assert.equal(lean.actions.length, OFFER_CAPS.interactive + 3, 'scroll down, scroll up and wait on top of the cap');
  assert.equal(lean.moreActions, dropped);
  assert.deepEqual(lean.warnings, [`controls_capped:${dropped}`]);
  // Ids keep their offered numbers: the gap shows where actions were left out.
  const ids = lean.actions.map(action => Number(action.id.slice(1)));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(lean.actions.some(action => action.description === 'scroll down'));
  // Without a task, ties keep page order: the last control on the page ("Price calendar") is left out.
  assert.ok(!listedLabels(lean).includes('click button "Price calendar"'));
  // The MCP text says so.
  const text = observeText({ ...lean, next: { kind: 'choose', text: 'x' } });
  assert.match(text, new RegExp(`\\(${dropped} more offered actions not listed: these are the most relevant to the task\\)`));
  assert.match(text, new RegExp(`warning: controls_capped:${dropped}`));
});

test('flights fixture: the control the instruction names near the end of the page is listed', async t => {
  const observation = await flights(t);
  const { lean } = listing(observation, { instruction: 'Click "Price calendar" and read the cheapest day' });
  assert.ok(listedLabels(lean).includes('click button "Price calendar"'));
  assert.ok(lean.warnings[0].startsWith('controls_capped:'));
  const graph = listing(observation, { instruction: "Click 'Price graph' to show prices by departure date" });
  assert.ok(listedLabels(graph.lean).includes('click button "Price graph"'));
});

test('flights fixture: read-only lists links only, at most 40, unchanged in shape', async t => {
  const observation = await flights(t);
  const { actions, lean } = listing(observation, { level: 'read-only' });
  assert.ok(actions.every(action => action.role === 'link' || ['scroll', 'wait'].includes(action.type)));
  assert.ok(actions.length - 3 <= OFFER_CAPS['read-only']);
  assert.equal(lean.actions.length, actions.length);
  assert.equal(lean.warnings, undefined);
});

// --------------------------------------------------------------------------------------------- caps and warnings

const busyPage = (n, extra = []) => ({
  title: 'Index', text: 'An index of many pages',
  controls: [...Array.from({ length: n }, (_, i) => link(String(i + 1), `Topic ${i + 1}`, `/topic/${i + 1}`)), ...extra],
});

test('offerCap by level; capOffer keeps page actions on top of the cap', () => {
  assert.equal(offerCap('read-only'), 40);
  assert.equal(offerCap('reversible'), 40);
  assert.equal(offerCap('interactive'), 80);
  assert.equal(offerCap('full'), 80);
  assert.equal(offerCap('testing'), 80);
  assert.equal(offerCap('unknown'), 40);
  const actions = nonTerminal(legalActions({ revision: 'r', url: 'https://example.com/', ...busyPage(100) }, { mode: 'interactive' }));
  const { actions: kept, dropped, cap } = capOffer(actions, 'interactive', null);
  assert.equal(cap, 80);
  assert.equal(kept.length, 83);
  assert.equal(dropped, 20);
  assert.deepEqual(kept.slice(-3).map(action => action.label), ['scroll down', 'scroll up', 'wait']);
});

test('cappedWarning adds the page script count and the offer and listing drops', () => {
  assert.equal(cappedWarning({ warnings: [] }), null);
  assert.equal(cappedWarning({ warnings: ['controls_capped'] }), 'controls_capped');
  assert.equal(cappedWarning({ warnings: ['controls_capped'], controlsDropped: 30 }), 'controls_capped:30');
  assert.equal(cappedWarning({ warnings: ['controls_capped'], controlsDropped: 30 }, 12), 'controls_capped:42');
  assert.equal(cappedWarning({ warnings: [] }, 5), 'controls_capped:5');
});

test('the MAX_OFFERED cap keeps the most relevant actions and reports how many it dropped', () => {
  const observation = { revision: 'r', url: 'https://example.com/', ...busyPage(60) };
  // 60 links, 30 selects with 8 options (7 offered each) and one more link: 60 + 210 + 1 + 3 = 274 actions from 91
  // controls, over the 250 cap.
  observation.controls.push(...Array.from({ length: 30 }, (_, i) => ({
    id: String(200 + i), role: 'combobox', label: `Filter ${i + 1}`, enabled: true, selectedValue: 'a',
    options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(value => ({ value, label: value.toUpperCase() })),
  })));
  observation.controls.push(link('300', 'Annual report', '/annual'));
  const { actions, dropped } = offeredActions(observation, { mode: 'interactive', instruction: 'Open the annual report' });
  assert.ok(dropped > 0);
  assert.equal(nonTerminal(actions).length, 250);
  assert.ok(actions.some(action => action.label === 'Annual report'), 'the named link survives the cap');
  assert.ok(['scroll', 'wait'].every(type => actions.some(action => action.type === type)));
  // Ids stay contiguous: a0..a249.
  assert.deepEqual(nonTerminal(actions).map(action => action.id), Array.from({ length: 250 }, (_, i) => `a${i}`));
});

// --------------------------------------------------------------------------------------------- runtime observe / act

test('runtime observe lists by relevance; act resolves an action the listing left out', async () => {
  const pages = {
    '/': busyPage(95, [link('900', 'Members', '/members')]),
    '/members': { title: 'Members', text: 'Ada', controls: [] },
    '/topic/95': { title: 'Topic 95', text: 'The last topic', controls: [] },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }) });
  const observed = await runtime.observe({ mode: 'interactive', instruction: 'Open the Members page' });
  const listed = new Set(observed.offer.listed);
  assert.equal(observed.offer.cap, 80);
  assert.equal(observed.offer.dropped, observed.actions.length - listed.size);
  assert.ok(observed.offer.dropped > 0);
  const members = observed.actions.find(action => action.label === 'Members');
  assert.ok(listed.has(members.id), 'the named link is listed');
  assert.deepEqual(observed.observation.warnings, [`controls_capped:${observed.offer.dropped}`]);
  const lean = leanObserve({ revision: observed.observation.revision, page: observed.observation, actions: observed.actions,
    offer: observed.offer, permissions: INTERACTIVE });
  assert.equal(lean.actions.length, listed.size);
  assert.deepEqual(lean.warnings, [`controls_capped:${observed.offer.dropped}`]);
  // An action the listing left out (the last topic) is still an offered action: act() runs it.
  const last = observed.actions.find(action => action.label === 'Topic 95');
  assert.ok(!listed.has(last.id));
  const result = await runtime.act(last.id, { revision: observed.observation.revision, expectation: { urlIncludes: '/topic/95' } });
  assert.equal(result.status, 'completed');
});

test('runtime observe always lists the consent dialog buttons, wherever they sit on the page', async () => {
  const pages = { '/': { ...busyPage(90, [{ id: '91', role: 'button', label: 'Reject all', enabled: true, consent: true }]),
    consent: { text: 'We use cookies', buttons: [{ id: '91', label: 'Reject all', kind: 'reject' }] } } };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }) });
  const observed = await runtime.observe({ mode: 'reversible' });
  assert.equal(observed.offer.cap, 40);
  const reject = observed.actions.find(action => action.label === 'Reject all');
  assert.ok(observed.offer.listed.includes(reject.id));
  assert.equal(observed.offer.listed.length, 40 + 1 + 3);
});

test('runtime observe passes the page script warnings and consent through', async () => {
  const pages = { '/': { title: 'Home', text: 'Hi', controls: [link('1', 'About', '/about')], warnings: ['controls_capped', 'password_field'],
    consent: { text: 'Cookies', buttons: [] } } };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }) });
  const observed = await runtime.observe({ mode: 'read-only' });
  assert.deepEqual(observed.observation.warnings, ['password_field', 'controls_capped']);
  assert.deepEqual(observed.observation.consent, { text: 'Cookies', buttons: [] });
});

test('a run warns controls_capped:<n> when the page script capped its controls', async () => {
  const pages = {
    '/': { ...busyPage(3, [link('900', 'Members', '/members')]), warnings: ['controls_capped'], controlsDropped: 31 },
    '/members': { title: 'Members', text: 'Ada', controls: [] },
  };
  const bridge = new FakeBridge({ pages });
  const original = Object.getOwnPropertyDescriptor(FakeBridge.prototype, 'observation').get;
  Object.defineProperty(bridge, 'observation', {
    get() {
      const observation = original.call(this);
      const page = this.pages[this.path];
      if (page.controlsDropped) observation.controlsDropped = page.controlsDropped;
      return observation;
    },
  });
  const provider = {
    async decide(observation, actions) {
      const members = actions.find(action => action.label === 'Members');
      return members ? { actionId: members.id, confidence: 0.9, done: { probability: 0.05 } } : { actionId: 'handoff', confidence: 0.9, done: { probability: 0.9 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider })
    .run('Open the Members page', { expectation: { urlIncludes: '/members' }, capture: 'none' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.warnings.filter(code => code.startsWith('controls_capped')), ['controls_capped:31']);
});

// --------------------------------------------------------------------------------------------- slim composition

test('slim.cap composes with the listing cap: the same ranking, no second drop of what the first kept', () => {
  const observation = { revision: 'r', url: 'https://example.com/', ...busyPage(95, [link('900', 'Members', '/members')]) };
  const hints = relevanceHints({ instruction: 'Open the Members page' });
  const actions = legalActions(observation, { mode: 'interactive' });
  const listed = capOffer(nonTerminal(actions), 'interactive', hints).actions;
  const direct = capActions(actions, DEFAULT_OPTION_CAP, hints);
  const composed = capActions(listed, DEFAULT_OPTION_CAP, hints);
  assert.deepEqual(nonTerminal(composed.actions).map(action => action.id), nonTerminal(direct.actions).map(action => action.id));
  assert.ok(composed.actions.some(action => action.label === 'Members'));
  // Each cap counts only its own drop: the listing left out 15, slim.cap 43 more of the 83 listed.
  assert.equal(composed.dropped, listed.length - DEFAULT_OPTION_CAP);
  assert.equal(direct.dropped, nonTerminal(actions).length - DEFAULT_OPTION_CAP);
});

test('slim.cap through a run on a page over MAX_OFFERED: the named link survives both caps, each drop counted once', async () => {
  // 28 links, 70 selects with 5 options (one selected: 4 offered each) and the named link last: 28 + 280 + 1 + 3 = 312
  // actions from 99 controls, over MAX_OFFERED (250).
  const selects = Array.from({ length: 70 }, (_, i) => ({
    id: String(200 + i), role: 'combobox', label: `Filter ${i + 1}`, enabled: true, selectedValue: 'a',
    options: ['a', 'b', 'c', 'd', 'e'].map(value => ({ value, label: value.toUpperCase() })),
  }));
  const pages = { '/': busyPage(28, [...selects, link('900', 'Members', '/members')]), '/members': { title: 'Members', text: 'Ada', controls: [] } };
  const seen = [];
  const provider = {
    async decide(observation, actions) {
      seen.push(actions.length);
      const members = actions.find(action => action.label === 'Members');
      return members ? { actionId: members.id, confidence: 0.9, done: { probability: 0.05 } } : { actionId: 'handoff', confidence: 0.9, done: { probability: 0.9 } };
    },
  };
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider })
    .run('Open the Members page', { mode: 'reversible', expectation: { urlIncludes: '/members' }, capture: 'none', slim: { cap: true } });
  assert.equal(result.status, 'completed');
  assert.equal(seen[0], DEFAULT_OPTION_CAP + 2);
  const offered = 28 + 70 * 4 + 1 + 3;
  // The offer cap left out offered - 250 actions (the warning); slim.cap then trimmed the request from 250 to 40 (the
  // provider-only trim is recorded in cost.requests, not as a warning).
  assert.deepEqual(result.warnings, [`controls_capped:${offered - 250}`]);
  assert.equal(result.cost.requests[0].optionsDropped, 250 - DEFAULT_OPTION_CAP);
});

test('runtime act returns the next offered actions on the landing page, remembered so the next act needs no observe', async () => {
  const pages = {
    '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'Members', '/members')] },
    '/members': busyPage(60, [link('900', 'Home', '/'), link('901', 'Ada', '/members/ada')]),
    '/members/ada': { title: 'Ada', text: 'Ada Lovelace', controls: [] },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }) });
  const observed = await runtime.observe({ mode: 'reversible', instruction: 'Open Members, then Ada' });
  const members = observed.actions.find(action => action.label === 'Members');
  const first = await runtime.act(members.id, { revision: observed.observation.revision });
  assert.equal(first.code, 'step_complete');
  // The landing page's offer: every offered action, the listing (the reversible cap of 40 plus page actions) and
  // the revision the next act may name.
  const offer = first.offer;
  assert.equal(typeof offer.revision, 'string');
  assert.ok(runtime.offers.has(offer.revision), 'remembered like an observe');
  assert.equal(offer.cap, 40);
  assert.ok(offer.dropped > 0, 'a busy page is capped');
  assert.equal(offer.actions.length - offer.listed.length, offer.dropped);
  const ada = offer.actions.find(action => action.label === 'Ada');
  assert.ok(offer.listed.includes(ada.id), 'the named link is listed');
  assert.ok(first.warnings.includes(`controls_capped:${offer.dropped}`));
  // The lean result lists the listing as `actions` and counts the rest; next says to keep driving or hand back.
  const lean = agentResult(JSON.parse(JSON.stringify(first)));
  assert.equal(lean.revision, offer.revision);
  assert.equal(lean.actions.length, offer.listed.length);
  assert.ok(lean.actions.some(action => action.description === 'click "Ada"'));
  assert.equal(lean.moreActions, offer.dropped);
  assert.equal(lean.next.kind, 'choose');
  assert.match(lean.next.text, /call fai_browser_act with requestId .* one actions\[\]\.id as actionId and revision/);
  assert.match(lean.next.text, /fai_browser_run/);
  assert.equal(agentResult(lean).actions.length, lean.actions.length, 'idempotent');
  // A second act on the new revision, with no observe in between; an expectation that passes ends it completed.
  const second = await runtime.act(ada.id, { revision: offer.revision, expectation: { urlIncludes: '/members/ada' } });
  assert.equal(second.status, 'completed');
  assert.equal(second.offer.actions.length, 3, 'scroll up, scroll down and wait on an empty page');
  assert.equal(agentResult(JSON.parse(JSON.stringify(second))).next.kind, 'answer');
  // The offer is spent once an act runs it.
  assert.equal(runtime.offers.has(offer.revision), false);
});
