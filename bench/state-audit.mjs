#!/usr/bin/env node
// What the data path loses: for a URL, a fixture or a saved trace, compare what the page holds with what the page
// script observes, what Jev receives (providerPage) and what the host digest keeps, and count the facts a task could
// need that the observation cannot recover (SVG/canvas content, table header relationships, glued list rows,
// off-viewport content, iframes, aria-live regions, aria-hidden text, images with alt only).
//
//   node bench/state-audit.mjs fixtures/flights.html https://en.wikipedia.org/wiki/Tagus
//   node bench/state-audit.mjs --task "cheapest day in the price graph" --click "Price graph" <url>
//   node bench/state-audit.mjs --page-script /tmp/old-page.js fixtures/state-views.html   # compare page.js versions
//   node bench/state-audit.mjs artifacts/<run>/trace.json     # offline: observation-side numbers only
//
// Options: --task TEXT (digest question; default ''), --level LEVEL (offer cap; default interactive), --click LABEL
// (click a button or tab with that accessible name before auditing, repeatable; your own headless browser only),
// --reject-consent (click a consent wall's "Reject all" first), --wait MS (after load; default 2500), --json,
// --page-script PATH (default extension/page.js), --runs N (observe latency samples; default 9).
// Read-only by design: it never submits, signs in or types. Live pages: public pages only, no sign-in.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { buildDigest } from '../src/digest.js';
import { providerPage } from '../src/typesafe.js';
import { offerCap } from '../src/relevance.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const opts = { task: '', level: 'interactive', clicks: [], rejectConsent: false, wait: 2500, json: false,
  pageScript: path.join(ROOT, 'extension/page.js'), runs: 9 };
const targets = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--task') opts.task = args[++i];
  else if (arg === '--level') opts.level = args[++i];
  else if (arg === '--click') opts.clicks.push(args[++i]);
  else if (arg === '--reject-consent') opts.rejectConsent = true;
  else if (arg === '--wait') opts.wait = Number(args[++i]);
  else if (arg === '--json') opts.json = true;
  else if (arg === '--page-script') opts.pageScript = path.resolve(args[++i]);
  else if (arg === '--runs') opts.runs = Number(args[++i]);
  else targets.push(arg);
}
if (!targets.length) {
  console.error('usage: node bench/state-audit.mjs [options] <url | fixture.html | trace.json> ...');
  process.exit(2);
}

// The independent census, run in the page: what is there, by the DOM, without the page script.
function census() {
  const vw = innerWidth;
  const vh = innerHeight;
  const inView = r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const shown = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }));
  };
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const area = el => {
    const r = el.getBoundingClientRect();
    return Math.round(r.width * r.height);
  };
  // Text: whole page (rendered) and the viewport part.
  let all = 0;
  let viewport = 0;
  let ariaHidden = 0;
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = clean(node.nodeValue);
    if (!text || !parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
    if (parent.checkVisibility && !parent.checkVisibility({ visibilityProperty: true })) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    all += text.length + 1;
    if (inView(rect)) viewport += text.length + 1;
    if (parent.closest('[aria-hidden="true"]')) ariaHidden += text.length + 1;
  }
  const controlSelector = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=combobox],'
    + '[role=listbox],[role=textbox],[role=checkbox],[role=radio],[role=option],[role=tab],[role=switch],[role=menuitem]';
  const controls = Array.from(document.querySelectorAll(controlSelector)).filter(shown);
  const svgs = Array.from(document.querySelectorAll('svg')).filter(el => shown(el) && area(el) >= 20000 && !el.parentElement?.closest('svg'));
  const svgItems = svgs.map(svg => {
    const parts = [];
    for (const el of svg.querySelectorAll('text,title,desc,[aria-label]')) {
      const t = el.tagName.toLowerCase() === 'text' || el.tagName.toLowerCase() === 'title' || el.tagName.toLowerCase() === 'desc'
        ? clean(el.textContent) : clean(el.getAttribute('aria-label'));
      if (t) parts.push(t);
    }
    const marks = svg.querySelectorAll('path,rect,circle,polyline,line').length;
    return { text: parts, marks, area: area(svg), inView: inView(svg.getBoundingClientRect()) };
  });
  const canvases = Array.from(document.querySelectorAll('canvas')).filter(el => shown(el) && area(el) >= 20000);
  const images = Array.from(document.querySelectorAll('img')).filter(el => shown(el) && area(el) >= 20000);
  // Tables and ARIA grids: data cells with a column header (and a row header for 2D tables).
  const grids = Array.from(document.querySelectorAll('table,[role=grid],[role=table],[role=treegrid]'))
    .filter(el => shown(el) && !el.parentElement?.closest('table,[role=grid],[role=table],[role=treegrid]'));
  const pairs = [];
  let gridCells = 0;
  let twoD = 0;
  for (const grid of grids) {
    const aria = grid.tagName !== 'TABLE';
    const rows = aria ? Array.from(grid.querySelectorAll('[role=row]')) : Array.from(grid.rows);
    const cellsOf = row => (aria ? Array.from(row.querySelectorAll('[role=gridcell],[role=cell],[role=columnheader],[role=rowheader]'))
      : Array.from(row.cells));
    const isHeader = cell => cell.tagName === 'TH' || /columnheader|rowheader/.test(cell.getAttribute('role') || '');
    let header = null;
    let hasRowHeader = false;
    for (const row of rows) {
      const cells = cellsOf(row);
      if (!cells.length) continue;
      if (!header && cells.every(isHeader)) {
        header = cells.map(cell => clean(cell.textContent || cell.getAttribute('aria-label')));
        continue;
      }
      const rowHeaderCell = cells.find(cell => (cell.tagName === 'TH' && cell.getAttribute('scope') !== 'col') || cell.getAttribute('role') === 'rowheader');
      if (rowHeaderCell) hasRowHeader = true;
      cells.forEach((cell, index) => {
        if (cell === rowHeaderCell) return;
        gridCells++;
        const value = clean(cell.textContent) || clean(cell.getAttribute('aria-label'));
        if (!value || !header?.[index] || pairs.length >= 400) return;
        pairs.push({ col: header[index], row: rowHeaderCell ? clean(rowHeaderCell.textContent) : null, value });
      });
    }
    if (hasRowHeader && header) twoD++;
  }
  const items = Array.from(document.querySelectorAll('li,[role=listitem],[role=row],article')).filter(shown);
  const frames = Array.from(document.querySelectorAll('iframe,frame')).filter(shown);
  let crossFrames = 0;
  for (const frame of frames) {
    try {
      if (!frame.contentDocument) crossFrames++;
    } catch {
      crossFrames++;
    }
  }
  const live = Array.from(document.querySelectorAll('[aria-live]:not([aria-live="off"]),[role=status],[role=log],[role=timer],[role=marquee]'));
  return {
    textAll: all, textViewport: viewport, ariaHidden,
    controlsAll: controls.length, controlsInView: controls.filter(el => inView(el.getBoundingClientRect())).length,
    svg: svgItems, canvas: canvases.map(el => ({ area: area(el), label: clean(el.getAttribute('aria-label')), role: el.getAttribute('role') })),
    images: images.map(el => ({ area: area(el), alt: clean(el.alt) })),
    grids: grids.length, gridCells, twoD, pairs,
    items: items.length,
    frames: frames.length, crossFrames,
    live: live.length, liveChars: live.reduce((sum, el) => sum + clean(el.textContent).length, 0),
  };
}

function lower(s) {
  return String(s ?? '').toLowerCase();
}

// What the observation recovers of the census facts.
function recover(observation, facts) {
  const blocks = observation.blocks ?? [];
  const blockText = blocks.map(block => lower(block.text));
  const joined = blockText.join('\n');
  const svgTokens = facts.svg.flatMap(item => item.text);
  const svgFound = svgTokens.filter(token => joined.includes(lower(token))).length;
  // A header relationship is recovered when one block holds the value with its column header (and row header).
  let paired = 0;
  for (const pair of facts.pairs) {
    const hit = blockText.some(text => text.includes(lower(pair.value)) && text.includes(lower(pair.col))
      && (!pair.row || text.includes(lower(pair.row))));
    if (hit) paired++;
  }
  const glue = /[a-z][A-Z]|[a-z]\d|\d(?:AM|PM)[A-Z]|[a-zA-Z][€$£]\d/;
  const rowBlocks = blocks.filter(block => block.t === 'li' || block.t === 'tr');
  const glued = rowBlocks.filter(block => glue.test(block.text)).length;
  const offscreenChars = blocks.filter(block => block.offscreen).reduce((sum, block) => sum + block.text.length, 0);
  return { svgTokens: svgTokens.length, svgFound, pairs: facts.pairs.length, paired, rowBlocks: rowBlocks.length, glued, offscreenChars };
}

function observationSide(observation, task, level) {
  const { digest } = buildDigest(observation, task);
  const jev = providerPage(observation);
  return {
    obsText: String(observation.text ?? '').length,
    textTruncated: observation.textTruncated === true,
    blocks: (observation.blocks ?? []).length,
    blockChars: (observation.blocks ?? []).reduce((sum, block) => sum + block.text.length, 0),
    blocksTruncated: observation.blocksTruncated === true,
    digestBlocks: digest.length,
    digestChars: digest.reduce((sum, block) => sum + block.text.length, 0),
    jevText: jev.text.length,
    jevControls: jev.controls.length,
    controlsObserved: (observation.controls ?? []).length,
    controlsDropped: observation.controlsDropped ?? 0,
    offered: Math.min((observation.controls ?? []).length, offerCap(level)),
    warnings: (observation.warnings ?? []).join(','),
    unreadable: (observation.unreadable ?? []).map(region => `${region.kind}${region.label ? `(${region.label.slice(0, 30)})` : ''}`).join(', '),
  };
}

async function auditPage(browser, target) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
  try {
    let url = target;
    if (!/^https?:/.test(target)) {
      const file = path.resolve(target);
      const base = path.dirname(file);
      await page.route('https://fixture.test/**', async route => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
        const candidate = path.join(base, rel || path.basename(file));
        if (!candidate.startsWith(base) || !existsSync(candidate)) return route.fulfill({ status: 404, body: 'not found' });
        const type = candidate.endsWith('.html') ? 'text/html' : candidate.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        return route.fulfill({ contentType: type, body: await readFile(candidate) });
      });
      url = `https://fixture.test/${path.basename(file)}`;
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(/^https?:/.test(target) ? opts.wait : 200);
    if (opts.rejectConsent && /consent\./.test(page.url())) {
      await page.getByRole('button', { name: /reject all/i }).first().click().catch(() => {});
      await page.waitForTimeout(opts.wait);
    }
    for (const label of opts.clicks) {
      let control = page.getByRole('button', { name: label, exact: true }).first();
      if (!(await control.count())) control = page.getByRole('tab', { name: label, exact: true }).first();
      await control.click({ timeout: 5000 }).catch(error => console.error(`click ${label}: ${error.message.split('\n')[0]}`));
      await page.waitForTimeout(opts.wait);
    }
    // Evaluated like the extension's executeScript (Trusted Types pages refuse an injected <script> tag).
    await page.evaluate(await readFile(opts.pageScript, 'utf8'));
    const terms = opts.task.toLowerCase().split(/\W+/).filter(word => word.length >= 3);
    const timing = await page.evaluate(({ runs, terms }) => {
      const times = [];
      for (let i = 0; i < runs; i++) {
        const started = performance.now();
        globalThis.__faiPage.observe({ terms });
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return { p50: +times[Math.floor(runs / 2)].toFixed(1), max: +times[runs - 1].toFixed(1),
        elements: document.getElementsByTagName('*').length };
    }, { runs: opts.runs, terms });
    const observation = await page.evaluate(terms => globalThis.__faiPage.observe({ terms }), terms);
    const facts = await page.evaluate(census);
    return { target, url: page.url(), timing, facts, side: observationSide(observation, opts.task, opts.level),
      recovered: recover(observation, facts), observation };
  } finally {
    await page.close();
  }
}

async function auditTrace(target) {
  const trace = JSON.parse(await readFile(target, 'utf8'));
  const observation = trace.finalObservation ?? trace.page;
  if (!observation?.controls) throw new Error(`${target}: no final observation with controls`);
  return { target, url: observation.url, timing: null, facts: null, side: observationSide(observation, opts.task, opts.level),
    recovered: recover(observation, { svg: [], pairs: [] }), observation };
}

function row(result) {
  const { side, facts, recovered, timing } = result;
  const name = result.target.replace(/^https?:\/\/(www\.)?/, '').replace(ROOT + '/', '').slice(0, 42);
  const f = facts;
  const svgText = f ? `${f.svg.length} svg/${f.svg.reduce((s, i) => s + i.text.length, 0)} txt/${f.svg.reduce((s, i) => s + i.marks, 0)} marks; found ${recovered.svgFound}/${recovered.svgTokens}` : 'n/a';
  return [
    name,
    f ? `${f.textAll}/${f.textViewport}` : 'n/a',
    `${side.obsText}${side.textTruncated ? '+' : ''}`,
    side.jevText,
    `${side.digestBlocks}/${side.digestChars}`,
    `${side.blocks}${side.blocksTruncated ? '+' : ''}`,
    f ? `${f.controlsAll}/${f.controlsInView}` : 'n/a',
    `${side.controlsObserved}${side.controlsDropped ? `(-${side.controlsDropped})` : ''}/${side.jevControls}/${side.offered}`,
    svgText,
    f ? `${f.canvas.length}` : 'n/a',
    f ? `${f.grids}/${f.twoD} 2D; hdr ${recovered.paired}/${recovered.pairs}` : 'n/a',
    `${recovered.glued}/${recovered.rowBlocks}`,
    f ? `${Math.max(0, f.textAll - f.textViewport)}/${recovered.offscreenChars}` : 'n/a',
    f ? `${f.frames}/${f.crossFrames}x` : 'n/a',
    f ? `${f.live}/${f.liveChars}` : 'n/a',
    f ? f.ariaHidden : 'n/a',
    f ? `${f.images.length}` : 'n/a',
    side.unreadable || '-',
    timing ? `${timing.p50}/${timing.elements}` : 'n/a',
  ];
}

const HEADER = ['page', 'text all/view', 'obs text', 'jev text', 'digest n/chars', 'blocks', 'ctrl all/view',
  'ctrl obs/jev/offer', 'svg (text/marks; in blocks)', 'canvas', 'tables (hdr pairs kept)', 'glued rows', 'offscreen chars/kept',
  'iframes', 'live n/chars', 'aria-hidden chars', 'big img', 'unreadable', 'observe p50 ms/elements'];

const browser = targets.some(target => !target.endsWith('.json'))
  ? await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(),
    args: ['--no-sandbox', '--lang=en-US'] })
  : null;
const results = [];
try {
  for (const target of targets) {
    try {
      results.push(target.endsWith('.json') ? await auditTrace(target) : await auditPage(browser, target));
    } catch (error) {
      console.error(`${target}: ${error.message.split('\n')[0]}`);
    }
  }
} finally {
  await browser?.close();
}
if (opts.json) {
  console.log(JSON.stringify(results.map(({ observation, ...rest }) => rest), null, 1));
} else {
  console.log(`| ${HEADER.join(' | ')} |`);
  console.log(`|${HEADER.map(() => '---').join('|')}|`);
  for (const result of results) console.log(`| ${row(result).join(' | ')} |`);
}
