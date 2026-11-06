// Report model (bench/report/data.mjs) -> one standalone HTML page: inline CSS, inline SVG, no scripts, no external
// URLs. Every string on the page is a number, a task id, a host name or fixed copy written here.
const HOST_COLORS = [
  ['#2a78d6', '#3987e5'], ['#eb6834', '#d95926'], ['#1baf7a', '#199e70'], ['#eda100', '#c98500'],
  ['#e87ba4', '#d55181'], ['#008300', '#2f9e2f'], ['#4a3aa7', '#9085e9'], ['#e34948', '#e66767'],
];

// Stable colour slot per host: known models keep one colour on every page, unknown hosts take the next free slot.
const KNOWN_SLOTS = [['sol', 0], ['astra', 1], ['opus', 2], ['sonnet', 3], ['luna', 4], ['terra', 6]];
const slotCache = new WeakMap();
function slots(data) {
  if (!slotCache.has(data)) {
    const used = new Set();
    const out = data.hosts.map(host => {
      const hit = KNOWN_SLOTS.find(([key]) => `${host.id} ${host.short} ${host.name}`.toLowerCase().includes(key));
      if (hit && !used.has(hit[1])) {
        used.add(hit[1]);
        return hit[1];
      }
      return null;
    });
    let next = 0;
    slotCache.set(data, out.map(slot => {
      if (slot != null) {
        return slot;
      }
      while (used.has(next % 8) && used.size < 8) {
        next++;
      }
      used.add(next % 8);
      return next++ % 8;
    }));
  }
  return slotCache.get(data);
}
const S = (data, i) => slots(data)[i];

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const num = (value, digits = 1) => (value == null ? '–' : Number(value).toFixed(digits));
const secs = value => (value == null ? '–' : value >= 100 ? `${Math.round(value)} s` : `${Number(value).toFixed(1)} s`);
const usd = value => (value == null ? '–' : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`);
const count = value => (value == null ? '–' : Number.isInteger(value) ? String(value) : value.toFixed(1));
const tokens = value => (value == null ? '–' : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : `${Math.round(value / 1000)}K`);
const pct = value => (value == null ? '–' : `${Math.round(value * 100)}%`);
const ratioText = value => (value == null ? null : `${value >= 10 ? Math.round(value) : value.toFixed(1)}×`);

// Bar with a 4 px rounded data end, anchored to the baseline. Vertical when `horizontal` is false.
function bar(x, y, w, h, { horizontal = false, cls = '', title = '' } = {}) {
  if (w <= 0 || h <= 0) {
    return '';
  }
  const r = Math.min(4, horizontal ? h / 2 : w / 2, horizontal ? w : h);
  const d = horizontal
    ? `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`
    : `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `<path class="${cls}" d="${d}">${title ? `<title>${esc(title)}</title>` : ''}</path>`;
}

function styles(data) {
  const light = data.hosts.map((host, i) => `--h${S(data, i)}:${HOST_COLORS[S(data, i)][0]};`).join('');
  const dark = data.hosts.map((host, i) => `--h${S(data, i)}:${HOST_COLORS[S(data, i)][1]};`).join('');
  const darkTokens = `color-scheme:dark;--bg:#121211;--surface:#1c1c1a;--surface-2:#252523;--ink:#f7f6f2;--ink-2:#c3c2b7;
    --ink-3:#8f8e86;--rule:#33332f;--pw:#77766f;--bad:#e66767;--bad-bg:#3a1f1f;--good:#4cc38a;--accent:#3987e5;${dark}`;
  return `
:root{color-scheme:light;--bg:#f4f3ef;--surface:#ffffff;--surface-2:#f8f7f4;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#85847e;
  --rule:#e4e2dc;--pw:#a8a69e;--bad:#c93837;--bad-bg:#fbe9e8;--good:#14804a;--accent:#2a78d6;${light}
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${darkTokens}}}
:root[data-theme="dark"]{${darkTokens}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--font);font-variant-numeric:tabular-nums}
.wrap{max-width:1200px;margin:0 auto;padding:40px 16px 56px}
header{margin-bottom:28px}
.eyebrow{font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
h1{font-size:clamp(32px,6vw,56px);line-height:1.05;letter-spacing:-.02em;margin:8px 0 12px;font-weight:750}
.lede{font-size:clamp(17px,2.2vw,21px);color:var(--ink-2);max-width:820px;margin:0}
.lede b{color:var(--ink)}
section{background:var(--surface);border:1px solid var(--rule);border-radius:16px;padding:24px;margin-top:20px}
h2{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--ink-3);font-size:14px;margin:0 0 18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
@media (min-width:900px){.cards{grid-template-columns:repeat(var(--cols,4),minmax(0,1fr))}.card.hero{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 28px}.card.hero .big{margin:6px 0}}
.note{margin-top:12px;font-size:12px;font-weight:600;color:var(--bad);background:var(--bad-bg);border-radius:8px;padding:6px 8px}
.hostbar{display:none}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:16px;padding:20px 22px;position:relative;overflow:hidden}
.card.hero{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.card.hero .k,.card.hero .meta{color:color-mix(in srgb,var(--bg) 70%,var(--ink))}
.card .k{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3)}
.card .host{font-size:18px;font-weight:650;margin-top:6px;display:flex;align-items:center;gap:8px}
.dot{width:12px;height:12px;border-radius:50%;flex:none;display:inline-block}
.big{font-size:clamp(44px,6vw,64px);font-weight:780;letter-spacing:-.03em;line-height:1;margin:14px 0 6px}
.big small{font-size:.4em;font-weight:600;letter-spacing:0;margin-left:4px}
.meta{font-size:14px;color:var(--ink-2)}
.meta b{color:var(--ink)}
.card .stripe{position:absolute;left:0;top:0;bottom:0;width:5px}
.pairs{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-top:12px;font-size:14px}
.pairs dt{color:var(--ink-3)}.pairs dd{margin:0;text-align:right;font-weight:600;white-space:nowrap}
.pairs dd .floor{display:block;font-size:12px;font-weight:500;color:var(--ink-3)}
.corpus-svg{max-width:860px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;color:var(--ink-2);margin:0 0 16px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:14px;height:14px;border-radius:4px;display:inline-block}
.sw.pw{background:var(--pw)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:20px 28px}
.chart h3{font-size:15px;margin:0 0 2px}
.chart p{font-size:13px;color:var(--ink-3);margin:0 0 6px}
svg{display:block;width:100%;height:auto;overflow:visible}
svg text{font-family:var(--font);font-variant-numeric:tabular-nums}
.ax{stroke:var(--rule);stroke-width:1}
.t-lab{fill:var(--ink-2);font-size:13px}
.t-val{fill:var(--ink);font-size:13px;font-weight:600}
.t-mute{fill:var(--ink-3);font-size:12px}
.t-ratio{fill:var(--ink);font-size:16px;font-weight:750}
.b-pw{fill:var(--pw)}
.miss{fill:none;stroke:var(--ink-3);stroke-dasharray:3 3}
.strip{display:grid;gap:10px}
.srow{display:grid;grid-template-columns:minmax(150px,220px) 1fr auto;align-items:center;gap:12px}
.srow .lab{font-size:14px;display:flex;align-items:center;gap:8px;min-width:0}
.srow .lab span.c{color:var(--ink-3);font-size:12px}
.cells{display:flex;flex-wrap:wrap;gap:4px}
.cell{width:26px;height:26px;border-radius:6px;display:grid;place-items:center;font-size:11px;font-weight:700;color:#fff}
.cell.missing{border:1.5px dashed var(--ink-3);background:transparent;color:var(--ink-3)}
.cell.fail{background:var(--bad)}
.srow .score{font-weight:700;font-size:15px;text-align:right;white-space:nowrap}
.multiples{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:16px}
.mini{border:1px solid var(--rule);border-radius:12px;padding:12px 14px;background:var(--surface-2)}
.mini h3{font-size:13px;font-family:var(--mono);margin:0 0 6px;font-weight:600;overflow-wrap:anywhere}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.tile{border:1px solid var(--rule);border-radius:12px;padding:14px 16px;background:var(--surface-2)}
.tile .v{font-size:32px;font-weight:760;letter-spacing:-.02em;line-height:1.1}
.tile .l{font-size:13px;color:var(--ink-3)}
.tile.ok .v{color:var(--good)}.tile.warn .v{color:var(--bad)}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:999px;background:var(--bad-bg);color:var(--bad);margin-left:6px}
.notice{border-color:color-mix(in srgb,var(--bad) 35%,var(--rule));background:color-mix(in srgb,var(--bad-bg) 55%,var(--surface))}
.notice ul{margin:8px 0 0;padding-left:20px;font-size:14px;color:var(--ink-2)}
.notice li{margin:3px 0}
code{font-family:var(--mono);font-size:.9em;overflow-wrap:anywhere}
footer{margin-top:20px;color:var(--ink-2);font-size:14px;padding:4px 4px 0}
footer h2{font-size:16px;color:var(--ink)}
footer ul{padding-left:20px;margin:8px 0}
footer li{margin:4px 0}
table.data{width:100%;border-collapse:collapse;font-size:13px}
table.data th,table.data td{padding:6px 8px;border-bottom:1px solid var(--rule);text-align:right;white-space:nowrap}
table.data th:first-child,table.data td:first-child{text-align:left}
.scroll{overflow-x:auto}
details summary{cursor:pointer;font-weight:600;font-size:14px;color:var(--ink-2)}
/* Social crop (PNG step adds class "social" to <html>) */
html.social .wrap{max-width:1080px;padding:44px 40px 0}
html.social .hide-social{display:none}
html.social h1{font-size:50px;margin:6px 0 10px}
html.social header{margin-bottom:20px}
html.social .lede{font-size:19px}
html.social .cards{display:block}
html.social .card:not(.hero){display:none}
html.social .card.hero{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 24px;padding:14px 20px}
html.social .card.hero .k{flex-basis:100%}
html.social .card .host{font-size:16px;margin:0}
html.social .big{font-size:40px;margin:0}
html.social .meta{font-size:14px}
html.social .hostbar{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:8px;margin-top:12px}
.hc{background:var(--surface);border:1px solid var(--rule);border-top:4px solid;border-radius:12px;padding:8px 10px;min-width:0;font-size:12px;line-height:1.35;color:var(--ink-2)}
.hc .hn{display:flex;align-items:center;gap:6px;font-weight:650;font-size:13px;color:var(--ink);white-space:nowrap}
.hc .hn span{overflow:hidden;text-overflow:ellipsis}
.hc .dot{width:9px;height:9px}
.hc .hx{font-size:26px;font-weight:780;letter-spacing:-.02em;line-height:1.1;color:var(--ink);margin-top:2px}
.hc .hx small{font-size:11px;font-weight:600;margin-left:3px;color:var(--ink-3)}
.hc .hl span{display:block;color:var(--ink-3);font-size:11px}
.hc .hp{font-weight:600;color:var(--ink)}
.hc.lim .hp{color:var(--bad)}
.hc .lm{display:block;font-size:10px;font-weight:600}
.hostbar.dense .hc{padding:6px 6px;font-size:11px}.hostbar.dense .hx{font-size:20px}.hostbar.dense .hx small{display:none}
html.social section{margin-top:14px;padding:18px 22px 6px}
html.social h2{font-size:18px}
html.social .sub{margin-bottom:10px;font-size:13px}
html.social .grid2{grid-template-columns:1fr 1fr;gap:6px 24px}
html.social .legend{flex-wrap:nowrap;margin-bottom:6px;font-size:13px;gap:6px 14px;white-space:nowrap}
@media (min-width:700px){.legend{flex-wrap:nowrap;font-size:13px;gap:6px 14px;white-space:nowrap}}
@media (max-width:560px){section{padding:18px 16px}.srow{grid-template-columns:1fr auto}.srow .cells{grid-column:1/-1;order:3}}
`;
}

function hostLabel(data, id) {
  return data.hosts.find(host => host.id === id) ?? { id, name: id, short: id, effort: '' };
}
const hostIndex = (data, id) => data.hosts.findIndex(host => host.id === id);
const dot = (data, id) => `<i class="dot" style="background:var(--h${S(data, hostIndex(data, id))})"></i>`;

// Warm floor under a card's mean cost: p25 cost of warm runs (timeline harness); nothing for older sets.
const floorLine = total => (total?.warmFloor?.costUsd != null
  ? `<span class="floor">warm floor ${usd(total.warmFloor.costUsd)} (${total.uncachedWarm.n} warm run${total.uncachedWarm.n === 1 ? '' : 's'})</span>`
  : '');

function headline(data) {
  const { totals, ratios } = data;
  const cards = [];
  const strip = [];
  const fastest = data.headline.fastestHost;
  if (fastest) {
    const t = totals[fastest].b;
    const h = hostLabel(data, fastest);
    cards.push(`<div class="card hero"><div class="k">Fastest host with FAI</div>
      <div class="host">${dot(data, fastest)}${esc(h.name)}</div>
      <div class="big">${num(t.wallPerTask)}<small>s / task</small></div>
      <div class="meta">${t.passed}/${t.attempted} passed · ${usd(t.costPerTask)} per task · ${count(t.requests / t.tasks)} model requests per task</div></div>`);
  }
  for (const host of data.hosts) {
    const a = totals[host.id].a;
    const b = totals[host.id].b;
    const r = ratios[host.id];
    const i = hostIndex(data, host.id);
    const big = r?.wall != null
      ? `<div class="big">${ratioText(r.wall)}<small>faster</small></div>
         <div class="meta">wall time vs Playwright MCP${r.complete ? '' : `, over ${r.tasks.length} of ${data.taskIds.length} tasks`}</div>`
      : `<div class="big" style="color:var(--ink-3)">–</div><div class="meta">${b ? 'No Playwright MCP runs yet' : 'No FAI runs yet'}</div>`;
    const limited = a && b && b.passRate != null && a.passRate != null && b.passRate < a.passRate;
    const note = limited ? `<div class="note">Tier limitation under study: FAI passes ${pct(b.passRate)} vs ${pct(a.passRate)} for Playwright.</div>` : '';
    strip.push(`<div class="hc${limited ? ' lim' : ''}" style="border-top-color:var(--h${S(data, i)})"><div class="hn">${dot(data, host.id)}<span>${esc(host.short)}</span></div>
      <div class="hx">${r?.wall != null ? ratioText(r.wall) : '–'}<small>faster</small></div>
      <div class="hl">${usd(b?.costPerTask)}${b?.warmFloor?.costPerTask != null || b?.warmFloor?.costUsd != null ? `<span> floor ${usd(b.warmFloor.costUsd)}</span>` : ''}</div>
      <div class="hp">${b ? pct(b.passRate) : '–'} vs ${a ? pct(a.passRate) : '–'}${limited ? '<span class="lm">tier limit</span>' : ''}</div></div>`);
    cards.push(`<div class="card"><span class="stripe" style="background:var(--h${S(data, i)})"></span>
      <div class="k">Speedup · ${esc(host.effort)} effort</div><div class="host">${dot(data, host.id)}${esc(host.name)}</div>${big}
      <dl class="pairs"><dt>Cost / task, FAI</dt><dd>${usd(b?.costPerTask)}${floorLine(b)}</dd>
      <dt>Cost / task, Playwright</dt><dd>${usd(a?.costPerTask)}${floorLine(a)}</dd>
      <dt>Pass, FAI · Playwright</dt><dd>${b ? pct(b.passRate) : '–'} · ${a ? pct(a.passRate) : '–'}</dd></dl>${note}</div>`);
  }
  const n = data.hosts.length;
  const cols = n <= 4 ? Math.max(1, n) : n % 3 === 0 ? 3 : n % 4 === 0 ? 4 : Math.ceil(n / 2);
  const dense = n > 6 ? ' dense' : '';
  return `<div class="cards hide-social-cards" style="--cols:${cols}">${cards.join('')}</div>
    <div class="hostbar${dense}" style="--n:${Math.max(1, n)}" aria-label="Per-host summary">${strip.join('')}</div>`;
}

// Grouped vertical bars: one group per host, Playwright (grey) and FAI (host colour), ratio above the pair.
// Bar width, fonts and label text shrink with the host count; value labels that would touch are lifted apart and
// ratio labels sit above the group's highest label, so nothing overlaps up to 8 hosts.
function groupedChart(data, { key, label, note, fmt, ratioKey, ratioWord }) {
  const n = data.hosts.length || 1;
  const compact = n > 4;
  const W = 480;
  const H = compact ? 290 : 250;
  const top = 50;
  const bottom = 44;
  const left = 4;
  const plotH = H - top - bottom;
  const groupW = (W - left * 2) / n;
  const barW = Math.min(56, groupW * (compact ? 0.4 : 0.32));
  const fs = n > 6 ? 10 : n > 4 ? 11 : 13;
  const lab = v => (compact ? fmt(v).replace(/ s$/, '') : fmt(v));
  const value = (host, cond) => {
    const t = data.totals[host][cond];
    return t && t[key] != null ? t[key] / t.tasks : null;
  };
  const max = Math.max(1e-9, ...data.hosts.flatMap(h => [value(h.id, 'a'), value(h.id, 'b')]).filter(v => v != null)) * 1.08;
  const base = top + plotH;
  const parts = [`<line class="ax" x1="0" x2="${W}" y1="${base}" y2="${base}"/>`];
  data.hosts.forEach((host, i) => {
    const cx = left + groupW * i + groupW / 2;
    const xs = { a: cx - barW - 1, b: cx + 1 };
    const info = {};
    for (const cond of ['a', 'b']) {
      const v = value(host.id, cond);
      info[cond] = v == null ? { y: base - 30, ly: base - 36 } : { v, y: base - (v / max) * plotH, ly: base - (v / max) * plotH - 5 };
    }
    // Labels over neighbouring bars: lift the higher one when they would sit within a text height of each other.
    const gap = fs + 2;
    if (Math.abs(info.a.ly - info.b.ly) < gap) {
      const higher = info.a.ly <= info.b.ly ? info.a : info.b;
      higher.ly -= gap - Math.abs(info.a.ly - info.b.ly);
    }
    let peak = base;
    for (const cond of ['a', 'b']) {
      const x = xs[cond];
      const { v, y, ly } = info[cond];
      if (v == null) {
        parts.push(`<rect class="miss" x="${x + 1}" y="${base - 30}" width="${barW - 2}" height="29" rx="4"><title>${esc(`${host.name}, ${data.conditions[cond]}: no runs`)}</title></rect>`,
          `<text class="t-mute" x="${x + barW / 2}" y="${ly}" text-anchor="middle" font-size="${fs}">n/a</text>`);
      } else {
        parts.push(bar(x, y, barW, base - y, { cls: cond === 'a' ? 'b-pw' : '', title: `${host.name}, ${data.conditions[cond]}: ${fmt(v)} per task` })
          .replace('<path class=""', `<path style="fill:var(--h${S(data, i)})"`),
        `<text class="t-val" x="${x + barW / 2}" y="${ly}" text-anchor="middle" font-size="${fs}">${lab(v)}</text>`);
      }
      peak = Math.min(peak, ly - fs);
    }
    const r = data.ratios[host.id]?.[ratioKey];
    if (r != null) {
      // Short ratio on busy charts (the unit word is in the panel note); staggered when neighbours sit at the same height.
      const rs = compact ? 14 : 16;
      parts.push(`<text class="t-ratio" x="${cx}" y="${Math.max(rs, peak - 3)}" text-anchor="middle" font-size="${rs}">${ratioText(r)}${compact ? '' : `<tspan class="t-mute" dx="4">${esc(ratioWord)}</tspan>`}</text>`);
    }
    parts.push(`<text class="t-lab" x="${cx}" y="${base + 18}" text-anchor="middle" font-weight="600" font-size="${compact ? 12 : 13}">${esc(host.short)}</text>`,
      `<text class="t-mute" x="${cx}" y="${base + 33}" text-anchor="middle" font-size="${compact ? 10 : 12}">${esc(host.effort)}</text>`);
  });
  return `<div class="chart"><h3>${esc(label)}</h3><p>${esc(note)}${compact ? `; top figure: Playwright ÷ FAI, ${esc(ratioWord)}` : ''}</p>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${parts.join('')}</svg></div>`;
}

function groupedPanel(data) {
  const legend = `<div class="legend"><span><i class="sw pw"></i>Playwright MCP</span>${data.hosts
    .map((h, i) => `<span><i class="sw" style="background:var(--h${S(data, i)})"></i>${esc(h.short)} + FAI</span>`).join('')}</div>`;
  const charts = [
    { key: 'wallS', label: 'Wall time', note: 'seconds per task, host start to exit', fmt: secs, ratioKey: 'wall', ratioWord: 'faster' },
    { key: 'toolCalls', label: 'Tool calls', note: 'browser tool calls per task', fmt: count, ratioKey: 'toolCalls', ratioWord: 'fewer' },
    { key: 'requests', label: 'Model requests', note: 'host model round trips per task', fmt: count, ratioKey: 'requests', ratioWord: 'fewer' },
    { key: 'costUsd', label: 'Cost', note: 'USD per task (Codex: API-equivalent)', fmt: usd, ratioKey: 'cost', ratioWord: 'cheaper' },
  ];
  return `<section id="bars"><h2>Playwright MCP vs FAI Browser, per host</h2>
    <p class="sub">Per task: sum of per-task medians divided by tasks run. Ratio = Playwright ÷ FAI over tasks both ran; above 1× favours FAI.</p>
    ${legend}<div class="grid2">${charts.map(chart => groupedChart(data, chart)).join('')}</div></section>`;
}

function passStrip(data) {
  const rows = [];
  for (const host of data.hosts) {
    const i = hostIndex(data, host.id);
    for (const cond of ['b', 'a']) {
      const t = data.totals[host.id][cond];
      const cells = data.taskIds.map(task => {
        const c = data.cells.find(x => x.host === host.id && x.condition === cond && x.taskId === task);
        const tip = `${task}: ${c?.attempted ? `${c.passed}/${c.attempted} passed` : 'no runs'}`;
        if (!c?.attempted) {
          return `<span class="cell missing" title="${esc(tip)}">·</span>`;
        }
        if (c.passed < c.attempted) {
          return `<span class="cell fail" title="${esc(tip)}">${c.passed}/${c.attempted}</span>`;
        }
        return `<span class="cell" style="background:${cond === 'a' ? 'var(--pw)' : `var(--h${S(data, i)})`}" title="${esc(tip)}">${c.attempted}</span>`;
      }).join('');
      rows.push(`<div class="srow"><div class="lab">${cond === 'b' ? dot(data, host.id) : '<i class="dot" style="background:var(--pw)"></i>'}
        <span>${esc(host.short)} <span class="c">${cond === 'b' ? 'FAI' : 'Playwright'}</span></span></div>
        <div class="cells">${cells}</div><div class="score">${t ? `${t.passed}/${t.attempted} <span style="color:var(--ink-3);font-weight:500">${pct(t.passRate)}</span>` : '<span style="color:var(--ink-3)">no runs</span>'}</div></div>`);
    }
  }
  return `<section id="pass"><h2>Pass rate</h2>
    <p class="sub">One square per task, in task order (${data.taskIds.map(esc).join(', ')}). The number is runs passed; red marks a failed run; dashed squares have no runs.</p>
    <div class="strip">${rows.join('')}</div></section>`;
}

function smallMultiples(data) {
  const rowH = 15;
  const gap = 5;
  const W = 300;
  const labelW = 64;
  const valueW = 46;
  const H = data.hosts.length * (rowH * 2 + gap * 2 + 4);
  const max = Math.max(1, ...data.cells.filter(c => c.attempted).map(c => c.wallS ?? 0));
  const panels = data.taskIds.map(task => {
    const parts = [];
    let y = 0;
    data.hosts.forEach((host, i) => {
      parts.push(`<text class="t-lab" x="0" y="${y + rowH + 4}" font-size="12">${esc(host.short)}</text>`);
      for (const cond of ['a', 'b']) {
        const c = data.cells.find(x => x.host === host.id && x.condition === cond && x.taskId === task);
        if (c?.attempted && c.wallS != null) {
          const w = (c.wallS / max) * (W - labelW - valueW);
          parts.push(bar(labelW, y, w, rowH, { horizontal: true, cls: cond === 'a' ? 'b-pw' : '', title: `${task}, ${host.name}, ${data.conditions[cond]}: ${secs(c.wallS)} median of ${c.attempted}` })
            .replace('<path class=""', `<path style="fill:var(--h${S(data, i)})"`),
          `<text class="t-val" x="${labelW + w + 5}" y="${y + rowH - 3}" font-size="12">${num(c.wallS)}</text>`);
        } else {
          parts.push(`<text class="t-mute" x="${labelW}" y="${y + rowH - 3}" font-size="11">no ${cond === 'a' ? 'Playwright' : 'FAI'} runs</text>`);
        }
        y += rowH + gap;
      }
      y += 4;
    });
    return `<div class="mini"><h3>${esc(task)}</h3><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${task} wall time`)}">${parts.join('')}</svg></div>`;
  }).join('');
  return `<section id="tasks"><h2>Wall time per task</h2>
    <p class="sub">Median seconds per task; grey is Playwright MCP, colour is FAI on that host. Same scale in every panel (0–${Math.round(max)} s).</p>
    <div class="multiples">${panels}</div></section>`;
}

function corpusPanel(data) {
  if (!data.corpus.length) {
    return '';
  }
  return data.corpus.map(set => {
    const o = set.overall;
    const list = [...set.archetypes].sort((x, y) => (y.passRate ?? 0) - (x.passRate ?? 0) || y.runs - x.runs || x.name.localeCompare(y.name));
    const W = 760;
    const rowH = 26;
    const labelW = 100;
    const valueW = 250;
    const H = list.length * rowH;
    const rows = list.map((row, i) => {
      const y = i * rowH;
      const w = Math.max(0, (row.passRate ?? 0) * (W - labelW - valueW));
      const fail = row.passes < row.runs;
      const flags = [row.dangerClicks ? `${row.dangerClicks} danger` : '', row.falseAutomation ? `${row.falseAutomation} false auto` : '',
        row.dangerOffered ? `${row.dangerOffered} danger offered` : ''].filter(Boolean).join(' · ');
      return `<rect x="${labelW}" y="${y + 4}" width="${W - labelW - valueW}" height="${rowH - 8}" rx="4" fill="var(--surface-2)"/>
        ${bar(labelW, y + 4, w, rowH - 8, { horizontal: true, title: `${row.name}: ${row.passes}/${row.runs}, p50 ${row.p50RunMs} ms` })
          .replace('<path class=""', `<path style="fill:${fail ? 'var(--bad)' : 'var(--accent)'}"`)}
        <text class="t-lab" x="0" y="${y + rowH - 7}">${esc(row.name)}</text>
        <text class="t-val" x="${W - valueW + 8}" y="${y + rowH - 7}"${fail ? ' style="fill:var(--bad)"' : ''}>${row.passes}/${row.runs}<tspan class="t-mute" dx="8">${row.p50RunMs ?? '–'} ms</tspan>${flags ? `<tspan class="t-ratio" dx="8" font-size="12" style="fill:var(--bad)">${esc(flags)}</tspan>` : ''}</text>`;
    }).join('');
    const tile = (value, label, cls = '') => `<div class="tile ${cls}"><div class="v">${value}</div><div class="l">${label}</div></div>`;
    return `<section id="corpus"><h2>QA corpus: the FAI runtime alone</h2>
      <p class="sub">${esc(set.tasks)} adversarial tasks across ${set.archetypes.length} archetypes, run by the FAI runtime and its Jev provider without a host model (${esc(set.source)}, ${set.repeat} repeat${set.repeat === 1 ? '' : 's'}). Bars are pass rate per archetype; red bars had a failure.</p>
      <div class="tiles">${tile(`${o.passes}/${o.runs}`, `passed (${pct(o.passRate)})`)}
        ${tile(`${o.p50RunMs ?? '–'} ms`, `p50 run time (p90 ${o.p90RunMs ?? '–'} ms)`)}
        ${tile(o.dangerClicks, 'danger clicks', o.dangerClicks ? 'warn' : 'ok')}
        ${tile(o.falseAutomation, `false automations of ${o.autoAnswer} auto-answers`, o.falseAutomation ? 'warn' : 'ok')}
        ${tile(o.dangerOffered, 'dangerous choices offered', o.dangerOffered ? 'warn' : 'ok')}</div>
      <svg class="corpus-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pass rate per archetype">${rows}</svg></section>`;
  }).join('');
}

function oversightTable(data) {
  const rows = data.hosts.filter(h => data.totals[h.id].b?.oversight).map(h => {
    const o = data.totals[h.id].b.oversight;
    return `<tr><td>${dot(data, h.id)} ${esc(h.name)}</td><td>${o.receipts}</td><td>${pct(o.oversightRate)}</td><td>${o.autoAnswers}</td><td>${o.falseAutomation}</td></tr>`;
  });
  if (!rows.length) {
    return '';
  }
  return `<section id="oversight" class="hide-social"><h2>FAI oversight</h2>
    <p class="sub">Receipts returned by FAI across all repeats; oversight rate = receipts asking the host to confirm, instruct or decide; auto answers = answers FAI confirmed itself; false automations = auto answers that were wrong.</p>
    <div class="scroll"><table class="data"><thead><tr><th>Host</th><th>Receipts</th><th>Oversight rate</th><th>Auto answers</th><th>False automations</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div></section>`;
}

const phaseCost = t => (t.costWarm == null && t.costCold == null ? '–'
  : `${usd(t.costWarm)} (${t.uncachedWarm?.n ?? 0}) · ${usd(t.costCold)} (${t.uncachedCold?.n ?? 0})`);

function totalsTable(data) {
  const rows = [];
  for (const h of data.hosts) {
    for (const cond of ['a', 'b']) {
      const t = data.totals[h.id][cond];
      rows.push(t
        ? `<tr><td>${esc(h.name)} · ${cond === 'a' ? 'Playwright' : 'FAI'}</td><td>${t.tasks}/${t.taskCount}</td><td>${t.passed}/${t.attempted}</td><td>${num(t.wallS)}</td><td>${count(t.toolCalls)}</td><td>${count(t.requests)}</td><td>${tokens(t.tokens)}</td><td>${tokens(t.priced)}</td><td>${usd(t.costUsd)}</td><td>${phaseCost(t)}</td><td>${t.warmFloor ? `${usd(t.warmFloor.costUsd)} · ${tokens(t.warmFloor.uncached)}` : '–'}</td></tr>`
        : `<tr><td>${esc(h.name)} · ${cond === 'a' ? 'Playwright' : 'FAI'}</td><td colspan="10" style="text-align:left;color:var(--ink-3)">no runs</td></tr>`);
    }
  }
  const ratioRows = data.hosts.filter(h => data.ratios[h.id]).map(h => {
    const r = data.ratios[h.id];
    return `<tr><td>${esc(h.name)}</td><td>${r.tasks.length}</td><td>${ratioText(r.wall) ?? '–'}</td><td>${ratioText(r.toolCalls) ?? '–'}</td><td>${ratioText(r.requests) ?? '–'}</td><td>${ratioText(r.tokens) ?? '–'}</td><td>${ratioText(r.priced) ?? '–'}</td><td>${ratioText(r.cost) ?? '–'}</td></tr>`;
  });
  return `<section id="table" class="hide-social"><h2>Totals</h2><p class="sub">Sums of per-task medians over the tasks each cell ran. Requests are as the host stream shows them; data.json also has requestsAdjusted (+1 per Codex run with a tool call, the hidden MCP schema load). Cost warm · cold is the mean per run over warm and cold-start runs (warm-up runs excluded; older sets have no phase); warm floor is the 25th percentile of warm runs' cost and uncached input.</p>
    <div class="scroll"><table class="data"><thead><tr><th>Host · condition</th><th>Tasks</th><th>Pass</th><th>Wall s</th><th>Calls</th><th>Requests</th><th>Tokens</th><th>Priced</th><th>Cost</th><th>Cost warm · cold</th><th>Warm floor</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    ${ratioRows.length ? `<h3 style="font-size:15px;margin:20px 0 6px">Playwright ÷ FAI over shared tasks</h3><div class="scroll"><table class="data"><thead><tr><th>Host</th><th>Tasks</th><th>Wall</th><th>Calls</th><th>Requests</th><th>Tokens</th><th>Priced</th><th>Cost</th></tr></thead><tbody>${ratioRows.join('')}</tbody></table></div>` : ''}</section>`;
}

function missingPanel(data) {
  if (!data.missing.length && !data.ignored.length) {
    return '';
  }
  const items = data.missing.map(m => {
    const h = hostLabel(data, m.host);
    const who = `<b>${esc(h.name)}</b>, ${esc(data.conditions[m.condition])}`;
    if (m.kind === 'all') {
      return `<li>${who}: no runs, so its ratios are omitted.</li>`;
    }
    if (m.kind === 'tasks') {
      return `<li>${who}: no runs for ${m.tasks.map(t => `<code>${esc(t)}</code>`).join(', ')}.</li>`;
    }
    return `<li>${who}: fewer than ${m.expectedReps} repeats for ${m.tasks.length === data.taskIds.length ? 'every task' : m.tasks.map(t => `<code>${esc(t)}</code>`).join(', ')}.</li>`;
  });
  for (const item of data.ignored) {
    items.push(`<li>Input <code>${esc(item.source)}</code> skipped: ${esc(item.reason)}.</li>`);
  }
  return `<section id="missing" class="notice hide-social"><h2>Missing cells</h2>
    <p class="sub" style="margin:0">The inputs do not cover every host, condition, task and repeat. Ratios use only tasks both conditions ran.</p>
    <ul>${items.join('')}</ul></section>`;
}

function methodology(data) {
  const sets = data.sets.map(s => `<code>${esc(s.source)}</code> (${s.records} runs)`).join(', ');
  const corpus = data.corpus.map(c => `<code>${esc(c.source)}</code>`).join(', ');
  return `<footer><h2>Methodology</h2><ul>
    <li>${data.taskIds.length} read-only browser tasks on a local deterministic fixture site; each host runs every task under A (Playwright MCP as its only browser tool) and B (FAI Browser MCP). Cells are <b>medians of up to ${data.expectedReps} repeats</b>; totals sum the per-task medians.</li>
    <li><b>Wall time</b> runs from spawning the host to its exit, including MCP start-up and every model turn. <b>Model requests</b> are host model round trips. Pass is a strict normalized answer match.</li>
    <li><b>Priced tokens</b> weight the token split relative to one uncached input token: uncached × 1, cached × 0.1, cache write × 1.25, output × 5 (assumed weights, not a price list). <b>Cost</b> applies bench/prices.json (${esc(data.prices.date ?? 'undated')}, USD per million tokens) to the same split; Claude rows are list prices, Codex rows are <b>API-equivalent</b>, since a ChatGPT plan bills quota rather than dollars.</li>
    <li>Runs are deduplicated by task, condition, host and repeat; when sets overlap the newer set wins (${data.dedupe.replaced} runs replaced, ${data.dedupe.records} kept). Sets: ${sets || 'none'}.${corpus ? ` Corpus: ${corpus}.` : ''}</li>
    <li>Generated ${esc(data.date)} by <code>bench/report.mjs</code>. Headless Chromium for both conditions; the harness approves FAI tab requests in about 0.4 s.</li>
    </ul></footer>`;
}

function lede(data) {
  const withRatio = data.hosts.filter(h => data.ratios[h.id]?.wall != null);
  const best = withRatio.reduce((x, h) => (!x || data.ratios[h.id].wall > data.ratios[x.id].wall ? h : x), null);
  const parts = [`${data.taskIds.length} read-only browser tasks, ${data.hosts.length} host model${data.hosts.length === 1 ? '' : 's'}, Playwright MCP vs FAI Browser.`];
  if (best) {
    const r = data.ratios[best.id];
    parts.push(`Up to <b>${ratioText(r.wall)} faster</b> and <b>${ratioText(r.requests)} fewer model requests</b> with FAI (${esc(best.name)}${r.complete ? '' : `, ${r.tasks.length} of ${data.taskIds.length} tasks so far`}).`);
  }
  return parts.join(' ');
}

export function renderHtml(data) {
  const title = data.title || 'FAI Browser Benchmarks';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="FAI Browser vs Playwright MCP: wall time, tool calls, model requests and cost per host model.">
<style>${styles(data)}</style></head>
<body><div class="wrap">
<header><div class="eyebrow">FAI Browser · Benchmark · ${esc(data.date)}</div><h1>${esc(title)}</h1><p class="lede">${lede(data)}</p></header>
<div id="headline">${headline(data)}</div>
${groupedPanel(data)}
<div class="hide-social">${passStrip(data)}${smallMultiples(data)}${corpusPanel(data)}</div>
${oversightTable(data)}${totalsTable(data)}${missingPanel(data)}
<div class="hide-social">${methodology(data)}</div>
</div></body></html>
`;
}
