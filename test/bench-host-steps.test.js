// The host bench's step tasks (bench/tasks.json, tagged steps): tasks that need two runs without a step list, on the
// bench fixture site. Each hop list validates, each hop's expectation holds on the fixture page it names (with the
// first hop's answer written in), and the first hop's answer is a value FAI can write into {{answer:1}}: its page
// block cuts to exactly that value for the hop's question, with the question's shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { answerShape, answerValue, classifyIntent } from '../src/digest.js';
import { fillStep, validateSteps } from '../src/steps.js';
import { checkDeclarative } from '../src/expectation.js';

const ROOT = resolve(import.meta.dirname, '..');
const SUITE = JSON.parse(readFileSync(resolve(ROOT, 'bench', 'tasks.json'), 'utf8'));
const SITE = resolve(ROOT, SUITE.site);
const ORIGIN = 'http://127.0.0.1:8080';

/**
 * A fixture page as an observation: URL, title and visible text (script text stripped). `revealed` is text a script
 * shows after a click (the plan details), checked against the script source by the caller.
 */
function page(path, revealed = '') {
  const html = readFileSync(resolve(SITE, path.replace(/^\//, '')), 'utf8');
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const text = `${html.replace(/<script[^>]*>[^]*?<\/script>/g, ' ').replace(/<title>[^<]*<\/title>/, ' ').replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–').replace(/&middot;/g, '·').replace(/\s+/g, ' ')} ${revealed}`;
  return { url: ORIGIN + path, title, text };
}

// Per task: the page each hop ends on, the block holding the first hop's answer, and where the final answer is.
const HOPS = {
  'billing-office-hours': { pages: ['/about.html', '/offices/lisbon.html'], block: 'Elif Demir — Billing and plans',
    final: 'Opening hours: 09:00–17:30 WET' },
  'office-plan-storage': { pages: ['/offices/oslo.html', '/pricing.html'], block: 'Workspace plan: Pro',
    final: 'Pro includes 250 GB storage', revealed: 'Pro includes 250 GB storage and priority support.' },
  'office-showroom-page': { pages: ['/offices/auckland.html', '/catalog/page-3.html'], block: 'Showroom items: catalog page 3',
    final: 'Vesper Reading Light' },
};

test('host bench: three step tasks that need two runs, with an expectation per hop that holds on the fixture site', () => {
  const tasks = SUITE.tasks.filter(task => task.tags?.includes('steps'));
  assert.deepEqual(tasks.map(task => task.id).sort(), Object.keys(HOPS).sort());
  for (const task of tasks) {
    const hops = HOPS[task.id];
    const steps = validateSteps(task.steps);
    assert.equal(steps.length, 2, task.id);
    assert.equal(task.expectation, undefined, `${task.id}: expectations are per hop`);
    assert.ok(task.hopExpected?.length && task.expected?.length && task.instruction.length > 40, task.id);
    // Hop 1: its page passes its expectation and shows the block with the answer.
    const first = page(hops.pages[0]);
    assert.ok(checkDeclarative(first, steps[0].expectation), `${task.id}: hop 1 expectation on ${hops.pages[0]}`);
    assert.ok(first.text.includes(hops.block), `${task.id}: ${hops.block}`);
    // The block cuts to exactly the hop answer (so {{answer:1}} can be filled), with the question's shape.
    const question = steps[0].answerQuestion;
    const intent = classifyIntent(question, steps[0].instruction);
    const value = answerValue(hops.block, { intent, question });
    assert.deepEqual([value.text, value.exact], [task.hopExpected[0], true], `${task.id}: ${JSON.stringify(value)}`);
    assert.ok(answerShape(intent, { text: hops.block }), `${task.id}: shape ${intent}`);
    // Hop 2, filled with that value, passes on the page that holds the final answer, and fails on the others.
    const { step } = fillStep(steps[1], new Map([[1, value.text]]));
    assert.ok(step, `${task.id}: hop 2 fills`);
    // Text a click reveals must be in the page's script, and is not on the page before the click.
    if (hops.revealed) {
      assert.ok(readFileSync(resolve(SITE, hops.pages[1].slice(1)), 'utf8').includes(hops.revealed), task.id);
      assert.ok(!page(hops.pages[1]).text.includes(hops.final), `${task.id}: hidden until the click`);
    }
    const last = page(hops.pages[1], hops.revealed);
    assert.ok(checkDeclarative(last, step.expectation), `${task.id}: hop 2 expectation on ${hops.pages[1]}`);
    assert.ok(last.text.includes(hops.final), `${task.id}: ${hops.final}`);
    assert.ok(!checkDeclarative(first, step.expectation), `${task.id}: hop 2 expectation fails on hop 1's page`);
  }
});

test('host bench: the step tasks cannot be done from one named-link run (the second hop depends on the first page)', () => {
  // The value that picks the second hop is not on the start page or on the page whose link it picks.
  assert.ok(!page('/contact.html').text.includes('Billing and plans'));
  assert.ok(!page('/pricing.html').text.includes('Oslo'));
  assert.ok(!page('/catalog/page-1.html').text.includes('Auckland'));
  // Only the selected plan's details are shown; the page starts on Starter.
  assert.match(readFileSync(resolve(SITE, 'pricing.html'), 'utf8'), /<option[^>]*>Starter<\/option>/);
});
