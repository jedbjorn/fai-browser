// Structured Agent-direct projection of generic records: dated rows, product/listing cards, explicit result state and
// honest incomplete pages. Fixtures are invented shapes, not site copies. CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { buildDigest } from '../src/digest.js';
import { directText } from '../src/mcp.js';
import { agentResult, compactPage, directResult, leanObserve, recordResultsOf } from '../src/result.js';

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

async function observe(t, name, transform = html => html) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  const body = transform(await fixture(name));
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page.evaluate(() => __faiPage.observe());
}

function actionsOf(observation) {
  return observation.controls.filter(control => control.role === 'link' || control.role === 'button')
    .map((control, index) => ({
      id: `a${index}`, type: 'click', target: control.id, role: control.role, label: control.label, href: control.href,
    }));
}

function project(observation, actions = actionsOf(observation), instruction = 'Find the oldest receipt and its date') {
  const digest = buildDigest(observation, instruction).digest;
  return leanObserve({ revision: observation.revision, page: observation, actions, digest }, { instruction });
}

function actionFor(actions, target) {
  return actions.find(action => action.target === target)?.id;
}

test('semantic data rows retain records with selection and state checkboxes, without admitting settings panels', async t => {
  for (const shape of ['table', 'grid', 'settings', 'settings-table', 'dated-settings-table']) {
    const observation = await observe(t, 'receipts.html', () => {
      const rows = Array.from({ length: 4 }, (_, i) => {
        const values = [
          '<span role="checkbox" aria-label="Select row">Select</span>',
          '<span role="checkbox" aria-label="Not starred">Star</span>',
          `Invented sender ${i + 1}`, `Receipt for order ${101 + i}`, `Nov ${i + 1}`,
        ];
        if (shape === 'table') return `<tr>${values.map(value => `<td>${value}</td>`).join('')}</tr>`;
        if (shape === 'grid') return `<div role="row">${values.map(value => `<div role="gridcell">${value}</div>`).join('')}</div>`;
        if (shape.endsWith('settings-table')) return `<tr><td>Preference ${i + 1}</td><td>Delivery notification settings`
          + `${shape === 'dated-settings-table' ? ' since 30 Oct 2026' : ''}</td>`
          + '<td><label>Notify <input type="checkbox"></label></td>'
          + '<td><label>Include summaries <input type="checkbox"></label></td></tr>';
        return `<section><h2>Preference ${i + 1}</h2><label>Notify <input type="checkbox"></label>`
          + '<label>Include summaries <input type="checkbox"></label></section>';
      }).join('');
      const list = shape.endsWith('table') ? `<table><tbody>${rows}</tbody></table>`
        : shape === 'grid' ? `<div role="grid">${rows}</div>` : `<div>${rows}</div>`;
      return `<style>[role="gridcell"]{display:inline-block;padding:8px}td{padding:8px}</style>`
        + `<main><h1>Receipt search</h1><p>128 results</p>${list}<button>Next results</button></main>`;
    });
    if (shape.includes('settings')) {
      assert.equal(observation.records?.length ?? 0, 0, 'multi-choice preference panels remain excluded');
      continue;
    }
    const results = project(observation, [], 'Search receipts').page.results;
    assert.equal(results.shown, 4, shape);
    assert.equal(results.total, 4, 'DOM row total is not the total search count');
    assert.deepEqual(results.resultCount, { value: 128 });
    assert.equal(results.complete, false, 'a visible page does not establish search completeness');
    assert.deepEqual(results.records.map(record => record.date), ['Nov 1', 'Nov 2', 'Nov 3', 'Nov 4']);
    assert.ok(results.records.every(record => record.open === undefined), 'missing offered controls never invent open actions');
  }
});

test('dated rows with multiple choice controls accept standalone display date formats', async t => {
  for (const date of ['30 Oct 2026', 'Oct 30, 2026', '2026-10-30', '10/30/26', '30.10.2026', 'Yesterday', 'Today', '9:45 AM']) {
    const observation = await observe(t, 'receipts.html', () => '<main><h1>Receipt archive</h1><table><tbody>'
      + Array.from({ length: 3 }, (_, i) => `<tr><td><input type="checkbox"></td><td><input type="checkbox"></td>`
        + `<td>Invented sender ${i}</td><td>Receipt for order ${i + 100}</td><td>${date}</td></tr>`).join('')
      + '</tbody></table></main>');
    assert.equal(observation.records?.length, 3, date);
    assert.equal(project(observation, []).page.results.shown, 3, date);
  }
});

test('dated rows: date, primary open action, explicit count/sort/pagination; projected rows leave the digest', async t => {
  const observation = await observe(t, 'receipts.html');
  assert.deepEqual(observation.recordState, {
    resultCount: { value: 128 },
    sort: { label: 'Newest first' },
    pagination: { previous: '11', next: '12', current: 2, total: 6 },
  });
  assert.deepEqual(observation.records[0].hints.when, ['30 Oct 2026']);
  const actions = actionsOf(observation);
  const before = JSON.stringify(observation);
  const lean = project(observation, actions);
  const results = lean.page.results;
  assert.deepEqual({
    shown: results.shown, total: results.total, resultCount: results.resultCount, sort: results.sort,
    pagination: results.pagination, complete: results.complete,
  }, {
    shown: 4, total: 4, resultCount: { value: 128 }, sort: { label: 'Newest first' },
    pagination: { previous: actionFor(actions, '11'), next: actionFor(actions, '12'), current: 2, total: 6 }, complete: false,
  });
  const first = results.records[0];
  assert.deepEqual(first, {
    id: 'r1', title: 'Northwind Office', date: '30 Oct 2026', price: '$84.20',
    fields: ['Receipt for ergonomic keyboard · order NW-104'], open: actionFor(actions, '3'),
  });
  assert.equal(results.records[3].date, '14 Jun 2026');
  assert.ok(!JSON.stringify(results.records).includes('openRef'));
  assert.ok(!lean.page.digest.some(line => /Northwind Office|City Cycle Works|Paper & Parcel|Harbour Hardware/.test(line)),
    JSON.stringify(lean.page.digest));
  assert.equal(JSON.stringify(observation), before, 'projection never mutates the observation or its cache inputs');
  assert.deepEqual(project(observation, actions), lean, 'the same observation and actions project identically');

  const direct = directResult(lean);
  assert.deepEqual(direct.page.results, results);
  const text = directText(direct);
  assert.match(text, /results: 4 shown, 128 results, incomplete/);
  assert.match(text, /result sort: Newest first/);
  assert.match(text, /result pagination: page 2 of 6; previous a\d+; next a\d+/);
  assert.match(text, /result r4: \{.*"title":"Harbour Hardware".*"date":"14 Jun 2026".*"open":"a\d+"/);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, description: `open ${i}` }));
  const previous = { ...direct, revision: 'rev:1', actions: many };
  const current = { ...direct, revision: 'rev:2', actions: many };
  const unchanged = directText(current, previous);
  assert.match(unchanged, /results: unchanged from revision rev:1/);
  assert.doesNotMatch(unchanged, /result r4:/);
  const changed = structuredClone(current);
  changed.page.results.records[3].date = '13 Jun 2026';
  assert.match(directText(changed, previous), /result r4: .*"date":"13 Jun 2026"/);
});

test('listing cards: meaningful details stay, structured values are not repeated, next page means incomplete', async t => {
  const observation = await observe(t, 'listings-incomplete.html');
  const actions = actionsOf(observation);
  const results = project(observation, actions).page.results;
  assert.equal(results.resultCount.value, 48);
  assert.equal(results.complete, false);
  assert.deepEqual(results.pagination, { next: actionFor(actions, '9'), current: 1 });
  assert.deepEqual(results.records[0], {
    id: 'r1', title: 'Oak standing desk', price: '$429.00', rating: 4.8, scale: 5, reviews: 321,
    fields: ['Adjustable frame · 140 cm'], open: actionFor(actions, '1'),
  });
  assert.ok(!results.records[0].fields.includes('$429.00'));
  assert.ok(!results.records[0].fields.includes('321 reviews'));
});

test('a capped or malformed state stays honest and bounded', async t => {
  const observation = await observe(t, 'receipts.html');
  observation.recordLists[0].total = 7;
  observation.recordLists[0].kept = 4;
  observation.recordsTruncated = true;
  observation.recordState = {
    resultCount: { value: -4 },
    sort: { label: 'Newest first', direction: 'sideways' },
    pagination: { current: 5, total: 2, next: { forged: true }, previous: true },
  };
  const results = compactPage(observation).results;
  assert.equal(results.resultCount, undefined);
  assert.deepEqual(results.sort, { label: 'Newest first' });
  assert.deepEqual(results.pagination, { previous: true });
  assert.equal(results.complete, false);
  assert.equal(results.total, 7);
  assert.equal(results.shown, 4);
});

test('ordinary run results keep their record digest; Agent-direct acts map only listed actions, idempotently', async t => {
  const observation = await observe(t, 'receipts.html');
  const page = compactPage(observation, 'oldest receipt');
  const ordinary = agentResult({ status: 'completed', code: 'expectation_passed', page });
  assert.equal(ordinary.page.results, undefined);
  assert.ok(ordinary.page.digest.some(line => line.includes('Northwind Office')));

  const actions = actionsOf(observation);
  const listed = actions.filter(action => action.target !== '3').map(action => action.id);
  const direct = agentResult({
    status: 'acted', code: 'step_complete', page,
    offer: { revision: observation.revision, actions, listed },
  });
  assert.equal(direct.page.results.records[0].open, undefined, 'an unlisted title action is not smuggled into the rows');
  assert.equal(direct.page.results.records[1].open, actionFor(actions, '5'));
  assert.ok(!direct.page.digest.some(line => line.includes('City Cycle Works')));
  assert.deepEqual(agentResult(direct), direct);
});

test('projected rows stay within a character budget, retain metadata and leave digest fallbacks', async t => {
  const observation = await observe(t, 'long-list.html');
  const variants = new Map([[3, structuredClone(observation)], [25, observation], [60, structuredClone(observation)]]);
  for (const [count, page] of variants) {
    if (count === 3) {
      page.records = page.records.slice(0, 3);
      page.recordLists = [{ list: 0, total: 3, kept: 3, afterCount: true }];
      page.recordState = { resultCount: { value: 3 } };
    } else if (count === 60) {
      page.records = Array.from({ length: 60 }, (_, i) => ({
        ...observation.records[i % 25], id: `r${i + 1}`, title: `Backend engineer ${i + 1}`,
      }));
      page.recordLists = [{ list: 0, total: 60, kept: 60, afterCount: true }];
      page.recordState = { resultCount: { value: 60 } };
    }
    const lean = project(page, actionsOf(page), 'Find engineering jobs and their dates');
    const results = lean.page.results;
    const text = directText(lean);
    const rowChars = results.records.reduce((sum, record) => {
      const { id, ...row } = record;
      return sum + `result ${id}: ${JSON.stringify(row)}\n`.length;
    }, 0);
    assert.ok(rowChars <= 600, `${count} rows used ${rowChars} characters`);
    assert.ok(text.length < 3500, `${count} rows produced ${text.length} characters`);
    assert.equal(results.total, count);
    assert.equal(results.resultCount.value, count);
    if (count === 3) {
      assert.equal(results.shown, 3);
      assert.equal(results.complete, true);
      assert.equal(results.truncated, undefined);
    } else {
      assert.ok(results.shown > 0 && results.shown < count);
      assert.equal(results.truncated, true);
      assert.equal(results.complete, false);
      assert.match(text, /results: \d+ shown, \d+ rows on this page, \d+ results, incomplete, truncated/);
      const projected = new Set(results.records.map(record => record.id));
      const omitted = page.records.filter(record => !projected.has(record.id));
      assert.ok(omitted.some(record => lean.page.digest.some(line => line.includes(record.title))),
        'an omitted row remains available in the digest');
    }
  }

  const relevant = project(observation, actionsOf(observation), 'Backend engineer 10').page.results;
  const late = relevant.records.find(record => record.id === 'r10');
  assert.ok(late, 'a task-relevant later row survives the projection budget');
  assert.match(late.date, /Posted \d+ Sep/);
  assert.ok(late.open, 'the relevant row retains its offered open action');
});

test('complete requires an exact consistent global count and an unprojected primary list', async t => {
  const observation = await observe(t, 'receipts.html');
  observation.records = observation.records.slice(0, 3);
  observation.recordLists = [{ list: 0, total: 3, kept: 3 }];
  delete observation.recordState.pagination;
  for (const value of [0, 2, 3, 4]) {
    observation.recordState.resultCount = { value };
    assert.equal(recordResultsOf(observation).complete, value === 3, `global count ${value}`);
  }
  observation.recordState.resultCount = { value: 3, approximate: true };
  assert.equal(recordResultsOf(observation).complete, false, 'an approximate count cannot certify completeness');
  observation.recordState.resultCount = { value: 25 };
  observation.recordLists.push({ list: 1, total: 22, kept: 22 });
  assert.equal(recordResultsOf(observation).complete, false, 'secondary rows cannot reconcile the primary global count');
});

test('two independent lists keep their own sort and pagination state', async t => {
  const observation = await observe(t, 'independent-lists.html');
  assert.equal(observation.recordLists.length, 2);
  assert.match(observation.records.find(record => record.list === 0).title, /^Primary result/);
  assert.equal(observation.recordState.resultCount.value, 3);
  assert.deepEqual(observation.recordState.sort, { label: 'Primary order' });
  assert.equal(observation.recordState.pagination.current, 1);
  assert.equal(observation.recordState.pagination.total, 3);
  assert.ok(observation.recordState.pagination.next);
  assert.equal(observation.recordState.pagination.previous, undefined);
  assert.doesNotMatch(JSON.stringify(observation.recordState), /Secondary|7|9/);

  const actions = actionsOf(observation);
  const results = project(observation, actions).page.results;
  assert.equal(results.total, 3);
  assert.equal(results.shown, 3);
  assert.equal(results.complete, false);
  assert.deepEqual(results.sort, { label: 'Primary order' });
  assert.equal(results.pagination.next, actions.find(action => action.label === 'Next' && action.href?.includes('/primary')).id);
});


test('a count above the primary module does not import a secondary sort or previous-page link', async t => {
  const observation = await observe(t, 'independent-lists.html', html => html
    .replace('<p>3 results</p>', '')
    .replace('<main>', '<p>3 results</p><main>')
    .replace(/<label>Sort by <select><option selected>Primary order[\s\S]*?<\/label>/, ''));
  assert.match(observation.records.find(record => record.list === 0).title, /^Primary result/);
  assert.equal(observation.recordState.resultCount.value, 3);
  assert.equal(observation.recordState.sort, undefined, 'the secondary sort is not the primary sort');
  assert.equal(observation.recordState.pagination.previous, undefined, 'the secondary Previous is not primary pagination');
  const next = observation.controls.find(control => control.id === observation.recordState.pagination.next);
  assert.equal(next.href, 'https://example.com/primary?page=2');
  assert.equal(observation.recordState.pagination.current, 1);
  assert.equal(observation.recordState.pagination.total, 3);
});

test('qualified result counts preserve uncertainty instead of certifying a complete list', async t => {
  for (const count of ['About 3 results', 'Approximately 3 results', 'Over 3 results', 'At least 3 results', 'Up to 3 results', 'Under 3 results', '3+ results']) {
    const observation = await observe(t, 'independent-lists.html', html => html
      .replace('<p>3 results</p>', `<p>${count}</p>`)
      .replace(/<nav[\s\S]*?<\/nav>/g, ''));
    assert.deepEqual(observation.recordState.resultCount, { value: 3, approximate: true }, count);
    assert.equal(recordResultsOf(observation).complete, false, count);
    const text = directText(project(observation));
    assert.match(text, /approximately 3 results, incomplete/, count);
    assert.doesNotMatch(text, /^results:.*3\+ results/m, 'an approximate count is not necessarily a lower bound');
  }
});
