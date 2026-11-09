// bench/live: date placeholders, task loading and skip, receipt parsing from a recorded real-install stream (the
// private smoke run, sanitized), trace summaries, grading and regrading, the approval estimate, the live checklist
// verdict, and summary rendering. The full --private run is a manual step (README); its committed summary is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeEvents } from '../bench/lib/claude.mjs';
import {
  applyGrades, approvalEstimate, approvalOutcome, buildSummary, liveMcpConfig, evaluateChecklist, fillDates, fillDeep, formatDate, gradeFinal,
  graderFor, gradesFile, loadLiveTasks, loadPrivateTasks, privatePrompt, receiptsFrom, renderChecklist, renderSummary,
  runCallStats, callShape, runKey, sanitizeHome, signalsIn, summarizeTrace, validateLiveTask,
} from '../bench/live/lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FIXTURE = join(ROOT, 'bench', 'lib', 'fixtures', 'claude-live-real-pricing.jsonl');
const asLines = text => text.split('\n').filter(Boolean).map((line, i) => ({ at: i * 1000, text: line }));
const NOW = new Date(2026, 9, 6, 9, 30); // Tuesday 6 October 2026, local

test('date placeholders fill local calendar dates in three formats', () => {
  assert.equal(formatDate(NOW, 0), '2026-10-06');
  assert.equal(formatDate(NOW, 1, 'long'), 'Wednesday 7 October 2026');
  assert.equal(formatDate(NOW, 26, 'dm'), '1 November');
  assert.equal(formatDate(new Date(2026, 11, 31, 23, 59), 1), '2027-01-01', 'year rollover');
  assert.equal(fillDates('from {{DATE+1}} to {{DATE+7|long}}, today {{DATE}}, ago {{DATE-6|dm}}', NOW),
    'from 2026-10-07 to Tuesday 13 October 2026, today 2026-10-06, ago 30 September');
  assert.equal(fillDates('no placeholder {{ORIGIN}}', NOW), 'no placeholder {{ORIGIN}}');
  assert.throws(() => fillDates('{{DATE+1|weird}}', NOW), /unknown date format/);
  assert.deepEqual(fillDeep({ a: ['{{DATE+2}}'], n: 3 }, NOW), { a: ['2026-10-08'], n: 3 });
});

test('the shipped live task file loads, fills dates, skips placeholders and keeps origins minimal', () => {
  const file = join(ROOT, 'bench', 'live', 'tasks.json');
  const { tasks, skipped } = loadLiveTasks(file, { now: NOW });
  const ids = tasks.map(task => task.id);
  for (const id of ['gf-week-window', 'gf-cheapest-day', 'gf-date-grid', 'wiki-tagus', 'hn-comments', 'mdn-array-at',
    'github-license', 'pydocs-read-text', 'booking-search', 'expedia-search']) {
    assert.ok(ids.includes(id), `${id} present`);
  }
  assert.deepEqual(skipped, []);
  const booking = tasks.find(task => task.id === 'booking-search');
  assert.deepEqual([booking.mode, booking.answerPattern, graderFor(booking).kind], ['interactive', undefined, 'manual']);
  const gf = tasks.find(task => task.id === 'gf-week-window');
  assert.match(gf.prompt, /Wednesday 7 October 2026 to Tuesday 13 October 2026/);
  assert.doesNotMatch(JSON.stringify(tasks), /\{\{DATE/, 'every placeholder filled');
  for (const task of tasks.filter(item => item.id.startsWith('gf-'))) {
    assert.deepEqual(task.origins, ['https://www.google.com', 'https://consent.google.com']);
  }
  assert.deepEqual(tasks.find(task => task.id === 'gf-date-grid').expectSignals, ['unreadable_region:canvas']);
  // The public comparisons reuse bench/real's answerPatterns.
  const real = JSON.parse(readFileSync(join(ROOT, 'bench', 'real', 'tasks.json'), 'utf8')).tasks;
  for (const id of ['wiki-tagus', 'hn-comments', 'mdn-array-at', 'github-license', 'pydocs-read-text']) {
    assert.equal(tasks.find(task => task.id === id).answerPattern, real.find(task => task.id === id).answerPattern, id);
    assert.equal(tasks.find(task => task.id === id).mode, real.find(task => task.id === id).mode, id);
  }
  assert.throws(() => loadLiveTasks(file, { ids: ['nope'] }), /unknown task id/);
});

test('skipped placeholders are listed and never run, even when asked for', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-bench-'));
  try {
    const file = join(dir, 'tasks.json');
    await writeFile(file, JSON.stringify({ tasks: [
      { id: 'a', prompt: 'p', origins: ['https://a.com'], mode: 'read-only' },
      { id: 'later', prompt: 'TODO', skip: true, skipReason: 'placeholder' }] }));
    const all = loadLiveTasks(file, { now: NOW });
    assert.deepEqual([all.tasks.map(task => task.id), all.skipped.map(item => item.id)], [['a'], ['later']]);
    const picked = loadLiveTasks(file, { ids: ['a', 'later'], now: NOW });
    assert.deepEqual(picked.tasks.map(task => task.id), ['a']);
    assert.deepEqual(picked.skipped.map(item => item.id), ['later']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('live task validation rejects bad origins, modes and patterns', async () => {
  assert.deepEqual(validateLiveTask({ id: 'ok', prompt: 'p', origins: ['https://*.example.com'], mode: 'read-only' }), []);
  assert.match(validateLiveTask({ id: 'x', prompt: 'p', origins: ['http://a.com'], mode: 'read-only' }).join(), /https origin/);
  assert.match(validateLiveTask({ id: 'x', prompt: 'p', origins: ['https://a.com'], mode: 'admin' }).join(), /mode/);
  assert.match(validateLiveTask({ id: 'x', prompt: 'p', origins: ['https://a.com'], mode: 'full', answerPattern: '(' }).join(), /regex/);
  assert.deepEqual(validateLiveTask({ id: 'x', prompt: 'TODO', skip: true }), [], 'a skipped placeholder needs no origins');
  const dir = await mkdtemp(join(tmpdir(), 'live-bench-'));
  try {
    const file = join(dir, 'tasks.json');
    await writeFile(file, JSON.stringify({ tasks: [{ id: 'a', prompt: 'p', origins: ['https://a.com'], mode: 'read-only' },
      { id: 'a', prompt: 'p', origins: ['https://a.com'], mode: 'read-only' }] }));
    assert.throws(() => loadLiveTasks(file), /duplicate task id a/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('private tasks come from the bench/tasks.json schema with the condition R prompt', () => {
  const { tasks } = loadPrivateTasks(join(ROOT, 'bench', 'tasks.json'), { ids: ['about-members', 'pricing-pro'] });
  assert.deepEqual(tasks.map(task => task.id), ['about-members', 'pricing-pro']);
  const prompt = privatePrompt(tasks[1], 'http://127.0.0.1:9', {
    common: readFileSync(join(ROOT, 'bench', 'prompts', 'common.md'), 'utf8'),
    tools: readFileSync(join(ROOT, 'bench', 'prompts', 'fai-real.md'), 'utf8'),
  });
  assert.match(prompt, /Website: http:\/\/127\.0\.0\.1:9\//);
  assert.match(prompt, /Task: What is the monthly price of the Pro plan\?/);
  assert.match(prompt, /has already opened http:\/\/127\.0\.0\.1:9\/ in their browser/);
  assert.doesNotMatch(prompt, /\{\{/);
  assert.throws(() => loadPrivateTasks(join(ROOT, 'bench', 'tasks.json'), { ids: ['nope'] }), /unknown task id/);
});

test('receipts parse from a recorded real-install stream; summaries keep no page text', () => {
  const parsed = parseClaudeEvents(asLines(readFileSync(FIXTURE, 'utf8')),
    { serverAlias: { 'fai-browser': 'fai_browser' }, realInstall: true });
  assert.equal(parsed.requests, 2);
  const receipts = receiptsFrom(parsed.calls);
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.equal(receipt.tool, 'fai_browser_run');
  assert.equal(receipt.parsed, true);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.verified, true);
  assert.equal(receipt.verdict.kind, 'verified');
  assert.equal(receipt.verdict.oversight, 'none');
  assert.equal(receipt.next.kind, 'answer');
  assert.equal(receipt.answer, '$37 per month');
  assert.equal(receipt.permissions.granted, 'read-only');
  assert.equal(receipt.trailLength, 1);
  assert.equal(receipt.cost.decisions, 2);
  assert.match(receipt.trace, /artifacts\/[0-9a-f-]+\/trace\.json$/);
  assert.equal(receipt.arguments.origins.length, 1);
  assert.equal(receipt.arguments.hasAnswerQuestion, true);
  assert.equal(receipt.arguments.instruction, undefined, 'free-text arguments are not copied');
  // A non-FAI or unparsable result is kept as unparsed, not dropped.
  const odd = receiptsFrom([{ id: 'x', tool: 'fai_browser_status', result: { content: [{ type: 'text', text: 'oops' }] }, isError: true, error: 'boom' }]);
  assert.deepEqual([odd[0].parsed, odd[0].error], [false, 'boom']);
});

test('trace summaries count Jev requests, ms and hops; signals and approval come from codes and timestamps', () => {
  const trace = {
    runId: 'r1', status: 'completed', code: 'expectation_passed', startedAt: '2026-10-06T10:00:05.000Z',
    steps: [{ observation: { warnings: ['unreadable_region:canvas'], text: 'PAGE TEXT' } }, { observation: {} }],
    cost: { decisions: 2, elapsedMs: 900, requests: [{ kind: 'decide', ms: 300 }, { kind: 'choose', ms: 200 }, { kind: 'decide', ms: 100, error: 'timeout' }] },
    page: { digest: ['PAGE TEXT'] },
  };
  const summary = summarizeTrace(trace);
  assert.deepEqual([summary.jevRequests, summary.jevMs, summary.hops, summary.jevErrors], [3, 600, 2, 1]);
  assert.deepEqual(summary.jevRequestKinds, { decide: 2, choose: 1 });
  assert.deepEqual(summary.warnings, ['unreadable_region:canvas']);
  assert.doesNotMatch(JSON.stringify(summary), /PAGE TEXT/);
  const receipts = [
    { tool: 'fai_browser_run', runId: null, next: { kind: 'relay' }, callMs: 45_000, startedAtMs: 1000, verdict: { why: [] } },
    { tool: 'fai_browser_run', runId: 'r1', startedAtMs: 47_000, callMs: 3000, code: 'expectation_passed', verdict: { why: ['done:0.9'] } },
  ];
  const start = Date.parse('2026-10-06T10:00:05.000Z') - 47_000 - 2000;
  assert.deepEqual(approvalEstimate(receipts, [summary], start), { ms: 47_000, calls: 2 });
  assert.deepEqual(signalsIn(['unreadable_region:canvas', 'consent_banner'], receipts, [summary]),
    { 'unreadable_region:canvas': true, consent_banner: false });
});

test('grading: answerPattern and expected are auto, the rest manual; owner grades apply on regrade', () => {
  assert.equal(graderFor({ answerPattern: 'x' }).kind, 'auto');
  assert.equal(graderFor({ expected: ['$37'] }).kind, 'auto');
  assert.equal(graderFor({}).kind, 'manual');
  const wiki = { answerPattern: '1[,.\\s]?0(07|38)\\s?km' };
  assert.equal(gradeFinal(wiki, 'The Tagus is 1,007 km long.').pass, true);
  assert.equal(gradeFinal(wiki, 'I could not open it.').pass, false);
  const pricing = { expected: ['$37', '$37 per month'], match: 'exact' };
  assert.equal(gradeFinal(pricing, 'It costs\nANSWER: $37 per month').pass, true);
  assert.equal(gradeFinal(pricing, 'The Pro plan is $37 per month.').pass, true, 'no ANSWER line: loose match');
  const manual = gradeFinal({}, 'The page has three sections.');
  assert.deepEqual([manual.grading, manual.pass, manual.answer], ['manual', null, 'The page has three sections.']);
  const records = [
    { taskId: 'booking-search', host: 'h', rep: 1, grading: 'manual', pass: null, answerText: 'three sections' },
    { taskId: 'wiki-tagus', host: 'h', rep: 1, grading: 'auto', pass: true, answerText: '1,007 km' },
  ];
  const grades = gradesFile(records);
  assert.equal(grades['booking-search|h|1'].pass, null);
  assert.equal(grades['booking-search|h|1'].answer, 'three sections');
  grades['booking-search|h|1'].pass = true;
  const applied = applyGrades(records, grades);
  assert.deepEqual([applied[0].pass, applied[0].gradedBy], [true, 'owner']);
  assert.equal(applied[1].pass, true);
  assert.equal(gradesFile(applied, grades)['booking-search|h|1'].pass, true, 'owner grade survives a rewrite');
  assert.equal(runKey(records[0]), 'booking-search|h|1');
});

test('the live checklist fails without a daemon or extension and warns loudly on an old daemon', () => {
  const base = { clientVersion: '0.2.0', root: '/r', claudeVersion: '2.1.290', nowMs: Date.parse('2026-10-06T12:00:00Z') };
  const down = evaluateChecklist({ ...base, health: null, status: null });
  assert.equal(down.ok, false);
  assert.match(renderChecklist(down), /\[FAIL\] no FAI Browser daemon answers on 127\.0\.0\.1:4318/);
  const status = {
    daemon: { version: '0.2.0', home: '/r', uptimeMs: 3_600_000 },
    extension: { connected: true, transport: 'socket' }, provider: { keyConfigured: true }, requests: [], runs: { active: [] },
  };
  const health = { version: '0.2.0', pid: 7 };
  const good = evaluateChecklist({ ...base, health, status, mainCommitEpochS: Date.parse('2026-10-06T10:00:00Z') / 1000,
    headCommit: 'abc', mainCommit: 'abc' });
  assert.equal(good.ok, true, renderChecklist(good));
  const stale = evaluateChecklist({ ...base, health, status, mainCommitEpochS: Date.parse('2026-10-06T11:30:00Z') / 1000 });
  assert.equal(stale.ok, true, 'an old daemon is a loud warning, not a failure');
  assert.match(renderChecklist(stale), /\[WARN\] !!! DAEMON STARTED .* BEFORE THE LAST COMMIT ON MAIN/);
  const otherHome = evaluateChecklist({ ...base, health, status: { ...status, daemon: { ...status.daemon, home: '/elsewhere' } } });
  assert.equal(otherHome.ok, false);
  const noExtension = evaluateChecklist({ ...base, health, status: { ...status, extension: { connected: false, lastSeenMs: null } } });
  assert.equal(noExtension.ok, false);
  const idle = evaluateChecklist({ ...base, health, status: { ...status, extension: { connected: false, lastSeenMs: 90_000 } } });
  assert.equal(idle.ok, true);
  assert.match(renderChecklist(idle), /\[WARN\] extension not connected right now/);
  const mismatch = evaluateChecklist({ ...base, health: { version: '0.1.9', pid: 7 }, status: null, statusError: 'not queried: version mismatch' });
  assert.equal(mismatch.ok, false);
  assert.match(renderChecklist(mismatch), /DAEMON VERSION 0\.1\.9/);
  assert.match(renderChecklist(evaluateChecklist({ ...base, health, status, foreignEnv: ['FAI_BRIDGE_PORT'] })), /FAI_BRIDGE_PORT is set/);
});

test('summary rendering: rows, totals, grading column, no answer text, home sanitized', () => {
  const records = [
    { taskId: 'wiki-tagus', host: 'claude:s:low', rep: 1, outcome: 'ok', grading: 'auto', pass: true, wallMs: 30_000,
      approvalMs: 8000, requests: 3, toolCalls: 2, faiRunCalls: 1, faiListSteps: 0, jev: { requests: 4, ms: 2500, hops: 2 },
      oversight: { autoAnswers: 1, falseAutomation: 0, finalNext: 'answer' }, oversightKind: 'none', cost: { usd: 0.05 },
      answerText: 'SECRET PAGE ANSWER' },
    { taskId: 'gf-date-grid', host: 'claude:s:low', rep: 1, outcome: 'ok', grading: 'manual', pass: null, wallMs: 60_000,
      requests: 5, toolCalls: 3, faiRunCalls: 2, jev: { requests: 6, ms: 4000, hops: 3 }, signals: { 'unreadable_region:canvas': true },
      reason: null, cost: { usd: 0.1 }, answerText: 'SECRET PAGE ANSWER' },
  ];
  const summary = sanitizeHome(buildSummary(records, { meta: { mode: 'live', tasksFile: '/home/me/x/tasks.json' },
    skipped: [{ id: 'later-task', reason: 'placeholder' }] }), '/home/me');
  assert.equal(summary.totals['claude:s:low'].passed, 1);
  assert.equal(summary.totals['claude:s:low'].graded, 1);
  assert.equal(summary.totals['claude:s:low'].ungraded, 1);
  assert.equal(summary.totals['claude:s:low'].requestsPerTask, 4);
  const md = renderSummary(summary);
  assert.match(md, /\| wiki-tagus \| claude:s:low \| 1 \| auto \| PASS \| 30\.0 \| 8\.0 \| 3 \| - \| 2 \| 1 \| - \| - \| 0 \| - \| - \| - \| 4 \| 2\.5 \| 2 \| 1 \| none \| 0 \| \$0\.050 \|/);
  assert.match(md, /\| gf-date-grid \| .* \| manual \| to grade \|/);
  assert.match(md, /unreadable_region:canvas seen/);
  assert.match(md, /Skipped tasks: later-task/);
  assert.match(md, /tasks ~\/x\/tasks\.json/);
  assert.doesNotMatch(JSON.stringify(summary) + md, /SECRET PAGE ANSWER/);
});

test('the committed private smoke summary shows both fixture tasks passing', () => {
  const file = join(ROOT, 'bench', 'live', 'results', 'private-smoke', 'summary.json');
  if (!existsSync(file)) {
    return;
  }
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(summary.meta.mode, 'private');
  assert.deepEqual(summary.rows.map(row => [row.taskId, row.pass]), [['about-members', true], ['pricing-pro', true]]);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /\/home\/[^/~"]+\//, 'home paths sanitized');
});

test('live entry: FAI_MCP_MAX_CALL_MS goes into the installed entry env, nothing else', () => {
  const installed = { mcpServers: { 'fai-browser': { type: 'stdio', command: '/usr/bin/node', args: ['/x/src/mcp-main.js'] } } };
  const config = liveMcpConfig(installed, 180000);
  assert.deepEqual(config.mcpServers['fai-browser'], {
    type: 'stdio', command: '/usr/bin/node', args: ['/x/src/mcp-main.js'], env: { FAI_MCP_MAX_CALL_MS: '180000' },
  });
  assert.equal(installed.mcpServers['fai-browser'].env, undefined, 'input untouched');
  assert.throws(() => liveMcpConfig({ mcpServers: { 'fai-browser': { env: { FAI_HOME: '/h' } } } }, 1000), /FAI_HOME/);
  assert.throws(() => liveMcpConfig({ mcpServers: {} }, 1000), /no fai-browser entry/);
});

test('approval timeouts: select_tab without any run is its own outcome, counted and kept out of the pass rate', () => {
  const selectTab = { tool: 'fai_browser_run', status: 'needs_user', code: 'select_tab', runId: null };
  assert.deepEqual(approvalOutcome([{ tool: 'fai_browser_run', parsed: false, errorCode: 'invalid_params' }, selectTab]),
    { approvalTimeouts: 1, lost: true, invalidParams: 1 });
  assert.deepEqual(approvalOutcome([selectTab, { tool: 'fai_browser_run', status: 'completed', runId: 'r' }]),
    { approvalTimeouts: 1, lost: false, invalidParams: 0 }, 'approved on the next call: not lost');
  const summary = buildSummary([
    { taskId: 'a', host: 'h', rep: 1, outcome: 'approval_timeout', grading: 'auto', pass: null, approvalTimeouts: 1 },
    { taskId: 'b', host: 'h', rep: 1, outcome: 'ok', grading: 'auto', pass: true },
    { taskId: 'c', host: 'h', rep: 1, outcome: 'ok', grading: 'manual', pass: null },
  ]);
  assert.deepEqual([summary.totals.h.graded, summary.totals.h.passed, summary.totals.h.approvalTimeoutRuns, summary.totals.h.ungraded], [1, 1, 1, 1]);
  assert.match(renderSummary(summary), /\| a \| h \| 1 \| auto \| approval timeout \|.*1× select_tab/);
});

test('--import converts hand-run dirs into run records and a summary', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir, copyFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'live-import-'));
  try {
    const src = join(dir, 'src');
    // A recorded completed run (the private smoke stream) and a synthetic select_tab session.
    await mkdir(join(src, 'pricing-pro', 'traces'), { recursive: true });
    await copyFile(FIXTURE, join(src, 'pricing-pro', 'events.jsonl'));
    await writeFile(join(src, 'pricing-pro', 'prompt.txt'), 'What is the Pro price?');
    await writeFile(join(src, 'pricing-pro', 'started.txt'), '2026-10-06T09:02:50+02:00\n');
    await writeFile(join(src, 'pricing-pro', 'ended.txt'), '2026-10-06T09:03:00+02:00\n');
    const receipt = { state: 'done', v: 2, requestId: 'req_x', status: 'needs_user', code: 'select_tab', verdict: { kind: 'needs_user', oversight: 'user', why: ['select_tab'] } };
    const events = [
      { type: 'system', subtype: 'init', session_id: 's', mcp_servers: [{ name: 'fai-browser', status: 'connected' }] },
      { type: 'assistant', timestamp: '2026-10-06T07:10:20.000Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__fai-browser__fai_browser_run', input: { origins: ['https://www.booking.com'] } }] } },
      { type: 'user', timestamp: '2026-10-06T07:11:05.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify(receipt) }] } },
      { type: 'assistant', timestamp: '2026-10-06T07:11:06.000Z', message: { id: 'm2', content: [{ type: 'text', text: 'Please approve the tab.' }] } },
      { type: 'result', subtype: 'success', duration_ms: 48200, num_turns: 2, total_cost_usd: 0.03, result: 'Please approve the tab.', usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    await mkdir(join(src, 'booking-paris-r2'), { recursive: true });
    await writeFile(join(src, 'booking-paris-r2', 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n'));
    await writeFile(join(src, 'booking-paris-r2', 'started.txt'), '2026-10-06T09:10:15+02:00\n');
    const out = join(dir, 'out');
    await promisify(execFile)(process.execPath, [join(ROOT, 'bench', 'live', 'run.mjs'), '--import', src, '--out', out],
      { timeout: 60_000, env: { ...process.env, CLAUDE_BIN: 'true' } });
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    const rows = Object.fromEntries(summary.rows.map(row => [row.taskId, row]));
    assert.equal(summary.meta.mode, 'live');
    assert.deepEqual([rows['booking-paris'].rep, rows['booking-paris'].outcome, rows['booking-paris'].approvalTimeouts, rows['booking-paris'].wallMs],
      [2, 'approval_timeout', 1, 48200]);
    assert.equal(rows['booking-paris'].approvalMs, 45000, 'the whole relay-less select_tab call');
    assert.deepEqual([rows['pricing-pro'].grading, rows['pricing-pro'].pass, rows['pricing-pro'].requests, rows['pricing-pro'].faiRunCalls],
      ['manual', null, 2, 1]);
    assert.ok(existsSync(join(out, 'runs', 'pricing-pro.claude_claude-sonnet-5-5_low.1', 'run.json')));
    assert.match(readFileSync(join(out, 'grades.json'), 'utf8'), /pricing-pro\|claude:claude-sonnet-5-5:low\|1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fixture tasks: user prompts sent as is, graded by pattern on the reply', () => {
  const { suite, tasks } = loadPrivateTasks(new URL('../bench/live/tasks-fixture.json', import.meta.url));
  assert.equal(suite.site, 'fixtures');
  assert.ok(existsSync(new URL('../fixtures/long/flights-live/index.html', import.meta.url)));
  for (const task of tasks) {
    const prompt = privatePrompt(task, 'http://127.0.0.1:9', { common: 'COMMON {{INSTRUCTION}}', tools: 'TOOLS' });
    assert.ok(prompt.includes('http://127.0.0.1:9/long/flights-live/'), task.id);
    assert.doesNotMatch(prompt, /COMMON|TOOLS|\{\{|steps|expectation|suppliedText/, task.id);
    assert.equal(graderFor(task).kind, 'auto');
    assert.equal(gradeFinal(task, 'Cheapest: easyJet, Thu 15 Oct, 10:40 AM, €58.').pass, true, task.id);
    assert.equal(gradeFinal(task, 'Cheapest: Vueling, Thu 15 Oct, 10:45 AM, €61.').pass, false, task.id);
  }
  const week = tasks.find(task => task.id === 'fx-results-week');
  assert.equal(gradeFinal(week, 'easyJet 10:40 AM €58 on Monday').pass, false);
});

test('runCallStats: suppliedText, needs_host and unverified counts, and call shapes without text', () => {
  const receipts = [
    { tool: 'fai_browser_run', status: 'needs_host', arguments: { instructionChars: 412, expectation: ['textIncludes'] } },
    { tool: 'fai_browser_run', status: 'completed', arguments: { steps: 2, suppliedText: ['destination'],
      stepExpectations: [['textIncludes'], ['textIncludes', 'urlIncludes']] } },
    { tool: 'fai_browser_run', status: 'unverified', arguments: { requestId: 'r1', instructionChars: 20 } },
    { tool: 'fai_browser_observe', status: 'needs_host', arguments: {} },
    { tool: 'fai_browser_run', parsed: false, errorCode: 'invalid_params', arguments: null },
  ];
  const stats = runCallStats(receipts);
  assert.equal(stats.suppliedTextCalls, 1);
  assert.equal(stats.needsHostCalls, 2);
  assert.equal(stats.unverifiedCalls, 1);
  assert.deepEqual(stats.calls, [
    'plain, 412 ch, exp textIncludes -> needs_host',
    'steps 2 [textIncludes, textIncludes+urlIncludes], st destination -> completed',
    'continue, 20 ch -> unverified',
    '? -> invalid_params',
  ]);
  assert.equal(callShape({ steps: 1, stepExpectations: [[]] }), 'steps 1 [none]');
});

test('receiptsFrom keeps suppliedText field names and expectation keys, never values', () => {
  const [receipt] = receiptsFrom([{ id: 'c1', tool: 'fai_browser_run', arguments: JSON.stringify({
    instruction: 'Fill Where to? with destination', suppliedText: { destination: 'London' },
    steps: [{ instruction: 'a', expectation: { textIncludes: 'x' } }], expectation: { urlIncludes: '/s' } }),
  result: { content: [{ type: 'text', text: '{"v":2,"status":"completed"}' }] } }]);
  assert.deepEqual(receipt.arguments.suppliedText, ['destination']);
  assert.equal(receipt.arguments.instructionChars, 31);
  assert.deepEqual(receipt.arguments.expectation, ['urlIncludes']);
  assert.deepEqual(receipt.arguments.stepExpectations, [['textIncludes']]);
  assert.doesNotMatch(JSON.stringify(receipt.arguments), /London/);
});

test('summary shows step calls, suppliedText calls, needs_host / unverified and the call shapes', () => {
  const summary = buildSummary([{ taskId: 't', host: 'h', rep: 1, outcome: 'ok', pass: true, grading: 'auto',
    faiRunCalls: 2, faiStepCalls: 1, faiListSteps: 4, suppliedTextCalls: 1, needsHostCalls: 1, unverifiedCalls: 0,
    runCalls: ['plain, 10 ch -> needs_host', 'steps 4 [a, b, c, d] -> completed'] }]);
  assert.equal(summary.totals.h.stepCalls, 1);
  assert.equal(summary.totals.h.suppliedTextCalls, 1);
  assert.equal(summary.totals.h.needsHostCalls, 1);
  const md = renderSummary(summary);
  assert.match(md, /Step calls \| Steps sent \| suppliedText calls \| needs_host \| unverified/);
  assert.match(md, /- t h #1: \(1\) plain, 10 ch -> needs_host; \(2\) steps 4/);
});
