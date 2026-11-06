#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createDaemon } from '../../src/daemon.js';
import { homePaths, saveDriver } from '../../src/home.js';
import { headlessEnv } from '../../scripts/headless-env.mjs';
import { startStaticSite } from '../lib/qa.mjs';
import { createFakeHub } from '../../test/helpers/fake-hub.js';
import { spawnMcp } from '../../test/helpers/mcp-harness.js';
import { mcpData } from '../../test/helpers/mcp-result.js';
import { PageBridge } from '../../test/helpers/page-bridge.js';
import { createTokenizers, publicTokenizers } from './tokenizers.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_OUT = join(import.meta.dirname);
const TASK = 'Read the page and summarize its main content.';
const BASELINE = Object.freeze({
  generatedAt: '2026-11-06T12:16:35.820Z',
  open: Object.freeze({ text: 481.5, structured: 674, both: 1155.5, codex: 674, claude: 674, openCode: 1192 }),
  act: Object.freeze({ text: 505, structured: 684.5, both: 1189.5, codex: 684.5, claude: 684.5, openCode: 1226.5 }),
  followUp: Object.freeze({ text: 481.5, structured: 674, both: 1155.5, codex: 674, claude: 674, openCode: 1192 }),
});

export const PAGES = Object.freeze([
  { id: 'long-list', kind: 'long page', fixture: 'fixtures/records/long-list.html', path: '/records/long-list.html' },
  { id: 'search-results', kind: 'search results', fixture: 'fixtures/qa/search/results.html', path: '/qa/search/results.html' },
  { id: 'contact-form', kind: 'form', fixture: 'fixtures/site/contact.html', path: '/site/contact.html' },
  { id: 'fare-tables', kind: 'table-heavy', fixture: 'fixtures/state-views.html', path: '/state-views.html' },
  { id: 'workspace-settings', kind: 'settings', fixture: 'fixtures/qa/settings/workspace.html', path: '/qa/settings/workspace.html' },
  { id: 'glossary-links', kind: 'many links', fixture: 'fixtures/qa/links/glossary.html', path: '/qa/links/glossary.html' },
  { id: 'product-grid', kind: 'shop / product', fixture: 'fixtures/records/products.html', path: '/records/products.html' },
  { id: 'docs-cli', kind: 'docs', fixture: 'fixtures/qa/docs/reference/cli.html', path: '/qa/docs/reference/cli.html' },
  { id: 'hotel-results', kind: 'large real-world-shaped saved page', fixture: 'fixtures/records/hotels.html', path: '/records/hotels.html' },
  { id: 'flight-results', kind: 'large real-world-shaped saved page', fixture: 'fixtures/long/flights-live/search.html',
    path: '/long/flights-live/search.html', ready: '#results ul.flights' },
]);

export const SMALL_PAGES = Object.freeze(['contact-form', 'docs-cli']);

const require = createRequire(import.meta.url);
async function packageVersion(name) {
  const direct = require(`${name}/package.json`).version;
  if (direct) return direct;
  let dir = dirname(require.resolve(`${name}/package.json`));
  for (let i = 0; i < 4; i += 1) {
    dir = dirname(dir);
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (pkg.version) return pkg.version;
    } catch {}
  }
  throw new Error(`No version in ${name}/package.json`);
}

function sample(text, tokenizers) {
  return {
    text,
    chars: text.length,
    tokens: Object.fromEntries(tokenizers.map(tokenizer => [tokenizer.id, tokenizer.count ? tokenizer.count(text) : null])),
  };
}

function mcpSamples(result, prefix, tokenizers) {
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const structuredJson = result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent);
  const structuredPreferred = structuredJson || text;
  const openCode = JSON.stringify(result);
  return {
    data: mcpData(result),
    payload: {
      mcpText: text, structuredContent: result.structuredContent, structuredJson,
      hosts: { codex: structuredPreferred, claude: structuredPreferred, openCode, legacyOpenCode: text },
    },
    samples: {
      [`${prefix}Text`]: sample(text, tokenizers),
      [`${prefix}Structured`]: sample(structuredJson, tokenizers),
      [`${prefix}Codex`]: sample(structuredPreferred, tokenizers),
      [`${prefix}Claude`]: sample(structuredPreferred, tokenizers),
      [`${prefix}OpenCode`]: sample(openCode, tokenizers),
    },
  };
}

async function pendingRequest(hub) {
  for (let i = 0; i < 400; i++) {
    const request = hub.published.at(-1)?.find(item => item.state === 'pending');
    if (request) return request;
    await new Promise(done => setTimeout(done, 5));
  }
  throw new Error('No pending FAI request');
}

async function ariaSnapshot(page) {
  const text = await page.locator('body').ariaSnapshot({ mode: 'ai' });
  if (!/\[ref=e\d+\]/.test(text)) throw new Error('AI accessibility snapshot has no element refs');
  return text;
}

async function playwrightMcpSnapshot(page, aria) {
  return `### Page\n- Page URL: ${page.url()}\n- Page Title: ${await page.title()}\n### Snapshot\n\`\`\`yaml\n${aria}\n\`\`\``;
}

async function measurePage(browser, site, definition, tokenizers) {
  const home = await mkdtemp(join(tmpdir(), 'fai-tokens-'));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  let daemon;
  let mcp;
  try {
    saveDriver('agent', homePaths({ home, env: {} }));
    const page = await context.newPage();
    await context.route('**/*', route => {
      const url = route.request().url();
      return url.startsWith(site.origin + '/') || url.startsWith('data:') ? route.continue() : route.abort();
    });
    const url = site.origin + definition.path;
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    if (definition.ready) await page.waitForSelector(definition.ready, { timeout: 10_000 });

    const bridge = new PageBridge(page, { level: 'interactive' });
    const hub = createFakeHub();
    hub.bridgeForTab = () => bridge;
    daemon = createDaemon({ home, env: {}, port: 0, hub,
      providerFactory: () => { throw new Error('Agent direct must not construct a provider'); } });
    await daemon.listen();
    mcp = spawnMcp({ PATH: process.env.PATH, HOME: home, FAI_HOME: home,
      FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '2000' });
    await mcp.initialize();

    const opening = mcp.callTool('fai_browser_open', {
      origins: [site.origin], allowedUrls: [url], reason: 'Measure observation size', task: TASK, mode: 'interactive',
    });
    const pending = await pendingRequest(hub);
    await hub.approve(pending.requestId, { level: 'interactive', origin: site.origin });
    const openResult = await opening;
    const open = mcpSamples(openResult, 'faiOpen', tokenizers);
    if (openResult.isError || open.data.status !== 'observed') {
      throw new Error(`FAI open failed for ${definition.id}: ${JSON.stringify(openResult)}`);
    }
    const playwrightOpen = await ariaSnapshot(page);
    const playwrightMcpOpen = await playwrightMcpSnapshot(page, playwrightOpen);

    const scroll = open.data.actions.find(action => action.description === 'scroll down');
    if (!scroll) throw new Error(`No scroll-down action for ${definition.id}`);
    const actResult = await mcp.callTool('fai_browser_act', {
      requestId: pending.requestId, actionId: scroll.id, revision: open.data.revision,
    });
    const act = mcpSamples(actResult, 'faiAct', tokenizers);
    if (actResult.isError || !['acted', 'completed'].includes(act.data.status)) {
      throw new Error(`FAI act failed for ${definition.id}: ${JSON.stringify(actResult)}`);
    }
    const playwrightAct = await ariaSnapshot(page);
    const playwrightMcpAct = await playwrightMcpSnapshot(page, playwrightAct);

    const followUpResult = await mcp.callTool('fai_browser_observe', {
      requestId: pending.requestId, focus: 'main content details', digestChars: 6000,
    });
    const followUp = mcpSamples(followUpResult, 'faiFollowUp', tokenizers);
    if (followUpResult.isError || followUp.data.status !== 'observed') {
      throw new Error(`FAI follow-up failed for ${definition.id}: ${JSON.stringify(followUpResult)}`);
    }

    return {
      id: definition.id, kind: definition.kind, fixture: definition.fixture, path: definition.path,
      sourceUrl: definition.sourceUrl, capturedAt: definition.capturedAt, htmlBytes: definition.htmlBytes,
      task: TASK, action: scroll.description,
      payloads: {
        open: open.payload, act: act.payload, followUp: followUp.payload,
        playwrightOpen, playwrightAct, playwrightMcpOpen, playwrightMcpAct,
      },
      samples: {
        ...open.samples, ...act.samples, ...followUp.samples,
        playwrightOpen: sample(playwrightOpen, tokenizers),
        playwrightAct: sample(playwrightAct, tokenizers),
        playwrightMcpOpen: sample(playwrightMcpOpen, tokenizers),
        playwrightMcpAct: sample(playwrightMcpAct, tokenizers),
      },
    };
  } finally {
    if (mcp) await mcp.close();
    if (daemon) await daemon.close();
    await context.close();
    await rm(home, { recursive: true, force: true });
  }
}

export function median(values) {
  const present = values.filter(Number.isFinite);
  if (!present.length) return null;
  const sorted = [...present].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function metric(page, name, field, tokenizer) {
  const value = page.samples[name][field];
  return field === 'tokens' ? value[tokenizer] : value;
}

function combined(page, prefix, field, tokenizer) {
  const text = metric(page, `${prefix}Text`, field, tokenizer);
  const structured = metric(page, `${prefix}Structured`, field, tokenizer);
  return field === 'tokens' && (!Number.isFinite(text) || !Number.isFinite(structured)) ? null : text + structured;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

const COMPARISONS = [
  { id: 'openText', label: 'Open', prefix: 'faiOpenText', pw: 'playwrightMcpOpen' },
  { id: 'openStructured', label: 'Open: structuredContent JSON', prefix: 'faiOpenStructured', pw: 'playwrightMcpOpen' },
  { id: 'openBoth', label: 'Open: text + structuredContent', prefix: 'faiOpen', combined: true, pw: 'playwrightMcpOpen' },
  { id: 'actText', label: 'Act', prefix: 'faiActText', pw: 'playwrightMcpAct' },
  { id: 'actStructured', label: 'Act: structuredContent JSON', prefix: 'faiActStructured', pw: 'playwrightMcpAct' },
  { id: 'actBoth', label: 'Act: text + structuredContent', prefix: 'faiAct', combined: true, pw: 'playwrightMcpAct' },
  { id: 'followUpText', label: 'Follow-up', prefix: 'faiFollowUpText', pw: 'playwrightMcpAct' },
  { id: 'followUpStructured', label: 'Follow-up: structuredContent JSON', prefix: 'faiFollowUpStructured', pw: 'playwrightMcpAct' },
  { id: 'followUpBoth', label: 'Follow-up: text + structuredContent', prefix: 'faiFollowUp', combined: true, pw: 'playwrightMcpAct' },
  { id: 'openCodex', label: 'Open: Codex model view', prefix: 'faiOpenCodex', pw: 'playwrightMcpOpen' },
  { id: 'openClaude', label: 'Open: Claude model view', prefix: 'faiOpenClaude', pw: 'playwrightMcpOpen' },
  { id: 'openOpenCode', label: 'Open: OpenCode 2 whole result', prefix: 'faiOpenOpenCode', pw: 'playwrightMcpOpen' },
  { id: 'actCodex', label: 'Act: Codex model view', prefix: 'faiActCodex', pw: 'playwrightMcpAct' },
  { id: 'actClaude', label: 'Act: Claude model view', prefix: 'faiActClaude', pw: 'playwrightMcpAct' },
  { id: 'actOpenCode', label: 'Act: OpenCode 2 whole result', prefix: 'faiActOpenCode', pw: 'playwrightMcpAct' },
  { id: 'followUpCodex', label: 'Follow-up: Codex model view', prefix: 'faiFollowUpCodex', pw: 'playwrightMcpAct' },
  { id: 'followUpClaude', label: 'Follow-up: Claude model view', prefix: 'faiFollowUpClaude', pw: 'playwrightMcpAct' },
  { id: 'followUpOpenCode', label: 'Follow-up: OpenCode 2 whole result', prefix: 'faiFollowUpOpenCode', pw: 'playwrightMcpAct' },
];

function comparisonMetric(page, comparison, field, tokenizer) {
  if (comparison.combined) return combined(page, comparison.prefix, field, tokenizer);
  return metric(page, comparison.prefix, field, tokenizer);
}

export function summarize(pages, tokenizers) {
  return Object.fromEntries(COMPARISONS.map(comparison => {
    const faiChars = median(pages.map(page => comparisonMetric(page, comparison, 'chars')));
    const pwChars = median(pages.map(page => metric(page, comparison.pw, 'chars')));
    const byTokenizer = Object.fromEntries(tokenizers.map(tokenizer => {
      const faiTokens = median(pages.map(page => comparisonMetric(page, comparison, 'tokens', tokenizer.id)));
      const pwTokens = median(pages.map(page => metric(page, comparison.pw, 'tokens', tokenizer.id)));
      return [tokenizer.id, {
        status: tokenizer.status,
        faiTokens, pwTokens,
        tokenRatio: ratio(pwTokens, faiTokens),
        tokenReduction: faiTokens && pwTokens ? 1 - faiTokens / pwTokens : null,
        medianPerPageTokenRatio: median(pages.map(page => ratio(
          metric(page, comparison.pw, 'tokens', tokenizer.id),
          comparisonMetric(page, comparison, 'tokens', tokenizer.id),
        ))),
      }];
    }));
    return [comparison.id, {
      label: comparison.label, faiChars, pwChars,
      charRatio: ratio(pwChars, faiChars),
      charReduction: faiChars && pwChars ? 1 - faiChars / pwChars : null,
      medianPerPageCharRatio: median(pages.map(page => ratio(
        metric(page, comparison.pw, 'chars'), comparisonMetric(page, comparison, 'chars'),
      ))),
      tokenizers: byTokenizer,
    }];
  }));
}

function number(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function integer(value) {
  return Number.isInteger(value) ? String(value) : number(value, 1);
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a';
}

function countCell(values, tokenizerId) {
  const value = values?.[tokenizerId];
  return Number.isFinite(value) ? integer(value) : 'not measured in this run';
}

function comparisonCell(entry, tokenizerId, side) {
  return countCell({ value: entry?.tokenizers?.[tokenizerId]?.[side] }, 'value');
}

function ratioCell(entry, tokenizerId) {
  const values = entry?.tokenizers?.[tokenizerId];
  if (!Number.isFinite(values?.tokenRatio)) return 'not measured in this run';
  return `${number(values.tokenRatio, 2)}× / ${percent(values.tokenReduction)} smaller`;
}

function publicPage(page, includeText) {
  if (includeText) return page;
  const { payloads, samples, ...metadata } = page;
  return {
    ...metadata,
    samples: Object.fromEntries(Object.entries(samples).map(([name, measured]) => [name, {
      chars: measured.chars, tokens: measured.tokens,
    }])),
  };
}

export function publicData(data) {
  return { ...data, pages: data.pages.map(page => publicPage(page, data.corpus === 'fixtures')) };
}

export function renderMarkdown(source) {
  const data = publicData(source);
  const { summary, pages, tokenizers } = data;
  const real = data.corpus === 'real';
  const claudeCounted = tokenizers.some(t => /^claude/.test(t.id) && t.status === 'available');
  const captureDates = [...new Set(pages.map(page => page.capturedAt).filter(Boolean))].sort();
  const lines = [
    '# FAI Agent direct vs Playwright-style accessibility snapshot',
    '',
    `Generated: ${data.generatedAt}`,
    '',
    real && captureDates.length ? `Captured: ${captureDates[0]}${captureDates.at(-1) !== captureDates[0] ? ` through ${captureDates.at(-1)}` : ''}` : null,
    real && captureDates.length ? '' : null,
    claudeCounted
      ? '**Token columns:** exact tokenizer counts where available; chars/4 is a rough baseline. Claude Sonnet 5.5 and Opus 5.5 come from Anthropic\'s count_tokens endpoint (owner run), because current Claude models have no official offline tokenizer.'
      : '**Token columns:** exact tokenizer counts where available; chars/4 is a rough baseline. Claude Sonnet 5.5 and Opus 5.5 are **not measured in this run** because current Claude models have no official offline tokenizer.',
    '',
    '## Method',
    '',
    real
      ? `- ${pages.length} public, logged-out pages captured as self-contained static copies on the dates above, then served from \`bench/tokens/pages/\` on loopback. Scripts were stripped, available CSS was inlined, and images were replaced with same-size/same-alt placeholders. Captured pages and raw strings are not committed.`
      : `- ${pages.length} existing local fixture pages, served from \`fixtures/\` by \`startStaticSite\` on loopback; no live sites.`,
    '- One headless Chromium, one page at a time, 1280 × 900 viewport, `en-US`; each page uses a fresh browser context, daemon, MCP server and temporary FAI home.',
    '- FAI path: real stdio MCP server → real daemon/runtime → test hub → `PageBridge` → real `extension/page.js` in Chromium. Agent direct, interactive level, no screenshots and no provider.',
    `- The opening task is \`${TASK}\`. The act is \`${pages[0]?.action ?? 'scroll down'}\`. The separate follow-up is one \`fai_browser_observe\` with \`focus: "main content details"\` and \`digestChars: 6000\`, after the act.`,
    '- FAI results are text-only. The primary FAI measurement is the exact MCP text block, which is also the Codex/reproduced Claude Code/legacy OpenCode model-visible fallback. OpenCode 2 whole-result JSON is reported separately. MCP/JSON-RPC envelopes, tool schemas and host instructions are not counted; see `docs/dev/mcp-result-shape.md`.',
    '- Raw snapshots are exact `page.locator(\'body\').ariaSnapshot({ mode: \'ai\' })` strings at the same before/after-act DOM states. Snapshot MCP columns add the explicit `browser_snapshot` Page/Snapshot YAML wrapper and local URL/title. This counts full snapshot strings rather than a current default host envelope: Playwright MCP 0.0.83 links automatic snapshots as files, and a host decides when to read them. The separate native task benchmark counts actual MCP text plus issued snapshot artifacts actually read.',
    '- OpenAI counts use `js-tiktoken` with `o200k_base`, the closest public encoding for current Sol/Astra-era GPT models. Kimi counts use Moonshot\'s published Kimi K2 `tiktoken.model` and official pattern, with no chat template or BOS/EOS. These count the same strings, not provider-side envelopes.',
    `- Versions: FAI Browser ${data.versions.fai}, Node ${data.versions.node}, playwright-core ${data.versions.playwrightCore}, Chromium ${data.versions.chromium}, MCP SDK ${data.versions.mcpSdk}.`,
    '',
    'Ratios are snapshot ÷ FAI using medians across pages; “smaller” is the corresponding FAI token reduction. The ratio of medians is not the median of per-page ratios; the latter is retained in JSON.',
    '',
    '## Medians and ratios',
    '',
    '| Tokenizer | FAI open | Snapshot open | Ratio / reduction | FAI act | Snapshot after act | Ratio / reduction | FAI follow-up | Snapshot after act | Ratio / reduction |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ].filter(line => line !== null);
  for (const tokenizer of tokenizers) {
    lines.push(`| ${tokenizer.label} | ${comparisonCell(summary.openText, tokenizer.id, 'faiTokens')} | ${comparisonCell(summary.openText, tokenizer.id, 'pwTokens')} | ${ratioCell(summary.openText, tokenizer.id)} | ${comparisonCell(summary.actText, tokenizer.id, 'faiTokens')} | ${comparisonCell(summary.actText, tokenizer.id, 'pwTokens')} | ${ratioCell(summary.actText, tokenizer.id)} | ${comparisonCell(summary.followUpText, tokenizer.id, 'faiTokens')} | ${comparisonCell(summary.followUpText, tokenizer.id, 'pwTokens')} | ${ratioCell(summary.followUpText, tokenizer.id)} |`);
  }
  lines.push('', '### OpenCode 2 whole-result host view', '',
    '| Tokenizer | FAI open | Snapshot open | Ratio / reduction | FAI act | Snapshot after act | Ratio / reduction | FAI follow-up | Ratio / reduction |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const tokenizer of tokenizers) {
    lines.push(`| ${tokenizer.label} | ${comparisonCell(summary.openOpenCode, tokenizer.id, 'faiTokens')} | ${comparisonCell(summary.openOpenCode, tokenizer.id, 'pwTokens')} | ${ratioCell(summary.openOpenCode, tokenizer.id)} | ${comparisonCell(summary.actOpenCode, tokenizer.id, 'faiTokens')} | ${comparisonCell(summary.actOpenCode, tokenizer.id, 'pwTokens')} | ${ratioCell(summary.actOpenCode, tokenizer.id)} | ${comparisonCell(summary.followUpOpenCode, tokenizer.id, 'faiTokens')} | ${ratioCell(summary.followUpOpenCode, tokenizer.id)} |`);
  }
  if (data.baseline) {
    const before = data.baseline.open;
    const rows = [
      ['Text', before.text, summary.openText.tokenizers.chars4.faiTokens],
      ['structuredContent JSON', before.structured, summary.openStructured.tokenizers.chars4.faiTokens],
      ['Text + structuredContent', before.both, summary.openBoth.tokenizers.chars4.faiTokens],
      ['Codex model view', before.codex, summary.openCodex.tokenizers.chars4.faiTokens],
      ['Claude Code model view', before.claude, summary.openClaude.tokenizers.chars4.faiTokens],
      ['OpenCode 2 whole-result JSON', before.openCode, summary.openOpenCode.tokenizers.chars4.faiTokens],
      ['Legacy OpenCode text only', before.text, summary.openText.tokenizers.chars4.faiTokens],
    ];
    lines.push('', '## Before / after: open result medians', '',
      'Counts are chars/4 estimates. The baseline is the earlier merged run in this directory; its OpenCode 2 value is computed from the same raw text and structured payloads.',
      '', '| Host-visible view | Before | After |', '|---|---:|---:|');
    for (const [label, oldValue, newValue] of rows) lines.push(`| ${label} | ${integer(oldValue)} | ${integer(newValue)} |`);
  }
  lines.push('', '## Page sizes', '',
    '| Page | HTML bytes | FAI open chars | Snapshot open chars | FAI act chars | Snapshot after-act chars |',
    '|---|---:|---:|---:|---:|---:|');
  for (const page of pages) {
    const label = real && page.sourceUrl ? `[${page.id}](${page.sourceUrl})` : page.id;
    lines.push(`| ${label} | ${integer(page.htmlBytes)} | ${integer(page.samples.faiOpenText.chars)} | ${integer(page.samples.playwrightMcpOpen.chars)} | ${integer(page.samples.faiActText.chars)} | ${integer(page.samples.playwrightMcpAct.chars)} |`);
  }
  for (const tokenizer of tokenizers) {
    lines.push('', `## Per page: ${tokenizer.label}`, '',
      Number.isFinite(pages[0]?.samples.faiOpenText.tokens[tokenizer.id]) ? null : '**Pending owner run.**',
      Number.isFinite(pages[0]?.samples.faiOpenText.tokens[tokenizer.id]) ? null : '',
      '| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |',
      '|---|---:|---:|---:|---:|---:|');
    for (const page of pages) {
      lines.push(`| ${page.id} | ${countCell(page.samples.faiOpenText.tokens, tokenizer.id)} | ${countCell(page.samples.faiActText.tokens, tokenizer.id)} | ${countCell(page.samples.faiFollowUpText.tokens, tokenizer.id)} | ${countCell(page.samples.playwrightMcpOpen.tokens, tokenizer.id)} | ${countCell(page.samples.playwrightMcpAct.tokens, tokenizer.id)} |`);
    }
  }
  if (real) {
    const open = summary.openText.tokenizers.openaiO200k;
    lines.push('', '## Suggested website claim', '',
      `Across ${pages.length} captured public pages, FAI Agent direct’s opening result used **${percent(open.tokenReduction)} fewer o200k_base tokens** than a full Playwright MCP-style accessibility snapshot (median ${integer(open.faiTokens)} vs ${integer(open.pwTokens)} tokens); this compares output size, not task success or accuracy.`,
    );
  }
  lines.push('', '## Caveats', '',
    '- This approximates Playwright MCP with Playwright\'s own AI ARIA snapshot engine plus the public MCP response wrapper. It does not run Microsoft Playwright MCP itself, so version-specific formatting and ref allocation can differ. No default truncation is applied.',
    claudeCounted
      ? '- Claude counts come from the owner-run `bench/tokens/count-anthropic.mjs` (Anthropic count_tokens endpoint) and include that endpoint\'s minimal one-user-message envelope, a few tokens per string. The old `@anthropic-ai/tokenizer` is not used as a substitute for current Claude models.'
      : '- Claude counts were not measured in this run. The optional owner-only `bench/tokens/count-anthropic.mjs` uses Anthropic\'s count_tokens endpoint and its minimal one-user-message envelope. The old `@anthropic-ai/tokenizer` is not used as a substitute for current Claude models.',
    '- FAI is task-ranked, not a complete accessibility tree. Defaults cap the digest at about 1,500 characters / 25 blocks and list at most 80 control actions at interactive level (40 at read-only/reversible; page actions are additional). The page script itself caps observed controls at 100. The 6,000-character follow-up is one deliberate read-more call, not a bound on total conversation cost.',
    '- A snapshot includes accessibility roles, names, states and tree relationships that FAI may omit. FAI instead includes trusted status/next-step metadata and task-ranked offered actions. The outputs are not feature-equivalent. **Success and accuracy are not measured here.**',
    real
      ? '- These are static captured copies, not live-site runs; dynamic behavior, personalization, regional variants, consent states and later page changes are outside the measurement. Medians aggregate unlike pages and should not be generalized to the web. Public JSON/Markdown contain counts and sizes only, no captured page text.'
      : '- The fixture corpus is small and synthetic. `hotel-results` and `flight-results` are larger real-world-shaped local fixtures, not live captures. Medians aggregate unlike pages and should not be generalized to the web.',
    '- Random local ports and generated ids remain in the measured payloads, so counts can vary slightly between runs.',
    '',
    real
      ? 'Reproduce by running `node bench/tokens/capture.mjs`, then `npm run bench:tokens:real` (install locked dependencies first). Captures, tokenizer cache and raw measurement strings stay local.'
      : 'Reproduce with `npm run bench:tokens` (install locked dependencies first). For a two-page run: `node bench/tokens/measure.mjs --pages contact-form,docs-cli --out /tmp/fai-tokens`.',
    '',
  );
  return lines.filter(line => line !== null).join('\n');
}

async function realDefinitions() {
  const list = JSON.parse(await readFile(join(DEFAULT_OUT, 'real-pages.json'), 'utf8'));
  const definitions = [];
  for (const entry of list) {
    const directory = join(DEFAULT_OUT, 'pages', entry.id);
    try {
      const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
      const html = await stat(join(directory, 'index.html'));
      definitions.push({ id: entry.id, kind: entry.kind, path: `/${entry.id}/`, sourceUrl: meta.url,
        capturedAt: meta.capturedAt, htmlBytes: html.size });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return definitions;
}

async function fixtureDefinitions() {
  return Promise.all(PAGES.map(async definition => ({
    ...definition, htmlBytes: (await stat(join(ROOT, definition.fixture))).size,
  })));
}

export async function writeResults(data, outDir = DEFAULT_OUT) {
  const suffix = data.corpus === 'real' ? '-real' : '';
  const publicResults = publicData(data);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `results${suffix}.json`), JSON.stringify(publicResults, null, 2) + '\n');
  await writeFile(join(outDir, `results${suffix}.md`), renderMarkdown(data));
  if (data.corpus === 'real') {
    await mkdir(join(outDir, 'pages'), { recursive: true });
    await writeFile(join(outDir, 'pages', 'measurement-strings.json'), JSON.stringify(data, null, 2) + '\n');
  }
  return join(outDir, `results${suffix}.md`);
}

export async function measure({ corpus = 'fixtures', pageIds, outDir = DEFAULT_OUT, quiet = false,
  includeKimi = true, tokenizers: suppliedTokenizers } = {}) {
  if (!['fixtures', 'real'].includes(corpus)) throw new Error(`Unknown corpus: ${corpus}`);
  const available = corpus === 'real' ? await realDefinitions() : await fixtureDefinitions();
  const selectedIds = pageIds ?? available.map(page => page.id);
  const selected = selectedIds.map(id => {
    const definition = available.find(page => page.id === id);
    if (!definition) throw new Error(`Unknown or uncaptured page id: ${id}`);
    return definition;
  });
  if (!selected.length) throw new Error(`At least one ${corpus} page is required`);
  const tokenizers = suppliedTokenizers ?? await createTokenizers({ includeKimi });
  const site = await startStaticSite(join(ROOT, corpus === 'real' ? 'bench/tokens/pages' : 'fixtures'));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      env: headlessEnv(), args: ['--no-sandbox', '--lang=en-US'],
    });
    const pages = [];
    for (const definition of selected) {
      if (!quiet) process.stderr.write(`measuring ${definition.id}\n`);
      pages.push(await measurePage(browser, site, definition, tokenizers));
    }
    const data = {
      schemaVersion: 3,
      corpus,
      generatedAt: new Date().toISOString(),
      baseline: corpus === 'fixtures' ? BASELINE : undefined,
      tokenizers: publicTokenizers(tokenizers),
      versions: {
        fai: JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version,
        node: process.version,
        playwrightCore: await packageVersion('playwright-core'),
        mcpSdk: await packageVersion('@modelcontextprotocol/sdk'),
        chromium: browser.version(),
      },
      method: {
        task: TASK, action: 'scroll down', mode: 'interactive', viewport: { width: 1280, height: 900 },
        followUp: { focus: 'main content details', digestChars: 6000 },
        snapshot: "page.locator('body').ariaSnapshot({ mode: 'ai' })",
        snapshotMcp: 'full explicit browser_snapshot-style string; automatic file-link envelopes and host artifact-read policy not measured',
        server: `bench/lib/qa.mjs startStaticSite(${corpus === 'real' ? 'bench/tokens/pages' : 'fixtures'})`,
      },
      pages,
      summary: summarize(pages, tokenizers),
    };
    const results = await writeResults(data, outDir);
    return { ...data, results };
  } finally {
    if (browser) await browser.close();
    await site.close();
  }
}

async function cli() {
  const args = process.argv.slice(2);
  let pageIds;
  let outDir = DEFAULT_OUT;
  let corpus = 'fixtures';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pages') pageIds = args[++i].split(',').filter(Boolean);
    else if (args[i] === '--out') outDir = resolve(args[++i]);
    else if (args[i] === '--corpus') corpus = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const data = await measure({ pageIds, outDir, corpus });
  process.stdout.write(`${JSON.stringify({ corpus, pages: data.pages.length,
    openText: data.summary.openText.tokenizers, results: data.results }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await cli();
}
