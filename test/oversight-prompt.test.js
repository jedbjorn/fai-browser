// Regression: bench 2026-10-04-oversight. The new bench prompt (bench/prompts/fai.md) caused two host-side
// regressions the receipts did not: (1) it dropped the textAbsent example, so slow-content's expectation was only
// {"urlIncludes": "/slow"} and maxActions 2 ("about twice the clicks"); (2) "split a task that joins facts from two
// pages into two runs" made docs-lead-guide two calls (the host planned both runs before the first result, and the
// first receipt said next: answer). Baseline ran docs-lead-guide in one call 3/3 from the trail. The prompt and the
// skill now keep named-link joins in one run and restore textAbsent; a completed one-run join answers with 0 extra calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FakeBridge, PAGES, link } from './runtime-fixtures.js';

const ROOT = resolve(import.meta.dirname, '..');
const PROMPT = readFileSync(resolve(ROOT, 'bench', 'prompts', 'fai.md'), 'utf8');
const SKILL = readFileSync(resolve(ROOT, 'skills', 'fai-browser', 'jev.md'), 'utf8'); // The Jev autopilot's guide.

test('the bench prompt teaches textAbsent for late content and a maxActions floor', () => {
  assert.match(PROMPT, /"textAbsent": "Loading"/);
  assert.match(PROMPT, /at least 4/);
});

test('the bench prompt and the skill keep a named-link join in one run and split only searched joins', () => {
  assert.doesNotMatch(PROMPT, /split a task that joins facts from two pages into two runs/);
  assert.match(PROMPT, /reachable by named links[^.]*in that one run/);
  // Hops that would once be split into runs now go in one call as steps (step lists).
  assert.match(PROMPT, /Use several hops only when one run cannot do the task: which item or page to open depends on a value read first/);
  assert.match(PROMPT, /never for one page\. Then send them as steps in one fai_browser_run/);
  assert.match(PROMPT, /use it only when step 1's answerQuestion asks one name, number or URL/);
  assert.match(SKILL, /a join of named links, is one run/);
  assert.match(SKILL, /only when one run cannot do it: which item or page to open depends on a value read first, or over 3 clicks/);
});

test('a one-run join (About, then Docs) that ends verified with a trail fact needs no further call', async () => {
  const bridge = new FakeBridge({
    pages: {
      ...PAGES,
      '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about'), link('2', 'Docs', '/docs')] },
      '/about': { title: 'About', text: 'Priya Raman — Documentation lead', controls: [link('1', 'Docs', '/docs')] },
      '/docs': { title: 'Docs', text: 'Migrating Ledgers to Version Two by Priya Raman', controls: [link('1', 'Home', '/')] },
    },
  });
  const provider = {
    async decide(observation, actions) {
      const path = new URL(observation.url).pathname;
      const next = path === '/' ? 'About' : path === '/about' ? 'Docs' : null;
      const action = actions.find(candidate => candidate.label === next);
      return { actionId: action?.id ?? 'handoff', confidence: 0.95, done: { probability: path === '/docs' ? 0.3 : 0.05 } };
    },
  };
  const runtime = new BrowserRuntime({ bridge, provider });
  const result = await runtime.run('Visit the About page and read which team member is named documentation lead. '
    + 'Then visit the docs home page via the Docs link and find the guide written by that person.', {
    allowedOrigins: ['https://example.com'],
    expectation: { urlIncludes: '/docs' },
    answerQuestion: 'What is the title of the guide on the docs home page written by the documentation lead?',
  });
  assert.equal(result.status, 'completed');
  const lean = agentResult(result);
  assert.ok(lean.trail?.some(entry => entry.lines.some(line => /Documentation lead/.test(line))));
  assert.ok(['answer', 'answer_from_digest'].includes(lean.next.kind), lean.next.kind);
  assert.equal(lean.verdict.plan, undefined);
  assert.equal(lean.verdict.suggested, null);
});
