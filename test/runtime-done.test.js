// Doneness: a provider that reports `done` decides when the run is finished; the expectation verifies it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

/**
 * Provider that clicks the first offered link whose label is in `labels` (else chooses `fallback`) and reports
 * done with the probability `done[path]` for the page it is shown (default 0.05).
 */
function doneProvider(labels, done = {}, { fallback = 'handoff', confidence = 0.9, choose } = {}) {
  const calls = [];
  return {
    calls,
    model: 'fake-done',
    async decide(observation, actions) {
      const path = new URL(observation.url).pathname;
      calls.push({ path, actions });
      const action = labels.map(label => actions.find(a => a.type === 'click' && a.label === label)).find(Boolean);
      return { actionId: action?.id ?? fallback, confidence, done: { probability: done[path] ?? 0.05 } };
    },
    choose,
  };
}

const setup = provider => {
  const bridge = new FakeBridge();
  return { bridge, runtime: new BrowserRuntime({ bridge, provider }) };
};

test('a loose expectation that passes on an intermediate page does not end the run while done is low', async () => {
  const provider = doneProvider(['About', 'Members'], { '/members': 0.9 });
  const { bridge, runtime } = setup(provider);
  // "us" also matches the About page ("About us"); before, the run stopped there.
  const result = await runtime.run('Open the members list', { expectation: { textIncludes: 'a' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.page.url, `${ORIGIN}/members`);
  assert.equal(result.steps.length, 2);
  assert.equal(result.cost.decisions, 3, 'the third decision confirms done on the members page');
  assert.deepEqual(provider.calls.map(call => call.path), ['/', '/about', '/members']);
  assert.equal(bridge.executions.length, 2);
  assert.deepEqual(result.steps.map(step => step.decision.done), [0.05, 0.05]);
  assert.equal(result.finalDecision.done, 0.9, 'the confirming decision is kept for the trace');
});

test('the provider choice is not executed once the outcome is confirmed, even below the link floor', async () => {
  const provider = doneProvider(['About'], { '/about': 0.7 }, { confidence: 0.2 });
  const { bridge, runtime } = setup(provider);
  const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' }, thresholds: { linkFloor: 0.5 } });
  // The first choice (on Home) is below the floor: nothing runs and the host gets alternatives.
  assert.equal(result.code, 'low_confidence');
  bridge.path = '/about';
  const confirmed = await runtime.run('Open About', { expectation: { urlIncludes: '/about' },
    thresholds: { linkFloor: 0.5 } });
  assert.equal(confirmed.code, 'expectation_passed');
  assert.equal(confirmed.steps.length, 0, 'the start page already shows the outcome');
});

test('budget runs out with the expectation passing: completed as budget_reached_expectation_passed', async () => {
  const provider = doneProvider(['About', 'Members'], {});
  const { runtime } = setup(provider);
  const result = await runtime.run('Open the members list', { expectation: { textIncludes: 'a' }, maxActions: 2 });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'budget_reached_expectation_passed');
  assert.equal(result.verification.passed, true);
  assert.equal(result.cost.decisions, 2, 'no extra decision after the last action');

  const failing = await setup(doneProvider(['About', 'Members'], {})).runtime.run('Open the members list', {
    expectation: { textIncludes: 'nowhere' }, maxActions: 2,
  });
  assert.equal(failing.code, 'action_budget');
});

test('without an expectation, done >= 0.8 ends the run unverified; lower values continue', async () => {
  const provider = doneProvider(['About', 'Members'], { '/about': 0.6, '/members': 0.85 });
  const { runtime } = setup(provider);
  const result = await runtime.run('Open the members list');
  assert.equal(result.status, 'unverified');
  assert.equal(result.code, 'no_expectation');
  assert.equal(result.page.url, `${ORIGIN}/members`);

  // The final terminal-only decision after the budget does not report done: the budget is exhausted.
  const exhausted = await setup(doneProvider(['About', 'Members'], {})).runtime.run('Open the members list', {
    maxActions: 1,
  });
  assert.equal(exhausted.code, 'action_budget');
  assert.equal(exhausted.cost.decisions, 2);
});

test('done above the threshold while the expectation keeps failing returns unverified after two decisions', async () => {
  const provider = doneProvider(['About'], { '/about': 0.6 }, { fallback: 'a2' });
  const { runtime } = setup(provider);
  // A too-strict expectation: About never contains it, and the provider keeps saying the outcome is visible.
  const result = await runtime.run('Open About', { expectation: { urlEquals: `${ORIGIN}/about.html` }, maxActions: 6 });
  assert.equal(result.status, 'unverified');
  assert.equal(result.code, 'expectation_failed');
  assert.ok(result.steps.length <= 2, `spent ${result.steps.length} actions`);
});

test('strong done with a failing expectation and a handoff re-observes once, then returns expectation_mismatch',
  async () => {
  // catalog-p3: the provider is sure (0.91-0.94) and hands off on the right page; the expectation guessed wrong.
  const provider = doneProvider(['About'], { '/about': 0.95 }, { fallback: 'handoff' });
  const { bridge, runtime } = setup(provider);
  const result = await runtime.run('Open About', {
    expectation: { urlEquals: `${ORIGIN}/about.html` }, maxActions: 6, reobserveDelayMs: 0,
  });
  assert.equal(result.status, 'unverified');
  assert.equal(result.code, 'expectation_mismatch');
  assert.equal(result.steps.length, 1);
  assert.equal(bridge.observes, 2, 'the initial observe plus one late re-observe');
  assert.equal(result.verdict.kind, 'likely');
  assert.deepEqual(result.verdict.suggested.expectation, { urlIncludes: '/about' });
  assert.equal(result.next.kind, 'confirm_page');
});

test('strong done with a failing expectation but a click: the click runs (hn "98 comments" at done 0.93)',
  async () => {
    const provider = doneProvider(['About'], { '/': 0.93, '/about': 0.9 });
    const { bridge, runtime } = setup(provider);
    const result = await runtime.run('Open About', {
      expectation: { urlIncludes: '/about' }, maxActions: 6, reobserveDelayMs: 0,
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.code, 'expectation_passed');
    assert.equal(result.steps.length, 1);
    assert.equal(provider.calls.length, 2);
    assert.equal(bridge.observes, 2, 'the initial observe plus one late re-observe before the click');
  });

test('strong done with a failing expectation on two consecutive click decisions ends expectation_mismatch (github)',
  async () => {
    // github: "Apache-2.0 license" at done 0.88, then another click at 0.95 with a LICENSE expectation that never
    // matches ?tab=Apache-2.0-1-ov-file.
    const provider = doneProvider(['About', 'Members'], { '/': 0.88, '/about': 0.95 });
    const { runtime } = setup(provider);
    const result = await runtime.run('Open the license', {
      expectation: { urlIncludes: '/LICENSE' }, maxActions: 6, reobserveDelayMs: 0,
    });
    assert.equal(result.code, 'expectation_mismatch');
    assert.equal(result.steps.length, 1, 'the first click ran; the second strong-done click did not');
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(result.verdict.suggested.expectation, { urlIncludes: '/about' });
  });

test('a strong-done click followed by a low-done decision resets the consecutive count', async () => {
  const provider = doneProvider(['About', 'Members'], { '/': 0.9, '/about': 0.1, '/members': 0.92 });
  const { runtime } = setup(provider);
  const result = await runtime.run('Open the members list', {
    expectation: { urlIncludes: '/members' }, maxActions: 6, reobserveDelayMs: 0,
  });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.steps.length, 2);
});

test('doneThreshold is configurable and validated', async () => {
  const provider = doneProvider(['About', 'Members'], { '/about': 0.7, '/members': 0.99 });
  const strict = await setup(provider).runtime.run('Open the members list', {
    expectation: { textIncludes: 'a' }, doneThreshold: 0.9,
  });
  assert.equal(strict.page.url, `${ORIGIN}/members`);
  const lenient = await setup(doneProvider(['About', 'Members'], { '/about': 0.7 })).runtime.run('Open About', {
    expectation: { textIncludes: 'a' }, doneThreshold: 0.6,
  });
  assert.equal(lenient.page.url, `${ORIGIN}/about`);
  await assert.rejects(setup(provider).runtime.run('x', { doneThreshold: 2 }), /doneThreshold/);
});

test('a step completes on a passing expectation after its one action', async () => {
  const { runtime } = setup(doneProvider(['About'], {}));
  const result = await runtime.step('Open About', { expectation: { urlIncludes: '/about' } });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.steps.length, 1);
});

test('earlier pages reach choose() and the lean result as a trail for multi-hop answers', async () => {
  const pages = {
    '/': { title: 'Home', text: 'Welcome', controls: [{ id: '1', role: 'link', label: 'About', href: `${ORIGIN}/about` }] },
    '/about': {
      title: 'About',
      text: '',
      controls: [{ id: '1', role: 'link', label: 'Docs', href: `${ORIGIN}/docs` }],
      blocks: [{ t: 'h1', text: 'About' }, { t: 'h2', text: 'Members' }, { t: 'li', text: 'Priya Raman — Documentation lead' },
        { t: 'li', text: 'Jonah Weiss — Support' }],
    },
    '/docs': {
      title: 'Docs',
      text: '',
      controls: [],
      blocks: [{ t: 'h1', text: 'Docs' }, { t: 'h2', text: 'Guides' }, { t: 'li', text: 'Getting Started by Jonah Weiss' },
        { t: 'li', text: 'Migrating Ledgers by Priya Raman' }],
    },
  };
  const requests = [];
  const provider = doneProvider(['About', 'Docs'], { '/docs': 0.9 }, {
    async choose(request) {
      requests.push(request);
      const right = request.candidates.find(candidate => candidate.text.includes('Priya'));
      return { choice: right.id, confidence: 0.9 };
    },
  });
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider });
  const result = await runtime.run('Find the guide written by the documentation lead', {
    expectation: { urlIncludes: '/docs' },
    answerQuestion: 'Which guide on the docs page was written by the documentation lead named on About?',
  });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.answer.candidates[0].text, 'Migrating Ledgers by Priya Raman');
  const about = result.trail.find(entry => entry.url === `${ORIGIN}/about`);
  // A remembered line names the section heading it sits under.
  assert.ok(about.lines.includes('Members › Priya Raman — Documentation lead'), JSON.stringify(result.trail));
  assert.equal(about.state, 1, 'the state index of /about');
  assert.ok(!result.trail.some(entry => entry.url === `${ORIGIN}/docs`), 'the final page is not in the trail');
  assert.deepEqual(requests[0].earlierPages, result.trail);
  assert.deepEqual(agentResult(result).trail, result.trail);
});

test('a handoff on a page where the expectation passes completes as handoff_expectation_passed', async () => {
  // The last page of a multi-hop task: the provider has nothing left to do but keeps done low.
  const provider = doneProvider(['About'], { '/about': 0.3 });
  const { runtime } = setup(provider);
  const result = await runtime.run('Open About and combine it with the home page', {
    expectation: { urlIncludes: '/about' }, answerQuestion: 'Who are we?',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'handoff_expectation_passed');
  assert.equal(result.verification.passed, true);
  assert.ok(result.answerDetail, 'completed results get answer ranking');

  const failing = await setup(doneProvider(['About'], { '/about': 0.3 })).runtime.run('Open About', {
    expectation: { urlIncludes: '/nowhere' },
  });
  assert.equal(failing.code, 'handoff', 'without a passing expectation a handoff stays a handoff');
});

test('a same-origin link that opens a new tab is offered as navigation in the selected tab', async () => {
  const { legalActions } = await import('../src/runtime.js');
  const observation = {
    revision: 'r', url: `${ORIGIN}/`, title: 'Home', text: '',
    controls: [
      { id: '1', role: 'link', label: 'Account settings', href: `${ORIGIN}/settings`, linkTarget: '_blank' },
      { id: '2', role: 'link', label: 'Elsewhere', href: 'https://other.example/x', linkTarget: '_blank' },
    ],
  };
  const offered = legalActions(observation, { allowedOrigins: [ORIGIN] });
  const open = offered.filter(action => action.type === 'navigate_allowed_url');
  assert.deepEqual(open.map(action => [action.url, action.newTab]), [[`${ORIGIN}/settings`, true]]);
  assert.ok(!offered.some(action => action.type === 'click' && action.target === '1'), 'never a new-tab click');
  const { actionBrief } = await import('../src/result.js');
  assert.equal(actionBrief(open[0]), 'open "Account settings" in this tab');
});
