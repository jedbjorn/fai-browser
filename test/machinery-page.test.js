// Machinery pass, items 4-6 in extension/page.js (headless Chromium): same-origin iframes read into blocks, text and
// controls with ids act can resolve (and cross-origin frames listed as cross_origin_frame), custom role=option
// dropdowns offered once open (the listbox container never), and the document's HTTP status for error pages.
// CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const SIZES = await readFile(new URL('../fixtures/qa/select/sizes.html', import.meta.url), 'utf8');
const SETTLE = { quietMs: 60, capMs: 1500 };

let browser;
test.before(async () => {
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'],
    });
  } catch {
    browser = null;
  }
});
test.after(() => browser?.close());

const doc = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Serves `routes` (path -> html or {status, body}) on https://example.com and https://other.test, opens `path`. */
async function open(t, routes, path = '/') {
  if (!browser) {
    t.skip('no Chromium');
    return null;
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  const serve = async route => {
    const url = new URL(route.request().url());
    const entry = routes[url.origin + url.pathname] ?? routes[url.pathname];
    if (entry === undefined) return route.fulfill({ status: 404, contentType: 'text/html', body: doc('Missing', 'missing') });
    const { status = 200, body } = typeof entry === 'string' ? { body: entry } : entry;
    return route.fulfill({ status, contentType: 'text/html', body });
  };
  await page.route('https://example.com/**', serve);
  await page.route('https://other.test/**', serve);
  await page.goto(`https://example.com${path}`);
  await page.addScriptTag({ path: PAGE_SCRIPT });
  return page;
}

const observe = page => page.evaluate(() => __faiPage.observe());
const execute = (page, action, revision) => page.evaluate(
  ([a, r, s]) => __faiPage.execute(a, r, s), [action, revision, SETTLE],
);

const TRACKER = {
  '/': doc('Shipment tracker', '<h1>Shipment tracker</h1><p>Details below.</p><a href="/help">Help</a>'
    + '<iframe src="/panel" title="Shipment details" width="640" height="260" style="border:1px solid #ccc"></iframe>'
    + '<p>Footer</p>'),
  '/panel': doc('Panel', '<h2>Shipment details</h2><p>Warehouse code: WH-5530</p>'
    + '<button type="button" onclick="document.getElementById(\'s\').textContent=\'Status: Picked up\'">Mark seen</button>'
    + '<p id="s">Status: Awaiting pickup</p><a href="/carrier" target="_top">Open carrier page</a>'),
  '/carrier': doc('Carrier', '<h1>Carrier</h1><p>Carrier: Saltmarsh Freight</p>'),
};

test('same-origin iframe: blocks, text and controls (ids continue the page sequence, frame index set)', async t => {
  const page = await open(t, TRACKER);
  if (!page) return;
  const observation = await observe(page);
  const texts = observation.blocks.map(block => block.text);
  assert.ok(texts.includes('Warehouse code: WH-5530'), JSON.stringify(texts));
  assert.match(observation.text, /WH-5530/);
  const ids = observation.controls.map(control => control.id);
  assert.deepEqual(ids, ids.map((_, i) => String(i + 1)), 'one numeric id sequence');
  const frameControls = observation.controls.filter(control => control.frame === 1);
  assert.deepEqual(frameControls.map(control => control.label), ['Mark seen', 'Open carrier page']);
  assert.ok(!observation.controls.find(control => control.label === 'Help').frame);
  const carrier = frameControls[1];
  assert.equal(carrier.href, 'https://example.com/carrier');
  assert.equal(carrier.linkTarget, '_top');
  // Bounds are in the top viewport: inside the iframe's box, not at the frame's own origin.
  assert.ok(carrier.bounds.y > 60, `bounds shifted into the page (${carrier.bounds.y})`);
  assert.ok(!(observation.warnings ?? []).includes('cross_origin_frame'));
});

test('act resolves a frame control id: a frame button runs in place, a target=_top link navigates the tab', async t => {
  const page = await open(t, TRACKER);
  if (!page) return;
  let observation = await observe(page);
  const button = observation.controls.find(control => control.label === 'Mark seen');
  const outcome = await execute(page, { type: 'click', target: button.id }, observation.revision);
  assert.ok(outcome.observation.blocks.some(block => block.text === 'Status: Picked up'));
  assert.notEqual(outcome.observation.revision, observation.revision);
  observation = outcome.observation;
  const link = observation.controls.find(control => control.label === 'Open carrier page');
  const navigation = page.waitForURL('https://example.com/carrier');
  const dispatched = await execute(page, { type: 'click', target: link.id }, observation.revision);
  assert.equal(dispatched.expectNavigation, true);
  await navigation;
});

test('cross-origin iframes are skipped silently and listed as the cross_origin_frame warning', async t => {
  const page = await open(t, {
    '/': doc('Embed', '<h1>Embed</h1><iframe src="https://other.test/widget" width="400" height="200"></iframe>'),
    'https://other.test/widget': doc('Widget', '<p>Secret partner text</p><button>Partner button</button>'),
  });
  if (!page) return;
  await page.waitForTimeout(200);
  const observation = await observe(page);
  assert.ok(observation.warnings.includes('cross_origin_frame'));
  assert.ok(!observation.text.includes('Secret partner text'));
  assert.ok(!observation.controls.some(control => control.label === 'Partner button'));
  assert.ok(!observation.controls.some(control => control.frame));
});

test('custom dropdown: options are offered only once open; the listbox container is never a control', async t => {
  const page = await open(t, { '/select/sizes.html': SIZES }, '/select/sizes.html');
  if (!page) return;
  let observation = await observe(page);
  assert.ok(!observation.controls.some(control => control.role === 'option'), 'closed list: no options');
  assert.ok(!observation.controls.some(control => control.role === 'listbox'), 'the container is not offered');
  const trigger = observation.controls.find(control => control.label === 'Size: choose');
  let outcome = await execute(page, { type: 'click', target: trigger.id }, observation.revision);
  observation = outcome.observation;
  const options = observation.controls.filter(control => control.role === 'option');
  assert.deepEqual(options.map(control => control.label), ['S', 'M', 'L', 'XL']);
  for (const option of options) assert.equal(option.risk, 'reversible');
  assert.ok(observation.blocks.some(block => block.t === 'li' && block.text === 'L'), 'blocks show the open list');
  const large = options.find(control => control.label === 'L');
  outcome = await execute(page, { type: 'click', target: large.id }, observation.revision);
  assert.match(outcome.observation.text, /Size L: 3 left in stock/);
  assert.ok(!outcome.observation.controls.some(control => control.role === 'option'), 'the list closed again');
});

test('custom options: a destructive option label is refused; a stray role=option outside any list is ignored', async t => {
  const page = await open(t, {
    '/': doc('Menu', '<button aria-expanded="true" aria-controls="m">Actions</button>'
      + '<div id="m"><div role="option">Rename</div><div role="option">Delete project</div></div>'
      + '<span role="option">Orphan</span>'),
  });
  if (!page) return;
  const observation = await observe(page);
  const options = Object.fromEntries(observation.controls.filter(control => control.role === 'option')
    .map(control => [control.label, control.risk]));
  assert.deepEqual(options, { Rename: 'reversible', 'Delete project': 'delete' });
});

test('httpStatus: the document status is reported (200, 404, 503) while the URL is the loaded one', async t => {
  const page = await open(t, {
    '/': doc('Home', '<a href="/gone">Gone</a>'),
    '/gone': { status: 404, body: doc('Page not found', '<h1>404: Page not found</h1>') },
    '/broken': { status: 503, body: doc('Oops', '<p>Try later</p>') },
  });
  if (!page) return;
  assert.equal((await observe(page)).httpStatus, 200);
  await page.goto('https://example.com/gone');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  assert.equal((await observe(page)).httpStatus, 404);
  await page.goto('https://example.com/broken');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  assert.equal((await observe(page)).httpStatus, 503);
  // A same-document route change keeps the old navigation entry: the status no longer describes the URL.
  await page.evaluate(() => history.pushState({}, '', '/elsewhere'));
  assert.equal((await observe(page)).httpStatus, undefined);
});

// Review fixes (machinery pass): frame-only navigations, mixed shadow/frame ids, consent inside a frame.

const FRAMED_NAV = {
  '/': doc('Reader', '<h1>Reader</h1><iframe src="/toc" width="600" height="240"></iframe>'),
  '/toc': doc('TOC', '<p>Table of contents</p><a href="/chapter">Chapter one</a><a href="/slow">Slow chapter</a>'),
  '/chapter': doc('Chapter', '<p>Chapter one text: the lighthouse keeper</p>'),
};

test('a frame link without a target navigates only the frame: no tab navigation, the frame load is awaited', async t => {
  const page = await open(t, FRAMED_NAV);
  if (!page) return;
  await page.waitForTimeout(150);
  const observation = await observe(page);
  const chapter = observation.controls.find(control => control.label === 'Chapter one');
  assert.equal(chapter.frame, 1);
  const outcome = await execute(page, { type: 'click', target: chapter.id }, observation.revision);
  assert.equal(outcome.expectNavigation, false, 'the tab itself does not navigate');
  assert.equal(page.url(), 'https://example.com/');
  assert.match(outcome.observation.text, /the lighthouse keeper/);
});

test('a frame navigation that never loads is waited for at most the frame cap', async t => {
  if (!browser) return t.skip('no Chromium');
  const page = await open(t, FRAMED_NAV);
  if (!page) return;
  await page.route('https://example.com/slow', () => {}); // never answered
  await page.waitForTimeout(150);
  const observation = await observe(page);
  const slow = observation.controls.find(control => control.label === 'Slow chapter');
  const started = Date.now();
  const outcome = await execute(page, { type: 'click', target: slow.id }, observation.revision);
  const elapsed = Date.now() - started;
  assert.equal(outcome.expectNavigation, false);
  assert.ok(elapsed < 3000 + SETTLE.capMs + 1000, `bounded wait (${elapsed} ms)`);
  assert.ok(elapsed >= 2500, `the frame load was awaited (${elapsed} ms)`);
});

test('ids are stable across shadow roots and frames: act on a shadow control and a frame control in one page', async t => {
  const page = await open(t, {
    '/': doc('Mixed', '<h1>Mixed</h1><div id="host"></div><iframe src="/inner" width="500" height="160"></iframe>'
      + '<button onclick="this.textContent=\'Top done\'">Top button</button>'
      + '<script>const r=document.getElementById("host").attachShadow({mode:"open"});'
      + 'r.innerHTML=\'<button onclick="this.textContent=\\\'Shadow done\\\'">Shadow button</button>\';</script>'),
    '/inner': doc('Inner', '<button onclick="this.textContent=\'Frame done\'">Frame button</button>'),
  });
  if (!page) return;
  await page.waitForTimeout(150);
  let observation = await observe(page);
  const labels = observation.controls.map(control => control.label);
  assert.deepEqual(labels, ['Shadow button', 'Frame button', 'Top button']);
  assert.deepEqual(observation.controls.map(control => control.id), ['1', '2', '3']);
  let outcome = await execute(page, { type: 'click', target: '1' }, observation.revision);
  observation = outcome.observation;
  assert.deepEqual(observation.controls.map(control => control.label), ['Shadow done', 'Frame button', 'Top button']);
  outcome = await execute(page, { type: 'click', target: '2' }, observation.revision);
  assert.deepEqual(outcome.observation.controls.map(control => control.label), ['Shadow done', 'Frame done', 'Top button']);
  assert.equal(outcome.observation.controls[1].frame, 1);
});

test('a consent banner inside a same-origin frame: Accept all is never clickable, Reject all is the reject', async t => {
  const page = await open(t, {
    '/': doc('News', '<h1>News</h1><iframe src="/cmp" width="700" height="200"></iframe>'),
    '/cmp': doc('CMP', '<div role="dialog" aria-label="Cookies"><p>We use cookies to improve your experience.</p>'
      + '<button>Accept all</button><button>Reject all</button></div>'),
    '/plain': doc('Plain', '<button>Accept all</button>'),
  });
  if (!page) return;
  await page.waitForTimeout(150);
  const observation = await observe(page);
  const risks = Object.fromEntries(observation.controls.map(control => [control.label, control.risk]));
  assert.equal(risks['Accept all'], 'consent_accept');
  assert.ok(!['destructive', 'consent_accept'].includes(risks['Reject all']));
  assert.ok(observation.consent?.buttons.some(button => button.label === 'Reject all' && button.kind === 'reject'));
});

test('observe with frame reading stays under 200 ms on a Wikipedia-sized page with 8 link-heavy frames', async t => {
  const paragraph = i => `<p>Paragraph ${i} about the river basin ${Array.from({ length: 10 }, (_, j) =>
    `<a href="/wiki/T${i}_${j}">Term ${i}.${j}</a> with <b>bold</b> words`).join(', ')}.</p>`;
  const frames = Array.from({ length: 8 }, (_, i) => `<iframe src="/f${i}" width="300" height="120"></iframe>`).join('');
  const routes = {
    '/': doc('Tagus', `<h1>Tagus</h1>${frames}${Array.from({ length: 340 }, (_, i) => paragraph(i)).join('')}`
      + '<a href="/estuary">Estuary basin</a>'),
  };
  for (let i = 0; i < 8; i++) {
    routes[`/f${i}`] = doc(`F${i}`, Array.from({ length: 300 }, (_, j) => `<a href="/x/${i}/${j}">Frame ${i} link ${j}</a> `).join(''));
  }
  const page = await open(t, routes);
  if (!page) return;
  await page.waitForTimeout(400);
  const stats = await page.evaluate(() => {
    const times = [];
    let last;
    for (let i = 0; i < 9; i++) {
      const started = performance.now();
      last = globalThis.__faiPage.observe({ terms: ['estuary'] });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return { p50: times[4], count: last.controls.length, warnings: last.warnings,
      frames: new Set(last.controls.map(c => c.frame).filter(Boolean)).size,
      estuary: last.controls.findIndex(c => c.label === 'Estuary basin'),
      ids: last.controls.map(c => c.id) };
  });
  t.diagnostic(JSON.stringify({ p50: stats.p50, count: stats.count, frames: stats.frames }));
  assert.ok(stats.p50 < 200, `observe p50 ${stats.p50} ms`);
  assert.equal(stats.count, 100, 'the 100-control cap holds with frames');
  assert.ok(stats.warnings.includes('controls_capped'));
  assert.ok(stats.estuary >= 0, 'an off-screen top-document term match still wins a slot over frame links');
  assert.deepEqual(stats.ids, stats.ids.map((_, i) => String(i + 1)));
});

test('visually hidden status text is marked hidden; a visible or aria-live placeholder is not', async t => {
  // Live Google Flights keeps a screen-reader "Loading results" next to its rendered rows (gf-week-window, E1).
  const sr = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
  const page = await open(t, {
    '/': doc('Results', `<h1>Results</h1><p style="${sr}">Loading results</p>`
      + '<div style="clip-path:inset(50%);position:absolute"><p>Fetching results</p></div>'
      + '<p aria-live="polite">Loading…</p><ul><li>10:40 AM easyJet €104</li><li>11:25 AM Vueling €132</li></ul>'),
  });
  if (!page) return;
  const observation = await observe(page);
  const byText = text => observation.blocks.find(block => block.text === text);
  assert.equal(byText('Loading results')?.hidden, true, JSON.stringify(observation.blocks));
  assert.equal(byText('Fetching results')?.hidden, true);
  assert.equal(byText('Loading…')?.hidden, undefined);
  assert.equal(byText('Results')?.hidden, undefined);
});

test('a hidden status span inside a visible bar of buttons is marked hidden; visible text beside it is not', async t => {
  // Google Flights' toolbar holds its buttons and a screen-reader "Fetching results" span: the block is the visible
  // bar (the buttons' text is theirs), so the check follows the text to the span that owns it.
  const sr = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap';
  const page = await open(t, {
    '/': doc('Results', `<div style="display:flex;gap:8px"><button>Date grid</button><button>Price graph</button>`
      + `<span style="${sr}">Fetching results</span></div>`
      + `<div style="display:flex"><span style="${sr}">Loading</span><span>results for Paris</span></div>`
      + '<ul><li>10:40 AM easyJet €104</li><li>11:25 AM Vueling €132</li><li>1:05 PM Ryanair €61</li></ul>'),
  });
  if (!page) return;
  const observation = await observe(page);
  const byText = text => observation.blocks.find(block => block.text === text);
  assert.equal(byText('Fetching results')?.hidden, true, JSON.stringify(observation.blocks));
  assert.equal(byText('Loading results for Paris')?.hidden, undefined, JSON.stringify(observation.blocks));
});
