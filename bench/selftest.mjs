#!/usr/bin/env node
// Offline checks for the comparison harness; spends no model quota.
//   node bench/selftest.mjs            metrics, site and task answers
//   node bench/selftest.mjs --browser  also launches Chromium with the extension and checks that the harness can
//                                      approve a tab through the popup, using today's companion (src/bridge.js)
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate, countModelRequests, extractAnswer, faiResultFrom, grade, markdownTable, normalize, oversightFor, parseEvents,
  tokenBreakdown,
} from './lib/metrics.mjs';
import { codexArgs } from './lib/codex.mjs';
import { startSite } from './serve-site.mjs';

const checks = [];
const ok = name => checks.push(name);

// --- answers -----------------------------------------------------------------------------------------------------
assert.deepEqual(extractAnswer('Found it.\nANSWER: $37'), { answer: '$37', formatOk: true });
assert.deepEqual(extractAnswer('ANSWER: **X-Lanternfish-Token**.\n'), { answer: 'X-Lanternfish-Token', formatOk: true });
assert.deepEqual(extractAnswer('ANSWER: a\nmore text'), { answer: 'a', formatOk: false });
assert.deepEqual(extractAnswer('no answer here'), { answer: null, formatOk: false });
assert.equal(normalize('Batch 7 reconciled: 1,284 records'), 'batch7reconciled1284records');
const suite = JSON.parse(await readFile(join(import.meta.dirname, 'tasks.json'), 'utf8'));
const task = id => suite.tasks.find(item => item.id === id);
assert.equal(grade(task('pricing-pro'), '$37 per month').pass, true);
assert.equal(grade(task('pricing-pro'), '$370 per year').pass, false);
assert.deepEqual(grade(task('pricing-pro'), 'The Pro plan costs $37 per month'), { pass: false, passLoose: true });
assert.equal(grade(task('about-members'), 'Elif Demir, Jonah Weiss, Mira Okafor, Priya Raman, Tomas Lindqvist').pass, true);
assert.equal(grade(task('about-members'), 'Mira Okafor, Tomas Lindqvist').pass, false);
assert.equal(grade(task('docs-auth-header'), '`X-Lanternfish-Token`').pass, true);
ok('answer extraction and grading');

// --- events --------------------------------------------------------------------------------------------------------
const lines = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate' } },
  { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate', status: 'completed', result: { content: [] } } },
  { type: 'item.started', item: { id: 'i2', type: 'mcp_tool_call', server: 'fai_browser', tool: 'fai_browser_open' } },
  { type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'fai_browser', tool: 'fai_browser_open', status: 'completed',
    result: { content: [{ type: 'text', text: JSON.stringify({ v: 1, runId: 'r1', status: 'completed', cost: { decisions: 3, elapsedMs: 1900 } }) }] } } },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'ANSWER: x' } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 4 } },
].map((event, i) => ({ at: i * 100, text: JSON.stringify(event) }));
const parsed = parseEvents(lines);
assert.equal(parsed.toolCalls, 2);
assert.deepEqual(parsed.toolCallsByName, { 'playwright.browser_navigate': 1, 'fai_browser.fai_browser_open': 1 });
assert.deepEqual(parsed.usage, { input: 100, cachedInput: 40, output: 10, reasoning: 4, turns: 1, total: 110 });
assert.equal(parsed.calls[0].ms, 100);
assert.equal(parsed.lastMessage, 'ANSWER: x');
assert.equal(parsed.requests, 3, 'two tool rounds plus the answer');
// Parallel calls from one response are one request; a message before a call shares its request.
assert.equal(countModelRequests([
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message' } },
  { type: 'item.started', item: { type: 'mcp_tool_call' } },
  { type: 'item.started', item: { type: 'mcp_tool_call' } },
  { type: 'item.completed', item: { type: 'mcp_tool_call' } },
  { type: 'item.completed', item: { type: 'mcp_tool_call' } },
  { type: 'item.completed', item: { type: 'agent_message' } },
]), 2);
assert.equal(faiResultFrom(parsed.calls[1].result).cost.decisions, 3);
assert.equal(faiResultFrom({ structuredContent: { v: 1, runId: 'r2', status: 'checkpoint' } }).runId, 'r2');
assert.equal(faiResultFrom({ structuredContent: { v: 2, runId: 'r3', status: 'completed' } }).runId, 'r3');
{
  const task = { expected: ['$37 per month'], match: 'exact' };
  const summary = oversightFor([
    { oversight: 'instruct', verdictKind: 'needs_decision', nextKind: 'rerun', verdictAnswer: null },
    { oversight: 'none', verdictKind: 'verified', nextKind: 'answer', verdictAnswer: 'Pro | $37 per month' },
  ], task);
  assert.deepEqual(summary, { receipts: 2, oversightReceipts: 1, autoAnswers: 1, hopAutoAnswers: 0, hopUngraded: 0,
    falseAutomation: 0, finalVerdict: 'verified', finalNext: 'answer', verdictAnswer: 'Pro | $37 per month', verdictAnswerPass: true });
  assert.equal(oversightFor([{ oversight: 'none', verdictAnswer: 'Team | $96' }], task).falseAutomation, 1);
  assert.equal(oversightFor([{ verified: true }], task).receipts, 0, 'v1 results carry no receipt');
}
ok('Codex JSONL parsing and FAI result extraction');

const records = [
  { taskId: 't', condition: 'a', outcome: 'ok', pass: true, wallMs: 20_000, toolCalls: 4, tokens: { total: 1000, input: 900, cachedInput: 500, output: 100 } },
  { taskId: 't', condition: 'b', outcome: 'ok', pass: true, wallMs: 10_000, toolCalls: 2, tokens: { total: 500, input: 450, cachedInput: 200, output: 50 }, fai: { decisions: 2, elapsedMs: 900 } },
];
const summary = aggregate(records, ['t'], ['a', 'b']);
assert.equal(summary.ratio.wall, 2);
assert.match(markdownTable(summary, ['t'], ['a', 'b']), /wall 2\.00x/);
assert.deepEqual(tokenBreakdown({ input: 1000, cachedInput: 800, output: 10, total: 1010 }),
  { cachedInput: 800, uncachedInput: 200, output: 10, total: 1010, priced: 200 + 80 + 50 });
assert.equal(tokenBreakdown({ input: 1000, cachedInput: 800, output: 10 }, { uncached: 1, cached: 0, output: 1 }).priced, 210);
const withBaseline = aggregate([...records.map(r => ({ ...r, requests: r.toolCalls + 1 })),
  { ...records[1], condition: 'b-baseline', wallMs: 15_000, toolCalls: 3, requests: 4 }],
['t'], ['a', 'b-baseline', 'b']);
assert.deepEqual(withBaseline.ratios.map(ratio => [ratio.over, ratio.wall, ratio.requests]), [['a', 2, 5 / 3], ['b-baseline', 1.5, 4 / 3]]);
assert.equal(withBaseline.totals['b-baseline'].requests, 4);
const table = markdownTable(withBaseline, ['t'], ['a', 'b-baseline', 'b']);
assert.match(table, /\| t \| B-baseline FAI Browser \| 1\/1 \| - \| 200 \| - \| 250 \| 50 \| - \| 15\.0 \| 3 \| 4 \|/);
assert.match(table, /B-baseline FAI Browser \/ B FAI Browser over 1 shared task\(s\).*wall 1\.50x/);
assert.match(table, /\*\*Total\*\* \(1 tasks\) \| B FAI Browser/);
ok('aggregation, A/B and baseline ratios, request counts and priced tokens');

const argv = codexArgs({ model: 'm', effort: 'medium', workdir: '/w', finalPath: '/f', serverName: 's',
  server: { command: 'x', args: ['--a'], env: { K: 'v' } }, features: new Set(['shell_tool']) });
assert.ok(argv.includes('mcp_servers.s.default_tools_approval_mode="approve"'));
assert.ok(argv.includes('mcp_servers.s.env={K="v"}'));
assert.deepEqual(argv.filter(arg => arg === '--disable').length, 1, 'only features this Codex knows are disabled');
ok('codex argument builder');

// --- site and task answers -----------------------------------------------------------------------------------------
const site = await startSite();
try {
  const text = async path => (await fetch(site.origin + path)).text();
  assert.match(await text('/about.html'), /Elif Demir/);
  assert.match(await text('/pricing.html'), /\$37 per month/);
  assert.match(await text('/docs/api/authentication.html'), /X-Lanternfish-Token/);
  assert.match(await text('/catalog/page-3.html'), /<li class="card"><strong>Vesper[^]*?Russet Leather Wallet/);
  const page3 = [...(await text('/catalog/page-3.html')).matchAll(/<strong>([^<]+)<\/strong>/g)].map(match => match[1]);
  assert.equal(page3[4], 'Russet Leather Wallet');
  assert.match(await text('/catalog/page-2.html'), /Kestrel Field Lamp<\/strong> &middot; SKU LF-206 &middot; Available on the Team plan/);
  assert.match(await text('/pricing.html'), /Team<\/td><td>\$96 per month/);
  assert.match(await text('/slow'), /setTimeout[^]*Batch 7 reconciled: 1,284 records[^]*800/);
  assert.match(await text('/'), /href="\/settings.html" target="_blank"/);
  assert.match(await text('/settings.html'), /Pacific\/Auckland/);
  assert.match(await text('/docs/index.html'), /Migrating Ledgers to Version Two<\/strong> by Priya Raman/);
  assert.match(await text('/about.html'), /Priya Raman &mdash; Documentation lead/);
  // The step tasks: the office pages behind Contact hold each first-hop value.
  assert.match(await text('/contact.html'), /href="\/offices\/lisbon.html">Lisbon office<\/a> &mdash; led by Elif Demir/);
  assert.match(await text('/offices/lisbon.html'), /Office lead: Elif Demir[^]*Opening hours: 09:00&ndash;17:30 WET/);
  assert.match(await text('/offices/oslo.html'), /Workspace plan: Pro/);
  assert.match(await text('/pricing.html'), /pro:"Pro includes 250 GB storage/);
  assert.match(await text('/offices/auckland.html'), /Showroom items: catalog page 3/);
  assert.equal((await fetch(`${site.origin}/contact`, { method: 'POST', body: 'x=1' })).status, 405);
  assert.equal(site.stats.forbidden.length, 1);
  assert.equal((await fetch(`${site.origin}/../package.json`)).status, 404);
  ok('fixture site serves every expected answer; POST refused and counted');
} finally {
  await site.close();
}

// --- optional: popup approval against today's companion ------------------------------------------------------------
if (process.argv.includes('--browser')) {
  const { FaiRun, mcpProbe } = await import('./fai-condition.mjs');
  const { createCompanion } = await import('./companion.js');
  const browserSite = await startSite();
  const scratch = await mkdtemp(join(tmpdir(), 'fai-bench-selftest-'));
  // No MCP server is needed for this check; the warm-up call fails harmlessly.
  const run = new FaiRun({ server: { command: 'false', args: [] }, origin: browserSite.origin, startUrl: `${browserSite.origin}/`, scratch });
  let companion;
  try {
    await run.setup();
    companion = createCompanion({ port: run.port, extensionId: run.extensionId, secret: run.secret, allowedOrigins: [browserSite.origin] });
    await companion.listen();
    run.start();
    // At a level above the popup's read-only default, as bench/qa/run.mjs approves a reversible task.
    const approval = await run.approve('selftest', { level: 'reversible' });
    assert.equal(approval.ok, true, JSON.stringify(approval));
    assert.equal(companion.status().status, 'active');
    assert.equal(companion.status().level, 'reversible', 'the harness granted the level it picked, not the default');
    const observation = await companion.bridge.observe();
    assert.equal(observation.url, `${browserSite.origin}/`);
    ok(`harness approved the tab through the popup at reversible in ${approval.ms} ms; companion lease active`);
  } finally {
    await run.teardown();
    await companion?.close();
    await browserSite.close();
    await rm(scratch, { recursive: true, force: true });
  }
  // A companion has no real pending tab requests. Also exercise today's Agent direct request UI against a real
  // daemon: this catches auto-open/armed-tab and success-wording drift which the companion check cannot see.
  const directSite = await startSite();
  const directScratch = await mkdtemp(join(tmpdir(), 'fai-bench-direct-selftest-'));
  const server = { command: process.execPath, args: [join(import.meta.dirname, '..', 'src', 'mcp-main.js')] };
  const direct = new FaiRun({ server, origin: directSite.origin, startUrl: directSite.origin + '/',
    scratch: directScratch, level: 'interactive', extraEnv: { FAI_HOME: join(directScratch, 'home') } });
  try {
    await direct.setup();
    direct.start();
    const opened = await mcpProbe(server, { env: direct.env, timeoutMs: 20_000, call: {
      name: 'fai_browser_open', arguments: { origins: [directSite.origin], mode: 'interactive',
        reason: 'Local benchmark selftest', task: 'Read the local fixture page' },
    } });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const { mcpData } = await import('../test/helpers/mcp-result.js');
    assert.equal(mcpData(opened.called).status, 'observed');
    assert.match(opened.called.content[0].text, /granted: interactive/);
    await direct.approving;
    assert.equal(direct.approvals.some(approval => approval.ok), true);
    ok('real Agent direct open: popup approves the declared level and returns the task page');
  } finally {
    await direct.teardown();
    await directSite.close();
    await rm(directScratch, { recursive: true, force: true });
  }
}

const { selftestShowcase } = await import('./showcase/selftest.mjs');
checks.push(...await selftestShowcase({ browser: process.argv.includes('--browser') }));
console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
