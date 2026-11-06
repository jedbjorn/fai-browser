// Derived views from extension/page.js (collectViews), run in headless Chromium on fixtures/state-views.html: SVG chart
// text and values read from bar geometry, keyed grid rows, grouped result rows, and the unreadable_region signal. The
// views replace raw text in `text` and blocks but never the semantic revision. CHROMIUM_PATH overrides the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { buildDigest } from '../src/digest.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const FIXTURE = await readFile(new URL('../fixtures/state-views.html', import.meta.url), 'utf8');

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'],
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

const observe = (page, options = {}) => page.evaluate(opts => __faiPage.observe(opts), options);
const doc = body => `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>${body}</body></html>`;
const blockText = (observation, t) => observation.blocks.filter(block => block.t === t).map(block => block.text);

test('a chart whose values are bar heights is read from its geometry against the numeric axis ticks', async t => {
  const observation = await observe(await load(t, FIXTURE));
  const [graph, trend] = blockText(observation, 'chart');
  assert.match(graph, /^Price graph: 14 bars read from their heights, lowest Oct 10 ≈€87, highest Oct 12 ≈€150: Oct 6 ≈€121, Oct 7 ≈€98,/);
  // Marks that name themselves (<title>) are the chart's own reading.
  assert.equal(trend, 'Weekly trend: Mon 6: €121, Tue 7: €98, Wed 8: €140, Thu 9: €112');
  // The chart line replaces the raw tick labels in the text, where the chart sits.
  assert.match(observation.text, /Price insights\nPrice graph: 14 bars read from their heights/);
  assert.doesNotMatch(observation.text, /€180\s+€120/);
  // In the digest for a price question.
  const { digest } = buildDigest(observation, 'Which day in the price graph is cheapest?');
  assert.ok(digest.some(block => block.t === 'chart' && block.text.includes('lowest Oct 10 ≈€87')));
});

test('grids keep each value with its headers; a plain table keeps its " | " rows', async t => {
  const observation = await observe(await load(t, FIXTURE));
  const rows = blockText(observation, 'tr');
  assert.ok(rows.includes('Oct 11 × Oct 17: €287; Oct 11 × Oct 18: €264; Oct 11 × Oct 19: €279'));
  assert.ok(rows.includes('Depart | Oct 17 | Oct 18 | Oct 19'), 'the header row stays as is');
  // An ARIA grid with column headers: its role=row elements are row blocks.
  assert.ok(rows.includes('Fare: Basic; Bags: 0; Price: €87'));
  assert.match(observation.text, /Date grid:\nOct 10 × Oct 17: €312; Oct 10 × Oct 18: €298; Oct 10 × Oct 19: €305\n/);
  assert.match(observation.text, /Fare classes:\nFare: Basic; Bags: 0; Price: €87\nFare: Standard; Bags: 1; Price: €118/);

  const plain = await observe(await load(t, doc(`<table><thead><tr><th>Plan</th><th>Monthly</th></tr></thead>
    <tbody><tr><td>Team</td><td>$29</td></tr><tr><td>Growth</td><td>$48</td></tr></tbody></table>`)));
  assert.deepEqual(blockText(plain, 'tr'), ['Plan | Monthly', 'Team | $29', 'Growth | $48']);
  // Visible text joins one row's cells with " | " instead of a line per cell.
  assert.equal(plain.text, 'Plan | Monthly\nTeam | $29\nGrowth | $48');
});

test('a grid over the text budget keeps the rows naming instruction terms and is flagged as cut', async t => {
  const page = await load(t, FIXTURE);
  const plain = await observe(page);
  assert.doesNotMatch(plain.text, /Day 70 × Economy/);
  const focused = await observe(page, { terms: ['day 70'] });
  assert.match(focused.text, /Day 70 × Economy: €169; Day 70 × Premium: €269; Day 70 × Business: €469/);
  // Blocks carry every keyed row (within the 200-block cap).
  assert.ok(blockText(focused, 'tr').includes('Day 80 × Economy: €179; Day 80 × Premium: €279; Day 80 × Business: €479'));
  const table = focused.unreadable.find(region => region.kind === 'table');
  assert.equal(table.label, 'All fares');
  assert.match(table.reason, /^rows_cut:\d+\/80$/);
});

test('result rows read as one line of fields', async t => {
  const observation = await observe(await load(t, FIXTURE));
  const items = blockText(observation, 'li');
  assert.ok(items.includes('10:25 AM – 11:40 AM · Air France · Nonstop · €121'));
  assert.match(observation.text, /\n10:25 AM – 11:40 AM · Air France · Nonstop · €121\n/);
  // Cards built from repeated divs: the link and the details are one block that keeps the link's ref.
  const card = observation.blocks.find(block => block.text.startsWith('Vueling'));
  assert.equal(card.t, 'li');
  assert.equal(card.text, 'Vueling · 2 hr 5 min €140');
  assert.equal(observation.controls.find(control => control.id === card.ref)?.label, 'Vueling');
  assert.match(observation.text, /\nVueling · 2 hr 5 min · €140\n/);
});

test('regions held only as pixels or cut are listed in unreadable with the warning unreadable_region', async t => {
  const observation = await observe(await load(t, FIXTURE));
  assert.ok(observation.warnings.includes('unreadable_region'));
  const kinds = observation.unreadable.map(region => `${region.kind}:${region.reason}`).sort();
  assert.deepEqual(kinds, ['canvas:pixels_only', 'image:alt_only', 'table:rows_cut:19/80']);
  for (const region of observation.unreadable) {
    for (const key of ['x', 'y', 'width', 'height']) assert.equal(typeof region.bounds[key], 'number');
  }
  assert.equal(observation.unreadable.find(region => region.kind === 'canvas').label, 'Seat map');
  assert.equal(observation.unreadable.find(region => region.kind === 'image').label, 'Price trend chart for the next 60 days');

  // A chart with many marks and nothing that reads their values (equal ticks while loading, no names).
  const bars = Array.from({ length: 12 }, (_, i) => `<rect x="${40 + i * 20}" y="100" width="12" height="80"></rect>`).join('');
  const loading = await observe(await load(t, doc(`<div role="region" aria-label="Price graph"><svg width="400" height="200">
    <text x="2" y="20">€0</text><text x="2" y="100">€0</text><text x="2" y="180">€0</text>${bars}</svg></div>`)));
  assert.deepEqual(loading.unreadable.map(region => [region.kind, region.label, region.reason]), [['chart', 'Price graph', 'values_in_geometry']]);
  // An ordinary page has none.
  const plain = await observe(await load(t, doc('<h1>Hello</h1><p>Text only.</p>')));
  assert.equal(plain.unreadable, undefined);
  assert.ok(!plain.warnings.includes('unreadable_region'));
});

test('views never enter the semantic revision: a bar that changes height keeps it, a tick label change does not', async t => {
  const page = await load(t, FIXTURE);
  const first = await observe(page);
  assert.equal((await observe(page, { blocks: false })).revision, first.revision);
  await page.evaluate(() => {
    const bar = document.querySelector('#graph rect[data-id="2026-10-10"]');
    bar.setAttribute('y', '160');
    bar.setAttribute('height', '60');
  });
  const moved = await observe(page);
  assert.equal(moved.revision, first.revision);
  assert.notEqual(blockText(moved, 'chart')[0], blockText(first, 'chart')[0]);
  assert.match(blockText(moved, 'chart')[0], /Oct 10 ≈€60/);
  await page.evaluate(() => { document.querySelector('#graph text').textContent = '€200'; });
  assert.notEqual((await observe(page)).revision, first.revision);
});

test('views stay within the page payload limits', async t => {
  const observation = await observe(await load(t, FIXTURE));
  assert.ok(observation.text.length <= 8000);
  assert.ok(observation.blocks.length <= 200);
  for (const block of observation.blocks) assert.ok(block.text.length <= 300);
  assert.ok(observation.unreadable.length <= 5);
});

// A labelled bar chart: `ticks` are [label, y] on the y axis (centred on y), `bars` raw <rect>/<path> markup.
function barChart(ticks, bars) {
  const labels = ticks.map(([label, y]) => `<text x="40" y="${y}" text-anchor="end" dominant-baseline="middle">${label}</text>`).join('');
  return doc(`<div role="region" aria-label="Price graph"><svg width="520" height="260">${labels}${bars}</svg></div>`);
}
// One <rect> per value against a linear scale from `lo` at y = 220 to `hi` at y = 20, drawn from the zero line.
function rects(values, lo, hi, attrs = () => '') {
  const y = v => 220 - ((v - lo) / (hi - lo)) * 200;
  return values.map((v, i) => `<rect data-id="2026-10-${String(1 + i).padStart(2, '0')}" x="${60 + i * 30}" y="${Math.min(y(v), y(0))}"
    width="16" height="${Math.abs(y(v) - y(0))}" ${attrs(i)}></rect>`).join('');
}
const linearTicks = [['€0', 220], ['€50', 153.33], ['€100', 86.67], ['€150', 20]];
// The "key ≈value" pairs after the colon of a chart line (tick labels sit within a pixel or two of their tick, so a read
// value is close, not exact: hence ≈).
function readBars(chart) {
  const list = chart.slice(chart.lastIndexOf(': ') + 2);
  return { values: Object.fromEntries(list.split(', ').map(entry => {
    const [, key, value] = /^(.+) ≈\D*(-?[\d.]+)$/.exec(entry);
    return [key, Number(value)];
  })) };
}
function assertNear(actual, expected, tolerance, message) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), message);
  for (const key of Object.keys(expected)) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${message}: ${key} ${actual[key]} vs ${expected[key]}`);
  }
}

test('bar geometry is read on a linear axis, with right-aligned ticks of different widths in one column', async t => {
  const observation = await observe(await load(t, barChart([['0', 220], ['1,000', 153.33], ['2,000', 86.67], ['3,000', 20]],
    rects([400, 900, 2500, 1500], 0, 3000))));
  const [chart] = blockText(observation, 'chart');
  assert.match(chart, /^Price graph: 4 bars read from their heights, lowest Oct 1 ≈\d+, highest Oct 3 ≈\d+: /);
  // Within 2% of the axis range.
  assertNear(readBars(chart).values, { 'Oct 1': 400, 'Oct 2': 900, 'Oct 3': 2500, 'Oct 4': 1500 }, 60, 'linear');
  assert.equal(observation.unreadable, undefined);
});

test('bar geometry that cannot be read honestly is never reported: log, out-of-order, negative and stacked charts', async t => {
  const cases = {
    // Evenly spaced 1, 10, 100, 1000: a log axis, which a straight scale through the end ticks would misread.
    log: barChart([['1', 220], ['10', 153.33], ['100', 86.67], ['1000', 20]],
      rects([5, 50, 500, 20], 0, 1000).replace(/height="[^"]*"/g, 'height="60"').replace(/y="[^"]*"/g, 'y="160"')),
    nonMonotonic: barChart([['€0', 220], ['€150', 153.33], ['€50', 86.67], ['€100', 20]], rects([40, 90, 120, 60], 0, 150)),
    // Bars below the zero line are negative values: the top edge of each sits on the baseline.
    negative: barChart([['-50', 220], ['0', 153.33], ['50', 86.67], ['100', 20]], rects([80, -40, 30, -10, 60], -50, 100)),
    // Two segments per key: the lower one alone would be read as the value.
    stacked: barChart(linearTicks, [0, 1, 2, 3].map(i => {
      const y = v => 220 - (v / 150) * 200;
      const low = 30 + i * 10;
      return `<rect data-id="s${i}" x="${60 + i * 30}" y="${y(low)}" width="16" height="${220 - y(low)}"></rect>`
        + `<rect data-id="s${i}" x="${60 + i * 30}" y="${y(low + 40)}" width="16" height="${y(low) - y(low + 40)}"></rect>`;
    }).join('')),
  };
  for (const [name, html] of Object.entries(cases)) {
    const observation = await observe(await load(t, html));
    const [chart] = blockText(observation, 'chart');
    assert.doesNotMatch(chart, /bars read|≈/, `${name}: ${chart}`);
    assert.deepEqual(observation.unreadable?.map(region => [region.kind, region.reason]), [['chart', 'values_in_geometry']], name);
    assert.ok(observation.warnings.includes('unreadable_region'), name);
  }
});

test('hidden bars are not read; non-numeric ticks give labels only', async t => {
  const hidden = await observe(await load(t, barChart(linearTicks,
    rects([40, 90, 120, 60, 10], 0, 150, i => (i === 4 ? 'style="visibility:hidden"' : i === 3 ? 'opacity="0"' : '')))));
  const [chart] = blockText(hidden, 'chart');
  assert.match(chart, /^Price graph: 3 bars read from their heights, lowest Oct 1 ≈€\d+, highest Oct 3 ≈€\d+: /);
  assertNear(readBars(chart).values, { 'Oct 1': 40, 'Oct 2': 90, 'Oct 3': 120 }, 3, 'hidden');
  const words = await observe(await load(t, barChart([['Low', 220], ['Mid', 120], ['High', 20]], rects([40, 90, 120], 0, 150))));
  assert.deepEqual(blockText(words, 'chart'), ['Price graph: Low, Mid, High']);
});

test('a chart with many bars is clipped at a whole entry, keeping the lowest and highest first', async t => {
  const values = Array.from({ length: 200 }, (_, i) => 20 + (i * 37) % 120);
  const y = v => 220 - (v / 150) * 200;
  const bars = values.map((v, i) => `<rect data-id="b${i}" x="${50 + i * 2.2}" y="${y(v)}" width="2" height="${220 - y(v)}"></rect>`).join('');
  const observation = await observe(await load(t, barChart(linearTicks, bars)));
  const [chart] = blockText(observation, 'chart');
  assert.ok(chart.length <= 300);
  assert.match(chart, /^Price graph: 200 bars read from their heights, lowest b\d+ ≈€(?:19|20|21), highest b\d+ ≈€(?:13[789]|140): .*, b\d+ ≈€\d+…$/);
  const line = observation.text.split('\n').find(text => text.startsWith('Price graph'));
  assert.ok(line.length <= 900 && line.endsWith('…'));
});

test('derived views keep the revision when only their presentation changes, and real content still moves it', async t => {
  const page = await load(t, FIXTURE);
  const first = await observe(page);
  // A canvas re-render (pixels only).
  await page.evaluate(() => {
    const context = document.querySelector('canvas').getContext('2d');
    context.fillStyle = '#c00';
    context.fillRect(0, 0, 200, 60);
  });
  assert.equal((await observe(page)).revision, first.revision);
  // Re-grouping: the cards stop being repeated siblings, so their fields are no longer one row.
  await page.evaluate(() => { document.querySelectorAll('#cards .card').forEach((card, i) => card.classList.add(`c${i}`)); });
  const regrouped = await observe(page);
  assert.equal(regrouped.revision, first.revision);
  assert.ok(!regrouped.blocks.some(block => block.text === 'Vueling · 2 hr 5 min €140'));
  // A grouped row's price, and a keyed grid cell, are content.
  await page.evaluate(() => { document.querySelector('ul.results li span:last-child').textContent = '€131'; });
  const repriced = await observe(page);
  assert.notEqual(repriced.revision, first.revision);
  assert.ok(blockText(repriced, 'li').includes('10:25 AM – 11:40 AM · Air France · Nonstop · €131'));
  await page.evaluate(() => { document.querySelector('#dates tbody td').textContent = '€399'; });
  const regridded = await observe(page);
  assert.notEqual(regridded.revision, repriced.revision);
  assert.ok(blockText(regridded, 'tr').includes('Oct 10 × Oct 17: €399; Oct 10 × Oct 18: €298; Oct 10 × Oct 19: €305'));
});

test('a decorative SVG and hundreds of small icons are not charts', async t => {
  const paths = Array.from({ length: 100 }, (_, i) => `<path d="M${i * 3} 0 L${i * 3 + 5} 50 Z"></path>`).join('');
  const icons = Array.from({ length: 300 }, (_, i) => `<p>Item ${i} <a href="/x/${i}"><svg width="24" height="24"><path d="M0 0h24v24H0z"></path></svg> link</a>
    <svg width="180" height="90"><rect width="180" height="90"></rect></svg></p>`).join('');
  const observation = await observe(await load(t, doc(`<h1>Hero</h1><svg width="900" height="400">${paths}</svg>${icons}`)));
  assert.equal(observation.unreadable, undefined);
  assert.deepEqual(blockText(observation, 'chart'), []);
  assert.ok(!observation.warnings.includes('unreadable_region'));
});

// Eight keyed tables (row and column headers) in the viewport, between an answer line and a footer.
function keyedTables(count, rows) {
  return Array.from({ length: count }, (_, t) => `<table style="font-size:8px;float:left"><caption>Fares ${t}</caption>
    <thead><tr><th>Day</th>${Array.from({ length: 6 }, (_, c) => `<th>Col ${c}</th>`).join('')}</tr></thead><tbody>${
    Array.from({ length: rows }, (_, r) => `<tr><th scope="row">Row ${t}-${r}</th>${
      Array.from({ length: 6 }, (_, c) => `<td>€${t * 100 + r * 3 + c}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
}

test('views share one text budget, so many keyed tables cannot crowd out the rest of the page', async t => {
  const observation = await observe(await load(t, doc(`<h1>Results</h1><p>The refund policy is 30 days.</p>${keyedTables(8, 12)}
    <p style="clear:both">Footer: contact support.</p>`)));
  assert.match(observation.text, /The refund policy is 30 days\./);
  assert.match(observation.text, /Footer: contact support\.$/);
  assert.ok(observation.text.length < 8000, `${observation.text.length}`);
  // The first tables get keyed lines; once the budget is spent the rest keep their " | " rows.
  assert.match(observation.text, /Fares 0:\nRow 0-0 × Col 0: €0; /);
  assert.match(observation.text, /Row 7-11 \| €733 \| €734/);
  assert.equal(observation.textTruncated, false);
  // Every keyed row is still a block.
  assert.ok(blockText(observation, 'tr').includes('Row 7-11 × Col 0: €733; Row 7-11 × Col 1: €734; Row 7-11 × Col 2: €735; Row 7-11 × Col 3: €736; Row 7-11 × Col 4: €737; Row 7-11 × Col 5: €738'));
});

test('a view that fills the text marks it truncated', async t => {
  const filler = Array.from({ length: 150 }, (_, i) => `Sentence ${i} with some words to fill the text.`).join(' ');
  const observation = await observe(await load(t, doc(`<p style="font-size:4px;margin:0">${filler}</p>${keyedTables(1, 30)}`)));
  assert.match(observation.text, /Fares 0:\nRow 0-0 × Col 0/);
  assert.equal(observation.text.length, 8000);
  assert.equal(observation.textTruncated, true);
});
