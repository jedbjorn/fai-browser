// Regression: bench 2026-10-04-oversight reported "false automation 6". All six were the first receipt of a split
// task (docs-lead-guide and catalog-plan-price, reps 1-3), whose auto-confirmed verdict.answer correctly answered that
// hop's own question ("Priya Raman — Documentation lead", "Kestrel Field Lamp · SKU LF-206 · Available on the Team
// plan") but was graded against the task's final answer. The grader now grades only the final receipt against the
// task answer and earlier receipts against task.hopExpected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { oversightFor } from '../bench/lib/metrics.mjs';

const TASKS = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'bench', 'tasks.json'), 'utf8')).tasks;
const task = id => TASKS.find(entry => entry.id === id);
const receipt = verdictAnswer => ({ oversight: 'none', verdictKind: 'verified', nextKind: 'answer', verdictAnswer });

test('a correct hop answer on an intermediate receipt is not a false automation', () => {
  const lead = oversightFor([receipt('Priya Raman — Documentation lead'),
    receipt('Migrating Ledgers to Version Two by Priya Raman')], task('docs-lead-guide'));
  assert.equal(lead.autoAnswers, 2);
  assert.equal(lead.hopAutoAnswers, 1);
  assert.equal(lead.falseAutomation, 0);
  assert.equal(lead.verdictAnswerPass, true);

  const plan = oversightFor([receipt('Kestrel Field Lamp · SKU LF-206 · Available on the Team plan'),
    receipt('Team | $96 per month | $960 per year | 40')], task('catalog-plan-price'));
  assert.equal(plan.falseAutomation, 0);
});

test('a wrong hop answer, a wrong final answer and ungraded hops are still reported', () => {
  const wrongHop = oversightFor([receipt('Jonah Weiss — Support'),
    receipt('Migrating Ledgers to Version Two by Priya Raman')], task('docs-lead-guide'));
  assert.equal(wrongHop.falseAutomation, 1);
  const wrongFinal = oversightFor([receipt('Priya Raman — Documentation lead'),
    receipt('Webhook Recipes by Mira Okafor')], task('docs-lead-guide'));
  assert.equal(wrongFinal.falseAutomation, 1);
  assert.equal(wrongFinal.verdictAnswerPass, false);
  // A task without hopExpected leaves intermediate auto answers ungraded rather than wrong.
  const ungraded = oversightFor([receipt('Anything'), receipt('$37 per month')], task('pricing-pro'));
  assert.equal(ungraded.falseAutomation, 0);
  assert.equal(ungraded.hopUngraded, 1);
});
