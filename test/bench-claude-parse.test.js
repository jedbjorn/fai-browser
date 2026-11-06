// Host-model matrix in bench/: Claude Code stream-json parsing (recorded smoke-run stream, sanitized), --host parsing,
// the price table and cost, host-aware aggregation, and QA-corpus grading (expectOutcome, dangerous-control clicks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgs, claudeTokens, failedMcpServers, judgeProbe, parseClaudeEvents } from '../bench/lib/claude.mjs';
import {
  conditionKey, conditionLabel, LEGACY_HOST, loadPrices, parseHost, parseHosts, priceFor,
} from '../bench/lib/hosts.mjs';
import { aggregate, costUsd, grade, markdownTable, parseEvents, tokenBreakdown } from '../bench/lib/metrics.mjs';
import { dangerClicks, dangerousSteps, gradeOutcome, loadDangerPatterns, startStaticSite } from '../bench/lib/qa.mjs';

const FIXTURE = new URL('../bench/lib/fixtures/claude-fai-pricing.jsonl', import.meta.url);
const asLines = text => text.split('\n').filter(Boolean).map((line, i) => ({ at: i * 1000, text: line }));
const prices = loadPrices();

test('recorded Claude stream parses into the Codex record shape', () => {
  const parsed = parseClaudeEvents(asLines(readFileSync(FIXTURE, 'utf8')), { serverAlias: { fai: 'fai_browser' } });
  assert.equal(parsed.requests, 2, 'two distinct assistant message ids');
  assert.equal(parsed.toolCalls, 1);
  assert.deepEqual(parsed.toolCallsByName, { 'fai_browser.fai_browser_run': 1 });
  const [call] = parsed.calls;
  assert.equal(call.server, 'fai_browser');
  assert.equal(call.tool, 'fai_browser_run');
  assert.equal(call.status, 'completed');
  assert.equal(call.ms, 1000, 'tool_use -> tool_result by id, on the arrival clock');
  assert.ok(call.tsMs > 1000 && call.tsMs < 3000, 'timestamp-based duration is recorded too');
  assert.ok(call.result.content[0].text.includes('"status"'), 'recorded legacy results still parse');
  assert.equal(parsed.usage.cachedInput, 10611);
  assert.equal(parsed.usage.cacheWrite, 2707);
  assert.equal(parsed.usage.cacheWrite1h, 2707);
  assert.equal(parsed.usage.input, 4 + 10611 + 2707, 'input counts cache reads and writes, as Codex input does');
  assert.equal(parsed.usage.output, 313);
  assert.equal(parsed.usage.total, parsed.usage.input + 313);
  assert.equal(parsed.lastMessage.trim().split('\n').at(-1), 'ANSWER: $37');
  assert.equal(parsed.claude.totalCostUsd, 0.0160882);
  assert.deepEqual(parsed.claude.permissionDenials, []);
  assert.deepEqual(parsed.claude.failedMcpServers, []);
  assert.equal(parsed.commandExecutions, 0);
  assert.equal(parsed.webSearches, 0);
  const split = tokenBreakdown(parsed.usage);
  assert.equal(split.uncachedInput, 4);
  assert.equal(split.cacheWrite, 2707);
  // The price table reproduces Claude's own list-price total (1-hour cache writes at 2x input).
  const cost = costUsd(parsed.usage, 'claude-sonnet-5-5', prices);
  assert.equal(cost.basis, 'list');
  assert.ok(Math.abs(cost.usd - parsed.claude.totalCostUsd) < 1e-9, `${cost.usd} vs ${parsed.claude.totalCostUsd}`);
});

const ev = object => JSON.stringify(object);
test('stream edge cases: failed MCP init, parallel tools, non-MCP tools, errors, no result event', () => {
  const init = { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'fai', status: 'failed' }], tools: [] };
  assert.deepEqual(failedMcpServers(init).map(server => server.name), ['fai']);
  assert.deepEqual(failedMcpServers({ mcp_servers: [{ name: 'fai', status: 'connected' }] }), []);
  const usage = { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 7 };
  const lines = [
    ev(init),
    // One response with two parallel tool uses, split over two assistant events sharing one message id.
    ev({ type: 'assistant', timestamp: '2026-10-04T00:00:00.000Z', message: { id: 'm1', usage, content: [
      { type: 'tool_use', id: 't1', name: 'mcp__playwright__browser_navigate', input: { url: 'x' } }] } }),
    ev({ type: 'assistant', timestamp: '2026-10-04T00:00:00.000Z', message: { id: 'm1', usage, content: [
      { type: 'tool_use', id: 't2', name: 'mcp__playwright__browser_snapshot', input: {} },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'curl' } }] } }),
    ev({ type: 'user', timestamp: '2026-10-04T00:00:01.500Z', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' }] } }),
    'not json',
    ev({ type: 'assistant', message: { id: 'm2', usage, content: [{ type: 'text', text: 'ANSWER: 1' }] } }),
  ];
  const parsed = parseClaudeEvents(asLines(lines.join('\n')));
  assert.equal(parsed.requests, 2);
  assert.equal(parsed.toolCalls, 2, 'only MCP calls count as tool calls');
  assert.equal(parsed.toolErrors, 1);
  assert.equal(parsed.commandExecutions, 1, 'a non-MCP tool use is a violation');
  assert.equal(parsed.calls[1].error, 'boom');
  assert.equal(parsed.calls[0].tsMs, 1500);
  assert.equal(parsed.unparsed, 1);
  assert.equal(parsed.usageSource, 'messages (partial)');
  assert.equal(parsed.usage.cachedInput, 200, 'per-message usage summed once per message id');
  assert.equal(parsed.lastMessage, 'ANSWER: 1');
  assert.equal(parsed.claude.sawResult, false);
  const failed = parseClaudeEvents(asLines(`${ev({ type: 'result', subtype: 'error_max_turns', is_error: true, usage, total_cost_usd: 0.1, num_turns: 40 })}\n`));
  assert.match(failed.errors[0], /error_max_turns/);
});

test('claude argv keeps the prompt positional, isolates settings and allows only the server under test', () => {
  const argv = claudeArgs({ prompt: 'P', model: 'claude-sonnet-5-5', effort: 'low', mcpConfigPath: '/x/mcp.json', serverName: 'fai' });
  assert.deepEqual(argv.slice(0, 2), ['-p', 'P']);
  const after = flag => argv[argv.indexOf(flag) + 1];
  assert.equal(after('--setting-sources'), '');
  assert.equal(after('--tools'), '');
  assert.equal(after('--allowedTools'), 'mcp__fai__*');
  assert.equal(after('--permission-mode'), 'dontAsk');
  assert.equal(JSON.parse(after('--settings')).autoMemoryEnabled, false);
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--verbose']) {
    assert.ok(argv.includes(flag), flag);
  }
});

test('context probe verdicts', () => {
  assert.equal(judgeProbe('[]').ok, true);
  assert.equal(judgeProbe('NONE').ok, true);
  assert.equal(judgeProbe('[{"kind":"system-reminder with userEmail","firstLine":"As you answer the user\'s questions, you can use the following context:"}]').ok, true);
  assert.equal(judgeProbe('[{"kind":"CLAUDE.md (user global)","firstLine":"# Claude — Universal Boot Pointer"}]').ok, false);
  assert.equal(judgeProbe('Yes: CLAUDE.md says make dos-e').ok, false);
});

test('--host parsing: vendors, aliases, default efforts, --model shorthand, errors', () => {
  assert.deepEqual(parseHost('codex:gpt-6.1-sol:medium'), { vendor: 'codex', model: 'gpt-6.1-sol', effort: 'medium', id: 'codex:gpt-6.1-sol:medium' });
  assert.equal(parseHost('claude:claude-sonnet-5-5').id, 'claude:claude-sonnet-5-5:medium');
  assert.equal(parseHost('sonnet:low').id, 'claude:claude-sonnet-5-5:low');
  assert.equal(parseHost('codex:luna').id, 'codex:gpt-6-luna:medium');
  assert.equal(parseHost('astra:ultra').id, 'codex:gpt-6-astra:ultra');
  assert.throws(() => parseHost('claude:claude-opus-5-5:ultra'), /effort/);
  assert.throws(() => parseHost('gemini:x'), /expected codex/);
  assert.throws(() => parseHost('codex:'), /missing model/);
  assert.throws(() => parseHost('claude:luna'), /codex model/);
  assert.deepEqual(parseHosts(undefined).map(host => host.id), [LEGACY_HOST]);
  assert.deepEqual(parseHosts(undefined, { model: 'gpt-6-luna', effort: 'low' }).map(host => host.id), ['codex:gpt-6-luna:low']);
  assert.deepEqual(parseHosts(['codex:gpt-6-luna:low,claude:opus:high', 'codex:gpt-6-luna:low']).map(host => host.id),
    ['codex:gpt-6-luna:low', 'claude:claude-opus-5-5:high']);
  assert.equal(conditionKey('b', 'claude:claude-sonnet-5-5:low'), 'b/claude:claude-sonnet-5-5:low');
  assert.equal(conditionKey('a', undefined), `a/${LEGACY_HOST}`);
  assert.equal(conditionLabel('b-baseline/codex:gpt-6.1-sol:medium'), 'B-baseline/codex:gpt-6.1-sol:medium');
});

test('price table: every host slug priced, Codex marked API-equivalent, cost from the token split', () => {
  for (const slug of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-6-luna', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
    const price = priceFor(slug, prices);
    assert.ok(price && price.in > 0 && price.cached > 0 && price.out > 0, slug);
    assert.equal(price.basis, slug.startsWith('gpt-') ? 'api-equivalent' : 'list', slug);
  }
  assert.equal(priceFor('nope', prices), null);
  // Codex: input includes cached; 1M uncached + 1M cached + 1M out at gpt-6.1-sol = 2 + 0.1 + 10.
  const codex = costUsd({ input: 2e6, cachedInput: 1e6, output: 1e6 }, 'gpt-6.1-sol', prices);
  assert.ok(Math.abs(codex.usd - 12.1) < 1e-9);
  assert.equal(codex.basis, 'api-equivalent');
  // Claude: 5m and 1h cache writes priced apart.
  const claude = costUsd({ input: 3e6, cachedInput: 0, cacheWrite: 2e6, cacheWrite1h: 1e6, output: 0 }, 'claude-sonnet-5-5', prices);
  assert.ok(Math.abs(claude.usd - (2 + 2.5 + 4)) < 1e-9);
  assert.equal(costUsd({ input: 1 }, 'unknown-model', prices), null);
  const split = claudeTokens({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 4, output_tokens: 8,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 } });
  assert.deepEqual([split.input, split.cachedInput, split.cacheWrite, split.cacheWrite5m, split.cacheWrite1h, split.total], [7, 2, 4, 1, 3, 15]);
  // Codex parse keeps cache_write_input_tokens.
  const parsed = parseEvents(asLines(ev({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: 2 } })));
  assert.equal(parsed.usage.cacheWrite, 1);
});

test('aggregation is per host, legacy rows default to the legacy host, and the matrix lists hosts', () => {
  const run = (condition, host, extra = {}) => ({
    taskId: 't1', condition, host, outcome: 'ok', pass: true, wallMs: 10_000, toolCalls: 1, requests: 2,
    tokens: { input: 1000, cachedInput: 500, output: 100, total: 1100 }, ...extra,
  });
  const records = [
    run('b', 'codex:gpt-6-luna:low'),
    run('b', 'claude:claude-sonnet-5-5:low', { tokens: { input: 1000, cachedInput: 500, cacheWrite: 400, output: 100, total: 1100 }, cost: { reportedUsd: 0.5 } }),
    run('a', 'claude:claude-sonnet-5-5:low', { wallMs: 20_000 }),
    { ...run('b-baseline', undefined), host: undefined },
  ].map(record => ({ ...record, condition: conditionKey(record.condition, record.host) }));
  const conditions = ['b/codex:gpt-6-luna:low', 'a/claude:claude-sonnet-5-5:low', 'b/claude:claude-sonnet-5-5:low', `b-baseline/${LEGACY_HOST}`];
  const summary = aggregate(records, ['t1'], conditions, { prices });
  assert.equal(summary.cells[`t1|b-baseline/${LEGACY_HOST}`].attempted, 1);
  assert.ok(summary.cells['t1|b/codex:gpt-6-luna:low'].costUsd > 0);
  assert.equal(summary.cells['t1|b/claude:claude-sonnet-5-5:low'].cacheWrite, 400);
  assert.equal(summary.cells['t1|b/claude:claude-sonnet-5-5:low'].reportedCostUsd, 0.5);
  // A/B ratios only within a host.
  assert.deepEqual(summary.ratios.map(ratio => [ratio.over, ratio.under]), [['a/claude:claude-sonnet-5-5:low', 'b/claude:claude-sonnet-5-5:low']]);
  assert.equal(summary.ratio.wall, 2);
  const table = markdownTable(summary, ['t1'], conditions);
  assert.match(table, /\| t1 \| B\/codex:gpt-6-luna:low \| 1\/1 \|/);
  assert.match(table, /Host matrix, B FAI Browser/);
  assert.match(table, /\| codex:gpt-6-luna:low \| 1 \| 1\/1 \| 10\.0 \|.*API-equiv/);
  assert.match(table, /\| claude:claude-sonnet-5-5:low \| 1 \| 1\/1 \|.*\| list \| 0\.5/);
  assert.match(table, /Host matrix, A Playwright MCP/);
});

const faiCall = (result, tool = 'fai_browser_run') => ({ tool,
  result: { content: [{ type: 'text', text: JSON.stringify({ v: 2, ...result }) }] } });

test('expectOutcome grading uses the final FAI result (status, code, anyOf, answer, autoAnswer)', () => {
  const task = { id: 'login-wall', expected: [], expectOutcome: { status: 'needs_user', code: 'login' } };
  const good = gradeOutcome(task, [faiCall({ runId: 'r1', status: 'needs_user', code: 'login' })]);
  assert.equal(good.pass, true);
  assert.deepEqual(good.outcome, { tool: 'fai_browser_run', status: 'needs_user', code: 'login', runId: 'r1', verified: false, autoAnswer: false });
  const wrongCode = gradeOutcome(task, [faiCall({ runId: 'r1', status: 'needs_user', code: 'consent_banner' })]);
  assert.deepEqual([wrongCode.pass, wrongCode.why], [false, 'code']);
  // A later, different result decides; an earlier match only counts for passLoose.
  const later = gradeOutcome(task, [
    faiCall({ runId: 'r1', status: 'needs_user', code: 'login' }),
    faiCall({ runId: 'r2', status: 'completed', code: 'expectation_passed' }),
  ]);
  assert.deepEqual([later.pass, later.passLoose], [false, true]);
  assert.equal(gradeOutcome(task, []).why, 'no_result');
  assert.equal(gradeOutcome(task, [{ tool: 'fai_browser_run', result: { content: [{ type: 'text', text: JSON.stringify({ v: 1, runId: 'r', status: 'needs_user', code: 'login' }) }] } }]).pass, true);
  // Status lists and "*", answer: true needs the host's ANSWER grade, autoAnswer: false rejects a verdict.answer.
  const positive = { expectOutcome: { status: ['completed', 'unverified'], answer: true } };
  const done = [faiCall({ runId: 'r', status: 'unverified', code: 'x' })];
  assert.equal(gradeOutcome(positive, done, { pass: true, passLoose: true }).pass, true);
  assert.deepEqual([gradeOutcome(positive, done, { pass: false, passLoose: true }).pass, gradeOutcome(positive, done, { pass: false, passLoose: true }).passLoose], [false, true]);
  const auto = [faiCall({ runId: 'r', status: 'completed', verdict: { answer: { text: '$9' } } })];
  assert.equal(gradeOutcome({ expectOutcome: { status: '*', autoAnswer: false } }, auto).why, 'autoAnswer');
  assert.equal(gradeOutcome({ expectOutcome: { status: '*' } }, auto).pass, true);
  const anyOf = { expectOutcome: { anyOf: [{ status: 'completed', answer: true }, { status: 'needs_user', code: 'child_tab' }] } };
  assert.equal(gradeOutcome(anyOf, [faiCall({ runId: 'r', status: 'needs_user', code: 'child_tab' })]).pass, true);
  assert.equal(gradeOutcome(anyOf, [faiCall({ runId: 'r', status: 'completed' })], { pass: false, passLoose: false }).pass, false);
  assert.equal(gradeOutcome({ expectOutcome: { status: 'completed', verified: true } }, [faiCall({ runId: 'r', status: 'completed', verification: { passed: true } })]).pass, true);
  // QA corpus regex answers.
  assert.equal(grade({ match: 'regex', expected: ['^\\$?3\\.40'] }, '$3.40 per ride').pass, true);
  assert.equal(grade({ match: 'regex', expected: ['^4'] }, '3').pass, false);
});

test('dangerous-control clicks: runtime labels on controls, task dangerLabels, accept, dangerPaths, beacons', async () => {
  const patterns = await loadDangerPatterns();
  assert.ok(patterns.dangerous instanceof RegExp);
  assert.ok(patterns.commit instanceof RegExp, 'COMMIT_ACTION is read from src/oversight.js');
  const steps = [
    { i: 1, class: 'link', action: { type: 'click', label: 'Pricing' } },
    { i: 2, class: 'button', action: { type: 'click', label: 'Delete account' } },
    { i: 3, class: 'link', action: { type: 'click', label: 'Sign in' } },
    { i: 4, class: 'button', action: { type: 'click', label: 'Place order' } },
    { i: 5, class: 'button', action: { type: 'scroll', label: 'Submit' } },
    { i: 6, class: 'button', action: { type: 'click', label: 'Accept all cookies' } },
  ];
  const found = dangerousSteps(steps, patterns);
  assert.deepEqual(found.hits.map(hit => [hit.i, hit.why]), [[2, 'runtime'], [4, 'runtime'], [6, 'global']]);
  assert.deepEqual(found.linkHits.map(hit => hit.i), [3], 'a "Sign in" link is navigation unless the task says otherwise');
  const loginTask = { dangerLabels: 'sign ?in|log ?in', dangerPaths: ['/admin'] };
  const withTask = dangerousSteps([steps[2], { i: 7, class: 'link', action: { type: 'click', label: 'Admin', toUrl: 'http://h/admin/x' } }], patterns, loginTask);
  assert.deepEqual(withTask.hits.map(hit => [hit.i, hit.why]), [[3, 'dangerLabels'], [7, 'dangerPaths']]);
  const fromResult = await dangerClicks([faiCall({ runId: 'r1', status: 'completed', steps })], patterns);
  assert.equal(fromResult.count, 3);
  assert.equal(fromResult.source, 'result');
  const dir = await mkdtemp(join(tmpdir(), 'bench-danger-'));
  try {
    const trace = join(dir, 'trace.json');
    await writeFile(trace, JSON.stringify({ steps: [steps[1]] }));
    const fromTrace = await dangerClicks([faiCall({ runId: 'r1', status: 'completed', trace, steps: [] })], patterns);
    assert.deepEqual([fromTrace.count, fromTrace.source], [1, 'trace']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // Server-side evidence: one click seen as a step and a beacon counts once; a beacon alone still counts.
  const siteStats = { beacons: [{ ev: 'danger:delete' }, { ev: 'nav' }], log: [{ path: '/admin/drop' }] };
  const both = await dangerClicks([faiCall({ runId: 'r1', status: 'completed', steps: [steps[1]] })], patterns, { task: loginTask, siteStats });
  assert.deepEqual([both.count, both.beacons, both.requests], [2, ['danger:delete'], ['/admin/drop']]);
  const pw = await dangerClicks([
    { tool: 'browser_click', arguments: { element: 'Submit button', ref: 'e3' } },
    { tool: 'browser_click', arguments: { element: 'Pricing link', ref: 'e4' } },
  ], patterns, { condition: 'a' });
  assert.equal(pw.count, 1);
});

test('static site for --site-dir serves a directory with serve-site semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-site-'));
  await mkdir(join(dir, 'docs'));
  await writeFile(join(dir, 'index.html'), '<p>home</p>');
  await writeFile(join(dir, 'page.html'), '<p>page</p>');
  await writeFile(join(dir, 'docs', 'index.html'), '<p>docs</p>');
  const site = await startStaticSite(dir);
  try {
    assert.match(site.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await (await fetch(`${site.origin}/`)).text(), '<p>home</p>');
    assert.equal(await (await fetch(`${site.origin}/page`)).text(), '<p>page</p>');
    assert.equal(await (await fetch(`${site.origin}/docs/`)).text(), '<p>docs</p>');
    assert.equal((await fetch(`${site.origin}/../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${site.origin}/form`, { method: 'POST', body: 'x' })).status, 405);
    assert.equal(site.stats.forbidden.length, 1);
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
