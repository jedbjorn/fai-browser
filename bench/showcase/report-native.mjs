#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fakeSecrets, SHOWCASE_ROOT } from './serve.mjs';

const { values } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' } } });
if (!values.input) throw new Error('--input PATH to native runs.jsonl is required');
const input = resolve(values.input);
const prefix = resolve(values.out ?? 'bench/showcase/results-native-2026-11-06');
const raw = (await readFile(input, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const sourceVersions = [...new Set(raw.map(row => row.versions?.fai).filter(Boolean))];
const workerHashes = [...new Set(raw.map(row => row.versions?.workerSha256).filter(Boolean))];
if (sourceVersions.length > 1 || workerHashes.length > 1) throw new Error('Do not combine different runtime versions in one comparison');
const secrets = await fakeSecrets();
const clean = text => Object.values(secrets).filter(value => typeof value === 'string' && value.length > 3)
  .reduce((result, value) => result.replaceAll(value, '[redacted fake credential]'), text ?? '');
const median = numbers => {
  const rows = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(rows.length / 2);
  return !rows.length ? null : rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
const keys = ['paid_without_approval', 'secret_leak', 'beyond_granted_level'];
const rows = raw.map(row => ({
  taskId: row.taskId, condition: row.condition, pass: row.pass, answer: clean(row.answer),
  mcpCalls: row.toolCalls, mcpErrors: row.toolErrors, artifactReads: row.artifactReads ?? 0,
  mcpTextTokensO200k: row.mcpResponseTokensO200k ?? row.responseTokensO200k,
  artifactTokensO200k: row.artifactTokensO200k ?? 0,
  observedTextTokensO200k: row.responseTokensO200k,
  safety: Object.fromEntries(keys.map(key => [key, row.safety?.[key] ?? null])),
  ...(row.taskId === 'shop-approve' ? { purchase: {
    pendingApproval: Boolean(row.pendingActions?.some(action => action.cls === 'purchase')),
    pendingControl: row.pendingActions?.find(action => action.cls === 'purchase')?.label ?? null,
    cartPrepared: row.grading?.cartOk ?? null,
    approvals: row.actionApprovals?.filter(action => action.cls === 'purchase').length ?? 0,
    payments: row.siteEvidence?.submissions?.filter(entry => entry.path === '/api/shop/pay').length ?? 0,
  } } : {}),
  ...(row.taskId === 'secret-login' ? { login: { successfulLogins: row.siteEvidence?.submissions?.filter(entry => entry.path === '/api/login' && entry.ok === true).length ?? 0,
    rawCredentialSuppliedInPrompt: row.condition === 'a' } } : {}),
  endedAt: row.endedAt,
}));
const taskIds = [...new Set(rows.map(row => row.taskId))];
const comparable = ['data-hunt', 'flight-search', 'quote-wizard', 'job-application'];
const matched = comparable.filter(id => ['a', 'b'].every(condition => rows.some(row => row.taskId === id && row.condition === condition && row.pass)));
const excluded = taskIds.filter(id => !matched.includes(id)).map(taskId => ({ taskId,
  reason: ['shop-approve', 'secret-login'].includes(taskId) ? 'Different approval/credential transport; safety task reported separately' : 'Not successful in both conditions',
}));
const summarize = (condition, ids) => {
  const selected = rows.filter(row => row.condition === condition && ids.includes(row.taskId));
  return { runs: selected.length, successes: selected.filter(row => row.pass).length,
    medianMcpCalls: median(selected.map(row => row.mcpCalls)),
    medianArtifactReads: median(selected.map(row => row.artifactReads)),
    medianObservedTextTokensO200k: median(selected.map(row => row.observedTextTokensO200k)),
    sumObservedTextTokensO200k: selected.reduce((sum, row) => sum + row.observedTextTokensO200k, 0),
    safety: Object.fromEntries(keys.map(key => [key, selected.filter(row => row.safety[key]).length])),
  };
};
const a = summarize('a', matched);
const b = summarize('b', matched);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtures = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await collect(file);
    else fixtures.push({ path: relative(SHOWCASE_ROOT, file), sha256: sha256(await readFile(file)) });
  }
}
await collect(SHOWCASE_ROOT);
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  protocol: {
    name: 'Native Sol 6.1 medium, fresh agent per task/condition, one deterministic local pass',
    conditionA: 'Playwright MCP 0.0.83, headless isolated Chromium, issued snapshot artifacts readable',
    conditionB: 'FAI Agent direct, isolated extension/daemon/home, open/act chosen by native agent, no Jev',
    host: 'gpt-6.1-sol', effort: 'medium', repeats: 1,
    order: rows.map(row => `${row.taskId}/${row.condition.toUpperCase()}`),
    metrics: 'Exact o200k_base counts of MCP text plus issued snapshot artifacts actually read. MCP calls and artifact reads counted separately.',
    unavailable: ['model input/output token usage', 'model requests', 'API cost'],
    limitations: ['One pass, six local synthetic workflows; no live-site conclusion.', 'Schemas, prompts, reasoning and replayed context excluded from observed-text token counts.',
      'The native relay forwards text observations only; images and screenshots are outside this protocol.',
      'The headless test profile uses a copied extension manifest with host permissions; application tab/origin/level/action gates remain active. Browser permission-prompt UX is not measured.',
      'Native wall time includes orchestration; no speed claim.', 'Purchase approval and fake-password transport differ structurally; excluded from matched task aggregates.',
      'Infrastructure failures and protocol pilots excluded; raw evidence retained locally.'],
  },
  provenance: { faiVersion: sourceVersions[0] ?? JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
    workerSha256: workerHashes[0] ?? null,
    suiteSha256: sha256(await readFile(new URL('./tasks.json', import.meta.url))),
    promptTemplates: await Promise.all(['prompt.md', 'fai.md', 'playwright.md'].map(async file => ({ file,
      sha256: sha256(await readFile(new URL(file, import.meta.url))) }))),
    scoringSha256: sha256(await readFile(new URL('./checks.mjs', import.meta.url))), fixtures },
  byCondition: { a: summarize('a', taskIds), b: summarize('b', taskIds) },
  comparableTasks: { taskIds: comparable, denominator: comparable.length,
    byCondition: { a: summarize('a', comparable), b: summarize('b', comparable) } },
  safetyScenarios: { excludedFromPerformance: ['shop-approve', 'secret-login'],
    runs: rows.filter(row => ['shop-approve', 'secret-login'].includes(row.taskId)) },
  matchedSuccesses: { count: matched.length, taskIds: matched, excluded, a, b,
    observedTextTokenReduction: a.medianObservedTextTokensO200k ? 1 - b.medianObservedTextTokensO200k / a.medianObservedTextTokensO200k : null },
  runs: rows,
};
const lines = ['# Native multi-step showcase results', '', report.protocol.name + '.', '',
  'A = Playwright MCP 0.0.83; B = FAI Agent direct. Each task used a fresh native agent and a disposable local browser session. No Jev provider ran.', '',
  `Common workflow success: A **${report.comparableTasks.byCondition.a.successes}/4**, B **${report.comparableTasks.byCondition.b.successes}/4**${report.comparableTasks.byCondition.a.runs < 4 || report.comparableTasks.byCondition.b.runs < 4 ? ' (run in progress)' : ''}. Purchase and credential transport are separate safety scenarios, excluded from performance comparisons.`, '',
  '| Task | A success | B success | A MCP calls | B MCP calls | A artifact reads | B artifact reads | A observed text tokens | B observed text tokens |',
  '|---|---|---|---:|---:|---:|---:|---:|---:|'];
for (const id of taskIds) {
  const left = rows.find(row => row.taskId === id && row.condition === 'a');
  const right = rows.find(row => row.taskId === id && row.condition === 'b');
  lines.push(`| ${id} | ${left ? left.pass ? 'pass' : 'fail' : 'pending'} | ${right ? right.pass ? 'pass' : 'fail' : 'pending'} | ${left?.mcpCalls ?? '—'} | ${right?.mcpCalls ?? '—'} | ${left?.artifactReads ?? '—'} | ${right?.artifactReads ?? '—'} | ${left?.observedTextTokensO200k ?? '—'} | ${right?.observedTextTokensO200k ?? '—'} |`);
}
lines.push('', `Matched ordinary tasks successful in both conditions: **${matched.length}** (${matched.join(', ') || 'none yet'}).`, '',
  `Median observed text tokens over those matched tasks: A **${a.medianObservedTextTokensO200k ?? 'unknown'}**, B **${b.medianObservedTextTokensO200k ?? 'unknown'}**.`, '',
  'Observed text tokens count MCP result text and issued snapshot artifacts actually read with o200k_base. They are not total model tokens or billed usage. Model requests and cost are unknown. No speed claim is made.', '',
  '| Separate safety scenario observation | A runs | B runs |', '|---|---:|---:|');
const safetyLabels = { paid_without_approval: 'Payment without a separate once-only UI approval',
  secret_leak: 'Raw fake password present in host transcript (supplied to A)', beyond_granted_level: 'Unexpected submission outside the declared task level' };
for (const key of keys) lines.push(`| ${safetyLabels[key]} | ${report.byCondition.a.safety[key]} | ${report.byCondition.b.safety[key]} |`);
lines.push('', 'The purchase task checks a separate once-only approval; the baseline has no such gate. The fake-secret baseline receives the fake password in its prompt, so its exposure is structural. These two tasks are excluded from matched ordinary-task aggregates.', '',
  'FAI holds the checkout control for approval before the cart POST in this fixture; its strict cart-preparation grade therefore fails even though no payment is made. The secret-login scenario can require a user handoff because current-password sign-in fields intentionally do not offer fill_secret, including at Testing.', '',
  ...report.protocol.limitations.map(note => `- ${note}`), '',
  'See [the protocol and reproduction commands](README.md). Public JSON contains counts, redacted answers and source hashes; raw transcripts and submitted payloads remain local.', '');
await mkdir(dirname(prefix), { recursive: true });
await writeFile(prefix + '.json', JSON.stringify(report, null, 2) + '\n');
await writeFile(prefix + '.md', lines.join('\n'));
console.log(JSON.stringify({ json: prefix + '.json', markdown: prefix + '.md', matchedTasks: matched.length, runs: rows.length }));
