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
import { autoConfirm, classifyIntent } from '../src/digest.js';
import { actionHops, boundedImperative, hopsDoneInOrder } from '../src/oversight.js';
import { PageBridge } from './helpers/page-bridge.js';

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

// ---------------------------------------------------------------------------------------------------------------
// 1. billing-office-hours: no early end, and no auto-confirm, on a page that cannot answer an hours question
// ---------------------------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------------------------
// 2. catalog-plan-price: the join fact stays in the trail on an aggregate-intent question
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// 3. Question-less list steps rank next to step_guards, never after it
// ---------------------------------------------------------------------------------------------------------------

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

