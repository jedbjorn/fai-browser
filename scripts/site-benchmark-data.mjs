#!/usr/bin/env node
// Build the README and site's labeled benchmark charts from checked-in results.
//
//   node scripts/site-benchmark-data.mjs [--agent-summary PATH]
//     [--visual-summary PATH] [--jev-data PATH]
//
// Writes grouped three-driver JSON and standalone SVGs for text and visual
// workflows, then splices the same charts and tables into site/index.html.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const AGENT_SUMMARY = resolve(ROOT, opt('agent-summary', 'bench/results/site-agentdirect-optimized-2026-11-06/summary.json'));
const VISUAL_SUMMARY = resolve(ROOT, opt('visual-summary', 'bench/results/site-agentdirect-optimized-visual-2026-11-06/summary.json'));
const JEV_DATA = resolve(ROOT, opt('jev-data', 'bench/results/jev-comparison-2026-11-06.json'));
const OUT_DIR = resolve(ROOT, 'site/media');
const SERIES = ['playwright', 'agent', 'jev'];

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const round = (n, digits = 1) => Number(n.toFixed(digits));
const usd = n => `$${n.toFixed(4)}`;
const kfmt = n => `${(n / 1000).toFixed(1)}k`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const relative = path => path.slice(ROOT.length + 1);

function buildComparison({ id, title, model, agentSummary, jevData, jevHost, playwright, agent, jev }) {
  if (!playwright || !agent || !jev) throw new Error(`${id} comparison is missing a driver total`);
  const tasks = agentSummary.meta.tasks;
  const repeats = agentSummary.meta.repeat;
  const taskCount = tasks.length;
  const attempted = agent.attempted;
  const source = [agentSummary === visualInput ? VISUAL_SUMMARY : AGENT_SUMMARY, JEV_DATA].map(relative).join(' + ');
  const per = (total, key) => total[key] / total.tasks;
  const totals = { playwright, agent, jev };
  const metric = (metricId, label, unit, key, digits, fmt) => ({
    id: metricId,
    label,
    unit,
    ...Object.fromEntries(SERIES.map(name => [name, {
      value: round(per(totals[name], key), digits),
      display: fmt(per(totals[name], key)),
    }])),
  });

  return {
    schemaVersion: 3,
    kind: 'grouped',
    status: 'complete',
    id,
    title,
    label: `${taskCount} ${id} workflows · ${repeats} repeats each · Jev experimental · two safety scenarios excluded`,
    run: {
      model,
      protocol: 'Fresh agent per task · host harness · local fixtures',
      taskCount,
      repeats,
      attempted,
      measuredAt: jevData.measuredAt ?? agentSummary.meta.finishedAt,
      source,
    },
    series: {
      playwright: 'Playwright MCP',
      agent: 'FAI Agent direct',
      jev: 'FAI Jev autopilot',
    },
    metrics: [
      {
        id: 'passes', label: 'Task checks passed', unit: 'runs',
        ...Object.fromEntries(SERIES.map(name => [name, {
          value: totals[name].passed,
          display: `${totals[name].passed}/${totals[name].attempted}`,
        }])),
      },
      metric('wall', 'Wall time per task', 's', 'wallS', 1, v => `${v.toFixed(1)} s`),
      metric('tokens', 'Raw host tokens per task', 'tokens', 'tokens', 0, kfmt),
      metric('cost', 'Host-only cost per task', 'USD', 'costUsd', 4, usd),
    ],
    notes: [
      'Lower wall time, token and cost bars are better; higher pass counts are better. Each metric uses a common zero baseline and shared scale.',
      'Raw host tokens are full model usage per vendor tokenizer. Visual counts include image tokens.',
      'Jev provider tokens are additional to raw host tokens and are not included in host-only cost.',
      `Cost uses bench/prices.json (${agentSummary.meta.prices?.date ?? 'see prices file'}), API-equivalent for Codex hosts.`,
      'Per-task figures are suites of per-task medians over repeats, divided by tasks.',
    ],
    jevHost,
  };
}

const agentInput = read(AGENT_SUMMARY);
const visualInput = read(VISUAL_SUMMARY);
const jevInput = read(JEV_DATA);
const agentHost = agentInput.meta.hosts[0];
const visualHost = visualInput.meta.hosts[0];

const text = buildComparison({
  id: 'text',
  title: 'Text workflows',
  model: 'Sol 6.1 medium (Codex CLI)',
  agentSummary: agentInput,
  jevData: jevInput,
  jevHost: 'sol',
  playwright: agentInput.totals[`a/${agentHost}`],
  agent: agentInput.totals[`b/${agentHost}`],
  jev: jevInput.totals.sol.b,
});
const visual = buildComparison({
  id: 'visual',
  title: 'Visual workflows',
  model: 'Claude Sonnet 5.5 medium',
  agentSummary: visualInput,
  jevData: jevInput,
  jevHost: 'sonnet',
  playwright: jevInput.totals.sonnet.a,
  agent: visualInput.totals[`b/${visualHost}`],
  jev: jevInput.totals.sonnet.b,
});

const BAR_X = 260;
const BAR_W = 560;
const VALUE_X = 850;
const ROW_H = 140;

function scaleLabel(metric, scale, data) {
  if (metric.id === 'passes') return `Shared max · ${scale} runs`;
  if (metric.unit === 'USD') return `Shared max · ${usd(scale)}`;
  return `Shared max · ${scale}${metric.unit === 's' ? ' s' : ` ${metric.unit}`}`;
}

function standaloneStyle() {
  return `<style>
    .chart-background { fill: #ffffff; }
    .metric-name { fill: #12251f; font: 700 16px system-ui, sans-serif; }
    .metric-note, .chart-scale { fill: #5a6d65; font: 11px ui-monospace, monospace; }
    .chart-grid { stroke: #dce7e0; stroke-width: 1; stroke-dasharray: 2 8; }
    .chart-zero { stroke: #9db8ab; stroke-width: 1.5; }
    .chart-track { fill: #e8f0eb; }
    .chart-bar-playwright { fill: #a3aea7; }
    .chart-bar-agent { fill: #0a9a80; }
    .chart-bar-jev { fill: #6558c7; }
    .chart-bar-label { fill: #ffffff; font: 700 12px ui-monospace, monospace; }
    .chart-bar-label-playwright { fill: #12251f; }
    .chart-value { fill: #12251f; font: 700 13px ui-monospace, monospace; }
    @media (prefers-color-scheme: dark) {
      .chart-background { fill: #10251f; }
      .metric-name, .chart-value { fill: #edf7f2; }
      .metric-note, .chart-scale { fill: #a3b8ae; }
      .chart-grid { stroke: #29443a; }
      .chart-track { fill: #1d372e; }
    }
  </style><rect class="chart-background" width="1000" height="100%" aria-hidden="true"></rect>`;
}

function svgGrouped(data, standalone = false) {
  const H = 44 + data.metrics.length * ROW_H;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" id="benchmark-${data.id}-chart" viewBox="0 0 1000 ${H}" role="img" aria-labelledby="benchmark-${data.id}-svg-title benchmark-${data.id}-svg-desc">`,
    `<title id="benchmark-${data.id}-svg-title">${esc(data.title)}: Playwright MCP, FAI Agent direct and FAI Jev autopilot</title>`,
    `<desc id="benchmark-${data.id}-svg-desc">${data.metrics.map(m => `${m.label}: ${SERIES.map(name => `${data.series[name]} ${m[name].display}`).join(', ')}`).join('. ')}. Each metric uses a common zero baseline and shared scale.</desc>`,
    standalone ? standaloneStyle() : '',
    `<path class="chart-grid" d="M${BAR_X} 24v${H - 64}M${BAR_X + 140} 24v${H - 64}M${BAR_X + 280} 24v${H - 64}M${BAR_X + 420} 24v${H - 64}M${BAR_X + BAR_W} 24v${H - 64}" aria-hidden="true"></path>`,
  ];
  data.metrics.forEach((metric, i) => {
    const scale = metric.id === 'passes' ? data.run.attempted : Math.max(...SERIES.map(name => metric[name].value));
    const y = 28 + i * ROW_H;
    out.push(`<g transform="translate(0 ${y})">`,
      `<text class="metric-name" x="0" y="25">${esc(metric.label)}</text>`,
      `<text class="metric-note" x="0" y="47">${metric.id === 'passes' ? `${data.run.taskCount} tasks · ${data.run.repeats} repeats` : 'per task · mean of task medians'}</text>`,
      `<line class="chart-zero" x1="${BAR_X}" y1="4" x2="${BAR_X}" y2="103" aria-hidden="true"></line>`);
    SERIES.forEach((name, seriesIndex) => {
      const point = metric[name];
      const width = (point.value / scale * BAR_W).toFixed(2);
      const barY = 10 + seriesIndex * 31;
      out.push(
        `<rect class="chart-track" x="${BAR_X}" y="${barY}" width="${BAR_W}" height="19" rx="3" aria-hidden="true"></rect>`,
        `<rect class="chart-bar chart-bar-${name}" fill="${name === 'playwright' ? '#a3aea7' : name === 'agent' ? '#0a9a80' : '#6558c7'}" x="${BAR_X}" y="${barY}" width="${width}" height="19" rx="3" data-width="${width}" aria-hidden="true"></rect>`,
        `<text class="chart-bar-label chart-bar-label-${name}" fill="${name === 'playwright' ? '#12251f' : '#ffffff'}" x="${BAR_X + 10}" y="${barY + 14}">${esc(data.series[name])}</text>`,
        `<text class="chart-value" x="${VALUE_X}" y="${barY + 14}">${esc(point.display)}</text>`,
      );
    });
    out.push(`<text class="chart-scale" x="${BAR_X}" y="124">0</text>`,
      `<text class="chart-scale" x="${BAR_X + BAR_W}" y="124" text-anchor="end">${esc(scaleLabel(metric, scale, data))}</text>`,
      '</g>');
  });
  out.push('</svg>');
  return out.join('');
}

function figureComparison(data) {
  const id = data.id;
  const runLine = `${esc(data.run.model)} · ${data.run.taskCount} tasks · ${data.run.repeats} repeats · local fixtures`;
  const caption = `Directly labeled bars; lower time, tokens and cost are better. Raw host tokens only; Jev provider tokens are additional and excluded from host-only cost. Each metric shares a zero baseline and scale. Measured ${esc(data.run.measuredAt)}. Sources: ${esc(data.run.source)}.`;
  const rows = data.metrics.map(metric => {
    const basis = metric.id === 'passes' ? `${data.run.taskCount} tasks × ${data.run.repeats} repeats` : `Per task · medians over ${data.run.repeats} repeats`;
    return `<tr><th scope="row">${esc(metric.label)}</th>${SERIES.map(name => `<td>${esc(metric[name].display)}</td>`).join('')}<td>${basis}</td></tr>`;
  }).join('');
  return `<figure class="benchmark reveal in" id="${id}-benchmark" data-state="complete" aria-label="${esc(data.title)} three-driver benchmark chart and table" aria-describedby="${id}-method">
        <div class="benchmark-topline">
          <div><span class="benchmark-status" id="${id}-status"><i aria-hidden="true"></i>Measured results · ${id === 'visual' ? 'screenshots' : 'text'}</span><p class="benchmark-run" id="${id}-run">${runLine}</p></div>
          <div class="benchmark-legend" aria-label="How to read the chart"><span>Lower time, tokens and cost are better · Jev is experimental</span></div>
        </div>
        <div class="benchmark-canvas" tabindex="0" role="region" aria-label="${esc(data.title)} benchmark chart; scrolls horizontally on small screens">
          ${svgGrouped(data)}
        </div>
        <figcaption id="${id}-method"><span>${esc(data.label)}</span><p>${caption}</p></figcaption>
        <details class="benchmark-data">
          <summary>Read the comparison as text</summary>
          <div class="benchmark-table-wrap" tabindex="0" role="region" aria-label="Text benchmark table; scrolls horizontally on small screens">
            <table>
              <caption id="${id}-table-caption">Measured values only. Jev provider tokens are additional and excluded from host-only cost. Sources: ${esc(data.run.source)}.</caption>
              <thead><tr><th scope="col">Metric</th>${SERIES.map(name => `<th scope="col">${esc(data.series[name])}</th>`).join('')}<th scope="col">Basis</th></tr></thead>
              <tbody id="${id}-table-body">${rows}</tbody>
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

for (const data of [text, visual]) {
  writeFileSync(resolve(OUT_DIR, `benchmark-${data.id}-data.json`), JSON.stringify(data, null, 2) + '\n');
  writeFileSync(resolve(OUT_DIR, `benchmark-${data.id}.svg`), svgGrouped(data, true) + '\n');
}

const indexPath = resolve(ROOT, 'site/index.html');
let indexHtml = readFileSync(indexPath, 'utf8');
indexHtml = spliceFigure(indexHtml, 'text', figureComparison(text));
indexHtml = spliceFigure(indexHtml, 'visual', figureComparison(visual));
writeFileSync(indexPath, indexHtml);

console.log('wrote labeled text and visual charts for Playwright MCP, Agent direct and Jev autopilot');
