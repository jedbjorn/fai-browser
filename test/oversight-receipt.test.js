// Receipt v2 (docs/design/OVERSIGHT-SPEC.md section 2): verdict and next for every outcome class, the new codes, the budget
// stop, the auto-confirm rule, expectation lint and the pure oversight helpers. No browser, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NEXT_KINDS, RESULT_VERSION, STATUSES, agentResult, applyBudget, buildVerdict, createResult, outcomeFor, outcomeResult,
  setOutcome,
} from '../src/result.js';
import { answerShape, autoConfirm, classifyIntent, isNavigationTrail } from '../src/digest.js';
import { lintExpectation } from '../src/expectation.js';
import {
  CONSENT_REJECT, consentRejectActions, instructionTerms, isRejectLabel, namedHops, remainingHops, resolveThresholds,
  suggestExpectation, suggestInstruction,
} from '../src/oversight.js';

function lean(code, extra = {}) {
  const result = createResult({ runId: 'r1', expectation: null, provider: null });
  setOutcome(result, code);
  Object.assign(result, extra);
  return agentResult(result);
}

test('receipt v2: version 2, the new codes keep the status taxonomy', () => {
  assert.equal(RESULT_VERSION, 2);
  const expected = {
    expectation_mismatch: 'unverified', consent_banner: 'needs_user', login: 'needs_user', task_budget: 'budget_exhausted',
  };
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(outcomeFor(code).status, status, code);
    assert.ok(STATUSES.includes(status));
    assert.ok(outcomeFor(code).message.length > 0);
  }
});

test('verdict and next per outcome class', () => {
  const cases = [
    ['expectation_passed', 'verified', 'confirm', 'answer_from_digest'],
    ['handoff_expectation_passed', 'likely', 'confirm', 'answer_from_digest'],
    ['expectation_mismatch', 'likely', 'confirm', 'confirm_page'],
    ['no_expectation', 'needs_decision', 'instruct', 'rerun'],
    ['handoff', 'needs_decision', 'instruct', 'rerun'],
    ['action_budget', 'needs_decision', 'instruct', 'rerun'],
    ['no_progress', 'needs_decision', 'instruct', 'rerun'],
    ['consent_banner', 'needs_user', 'user', 'relay'],
    ['login', 'needs_user', 'user', 'relay'],
    ['cross_origin', 'needs_user', 'user', 'relay'],
    ['blocked_risky', 'needs_user', 'user', 'relay'],
    ['config', 'failed', 'user', 'relay'],
    ['stopped', 'failed', 'user', 'stop'],
    ['task_budget', 'failed', 'user', 'stop'],
    ['request_closed', 'failed', 'user', 'stop'],
    ['provider_error', 'failed', 'user', 'stop'],
  ];
  for (const [code, kind, oversight, next] of cases) {
    const result = lean(code);
    assert.equal(result.verdict.kind, kind, code);
    assert.equal(result.verdict.oversight, oversight, code);
    assert.equal(result.next.kind, next, code);
    assert.ok(NEXT_KINDS.includes(result.next.kind));
    assert.equal(typeof result.next.text, 'string');
    assert.deepEqual(Object.keys(result.verdict), ['kind', 'oversight', 'answer', 'why', 'decide', 'suggested',
      'budget'], code);
    assert.equal(result.verdict.why[0], code);
  }
});

test('no_expectation without a digest hit: next rerun says to run again with an expectation', () => {
  const bare = lean('no_expectation');
  assert.equal(bare.verdict.kind, 'needs_decision');
  assert.equal(bare.next.kind, 'rerun');
  assert.match(bare.next.text, /^Not verified: the run had no expectation and page\.digest holds no likely answer\./);
  assert.match(bare.next.text, /the instruction for what is left and an expectation \(the page path that proves it /);
  assert.match(bare.next.text, /Every run needs an expectation\.$/);
  const result = createResult({ runId: 'r', expectation: null, provider: null });
  setOutcome(result, 'no_expectation');
  result.verdict = buildVerdict(result, { suggested: { expectation: { urlIncludes: '/pricing' } } });
  const suggested = agentResult(result);
  assert.equal(suggested.next.kind, 'rerun');
  assert.match(suggested.next.text, /expectation = verdict\.suggested\.expectation/);
  assert.deepEqual(suggested.verdict.suggested.expectation, { urlIncludes: '/pricing' });
  // Other unverified digests keep their text.
  assert.match(lean('handoff_expectation_passed').next.text, /^Not verified by the expectation alone/);
});

test('no_expectation with a digest hit: next answer_from_digest says not to call any tool', () => {
  const answer = { method: 'jev', candidates: [{ text: '$37', confidence: 0.8 }] };
  const hit = lean('no_expectation', { answer });
  assert.equal(hit.verdict.kind, 'likely');
  assert.equal(hit.next.kind, 'answer_from_digest');
  assert.match(hit.next.text, /^Not verified: the run had no expectation/);
  assert.match(hit.next.text, /Do not call any tool\.$/);
  assert.doesNotMatch(hit.next.text, /Call fai_browser_run|call fai_browser_run/);
  // A weak top candidate is no hit.
  const weak = lean('no_expectation', { answer: { method: 'jev', candidates: [{ text: 'x', confidence: 0.3 }] } });
  assert.equal(weak.next.kind, 'rerun');
});

test('no_expectation with the call budget used up: the rerun becomes stop, a digest answer stays', () => {
  const bare = lean('no_expectation');
  applyBudget(bare, { callsUsed: 6, callsLeft: 0, msUsed: 9000 }, { requestId: 'req_1' });
  assert.equal(bare.next.kind, 'stop');
  assert.ok(bare.verdict.why.includes('task_budget'));
  assert.equal(bare.verdict.suggested, null);
  assert.doesNotMatch(bare.next.text, /Call fai_browser_run/);
  const hit = lean('no_expectation', { answer: { method: 'jev', candidates: [{ text: '$37', confidence: 0.8 }] } });
  applyBudget(hit, { callsUsed: 6, callsLeft: 0, msUsed: 9000 }, { requestId: 'req_1' });
  assert.equal(hit.next.kind, 'answer_from_digest');
  assert.match(hit.next.text, /Do not call any tool\.$/);
});

test('a level refusal the grant already covers: next rerun names the mode, without the popup sentence', () => {
  const result = lean('refused_action', { needs: { who: 'host', message: 'x', level: 'reversible' } });
  assert.equal(result.next.kind, 'rerun');
  assert.match(result.next.text, /the same instruction and mode "reversible"; the user already granted it/);
  assert.doesNotMatch(result.next.text, /FAI Browser icon|popup/);
});

test('an auto-confirmed answer makes next "answer"; without a question a verified outcome is simply reported', () => {
  const result = createResult({ runId: 'r', expectation: null, provider: null });
  setOutcome(result, 'expectation_passed');
  result.verdict = buildVerdict(result, { answer: { text: '$37', confidence: 0.99, basis: ['x'] } });
  const out = agentResult(result);
  assert.equal(out.verdict.kind, 'verified');
  assert.equal(out.verdict.oversight, 'none');
  assert.equal(out.next.kind, 'answer');
  assert.match(out.next.text, /verdict\.answer\.text/);

  const report = createResult({ runId: 'r', expectation: null, provider: null });
  setOutcome(report, 'expectation_passed');
  report.verdict = buildVerdict(report, { hasQuestion: false });
  assert.match(agentResult(report).next.text, /Report it/);
});

test('low_confidence without decide signals derives decide from needs.alternatives', () => {
  const result = lean('low_confidence', {});
  assert.equal(result.next.kind, 'rerun', 'no alternatives: nothing to choose');
  const raw = createResult({ runId: 'r', expectation: null, provider: null });
  setOutcome(raw, 'low_confidence');
  raw.needs.revision = 'rev1';
  raw.needs.alternatives = [{ id: 'a1', description: 'Click link 1: Pricing', probability: 0.4 }];
  const out = agentResult(raw);
  assert.equal(out.next.kind, 'choose');
  assert.deepEqual(out.verdict.decide, { question: 'Which offered action should run next?',
    options: [{ id: 'a1', label: 'Click link 1: Pricing', p: 0.4 }], revision: 'rev1' });
  assert.match(out.next.text, /"rev1"/);
});

test('next names the requestId from the lease; select_tab gets the approval hint', () => {
  const result = outcomeResult('select_tab', { lease: { requestId: 'req_9', state: 'pending' } });
  assert.equal(result.next.kind, 'relay');
  assert.match(result.next.text, /requestId req_9/);
  const consent = outcomeResult('consent_banner', { lease: { requestId: 'req_9', state: 'active' } });
  assert.match(consent.next.text, /once they have done it/);
});

test('agentResult is idempotent and keeps the next kind across JSON', () => {
  const raw = createResult({ runId: 'r', expectation: null, provider: null });
  setOutcome(raw, 'handoff');
  raw.verdict = buildVerdict(raw, { decide: { question: 'q', options: [{ id: 'a1', label: 'x' }, { id: 'a2', label: 'y' }],
    revision: 'v' } });
  const once = agentResult(raw);
  const again = agentResult(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(again, once);
  assert.equal(again.next.kind, 'choose');
});

test('applyBudget: verdict.budget is set, and with no call left a rerun becomes stop', () => {
  const result = lean('handoff');
  applyBudget(result, { callsUsed: 2, callsLeft: 4, msUsed: 9000 }, { requestId: 'req_1' });
  assert.deepEqual(result.verdict.budget, { callsUsed: 2, callsLeft: 4, msUsed: 9000 });
  assert.equal(result.next.kind, 'rerun');
  assert.match(result.next.text, /requestId req_1/);
  applyBudget(result, { callsUsed: 6, callsLeft: 0, msUsed: 9000 }, { requestId: 'req_1' });
  assert.equal(result.next.kind, 'stop');
  assert.ok(result.verdict.why.includes('task_budget'));
  const verified = lean('expectation_passed');
  applyBudget(verified, { callsUsed: 6, callsLeft: 0, msUsed: 1 });
  assert.equal(verified.next.kind, 'answer_from_digest', 'answering needs no further call');
});

// ---------------------------------------------------------------------------------------------------------------
// Answer intent and the auto-confirm rule
// ---------------------------------------------------------------------------------------------------------------

test('classifyIntent: late, nth, count, price, list, name, other', () => {
  assert.equal(classifyIntent('What is the status after the page loads?'), 'late');
  assert.equal(classifyIntent('What is the third item?'), 'nth');
  assert.equal(classifyIntent('How many members are listed?'), 'count');
  assert.equal(classifyIntent('What is the monthly price of the Pro plan?'), 'price');
  assert.equal(classifyIntent('Which members are listed on the About page?'), 'list');
  assert.equal(classifyIntent('Who is the documentation lead?'), 'name');
  assert.equal(classifyIntent('Which HTTP header carries the token?'), 'other');
  assert.equal(classifyIntent('What is shown?', 'Wait until the report finishes loading'), 'late');
});

test('answer shape: price needs a currency amount, count a digit, list a run of two or more items', () => {
  assert.equal(answerShape('price', { text: 'Pro | $37 per month' }), true);
  assert.equal(answerShape('price', { text: 'Pro plan' }), false);
  assert.equal(answerShape('count', { text: 'Ask HN: what are you reading' }), false);
  assert.equal(answerShape('count', { text: '128 comments' }), true);
  assert.equal(answerShape('list', { t: 'list', text: 'a; b', items: 2 }), true);
  assert.equal(answerShape('list', { t: 'li', text: 'a' }), false);
  assert.equal(answerShape('nth', { text: 'x' }), false);
});

const ranked = (...pairs) => ({ method: 'provider', candidates: pairs.map(([text, confidence]) => ({ text, confidence })) });

test('autoConfirm: provider-ranked, at least 0.8, right shape, margin 0.5, not list/nth/late', () => {
  const ok = autoConfirm(ranked(['Pro | $37 per month', 0.99], ['Team | $96', 0.01]),
    { question: 'What is the monthly price of Pro?' });
  assert.deepEqual(ok.answer, { text: '$37 per month', confidence: 0.99,
    basis: ['candidate>=0.8', 'shape:price', 'margin:0.98', 'value:price'], line: 'Pro | $37 per month' });

  assert.deepEqual(autoConfirm(ranked(['Show HN: a tool', 0.98]), { question: 'How many comments?' }).why,
    ['answer:shape_count'], 'hn: the title is not the count');
  assert.ok(autoConfirm(ranked(['Ada', 0.95]), { question: 'Which members are listed?' }).why
    .includes('answer:intent_list'));
  assert.ok(autoConfirm(ranked(['Lamp', 0.95]), { question: 'What is the fifth item?' }).why.includes('answer:intent_nth'));
  assert.ok(autoConfirm(ranked(['X-Token', 0.58]), { question: 'Which header?' }).why.includes('answer:low_confidence'));
  assert.ok(autoConfirm(ranked(['$37', 0.92], ['$96', 0.6]), { question: 'What is the price?' }).why
    .includes('answer:margin'));
  assert.ok(autoConfirm({ method: 'heuristic', candidates: [{ text: '$37', confidence: 0.95 }] },
    { question: 'What is the price?' }).why.includes('answer:not_ranked'));
  // The 0.8 bar (lowered from 0.9): 0.87 with a clear lead confirms, 0.79 does not; the margin still applies.
  assert.equal(autoConfirm(ranked(['$37', 0.87], ['$96', 0.05]), { question: 'What is the price?' }).answer?.text, '$37');
  assert.equal(autoConfirm(ranked(['$37', 0.8], ['$96', 0.05]), { question: 'What is the price?' }).answer?.text, '$37');
  assert.deepEqual(autoConfirm(ranked(['$37', 0.79], ['$96', 0.05]), { question: 'What is the price?' }).why,
    ['answer:low_confidence']);
  assert.ok(autoConfirm(ranked(['$37', 0.85], ['$96', 0.4]), { question: 'What is the price?' }).why
    .includes('answer:margin'));
  assert.ok(autoConfirm(ranked(['X-Token', 0.7]), { question: 'Which header?' }).why.includes('answer:low_confidence'));
  const tuned = autoConfirm(ranked(['X-Token', 0.7]), { question: 'Which header?',
    thresholds: { answerConfirm: 0.65, answerMargin: 0.5 } });
  assert.equal(tuned.answer.text, 'X-Token', 'the thresholds object tunes the rule');
});

// Threshold 0.80 pass (bench/results/threshold-080-2026-10-06): at 0.8 docs-3hop-canary auto-confirmed the page's
// breadcrumb "› › › Canary releases" (0.84-0.87) for a traffic-share question, 3/3 runs. Two guards close it.
test('autoConfirm: a quantity question needs a number, and a navigation trail is never an answer', () => {
  const share = 'What share of traffic do canaries receive?';
  assert.equal(classifyIntent(share), 'quantity');
  assert.equal(classifyIntent('How long are backups kept?'), 'quantity');
  assert.equal(classifyIntent('How often are metrics scraped?'), 'quantity');
  assert.equal(classifyIntent('How many members are listed?'), 'count', 'count stays first');
  assert.equal(classifyIntent('How much does Pro cost?'), 'price', 'price stays first');
  const breadcrumb = autoConfirm(ranked(['› › › Canary releases', 0.87], ['Deployment', 0.06]), { question: share });
  assert.equal(breadcrumb.answer, null);
  assert.ok(breadcrumb.why.includes('answer:shape_quantity'), breadcrumb.why.join(' '));
  assert.ok(breadcrumb.why.includes('answer:navigation_trail'), breadcrumb.why.join(' '));
  assert.ok(autoConfirm(ranked(['Docs › Guides › Deployment', 0.95]), { question: 'Which section is this page in?' })
    .why.includes('answer:navigation_trail'), 'a trail is never confirmed, whatever the intent');
  assert.ok(autoConfirm(ranked(['Canary releases', 0.95]), { question: share }).why.includes('answer:shape_quantity'));
  for (const [question, text] of [[share, 'Canaries receive 5% of traffic for 30 minutes.'],
    ['How long are backups kept?', 'Backups are kept for 35 days.'],
    ['How often are metrics scraped?', 'Metrics are scraped every 30 seconds.'],
    ['How often is the report sent?', 'The report is sent weekly.'],
    ['How long is the trial?', 'The trial lasts two weeks.'],
    ['How much storage does the Pro plan include?', 'Storage | 250 GB'],
    ['How long can a release be rolled back?', 'Rollback window: 72h']]) {
    assert.ok(autoConfirm(ranked([text, 0.85], ['x', 0.01]), { question }).answer, `${question} ${text}`);
  }
  // Host R, office-plan-storage: "how much storage" is a quantity, and a price row is not its answer (0.87-0.90).
  const storage = 'How much storage does the Oslo office\'s plan include?';
  assert.equal(classifyIntent(storage), 'quantity');
  assert.equal(classifyIntent('How much is the Pro plan?'), 'price');
  assert.equal(classifyIntent('How much does the storage add-on cost?'), 'price', 'a price word keeps it a price');
  const row = autoConfirm(ranked(['Pro | $37 per month | $370 per year | 10', 0.9], ['Team | $96', 0.02]), { question: storage });
  assert.equal(row.answer, null);
  assert.ok(row.why.includes('answer:shape_quantity'), row.why.join(' '));
  assert.equal(isNavigationTrail('Home › Guides'), false, 'one separator inside a short label is not a trail');
  assert.equal(isNavigationTrail('Home › Guides › Backups'), true);
  assert.equal(isNavigationTrail('Pro | $37 per month | $370 per year'), false);
  assert.equal(isNavigationTrail('Read docs/guides/backups.md for the details'), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Expectation lint and helpers
// ---------------------------------------------------------------------------------------------------------------

test('lintExpectation shapes', () => {
  const start = { controls: [{ role: 'link', label: 'Pricing' }, { role: 'button', label: 'Sign up' }] };
  assert.deepEqual(lintExpectation({ urlIncludes: '/pricing' }), { shape: 'url_path', weak: false, hint: '' });
  assert.equal(lintExpectation({ urlMatches: 'page=3' }).shape, 'url_guess');
  assert.equal(lintExpectation({ urlEquals: 'https://x/slow' }).weak, true);
  assert.equal(lintExpectation({ textIncludes: 'Pricing' }, start).shape, 'text_menu');
  assert.match(lintExpectation({ textIncludes: 'pricing' }, start).hint, /link label/);
  assert.equal(lintExpectation({ textIncludes: 'Page 3 of 3' }, start).shape, 'text_unique');
  assert.equal(lintExpectation({ textAbsent: 'Loading' }).shape, 'absent');
  assert.equal(lintExpectation(undefined).shape, 'none');
  assert.equal(lintExpectation(() => true).shape, 'predicate');
});

test('namedHops, remainingHops and suggestions come from the host instruction and URL paths only', () => {
  assert.deepEqual(namedHops('From the home page visit Docs, then the API documentation, then the API authentication '
    + 'page, in that order. Read which HTTP header the page says to send your token in.'),
  ['Docs', 'API documentation', 'API authentication']);
  assert.deepEqual(namedHops('Visit the home page, then follow the Pricing link to the Pricing page.'), ['Pricing']);
  assert.deepEqual(namedHops('Find the documentation for pathlib.Path.read_text'), []);
  assert.deepEqual(remainingHops(['Docs', 'API documentation', 'API authentication'], ['docs', 'api documentation']),
    ['API authentication']);
  assert.deepEqual(suggestExpectation('https://x.test/catalog/page-3.html'), { urlIncludes: '/catalog/page-3.html' });
  assert.deepEqual(suggestExpectation('https://news.ycombinator.com/item?id=4&utm_source=a'),
    { urlIncludes: '/item?id=4' });
  assert.equal(suggestExpectation('https://x.test/'), null);
  assert.equal(suggestExpectation('https://x.test/a', { urlIncludes: '/a' }), null, 'never the same expectation');
  assert.equal(suggestInstruction({ hops: ['A'], remaining: [], question: 'q' }), null);
  assert.deepEqual(instructionTerms('Open the Pricing page and read it'), ['pricing']);
});

test('thresholds: one object, defaults, aliases and validation', () => {
  assert.equal(resolveThresholds({}).thresholds.controlFloor, 0.5);
  assert.equal(resolveThresholds({ minConfidence: 0.7 }).thresholds.controlFloor, 0.7);
  assert.ok(resolveThresholds({ minConfidence: 0.7 }).explicit.has('controlFloor'));
  assert.equal(resolveThresholds({ doneThreshold: 0.6 }).thresholds.doneThreshold, 0.6);
  assert.equal(resolveThresholds({ thresholds: { strongDone: 0.85 } }).thresholds.strongDone, 0.85);
  assert.throws(() => resolveThresholds({ thresholds: { answerMargin: 1.5 } }), /answerMargin/);
  assert.throws(() => resolveThresholds({ thresholds: [] }), /object/);
});

test('consent: kinds decide, labels are the fallback, and accept-all variants never qualify', () => {
  assert.equal(isRejectLabel('Reject all'), true);
  assert.equal(isRejectLabel('Only necessary cookies'), true);
  assert.equal(isRejectLabel('Accept non-essential cookies'), false);
  assert.equal(isRejectLabel('Allow all and necessary'), false);
  assert.equal(isRejectLabel('Accept all'), false);
  const actions = consentRejectActions({ buttons: [
    { id: '1', label: 'Reject all', kind: 'reject' },
    { id: '2', label: 'Necessary only', kind: 'settings' },
    { id: '3', label: 'Decline' },
    { id: '4', label: 'Agree' },
  ] });
  assert.deepEqual(actions.map(action => action.target), ['1', '3']);
  assert.ok(actions.every(action => action.consent === true && action.type === 'click'));
});

test('the consent reject regex in extension/page.js matches the runtime constant (drift check)', () => {
  const page = readFileSync(resolve(import.meta.dirname, '..', 'extension', 'page.js'), 'utf8');
  const match = page.match(/const CONSENT_REJECT = (\/.+\/[a-z]*);/);
  assert.ok(match, 'extension/page.js defines CONSENT_REJECT');
  assert.equal(match[1], String(CONSENT_REJECT));
});

test('config.json accepts thresholds and budget and rejects invalid ones', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig } = await import('../src/home.js');
  const home = await mkdtemp(join(tmpdir(), 'fai-oversight-config-'));
  try {
    const paths = { home, config: join(home, 'config.json') };
    await writeFile(paths.config, JSON.stringify({ thresholds: { linkFloor: 0.2 }, budget: { maxCalls: 4 } }));
    assert.deepEqual(loadConfig(paths).thresholds, { linkFloor: 0.2 });
    await writeFile(paths.config, JSON.stringify({ thresholds: { linkFloor: 3 } }));
    assert.throws(() => loadConfig(paths), /thresholds: linkFloor/);
    await writeFile(paths.config, JSON.stringify({ budget: { maxCalls: 0 } }));
    assert.throws(() => loadConfig(paths), /budget\.maxCalls/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a host act with an offer: step_complete is a choose next naming the new revision; no call left makes it stop', () => {
  const offer = {
    revision: 'r2',
    actions: [{ id: 'a1', type: 'click', target: '3', role: 'link', label: 'Home' },
      { id: 'a2', type: 'click', target: '4', role: 'button', label: 'Save' },
      { id: 'a3', type: 'scroll', direction: 'down' }],
    listed: ['a1', 'a3'], cap: 40, dropped: 1,
  };
  const result = setOutcome(createResult({ runId: 'r', expectation: null, provider: null }), 'step_complete');
  result.offer = offer;
  result.lease = { requestId: 'req_9', state: 'active' };
  const verdict = buildVerdict(result);
  assert.equal(verdict.kind, 'needs_decision');
  assert.equal(verdict.nextKind, 'choose');
  assert.equal(verdict.decide, null, 'the listed actions stand in for decide options');
  const lean = agentResult(result);
  assert.equal(lean.revision, 'r2');
  assert.deepEqual(lean.actions, [{ id: 'a1', description: 'click "Home"' }, { id: 'a3', description: 'scroll down' }]);
  assert.equal(lean.moreActions, 1);
  assert.equal(lean.next.kind, 'choose');
  assert.match(lean.next.text, /fai_browser_act with requestId req_9, one actions\[\]\.id as actionId and revision "r2"/);
  assert.match(lean.next.text, /fai_browser_run with requestId req_9/);
  // Without an offer (a run's step, a cross-origin act) step_complete stays a rerun.
  const plain = setOutcome(createResult({ runId: 'p', expectation: null, provider: null }), 'step_complete');
  assert.equal(buildVerdict(plain).nextKind, 'rerun');
  assert.equal(agentResult(plain).actions, undefined);
  // The call budget still applies: with no call left the choose becomes stop; the listing stays for the record.
  const spent = applyBudget(agentResult(result), { callsUsed: 3, callsLeft: 0, msUsed: 1000 }, { requestId: 'req_9' });
  assert.equal(spent.next.kind, 'stop');
  assert.equal(spent.actions.length, 2);
  // A passed expectation on the landing page: a verified answer next, the actions still listed for a driving host.
  const passed = setOutcome(createResult({ runId: 'q', expectation: { urlIncludes: '/x' }, provider: null }), 'expectation_passed');
  passed.verification = { checked: true, passed: true, expectation: { urlIncludes: '/x' } };
  passed.offer = offer;
  const done = agentResult(passed);
  assert.equal(done.next.kind, 'answer_from_digest', 'a code-only verdict without an answer signal');
  assert.equal(done.actions.length, 2);
});

test('select_tab wording follows how the request is approved: on its page (opened right away) or in the window', async () => {
  const { approvalSteps, selectTabMessage, LEASE_MESSAGES } = await import('../src/result.js');
  assert.equal(approvalSteps('page'), 'its task page opened in an existing browser window; click Approve in the page request modal (grant browser site access if asked), or use the FAI Browser toolbar icon');
  assert.match(approvalSteps('window'), /click Open in the FAI Browser window, then Approve in the page request modal/);
  assert.equal(approvalSteps(null), approvalSteps('window'));
  assert.equal(selectTabMessage('window'), LEASE_MESSAGES.select_tab);
  assert.match(selectTabMessage('page'), /^Not approved yet\. Ask the user to approve: its task page opened in an existing browser window/);
  const page = outcomeResult('select_tab', { lease: { requestId: 'req_9', state: 'pending' }, approval: 'page' });
  assert.equal(page.needs.message, selectTabMessage('page'));
  assert.equal(page.next.kind, 'relay');
  assert.match(page.next.text, /in the browser: its task page opened in an existing browser window; click Approve in the page request modal \(grant browser site access if asked\), or use the FAI Browser toolbar icon\. Then call fai_browser_run again with requestId req_9/);
  assert.equal(JSON.parse(JSON.stringify(page)).approval, undefined, 'not a result field');
  const window = outcomeResult('select_tab', { lease: { requestId: 'req_9', state: 'pending' }, approval: 'window' });
  assert.equal(window.needs.message, LEASE_MESSAGES.select_tab);
  assert.match(window.next.text, /click Open in the FAI Browser window, then Approve in the page request modal/);
});
