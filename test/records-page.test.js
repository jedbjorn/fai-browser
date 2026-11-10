// Record detection in extension/page.js (detectRecords), run in headless Chromium on synthetic front ends of several
// styles (fixtures/records/): a stay-results list of cards with a sponsored and a sold-out card and a banner between
// cards, a CSS grid of product tiles with star ratings only in aria-labels and a struck-through price, a table of
// rows, a 25-row list of which the viewport shows the first five, page chrome only (menus, link columns, a related
// list), and the same chrome around a grid split into rows of two. Each observation then goes through the core
// (digest, aggregation, auto-confirm) as a run would. No site rules: the fixtures are shapes, not copies.
// CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { blocksOf } from '../src/digest.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const fixture = name => readFile(new URL(`../fixtures/records/${name}`, import.meta.url), 'utf8');

let browser;
test.before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'],
  });
});
test.after(() => browser?.close());

async function observe(t, html, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page.evaluate(() => __faiPage.observe());
}

const HOTELS = ['Hotel Lumière Canal', 'Maison Ardoise', 'Le Petit Quai', 'Hôtel des Tilleuls', 'Gare Nord Rooms', 'Studio Rivoli',
  'Auberge Montmartre', 'Les Jardins Bleus'];

test('hotel cards: one record per card of the whole list, names, ratings, prices, sponsored and sold-out marks', async t => {
  const observation = await observe(t, await fixture('hotels.html'), { width: 1140, height: 893 });
  assert.deepEqual(observation.recordLists, [{ list: 0, total: 8, kept: 8, main: true, afterCount: true }], 'one list: not the filters, the footer or the menu');
  assert.equal(observation.recordsTruncated, false);
  const records = observation.records;
  assert.deepEqual(records.map(record => record.title), HOTELS, 'the banner between cards is no record, screen-reader suffixes are not titles');
  const byName = Object.fromEntries(records.map(record => [record.title, record]));
  const first = byName['Hotel Lumière Canal'];
  assert.equal(first.href, 'https://example.com/hotel/0.html');
  assert.equal(observation.controls.find(control => control.id === first.ref)?.href, first.href, 'ref names the offered title link');
  assert.equal(first.hints.price, '€ 412');
  assert.equal(first.hints.rating, 8.4);
  assert.equal(first.hints.reviews, 2310);
  assert.ok(first.fields.includes('Scored 8.4'), first.fields.join(' | '));
  // Template text every card repeats is dropped; a field with a value never is.
  for (const record of records) {
    assert.ok(!record.fields.includes('See availability') && !record.fields.includes('Includes taxes and fees'), record.fields.join(' | '));
    assert.ok([record.title, ...record.fields].join(' · ').length <= 300);
  }
  assert.equal(byName['Le Petit Quai'].sponsored, true);
  assert.equal(byName['Gare Nord Rooms'].unavailable, true);
  assert.equal(byName['Gare Nord Rooms'].hints.price, undefined);
  assert.ok(!byName['Hôtel des Tilleuls'].fields.some(field => field.includes('470')), 'the struck-through old price is not a field');
  assert.equal(byName['Hôtel des Tilleuls'].struck, 1);
  // The whole list, not only the viewport: the cards below it are records too, marked offscreen.
  assert.ok(!first.offscreen);
  assert.ok(byName['Les Jardins Bleus'].offscreen);
  assert.ok(records.every(record => record.blocks?.length >= 1), 'each record names its blocks');
  // In the viewport text a card's last link never runs into the next card's name.
  for (const line of observation.text.split('\n')) {
    assert.ok(HOTELS.filter(name => line.includes(name)).length <= 1, line);
    assert.ok(!/See availability\s+\S/.test(line), line);
  }
});

test('negative: menus, link columns, footers and a related-links list are never records; a real list beside them is the only one', async t => {
  const chrome = await observe(t, await fixture('chrome-only.html'));
  assert.equal(chrome.records, undefined, JSON.stringify(chrome.records?.map(record => record.title)));
  assert.equal(chrome.recordLists, undefined);
  const rows = await observe(t, await fixture('chrome-and-rows.html'));
  assert.deepEqual(rows.recordLists, [{ list: 0, total: 7, kept: 7 }]);
  assert.deepEqual(rows.records.map(record => record.title),
    ['Casa Lume', 'Tasca Velha', 'Mar Alto', 'Prato Cheio', 'Jardim', 'Forno Azul', 'Cais 9'], 'grid rows of two, the last row of one');
  // A grouped row block around two tiles is shared, never one record's text.
  const texts = blocksOf(rows).filter(block => block.rec).map(block => block.text);
  assert.equal(texts[0], 'Casa Lume · Rated 4.6 by diners · Set menu € 38');
});

// Record detection cost on a card-heavy page: 200 result cards of nested parts (a titled link, a score box, a room box
// with facility bullets, a price box with a struck price, a button), a strip of offers inside one card and a filter
// panel. The limit is generous; it pins the order of the cost, not a budget.
test('record detection stays fast on 200 nested cards (observe p50 under 250 ms)', async t => {
  const card = i => `<div class="card"><div class="head"><h3><a href="/stay/${i}">Stay number ${i}</a></h3>
    <span class="area">District ${i % 9}, 1.${i % 10} km from centre</span></div>
    <div class="score"><span>${(7 + (i % 30) / 10).toFixed(1)}</span><span>Very good</span><span>${100 + i} reviews</span></div>
    <div class="room"><span>Double room</span><ul>${['Free WiFi', 'Breakfast', 'Air conditioning', 'Balcony']
      .map(item => `<li><span>${item}</span></li>`).join('')}</ul></div>
    <div class="price"><s>€ ${300 + i}</s><span>€ ${200 + i}</span><span>Includes taxes and fees</span></div>
    <button>See availability</button>${i === 40 ? `<div class="strip">${Array.from({ length: 6 }, (_, j) =>
      `<div class="offer"><a href="/offer/${j}">Offer ${j}</a><span>€ ${50 + j}</span></div>`).join('')}</div>` : ''}</div>`;
  const filters = Array.from({ length: 8 }, (_, i) => `<fieldset><legend>Filter ${i}</legend>${Array.from({ length: 5 }, (_, j) =>
    `<label><input type="checkbox"> Option ${j} <span>(${10 + j})</span></label>`).join('')}</fieldset>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Stays</title></head><body>
    <aside>${filters}</aside><main><h1>Stays</h1><p>200 properties found</p>
    <div class="results">${Array.from({ length: 200 }, (_, i) => card(i)).join('')}</div></main></body></html>`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const stats = await page.evaluate(() => {
    const measure = options => {
      const times = [];
      for (let i = 0; i < 7; i++) {
        const started = performance.now();
        globalThis.__faiPage.observe(options);
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return { p50: +times[3].toFixed(1), max: +times[6].toFixed(1) };
    };
    return { elements: document.getElementsByTagName('*').length, plain: measure({}), withoutBlocks: measure({ blocks: false }) };
  });
  t.diagnostic(JSON.stringify(stats));
  assert.ok(stats.plain.p50 < 250, `observe p50 ${stats.plain.p50} ms`);
  const observation = await page.evaluate(() => __faiPage.observe());
  assert.deepEqual(observation.recordLists[0], { list: 0, total: 199, kept: 60, main: true, afterCount: true },
    'every card but the one holding the strip of offers');
  assert.equal(observation.records.length, 60);
});
