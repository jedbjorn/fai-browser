#!/usr/bin/env node
// bench/report/readme-chart.mjs: README benchmark chart, generated from the merged report data.
//
//   node bench/report/readme-chart.mjs [data.json] [--out dir]
//
// Writes <out>/benchmark-light.svg, <out>/benchmark-dark.svg and <out>/benchmark-table.md (default out: docs/assets).
// Hand-built SVG, no dependencies, no browser, no external resources (GitHub strips them from README images).
//
// Design choices (dataviz method):
// - Form: "before -> after per item" with one series as the point, so this is an EMPHASIS chart: the baseline
//   (Playwright MCP) in a de-emphasis gray, FAI Browser in the accent blue. Validated with the skill's palette
//   checker against GitHub's light (#ffffff) and dark (#0d1117) surfaces: CVD and normal-vision separation and
//   3:1 contrast pass; the gray's chroma-floor FAIL is intended (a de-emphasis gray is not a categorical slot).
// - Horizontal grouped bars, one row per host, so full host names, value labels at bar tips and a ratio label
//   per pair all fit without collisions; the host column is shared by every panel (small multiples by metric).
// - Wall time and tool calls share one linear axis across hosts (same unit, same order of magnitude).
// - Cost is INDEXED per host (Playwright MCP = 100%) because per-task prices differ ~100x between models
//   (Luna $0.002 vs Astra $0.19); a shared linear $ axis would make the cheap hosts invisible, and a log axis
//   would understate the per-host saving. Indexing to a common base is the method's answer to "different
//   scales, one comparison"; the actual dollar values are printed at each bar so nothing is hidden.
// - Every value is direct-labelled and the Markdown table is the table-view twin; text never wears the series color.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_DATA = join(ROOT, 'bench', 'report', 'out', 'all-hosts', 'data.json');
const DEFAULT_OUT = join(ROOT, 'docs', 'assets');

const THEMES = {
  light: {
    surface: '#ffffff', border: '#d1d9e0', primary: '#1f2328', secondary: '#59636e', muted: '#6e7781',
    grid: '#eaeef2', axis: '#c8d1da', baseline: '#94928b', fai: '#2a78d6',
  },
  dark: {
    surface: '#0d1117', border: '#30363d', primary: '#e6edf3', secondary: '#9198a1', muted: '#7d8590',
    grid: '#1c2129', axis: '#3d444d', baseline: '#6f6e68', fai: '#3987e5',
  },
};

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const VENDOR = { codex: 'Codex CLI', claude: 'Claude Code' };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Three significant figures, keeping trailing zeros ($0.00140, $0.0201, $0.189).
const usd = n => `$${n.toFixed(n > 0 ? Math.max(2, 2 - Math.floor(Math.log10(n))) : 2)}`;
const ratio = r => `${r.toFixed(2)}×`;

/** Pull the per-host rows the chart and table need out of a report data.json. */
export function chartRows(data) {
  return data.hosts.map(host => {
    const t = data.totals[host.id];
    const r = data.ratios[host.id];
    if (!t?.a || !t?.b || !r) throw new Error(`incomplete data for ${host.id}`);
    const per = (c, key) => t[c][key] / t[c].taskCount;
    return {
      id: host.id, name: host.name, vendor: VENDOR[host.vendor] ?? host.vendor,
      costBasis: t.b.costBasis,
      pass: { a: `${t.a.passed}/${t.a.attempted}`, b: `${t.b.passed}/${t.b.attempted}` },
      wall: { a: t.a.wallPerTask, b: t.b.wallPerTask, ratio: r.wall },
      cost: { a: t.a.costPerTask, b: t.b.costPerTask, ratio: r.cost },
      calls: { a: per('a', 'toolCalls'), b: per('b', 'toolCalls'), ratio: r.toolCalls },
    };
  });
}

const niceMax = (v, step) => Math.ceil(v / step) * step;

function barPath(x, y, w, h, r = 4) {
  // square at the baseline, 4px rounded data end
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}h${(w - rr).toFixed(2)}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 ${-rr},${rr}h${(-(w - rr)).toFixed(2)}z`;
}

/** Build one themed SVG. */
export function renderSvg(data, themeName = 'light') {
  const th = THEMES[themeName];
  const rows = chartRows(data);
  const W = 1200;
  const PAD = 32;
  const HOST_COL = 172;
  const GAP = 32;
  const TOP = 104;            // panel header baseline
  const ROWS_Y = 150;         // first row top
  const ROW_H = 58;
  const BAR_H = 16;
  const rowsBottom = ROWS_Y + rows.length * ROW_H;
  const RATIO_W = 108;

  const reps = data.expectedReps ?? 3;
  const n = data.taskIds.length;
  const panels = [
    {
      key: 'wall', title: 'Wall time per task', caption: 'seconds · shared axis', width: 320, labelW: 60,
      max: niceMax(Math.max(...rows.map(r => r.wall.a)), 10), ticks: 3, tick: v => `${v} s`,
      value: r => r.wall, fmt: v => `${v.toFixed(1)} s`, word: 'faster',
    },
    {
      key: 'cost', title: 'Cost per task', caption: '% of Playwright cost, indexed per host', width: 350, labelW: 68,
      max: 100, ticks: 2, tick: v => `${v}%`,
      value: r => ({ a: 100, b: 100 * r.cost.b / r.cost.a, ratio: r.cost.ratio, rawA: r.cost.a, rawB: r.cost.b }),
      fmt: (v, which, val) => usd(which === 'a' ? val.rawA : val.rawB), word: 'cheaper',
    },
    {
      key: 'calls', title: 'Tool calls per task', caption: 'host-visible calls', width: 0, labelW: 40,
      max: niceMax(Math.max(...rows.map(r => r.calls.a)), 2), ticks: 3, tick: v => `${v}`,
      value: r => r.calls, fmt: v => v.toFixed(1), word: 'fewer',
    },
  ];
  let x = PAD + HOST_COL;
  panels[2].width = W - PAD - x - panels[0].width - panels[1].width - 2 * GAP;
  for (const p of panels) { p.x = x; x += p.width + GAP; p.barMax = p.width - RATIO_W - p.labelW; }

  const out = [];
  const H = rowsBottom + 104;
  const titleId = `t-${themeName}`;
  const descId = `d-${themeName}`;
  const desc = rows.map(r => `${r.name}: wall ${r.wall.a.toFixed(1)} s to ${r.wall.b.toFixed(1)} s (${ratio(r.wall.ratio)} faster), cost ${usd(r.cost.a)} to ${usd(r.cost.b)} (${ratio(r.cost.ratio)} cheaper), tool calls ${r.calls.a.toFixed(1)} to ${r.calls.b.toFixed(1)}`).join('; ');

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${titleId} ${descId}">`);
  out.push(`<title id="${titleId}">FAI Browser vs Playwright MCP: per-task wall time, cost and tool calls for six host models</title>`);
  out.push(`<desc id="${descId}">${esc(desc)}.</desc>`);
  out.push(`<style>text{font-family:${FONT};fill:${th.secondary}}.p{fill:${th.primary}}.m{fill:${th.muted}}.b{font-weight:600}.n{font-variant-numeric:tabular-nums}</style>`);
  out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${th.surface}" stroke="${th.border}"/>`);

  // Header
  out.push(`<text x="${PAD}" y="46" class="p b" font-size="22">FAI Browser vs Playwright MCP</text>`);
  out.push(`<text x="${PAD}" y="72" font-size="14">${n} read-only fixture tasks · per-task medians of ${reps} repeats · six host models · ${esc(data.date)} · shorter bars are better</text>`);
  // Legend (top right)
  const legend = [['Playwright MCP (baseline)', th.baseline], ['FAI Browser', th.fai]];
  let lx = W - PAD;
  const legendItems = [];
  for (const [label, color] of legend.slice().reverse()) {
    const w = label.length * 7.4 + 22;
    lx -= w;
    legendItems.unshift(`<rect x="${lx.toFixed(1)}" y="35" width="14" height="14" rx="3" fill="${color}"/><text x="${(lx + 20).toFixed(1)}" y="47" class="p" font-size="13">${esc(label)}</text>`);
    lx -= 18;
  }
  out.push(...legendItems);

  // Panel headers, gridlines, ticks
  for (const p of panels) {
    out.push(`<text x="${p.x}" y="${TOP + 12}" class="p b" font-size="15">${esc(p.title)}</text>`);
    out.push(`<text x="${p.x}" y="${TOP + 31}" font-size="13">${esc(p.caption)}</text>`);
    for (let i = 0; i <= p.ticks; i++) {
      const v = p.max * i / p.ticks;
      const gx = p.x + p.barMax * i / p.ticks;
      out.push(`<line x1="${gx.toFixed(1)}" y1="${ROWS_Y - 4}" x2="${gx.toFixed(1)}" y2="${rowsBottom}" stroke="${i === 0 ? th.axis : th.grid}" stroke-width="1"/>`);
      out.push(`<text x="${gx.toFixed(1)}" y="${rowsBottom + 16}" class="m n" font-size="12" text-anchor="${i === 0 ? 'start' : 'middle'}">${esc(p.tick(Math.round(v)))}</text>`);
    }
  }

  // Rows
  rows.forEach((row, i) => {
    const top = ROWS_Y + i * ROW_H;
    if (i > 0) out.push(`<line x1="${PAD}" y1="${top}" x2="${W - PAD}" y2="${top}" stroke="${th.grid}" stroke-width="1"/>`);
    out.push(`<text x="${PAD}" y="${top + 26}" class="p b" font-size="15">${esc(row.name)}</text>`);
    out.push(`<text x="${PAD}" y="${top + 44}" class="m" font-size="13">${esc(row.vendor)} · ${row.costBasis === 'list' ? 'list price' : 'API-equivalent'}</text>`);
    for (const p of panels) {
      const val = p.value(row);
      const bars = [['a', top + 9, th.baseline], ['b', top + 9 + BAR_H + 2, th.fai]];
      for (const [which, y, color] of bars) {
        const w = Math.max(2, p.barMax * val[which] / p.max);
        out.push(`<path d="${barPath(p.x, y, w, BAR_H)}" fill="${color}"/>`);
        const cls = which === 'b' ? 'p b n' : 'n';
        out.push(`<text x="${(p.x + w + 6).toFixed(1)}" y="${y + 12.5}" class="${cls}" font-size="13">${esc(p.fmt(val[which], which, val))}</text>`);
      }
      out.push(`<text x="${p.x + p.width}" y="${top + 34}" font-size="14" text-anchor="end"><tspan class="p b n">${ratio(val.ratio)}</tspan> ${p.word}</text>`);
    }
  });

  // Footnotes
  const passNote = rows.map(r => r.pass.a !== `${r.pass.a.split('/')[1]}/${r.pass.a.split('/')[1]}` ? `${r.name.split(' ').pop()} ${r.pass.a}` : null).filter(Boolean);
  const allB = rows.every(r => r.pass.b.split('/')[0] === r.pass.b.split('/')[1]);
  const fy = rowsBottom + 50;
  out.push(`<text x="${PAD}" y="${fy}" font-size="13">Pass rate: FAI Browser ${allB ? 'passes every repeat on every host' : 'see table'}${passNote.length ? `; Playwright MCP also passes all except ${esc(passNote.join(', '))}` : ''}. Ratios are Playwright ÷ FAI on the same tasks.</text>`);
  out.push(`<text x="${PAD}" y="${fy + 22}" font-size="13">Codex costs are API-equivalent, not subscription charges; Claude costs are list prices (${esc(data.prices?.date ?? data.date)}). Cost is indexed per host: prices differ ~100× between models.</text>`);
  out.push('</svg>');
  return out.join('\n') + '\n';
}

/** Compact Markdown table (the chart's table view). */
export function renderTable(data) {
  const rows = chartRows(data);
  const lines = [
    '| Host | Pass (Playwright → FAI) | Wall s/task (Playwright → FAI) | Speedup | $/task (Playwright → FAI) | Cheaper |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.name} | ${r.pass.a} → ${r.pass.b} | ${r.wall.a.toFixed(1)} → ${r.wall.b.toFixed(1)} | ${ratio(r.wall.ratio)} | ${usd(r.cost.a)} → ${usd(r.cost.b)} | ${ratio(r.cost.ratio)} |`),
  ];
  const reps = data.expectedReps ?? 3;
  return `<!-- generated by bench/report/readme-chart.mjs from bench/report/out/all-hosts/data.json; do not edit by hand -->\n${lines.join('\n')}\n\n`
    + `${data.taskIds.length} read-only fixture tasks, per-task medians of ${reps} repeats, ${data.date}. Codex costs are API-equivalent; Claude costs are list prices. Each host is priced separately; no cross-model average is implied.\n`;
}

export function writeAll(dataPath = DEFAULT_DATA, outDir = DEFAULT_OUT) {
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  mkdirSync(outDir, { recursive: true });
  const files = {
    'benchmark-light.svg': renderSvg(data, 'light'),
    'benchmark-dark.svg': renderSvg(data, 'dark'),
    'benchmark-table.md': renderTable(data),
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(outDir, name), body);
  return Object.keys(files).map(name => join(outDir, name));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  let out = DEFAULT_OUT;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = resolve(args[++i]);
    else if (args[i] === '--table') { /* the table is always written; flag accepted for clarity */ }
    else rest.push(args[i]);
  }
  const written = writeAll(rest[0] ? resolve(rest[0]) : DEFAULT_DATA, out);
  for (const file of written) console.log(file);
}
