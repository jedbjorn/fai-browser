// Regression: bench 2026-10-04-matrix-2, cheaper Codex hosts (Luna, Terra). Two failure classes:
// 1. docs-lead-guide failed 6/6 on Luna and Terra: the auto-confirmed verdict.answer was the whole digest line
//    "Migrating Ledgers to Version Two by Priya Raman" and next said "Answer with verdict.answer.text". Sonnet, Sol,
//    Astra and Opus trimmed the byline; Luna and Terra copied it verbatim. verdict.answer.text is now the value cut
//    from the block (the block stays in verdict.answer.line), or carries exact: false when it cannot be cut.
// 2. Terra made no FAI call in 4/24 runs: Codex 0.160 exposes MCP tools as deferred nested tools (exec/ALL_TOOLS,
//    as mcp__fai_browser__fai_browser_run), the host called list_mcp_resources, saw nothing and gave up. The bench
//    prompt and the skill now name the tool and say it is a tool, not an MCP resource.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerValue, autoConfirm, classifyIntent } from '../src/digest.js';

const ranked = (...pairs) => ({ method: 'provider', candidates: pairs.map(([text, confidence]) => ({ text, confidence })) });

// The verdict.answer blocks and host questions recorded in matrix-2 receipts.
const LUNA_DOCS_LEAD_Q = 'What is the title of the guide listed on the docs home page as written by the person named '
  + 'as documentation lead on the About page?';

test('answerValue cuts the value out of the blocks matrix-2 auto-confirmed', () => {
  const cases = [
    ['Migrating Ledgers to Version Two by Priya Raman', LUNA_DOCS_LEAD_Q, 'Migrating Ledgers to Version Two',
      'byline_title'],
    ['Migrating Ledgers to Version Two by Priya Raman', 'Who wrote the migration guide?', 'Priya Raman', 'byline_name'],
    ['Pro | $37 per month | $370 per year | 10', 'What is the monthly price of the Pro plan?', '$37 per month', 'price'],
    ['Team | $96 per month | $960 per year | 40', 'What is the yearly price of the Team plan?', '$960 per year', 'price'],
    ['Priya Raman — Documentation lead', 'Who is the documentation lead?', 'Priya Raman', 'role_name'],
    ['Every request must carry your workspace token. Send it in the X-Lanternfish-Token HTTP header.',
      'Which HTTP header must the token be sent in?', 'X-Lanternfish-Token', 'header'],
  ];
  for (const [block, question, value, rule] of cases) {
    const out = answerValue(block, { intent: classifyIntent(question), question });
    assert.deepEqual(out, { text: value, exact: true, rule }, `${block} / ${question}`);
  }
});

test('answerValue drops a label the question repeats and cuts the amount from a price-like line', () => {
  assert.deepEqual(answerValue('Region: eu-west-2', { intent: 'other', question: 'Which region is the workspace in?' }),
    { text: 'eu-west-2', exact: true, rule: 'label' });
  assert.equal(answerValue('Batch 7 reconciled: 1,284 records', { intent: 'other',
    question: 'What does the reconciliation status say?' }).text, 'Batch 7 reconciled: 1,284 records',
  'a label the question does not ask about stays');
  assert.deepEqual(answerValue('Total | $142.80', { intent: 'count', question: 'What is the cart total in dollars?' }),
    { text: '$142.80', exact: true, rule: 'price' });
});

test('answerValue leaves single values whole and flags compound blocks it cannot cut', () => {
  for (const block of ['Batch 7 reconciled: 1,284 records', 'Open links in a new tab', '$37']) {
    assert.deepEqual(answerValue(block, { intent: 'other', question: 'What does it say?' }),
      { text: block, exact: true, rule: null }, block);
  }
  assert.equal(answerValue('Sorted by Date Added', { intent: 'other', question: 'What is the sort order?' }).text,
    'Sorted by Date Added', 'a "by" tail is a byline only for a question about a work or its author');
  const row = answerValue('Pro | 10 seats | priority support', { intent: 'other', question: 'How is support handled?' });
  assert.equal(row.exact, false, 'table cells with no cut are a whole line');
  const dotted = answerValue('Kestrel Field Lamp · SKU LF-206 · Available on the Team plan',
    { intent: 'other', question: 'Which plan carries the lamp?' });
  assert.equal(dotted.exact, false);
  const twoPrices = answerValue('Pro | $37 per month | $370 per year', { intent: 'price', question: 'What does Pro cost?' });
  assert.equal(twoPrices.exact, false, 'two prices and no period in the question: the host picks');
});

test('autoConfirm returns the cut value with its source line; thresholds and rejections are unchanged', () => {
  const lead = autoConfirm(ranked(['Migrating Ledgers to Version Two by Priya Raman', 0.99],
    ['Getting Started with Shared Ledgers by Jonah Weiss', 0]), { question: LUNA_DOCS_LEAD_Q });
  assert.deepEqual(lead.answer, {
    text: 'Migrating Ledgers to Version Two',
    confidence: 0.99,
    basis: ['candidate>=0.8', 'shape:name', 'margin:0.99', 'value:byline_title'],
    line: 'Migrating Ledgers to Version Two by Priya Raman',
  });
  const plain = autoConfirm(ranked(['Open links in a new tab', 0.95]), { question: 'What is the setting called?' });
  assert.deepEqual(plain.answer, { text: 'Open links in a new tab', confidence: 0.95,
    basis: ['candidate>=0.8', 'shape:name', 'margin:0.95'] }, 'no line or exact flag when nothing was cut');
  assert.equal(autoConfirm(ranked(['Pro | $37 per month', 0.6]), { question: 'What is the price?' }).answer, null);
});

