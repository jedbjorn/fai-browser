// Round six regressions (bench/results/host-2026-10-06-final-after, qa-2026-10-06-final-after-x3), reproduced on the
// real fixture pages in headless Chromium with extension/page.js (test/helpers/page-bridge.js) and scripted providers
// that answer the way live Jev did in those runs:
// 1. billing-office-hours: "Open the Contact page and read the opening hours of the Lisbon office" ended early on
//    Contact (early_end:named_actions) and auto-confirmed "Lisbon office — led by Elif Demir" as the opening hours;
// 2. catalog-plan-price: the aggregate-intent trail kept item lines only, so the catalog join fact never reached the
//    ranking and the first call no longer auto-answered "$96 per month";
// 3. a question-less list step ranked its answer serially after step_guards (+0.3 s per step);
// 4. spa-reports-pushstate / spa-billing-balance: the grouped-row view merged a panel's separate facts into one block,
//    and select-oceania's ranking request carried the page's own pre-select prompt as earlier-pages context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { startSite } from '../bench/serve-site.mjs';
import { startQaSite } from '../bench/qa/serve.mjs';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { autoConfirm, classifyIntent } from '../src/digest.js';
import { actionHops, boundedImperative, hopsDoneInOrder } from '../src/oversight.js';
import { PageBridge } from './helpers/page-bridge.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

let site;
let qa;
let browser;
test.before(async () => {
  site = await startSite();
  qa = await startQaSite();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(async () => {
  await browser?.close();
  await site?.close();
  await qa?.close();
});

async function open(t, origin, path, level = 'read-only') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.goto(origin + path);
  return new PageBridge(page, { level });
}

const pathOf = observation => new URL(observation.url).pathname;
const kinds = result => result.cost.requests.map(entry => entry.kind);

// ---------------------------------------------------------------------------------------------------------------
// 1. billing-office-hours: no early end, and no auto-confirm, on a page that cannot answer an hours question
// ---------------------------------------------------------------------------------------------------------------

/**
 * Jev as the final-after R traces show it: Contact from the home page, the Lisbon office link from Contact (when it
 * is asked again there), a handoff with done 0.9 on the office page; the slim guards request scores pages clean; the
 * ranking picks a time-of-day line when there is one and otherwise, confidently, the line naming the Lisbon office.
 */
function officeJev() {
  const calls = { decide: [], confirm: [], choose: [] };
  return {
    model: 'office-jev',
    calls,
    async decide(observation, actions) {
      const path = pathOf(observation);
      calls.decide.push(path);
      const pick = label => actions.find(action => action.label === label);
      if (path === '/' || path === '/index.html') return { actionId: pick('Contact').id, confidence: 0.92, done: { probability: 0.05 } };
      if (path === '/contact.html') return { actionId: pick('Lisbon office').id, confidence: 0.88, done: { probability: 0.3 } };
      return { actionId: 'handoff', confidence: 0.6, done: { probability: 0.9 } };
    },
    async confirm(observation) {
      calls.confirm.push(pathOf(observation));
      return { done: { probability: 0.3 }, guards: { blocked: 0.01, injection: 0.01 } };
    },
    async choose(request) {
      calls.choose.push(request);
      const right = request.candidates.find(candidate => /\d{2}:\d{2}/.test(candidate.text))
        ?? request.candidates.find(candidate => /Lisbon office/.test(candidate.text)) ?? request.candidates[0];
      return { choice: right.id, confidence: 0.95 };
    },
  };
}

const LISBON = 'Open the Contact page and read the opening hours of the Lisbon office.';
const LISBON_Q = 'What are the opening hours of the Lisbon office?';

test('billing-office-hours: hours questions have the hours shape; a line naming the office is never confirmed', () => {
  assert.equal(classifyIntent(LISBON_Q), 'hours');
  assert.equal(classifyIntent("What are the office's opening hours?"), 'hours');
  // The host's first call: "who" no longer makes it a name question that "Elif Demir" satisfies.
  const first = 'What are the opening hours of the office led by the team member who handles billing and plans?';
  assert.equal(classifyIntent(first), 'hours');
  const ranked = text => ({ method: 'provider', candidates: [{ text, confidence: 0.95 }, { text: 'Oslo office', confidence: 0.02 }] });
  const wrong = autoConfirm(ranked('Lisbon office — led by Elif Demir'), { question: LISBON_Q });
  assert.equal(wrong.answer, null);
  assert.ok(wrong.why.includes('answer:shape_hours'));
  assert.equal(autoConfirm(ranked('Elif Demir'), { question: first }).answer, null);
  assert.equal(autoConfirm(ranked('Opening hours: 09:00–17:30 WET'), { question: LISBON_Q }).answer.text, '09:00–17:30 WET');
  // The read clause's entity is not a hop: only Contact is, and only an action's label or landing page does it.
  assert.deepEqual(boundedImperative(LISBON), ['Contact']);
  assert.deepEqual(actionHops('Click Contact, then the Lisbon office. Read its opening hours.'), ['Contact', 'Lisbon office']);
  assert.equal(hopsDoneInOrder(['Contact', 'Lisbon office'], [['contact', 'contact us', '/contact.html']]), false,
    'a Contact page whose text mentions the Lisbon office does not do the Lisbon hop');
});

test('billing-office-hours (host call, urlIncludes contact): no early end on Contact, no wrong verified answer', async t => {
  const bridge = await open(t, site.origin, '/');
  const jev = officeJev();
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run(LISBON, {
    expectation: { urlIncludes: 'contact' }, answerQuestion: LISBON_Q, maxActions: 3, capture: 'none',
    allowedOrigins: [site.origin] }));
  assert.ok(!result.verdict.why.includes('early_end:named_actions'), result.verdict.why.join(' '));
  assert.ok(result.verdict.why.includes('early_end:read_unmet'));
  // Contact cannot answer: the terminal decide went on to the office page.
  assert.deepEqual(jev.calls.decide.slice(0, 2), ['/', '/contact.html']);
  assert.match(result.page.url, /\/offices\/lisbon\.html$/);
  assert.doesNotMatch(result.verdict.answer?.text ?? '', /led by/);
  assert.ok(result.page.digest.some(line => /09:00/.test(line)));
});

test('billing-office-hours (host call, textIncludes Lisbon): ends verified on the office page with the hours', async t => {
  const bridge = await open(t, site.origin, '/');
  const jev = officeJev();
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run(LISBON, {
    expectation: { textIncludes: 'Lisbon' }, answerQuestion: LISBON_Q, maxActions: 3, capture: 'none',
    allowedOrigins: [site.origin] }));
  assert.equal(result.status, 'completed', JSON.stringify(result.verdict));
  assert.equal(result.verification.passed, true);
  assert.match(result.page.url, /\/offices\/lisbon\.html$/);
  assert.equal(result.verdict.answer?.text, '09:00–17:30 WET');
  // The early end applies on the office page (its page has the hours): no decide there, one guards request.
  assert.ok(result.verdict.why.includes('early_end:named_actions'));
  assert.deepEqual(jev.calls.decide, ['/', '/contact.html']);
});

test('bounded imperative with a question: an unconfirmed ranking falls back to the done-gated decide', async t => {
  const bridge = await open(t, site.origin, '/');
  const jev = officeJev();
  // Jev unsure on the office page: the early end does not stop on it, the terminal decide (handoff) does.
  jev.choose = async request => ({ choice: request.candidates[0].id, confidence: 0.5 });
  const raw = await new BrowserRuntime({ bridge, provider: jev }).run('Open the Contact page, then the Lisbon office.', {
    expectation: { textIncludes: 'Office lead' }, answerQuestion: 'Who leads the Lisbon office?', maxActions: 3,
    capture: 'none', allowedOrigins: [site.origin] });
  const result = agentResult(raw);
  assert.equal(result.status, 'completed');
  assert.ok(result.verdict.why.includes('early_end:read_unmet'));
  assert.ok(!result.verdict.why.includes('early_end:named_actions'));
  assert.equal(result.verdict.answer, null);
  // The ranking that ran next to the guards request is reused by the terminal decide: one choose in all.
  assert.equal(kinds(raw).filter(kind => kind === 'choose').length, 1, kinds(raw).join(' '));
});

// ---------------------------------------------------------------------------------------------------------------
// 2. catalog-plan-price: the join fact stays in the trail on an aggregate-intent question
// ---------------------------------------------------------------------------------------------------------------

test('catalog-plan-price: the catalog join fact reaches the trail and the ranking; "$96 per month" auto-confirms', async t => {
  const bridge = await open(t, site.origin, '/');
  const requests = [];
  const route = { '/': 'Catalog', '/index.html': 'Catalog', '/catalog/page-1.html': 'Next page', '/catalog/page-2.html': 'Pricing' };
  const jev = {
    model: 'catalog-jev',
    async decide(observation, actions) {
      const label = route[pathOf(observation)];
      const action = label && actions.find(entry => entry.label === label);
      return action ? { actionId: action.id, confidence: 0.9, done: { probability: 0.1 } }
        : { actionId: 'handoff', confidence: 0.6, done: { probability: 0.4 } };
    },
    async confirm() {
      return { done: { probability: 0.4 }, guards: { blocked: 0.01, injection: 0.01 } };
    },
    // Jev with the earlier page's fact picks the Team row; without it, it hesitates between the plans (0.29-0.4).
    async choose(request) {
      requests.push(request);
      const joined = (request.earlierPages ?? []).some(page => page.lines.some(line => /Kestrel.*Team plan/.test(line)));
      const team = request.candidates.find(candidate => /^Team \|/.test(candidate.text));
      return joined && team ? { choice: team.id, confidence: 0.95 } : { choice: request.candidates[0].id, confidence: 0.4 };
    },
  };
  const result = agentResult(await new BrowserRuntime({ bridge, provider: jev }).run(
    'Find the catalog item Kestrel Field Lamp and note which plan it is available on. Then open the Pricing page and read the monthly price of that plan.', {
      expectation: { urlIncludes: 'pricing' }, maxActions: 6, capture: 'none', allowedOrigins: [site.origin],
      answerQuestion: 'The catalog item called Kestrel Field Lamp is available on exactly one plan. What is the monthly price of that plan on the Pricing page?',
    }));
  assert.equal(result.status, 'completed');
  assert.match(result.page.url, /\/pricing\.html$/);
  assert.ok(result.trail?.some(entry => entry.lines.some(line => /Kestrel Field Lamp.*Team plan/.test(line))),
    JSON.stringify(result.trail));
  assert.ok(result.verdict.why.includes('trail_has_fact'));
  assert.ok(result.verdict.why.includes('join_task'));
  assert.equal(result.verdict.answer?.text, '$96 per month', result.verdict.why.join(' '));
  assert.ok(requests.at(-1).earlierPages.length >= 1);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Question-less list steps rank next to step_guards, never after it
// ---------------------------------------------------------------------------------------------------------------

const CATALOG = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`/c${i + 1}`, {
  title: `Catalog page ${i + 1}`, text: `Page ${i + 1} of 4. Tents: Ridge ${100 + i}. Lamps: Kestrel ${200 + i}`,
  blocks: [{ t: 'h1', text: `Catalog page ${i + 1}` }, { t: 'p', text: `Page ${i + 1} of 4` },
    { t: 'p', text: `Next page: Ridge ${101 + i} tents` }, { t: 'p', text: `The next page lists Kestrel ${201 + i} lamps` }],
  controls: i < 3 ? [{ id: '1', role: 'link', label: 'Next page', href: `${ORIGIN}/c${i + 2}`, enabled: true }] : [],
}]));

test('list step without a question: the ranking starts next to the end-of-step guards (parallel, not serial)', async () => {
  const log = [];
  const DELAY = 120;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const jev = {
    model: 'fake',
    async decide(observation, actions) {
      const next = actions.find(action => action.label === 'Next page');
      return { actionId: next?.id ?? 'handoff', confidence: 0.9, done: { probability: 0.3 } };
    },
    async confirm() {
      log.push('guards:start');
      await sleep(DELAY);
      log.push('guards:end');
      return { done: { probability: 0.3 }, guards: { blocked: 0.01, injection: 0.01 } };
    },
    async choose(request) {
      log.push('choose:start');
      await sleep(DELAY);
      log.push('choose:end');
      return { choice: request.candidates[0].id, confidence: 0.6 };
    },
  };
  const bridge = new FakeBridge({ pages: CATALOG, path: '/c1' });
  const steps = [2, 3, 4].map(n => ({ instruction: 'Click Next page.', expectation: { textIncludes: `Page ${n} of 4` }, maxActions: 3 }));
  const started = Date.now();
  const raw = await new BrowserRuntime({ bridge, provider: jev }).run({ steps, capture: 'none' });
  const elapsed = Date.now() - started;
  assert.equal(raw.code, 'expectation_passed');
  // Every step's ranking started before its guards request ended.
  assert.equal(log.filter(entry => entry === 'choose:start').length, 3, log.join(' '));
  // Step k's ranking started before step k's guards request ended (serial would start it after).
  const at = name => log.flatMap((entry, i) => (entry === name ? [i] : []));
  at('choose:start').forEach((start, k) => assert.ok(start < at('guards:end')[k], `serial: ${log.join(' ')}`));
  assert.ok(kinds(raw).includes('choose'));
  // Three steps of guards + ranking in parallel: about 3 × DELAY, not 6 × DELAY.
  assert.ok(elapsed < 5 * DELAY, `${elapsed} ms`);
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Grouped rows keep a panel's separate facts apart; one-page runs send no prompt-only earlier context
// ---------------------------------------------------------------------------------------------------------------

test('spa panels: the Reports and Billing facts stay separate blocks; flight rows stay grouped', async t => {
  const bridge = await open(t, qa.origin, '/spa/app/reports', 'reversible');
  const reports = await bridge.observe();
  const texts = reports.blocks.map(block => block.text);
  assert.ok(texts.includes('Q2 revenue: $388,400'), texts.join(' / '));
  assert.ok(texts.includes('Q3 revenue: $412,900'));
  assert.ok(!texts.some(text => /388,400 · Q3/.test(text)));
  assert.doesNotMatch(reports.text, /\$388,400 · Q3/);
  await bridge.page.click('aside button[data-view="billing"]');
  const billing = await bridge.observe();
  const lines = billing.blocks.map(block => block.text);
  assert.ok(lines.includes('Current balance: $1,284.00'), lines.join(' / '));
  assert.ok(lines.includes('Next invoice: 1 November 2026'));

  const flights = await open(t, qa.origin, '/long/flights/', 'reversible');
  const rows = (await flights.observe()).blocks.filter(block => block.t === 'li').map(block => block.text);
  assert.ok(rows.some(text => /^\d{2}:\d{2} · .+ · Nonstop · 1 h 40 min · €\d+$/.test(text)), rows.join(' / '));
});

test('repeated stat cards: distinct "Label: value" facts are separate blocks, list rows still join', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html><head><title>T</title><style>.card{display:flex;gap:8px}</style></head><body>
    <div class="card"><p>Q2 revenue: $388,400</p><p>Q3 revenue: $412,900</p></div>
    <div class="card"><p>Q2 costs: $201,000</p><p>Q3 costs: $199,500</p></div>
    <div class="card"><p>Q2 margin: 48%</p><p>Q3 margin: 52%</p></div>
    <div class="row"><a href="/1">Vueling</a><span>2 hr 5 min</span><span>€140</span></div>
    <div class="row"><a href="/2">KLM</a><span>4 hr 10 min</span><span>€205</span></div>
    <div class="row"><a href="/3">Lufthansa</a><span>5 hr</span><span>€231</span></div></body></html>` }));
  await page.goto('https://example.com/');
  const observation = await new PageBridge(page, { level: 'reversible' }).observe();
  const texts = observation.blocks.map(block => block.text);
  assert.ok(texts.includes('Q3 revenue: $412,900'), texts.join(' / '));
  assert.ok(texts.includes('Q2 margin: 48%'));
  assert.ok(texts.some(text => text.startsWith('Vueling · ')), texts.join(' / '));
});

test('select-oceania: a one-page run sends no earlier-pages context when the earlier state holds only a prompt', async () => {
  const requests = [];
  // Two states of one URL: the button redraws the page in place (FakeBridge: two pages reported at one URL).
  const url = `${ORIGIN}/ship`;
  const before = { url, title: 'Shipping rates',
    blocks: [{ t: 'h1', text: 'Shipping rates' }, { t: 'label', text: 'Region' },
      { t: 'p', text: 'Select a region to see the shipping cost.' }],
    text: 'Shipping rates\nRegion\nSelect a region to see the shipping cost.',
    controls: [{ id: '1', role: 'button', label: 'Show Oceania', href: `${ORIGIN}/after`, enabled: true }] };
  const after = { url, title: 'Shipping rates',
    blocks: [{ t: 'h1', text: 'Shipping rates' }, { t: 'label', text: 'Region' },
      { t: 'p', text: 'Shipping to Oceania: $18.50 (7 to 10 days)' }, { t: 'p', text: 'Shipping is tracked.' }],
    text: 'Shipping rates\nRegion\nShipping to Oceania: $18.50 (7 to 10 days)\nShipping is tracked.', controls: [] };
  const bridge = new FakeBridge({ pages: { '/before': before, '/after': after }, path: '/before' });
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      const show = actions.find(action => action.label === 'Show Oceania');
      return show ? { actionId: show.id, confidence: 0.98, done: { probability: 0.05 } }
        : { actionId: 'handoff', confidence: 0.6, done: { probability: 0.94 } };
    },
    async choose(request) {
      requests.push(request);
      return { choice: request.candidates.find(candidate => /\$18\.50/.test(candidate.text)).id, confidence: 0.94 };
    },
  };
  const result = agentResult(await new BrowserRuntime({ bridge, provider }).run(
    'Click Show Oceania. Read the shipping cost that appears and stop there.', {
      mode: 'reversible', capture: 'none', expectation: { textIncludes: 'Shipping to Oceania' },
      answerQuestion: 'What does shipping to Oceania cost?' }));
  assert.equal(result.status, 'completed');
  assert.ok(requests.length >= 1);
  for (const request of requests) assert.equal(request.earlierPages, undefined, JSON.stringify(request.earlierPages));
  assert.equal(result.verdict.answer?.text, '$18.50');
});

test('flights-live: a textIncludes sentence the click scrolled above the viewport still verifies the step', async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  const rows = Array.from({ length: 80 }, (_, i) => `<li>Flight ${i + 1} · €${100 + i}</li>`).join('');
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html><head><meta charset="utf-8"><title>Flights</title></head><body><h1>Flights</h1>
    <p aria-hidden="true">departing 2026-10-13</p><div id="out"></div>
    <button onclick="document.getElementById('out').innerHTML = '<p>Top flights, departing 2026-10-12</p><ul>${rows}</ul>';
      this.remove(); window.scrollTo(0, document.body.scrollHeight)">View more flights</button></body></html>` }));
  await page.goto('https://example.com/');
  const bridge = new PageBridge(page, { level: 'reversible' });
  const execute = bridge.execute.bind(bridge);
  bridge.execute = async (...args) => {
    const outcome = await execute(...args);
    bridge.lastText = outcome.observation.text.toLowerCase();
    return outcome;
  };
  const provider = {
    model: 'scroll-jev',
    async decide(observation, actions) {
      const more = actions.find(action => action.label === 'View more flights');
      return more ? { actionId: more.id, confidence: 0.95, done: { probability: 0.05 } }
        : { actionId: 'handoff', confidence: 0.6, done: { probability: 0.95 } };
    },
    async confirm() {
      return { done: { probability: 0.95 }, guards: { blocked: 0.01, injection: 0.01 } };
    },
  };
  const run = expectation => new BrowserRuntime({ bridge, provider }).run('Click View more flights', {
    expectation, mode: 'reversible', maxActions: 3, capture: 'none', allowedOrigins: ['https://example.com'] });
  const result = agentResult(await run({ textIncludes: 'departing 2026-10-12' }));
  assert.ok(!bridge.lastText.includes('departing 2026-10-12'), 'scrolled out of the viewport text');
  assert.equal(result.status, 'completed', JSON.stringify(result.verdict));
  assert.equal(result.verification.passed, true);
  // Hidden text scrolled out of the viewport never satisfies textIncludes.
  await page.goto('https://example.com/');
  const hidden = agentResult(await run({ textIncludes: 'departing 2026-10-13' }));
  assert.notEqual(hidden.status, 'completed');
});
