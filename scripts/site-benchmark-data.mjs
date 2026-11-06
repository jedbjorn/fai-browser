#!/usr/bin/env node
// Build the marketing site's benchmark data files from checked-in bench results.
//
//   node scripts/site-benchmark-data.mjs [--agent-summary PATH] [--jev-data PATH]
//
// Writes:
//   site/media/benchmark-data.json        Agent direct chart (paired bars, schemaVersion 2)
//   site/media/jev-matrix-data.json       Jev autopilot chart (per-host ratio bars, schemaVersion 2)
//   site/media/benchmark-agentdirect.svg  Static fallback for the Agent direct chart
//   site/media/jev-matrix.svg             Static fallback for the Jev chart
//
// Sources:
//   Agent direct: a bench/compare.mjs summary.json run on bench/showcase/tasks.json (Agent direct B condition)
//   Jev:          bench/results/jev-comparison-2026-11-06.json (Sol text + Claude visual comparison)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const AGENT_SUMMARY = resolve(ROOT, opt('agent-summary', 'bench/results/site-agentdirect-optimized-2026-11-06/summary.json'));
const JEV_DATA = resolve(ROOT, opt('jev-data', 'bench/results/jev-comparison-2026-11-06.json'));
const OUT_DIR = resolve(ROOT, 'site/media');

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const round = (n, digits = 1) => Number(n.toFixed(digits));
const usd = n => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;
const kfmt = n => (n >= 10000 ? `${round(n / 1000, 1)}k` : `${Math.round(n)}`);

// ---------------------------------------------------------------------------
// Agent direct (paired bars)
// ---------------------------------------------------------------------------

function buildAgentDirect(summary) {
  const host = summary.meta.hosts[0];
  const a = summary.totals[`a/${host}`];
  const b = summary.totals[`b/${host}`];
  if (!a || !b) throw new Error(`summary is missing a/b totals for ${host}`);
  const tasks = summary.meta.tasks;
  const per = (t, key) => t[key] / t.tasks;
  const pw = summary.meta.playwrightMcp?.version;
  const faiExt = summary.meta.fai?.extensionVersion;

  const metric = (id, label, unit, ta, tb, digits, fmt) => ({
    id, label, unit,
    a: { value: round(ta, digits), display: fmt(ta) },
    b: { value: round(tb, digits), display: fmt(tb) },
  });

  return {
    schemaVersion: 2,
    kind: 'paired',
    status: 'complete',
    label: `${tasks.length} common workflows · ${summary.meta.repeat} repeats each · two safety scenarios excluded`,
    run: {
      model: 'Sol 6.1 medium (Codex CLI)',
      driver: 'Agent direct',
      protocol: 'Fresh agent per task · host harness · local fixtures',
      taskCount: tasks.length,
      repeats: summary.meta.repeat,
      attempted: a.attempted,
      matchedTasks: Math.min(a.passed, b.passed),
      measuredAt: summary.meta.finishedAt,
      source: AGENT_SUMMARY.slice(ROOT.length + 1),
    },
    series: {
      a: `Playwright MCP${pw ? ` ${pw}` : ''}`,
      b: `FAI Agent direct${faiExt ? ` ${faiExt}` : ''}`,
    },
    metrics: [
      {
        id: 'passes', label: 'Task checks passed', unit: 'runs',
        a: { value: a.passed, display: `${a.passed} / ${a.attempted}` },
        b: { value: b.passed, display: `${b.passed} / ${b.attempted}` },
      },
      metric('wall', 'Wall time per task', 's', per(a, 'wallS'), per(b, 'wallS'), 1, v => `${round(v, 1)} s`),
      metric('tokens', 'Raw model tokens per task', 'tokens', per(a, 'tokens'), per(b, 'tokens'), 0, v => `${kfmt(v)}`),
      metric('cost', 'Cost per task', 'USD', per(a, 'costUsd'), per(b, 'costUsd'), 4, usd),
    ],
    ratios: {
      wall: round(a.wallS / b.wallS, 2),
      tokens: round(a.tokens / b.tokens, 2),
      priced: round(a.priced / b.priced, 2),
      cost: round(a.costUsd / b.costUsd, 2),
      note: 'A over B, above 1 favours FAI',
    },
    notes: [
      'Wall time: host process spawn to exit, approval automation included, model latency dominant.',
      'Raw model tokens: full model usage per vendor tokenizer (input including cache reads, plus output); text only — no condition requested screenshots on these tasks.',
      `Cost: bench/prices.json (${summary.meta.prices?.date ?? 'see prices file'}), API-equivalent for Codex hosts.`,
      'Suite figures are sums of per-task medians over repeats, divided by tasks; see source summary.json for per-task cells.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Jev autopilot (per-host ratio bars; value = how many times better than baseline)
// ---------------------------------------------------------------------------

function buildJevMatrix(data) {
  const hostRows = data.hosts.map(h => {
    const t = data.totals[h.id];
    const r = data.ratios?.[h.id];
    if (!t?.a || !t?.b) return null;
    return {
      name: h.name,
      pass: { a: `${t.a.passed}/${t.a.attempted}`, b: `${t.b.passed}/${t.b.attempted}` },
      wall: round(t.a.wallS / t.b.wallS, 2),
      tokens: round(t.a.tokens / t.b.tokens, 2),
      cost: round(t.a.costUsd / t.b.costUsd, 2),
      costPerTask: { a: t.a.costPerTask, b: t.a.costPerTask && t.b.costPerTask ? t.b.costPerTask : t.b.costUsd / t.b.taskCount },
      wallPerTask: { a: round(t.a.wallS / t.a.taskCount, 1), b: round(t.b.wallS / t.b.taskCount, 1) },
    };
  }).filter(Boolean);

  const ratioMetric = (id, label, pick) => {
    const values = hostRows.map(pick).filter(Number.isFinite);
    return {
      id, label, unit: '×',
      hosts: hostRows.map(h => ({ name: h.name, value: pick(h), display: `${pick(h).toFixed(2)}×` })),
      min: Math.min(...values), max: Math.max(...values),
      median: round(values.sort((x, y) => x - y)[Math.floor(values.length / 2)], 2),
    };
  };

  return {
    schemaVersion: 2,
    kind: 'ratio',
    status: 'complete',
    label: data.label ?? 'Experimental autopilot · one delegation per task',
    run: {
      model: data.model ?? 'Six host models (Sol 6.1, Astra, Opus 5.5, Sonnet 5.5, Luna, Terra)',
      driver: 'Jev autopilot (experimental, opt-in)',
      protocol: data.protocol ?? 'One fai_browser_run per task · host harness · local fixtures',
      taskCount: data.taskIds.length,
      repeats: data.expectedReps ?? 3,
      measuredAt: data.measuredAt ?? data.date,
      source: JEV_DATA.slice(ROOT.length + 1),
    },
    series: { a: 'Playwright MCP', b: 'FAI Jev autopilot' },
    parity: 1,
    metrics: [
      ratioMetric('wall', 'Wall-time speedup', h => h.wall),
      ratioMetric('tokens', 'Raw-token reduction', h => h.tokens),
      ratioMetric('cost', 'Cost saving', h => h.cost),
    ],
    hosts: hostRows,
    notes: data.notes ?? [
      'Bars show Playwright MCP ÷ FAI per host; above the 1× parity line FAI is faster/cheaper. Wall time and tokens are suite totals per host; cost is priced at bench/prices.json (API-equivalent for Codex hosts).',
      'Jev autopilot is experimental and opt-in; it delegates the whole task in one fai_browser_run call. This chart does not describe Agent direct, the default driver (chart above).',
      'Raw model tokens: full model usage per vendor tokenizer; text only on these tasks.',
      'Pass rates: every host passed 24/24 with FAI except Luna in its first matrix (21/24, fixed and rerun clean); see docs/results/RESULTS.md.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Static SVG fallbacks (rendered once, embedded in index.html for no-JS views)
// ---------------------------------------------------------------------------

const BAR_A = 'var(--chart-a, #8a919c)';
const BAR_B = 'var(--chart-b, #2f6fdd)';

function svgPaired(data) {
  const rowH = 114;
  const H = 54 + data.metrics.length * rowH;
  const out = [
    `<svg id="benchmark-chart" viewBox="0 0 960 ${H}" role="img" aria-labelledby="benchmark-svg-title benchmark-svg-desc">`,
    `<title id="benchmark-svg-title">${data.series.b} compared with ${data.series.a}</title>`,
    `<desc id="benchmark-svg-desc">${data.metrics.map(m => `${m.label}: ${data.series.a} ${m.a.display}, ${data.series.b} ${m.b.display}`).join('. ')}. Each pair uses a common zero baseline and shared scale.</desc>`,
    '<path class="chart-grid" d="M270 30v' + (H - 70) + 'M400 30v' + (H - 70) + 'M530 30v' + (H - 70) + 'M660 30v' + (H - 70) + 'M790 30v' + (H - 70) + '" aria-hidden="true"></path>',
  ];
  data.metrics.forEach((m, i) => {
    const scale = m.id === 'passes' ? (data.run.attempted || data.run.taskCount) : Math.max(m.a.value, m.b.value);
    const bar = v => (v / scale * 520).toFixed(2);
    const y = 38 + i * rowH;
    const scaleLabel = m.id === 'passes' ? `Shared max · ${scale} runs` : m.unit === 'USD' ? `Shared max · $${scale}` : `Shared max · ${scale}${m.unit === 's' ? ' s' : ' ' + m.unit}`;
    out.push(`<g transform="translate(0 ${y})">`,
      `<text class="metric-name" x="0" y="25">${m.label}</text>`,
      `<text class="metric-note" x="0" y="47">${m.id === 'passes' ? `out of ${data.run.attempted || data.run.taskCount} runs` : `suite of per-task medians · ${data.run.repeats} repeats`}</text>`,
      '<line class="chart-zero" x1="270" y1="5" x2="270" y2="72" aria-hidden="true"></line>',
      `<text class="series-name" x="222" y="25">A</text>`,
      '<rect class="chart-track" x="270" y="12" width="520" height="16" rx="3" aria-hidden="true"></rect>',
      `<rect class="chart-bar chart-bar-a" x="270" y="12" width="${bar(m.a.value)}" height="16" rx="3" data-width="${bar(m.a.value)}" aria-hidden="true"></rect>`,
      `<text class="chart-value" x="820" y="25">${m.a.display}</text>`,
      `<text class="series-name" x="222" y="63">B</text>`,
      '<rect class="chart-track" x="270" y="50" width="520" height="16" rx="3" aria-hidden="true"></rect>',
      `<rect class="chart-bar chart-bar-b" x="270" y="50" width="${bar(m.b.value)}" height="16" rx="3" data-width="${bar(m.b.value)}" aria-hidden="true"></rect>`,
      `<text class="chart-value" x="820" y="63">${m.b.display}</text>`,
      '<text class="chart-scale" x="270" y="94">0</text>',
      `<text class="chart-scale" x="790" y="94" text-anchor="end">${scaleLabel}</text>`,
      '</g>');
  });
  out.push('</svg>');
  return out.join('');
}

function svgRatio(data) {
  const hosts = data.metrics[0].hosts;
  const rowH = 40;
  const H = 70 + data.metrics.length * (34 + hosts.length * rowH + 20);
  const max = Math.max(...data.metrics.flatMap(m => m.hosts.map(h => h.value))) * 1.12;
  const x = v => 270 + (v / max) * 520;
  const out = [
    `<svg id="jev-chart" viewBox="0 0 960 ${H}" role="img" aria-labelledby="jev-svg-title jev-svg-desc">`,
    `<title id="jev-svg-title">${data.series.b} compared with ${data.series.a} across ${hosts.length} host models</title>`,
    `<desc id="jev-svg-desc">${data.metrics.map(m => `${m.label}: median ${m.median.toFixed(2)} times, range ${m.min.toFixed(2)} to ${m.max.toFixed(2)} across ${hosts.length} hosts`).join('. ')}. Bars right of the 1× line favour FAI.</desc>`,
  ];
  let y = 30;
  data.metrics.forEach(m => {
    out.push(`<text class="metric-name" x="0" y="${y + 16}">${m.label}</text>`,
      `<text class="metric-note" x="0" y="${y + 36}">median ${m.median.toFixed(2)}× · range ${m.min.toFixed(2)}×–${m.max.toFixed(2)}× · bars right of 1× favour FAI</text>`);
    y += 50;
    // parity line
    out.push(`<line class="chart-zero" x1="${x(1).toFixed(1)}" y1="${y - 6}" x2="${x(1).toFixed(1)}" y2="${y + hosts.length * rowH - 6}" aria-hidden="true"></line>`);
    m.hosts.forEach((h, i) => {
      const ry = y + i * rowH;
      const bw = (h.value / max * 520).toFixed(2);
      out.push(`<text class="series-name" x="150" y="${ry + 22}">${h.name}</text>`,
        `<rect class="chart-track" x="270" y="${ry + 6}" width="520" height="16" rx="3" aria-hidden="true"></rect>`,
        `<rect class="chart-bar chart-bar-b" x="270" y="${ry + 6}" width="${bw}" height="16" rx="3" data-width="${bw}" aria-hidden="true"></rect>`,
        `<text class="chart-value" x="820" y="${ry + 22}">${h.display}</text>`);
    });
    y += hosts.length * rowH + 26;
    out.push(`<text class="chart-scale" x="270" y="${y - 12}">0</text>`,
      `<text class="chart-scale" x="790" y="${y - 12}" text-anchor="end">Shared max · ${max.toFixed(1)}×</text>`);
  });
  out.push('</svg>');
  return out.join('');
}

// ---------------------------------------------------------------------------
// Baked figure markup for index.html (static no-JS fallback; JS replaces it
// with a live render from the JSON files above).
// ---------------------------------------------------------------------------

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function figureAgentDirect(d) {
  const runLine = `${esc(d.run.model)} · ${esc(d.run.driver)} · ${d.run.taskCount} tasks · ${d.run.repeats} repeat${d.run.repeats === 1 ? '' : 's'} · local fixtures`;
  const captionP = `Measured values only; each pair shares a zero baseline and scale. Per-task figures are suites of per-task medians over repeats. Measured ${esc(d.run.measuredAt)}. Source: ${esc(d.run.source)}.`;
  const rows = d.metrics.map(m => {
    const basis = m.id === 'passes' ? `${d.run.taskCount} tasks total` : `Per task · medians over ${d.run.repeats} repeats each`;
    return `<tr><th scope="row">${esc(m.label)}</th><td>${esc(m.a.display)}</td><td>${esc(m.b.display)}</td><td>${basis}</td></tr>`;
  }).join('');
  const note = m => m.id === 'passes' ? `out of ${d.run.taskCount} tasks` : `per task · suite of per-task medians · ${d.run.repeats} repeat${d.run.repeats === 1 ? '' : 's'}`;
  // The static SVG needs metric notes baked per metric.
  const svg = svgPaired(d).replace(/(<text class="metric-note"[^>]*>)[^<]*(<\/text>)/g, (match, open, close) => {
    const index = svgMetricNoteIndex++;
    return open + note(d.metrics[index]) + close;
  });
  return `<figure class="benchmark reveal in" id="task-benchmark" data-state="complete" aria-label="Agent direct benchmark chart and table" aria-describedby="benchmark-method">
        <div class="benchmark-topline">
          <div><span class="benchmark-status" id="benchmark-status"><i aria-hidden="true"></i>Measured results</span><p id="benchmark-run">${runLine}</p></div>
          <div class="benchmark-legend" aria-label="Chart legend"><span><i class="legend-a"></i>A · ${esc(d.series.a)}</span><span><i class="legend-b"></i>B · ${esc(d.series.b)}</span></div>
        </div>
        <div class="benchmark-canvas" tabindex="0" role="region" aria-label="Agent direct benchmark chart; scrolls horizontally on small screens">
          ${svg}
        </div>
        <figcaption id="benchmark-method"><span>${esc(d.label)}</span><p>${captionP}</p></figcaption>
        <details class="benchmark-data">
          <summary>Read the comparison as text</summary>
          <div class="benchmark-table-wrap" tabindex="0" role="region" aria-label="Text benchmark table; scrolls horizontally on small screens">
            <table>
              <caption id="benchmark-table-caption">Measured values only. Per-task figures are suites of per-task medians over repeats. Source: ${esc(d.run.source)}.</caption>
              <thead><tr><th scope="col">Metric</th><th scope="col">A · ${esc(d.series.a)}</th><th scope="col">B · ${esc(d.series.b)}</th><th scope="col">Basis</th></tr></thead>
              <tbody id="benchmark-table-body">${rows}</tbody>
            </table>
          </div>
        </details>
      </figure>`;
}

let svgMetricNoteIndex = 0;

function figureJev(d) {
  const runLine = `${esc(d.run.model)} · ${esc(d.run.driver)} · ${d.run.taskCount} tasks · ${d.run.repeats} repeats · local fixtures`;
  const captionP = `Bars show ${esc(d.series.a)} ÷ ${esc(d.series.b)} per host; a bar past the 1× parity line means FAI is faster or cheaper on that host. Raw model tokens per vendor tokenizer; cost priced from bench/prices.json. Measured ${esc(d.run.measuredAt)}. Source: ${esc(d.run.source)}.`;
  const rows = d.hosts.map(h => `<tr><th scope="row">${esc(h.name)}</th><td>${h.wall.toFixed(2)}×</td><td>${h.tokens.toFixed(2)}×</td><td>${h.cost.toFixed(2)}×</td><td>${esc(h.pass.a)} → ${esc(h.pass.b)}</td></tr>`).join('');
  return `<figure class="benchmark reveal in" id="jev-benchmark" data-state="complete" aria-label="Experimental Jev autopilot benchmark chart and table" aria-describedby="jev-method">
        <div class="benchmark-topline">
          <div><span class="benchmark-status" id="jev-status"><i aria-hidden="true"></i>Measured results · experimental</span><p id="jev-run">${runLine}</p></div>
          <div class="benchmark-legend" aria-label="Chart legend"><span><i class="legend-b"></i>${esc(d.series.a)} ÷ ${esc(d.series.b)} per host · bars past 1× favour FAI</span></div>
        </div>
        <div class="benchmark-canvas" tabindex="0" role="region" aria-label="Jev autopilot benchmark chart; scrolls horizontally on small screens">
          ${svgRatio(d)}
        </div>
        <figcaption id="jev-method"><span>${esc(d.label)}</span><p>${captionP}</p></figcaption>
        <details class="benchmark-data">
          <summary>Read the comparison as text</summary>
          <div class="benchmark-table-wrap" tabindex="0" role="region" aria-label="Text benchmark table; scrolls horizontally on small screens">
            <table>
              <caption id="jev-table-caption">${esc(d.series.a)} ÷ ${esc(d.series.b)} per host; above 1× favours FAI. Source: ${esc(d.run.source)}.</caption>
              <thead><tr><th scope="col">Host</th><th scope="col">Wall-time speedup</th><th scope="col">Raw-token reduction</th><th scope="col">Cost saving</th><th scope="col">Pass A → B</th></tr></thead>
              <tbody id="jev-table-body">${rows}</tbody>
            </table>
          </div>
        </details>
      </figure>`;
}

function spliceFigure(html, name, block) {
  const begin = `<!-- figure:${name}:begin -->`;
  const end = `<!-- figure:${name}:end -->`;
  const start = html.indexOf(begin);
  const stop = html.indexOf(end);
  if (start < 0 || stop < 0) throw new Error(`figure markers for ${name} not found in site/index.html`);
  return html.slice(0, start + begin.length) + '\n      ' + block + '\n      ' + html.slice(stop);
}

// ---------------------------------------------------------------------------

const agent = buildAgentDirect(read(AGENT_SUMMARY));
const jev = buildJevMatrix(read(JEV_DATA));

writeFileSync(resolve(OUT_DIR, 'benchmark-data.json'), JSON.stringify(agent, null, 2) + '\n');
writeFileSync(resolve(OUT_DIR, 'jev-matrix-data.json'), JSON.stringify(jev, null, 2) + '\n');
writeFileSync(resolve(OUT_DIR, 'benchmark-agentdirect.svg'), svgPaired(agent) + '\n');
writeFileSync(resolve(OUT_DIR, 'jev-matrix.svg'), svgRatio(jev) + '\n');

const indexPath = resolve(ROOT, 'site/index.html');
let indexHtml = readFileSync(indexPath, 'utf8');
svgMetricNoteIndex = 0;
indexHtml = spliceFigure(indexHtml, 'agentdirect', figureAgentDirect(agent));
indexHtml = spliceFigure(indexHtml, 'jev', figureJev(jev));
writeFileSync(indexPath, indexHtml);

console.log(`agent direct: wall ${agent.ratios.wall}×, tokens ${agent.ratios.tokens}×, cost ${agent.ratios.cost}× (A/B)`);
console.log(`jev matrix:   wall ${jev.metrics[0].median}×, tokens ${jev.metrics[1].median}×, cost ${jev.metrics[2].median}× (medians)`);
console.log('wrote site/media/{benchmark-data,jev-matrix-data}.json, spliced figures into site/index.html');
