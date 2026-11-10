// Receipt v2 (docs/design/OVERSIGHT-SPEC.md section 2): verdict and next for every outcome class, the new codes, the budget
// stop, the auto-confirm rule, expectation lint and the pure oversight helpers. No browser, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { answerShape, autoConfirm, classifyIntent, isNavigationTrail } from '../src/digest.js';
import { lintExpectation } from '../src/expectation.js';
import { CONSENT_REJECT } from '../src/oversight.js';

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
    await writeFile(paths.config, JSON.stringify({ thresholds: { answerConfirm: 0.9 }, budget: { maxCalls: 4 } }));
    assert.deepEqual(loadConfig(paths).thresholds, { answerConfirm: 0.9 });
    await writeFile(paths.config, JSON.stringify({ thresholds: { answerConfirm: 3 } }));
    assert.throws(() => loadConfig(paths), /thresholds: answerConfirm/);
    // A gate of the removed autopilot in an older config.json is ignored, never an error.
    await writeFile(paths.config, JSON.stringify({ thresholds: { linkFloor: 0.2, commitVeto: 0.5 } }));
    assert.doesNotThrow(() => loadConfig(paths));
    await writeFile(paths.config, JSON.stringify({ budget: { maxCalls: 0 } }));
    assert.throws(() => loadConfig(paths), /budget\.maxCalls/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

