// Confidence floors: a provider choice below its class floor (thresholds.linkFloor for links, controlFloor for
// buttons, selects and fills; minConfidence is an alias for controlFloor) is handed to the host, unexecuted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, choiceConfidence } from '../src/runtime.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

// On /about the read-only offer is a0 Members, a1 Home, a2 scroll down, a3 scroll up, a4 wait, done, handoff.
function provider(decision) {
  const calls = [];
  return {
    calls,
    async decide(observation, actions) {
      calls.push(actions);
      return typeof decision === 'function' ? decision(actions) : decision;
    },
  };
}

function setup(decision) {
  const bridge = new FakeBridge({ path: '/about' });
  const chosen = provider(decision);
  return { bridge, provider: chosen, runtime: new BrowserRuntime({ bridge, provider: chosen }) };
}

const UNSURE = {
  actionId: 'a0',
  confidence: 0.42,
  probabilities: { a0: 0.42, done: 0.2, a1: 0.18, a4: 0.08, a2: 0.06, handoff: 0.04, a3: 0.02 },
};

test('the floor is off by default: a low-confidence choice still executes', async () => {
  const { bridge, runtime } = setup(UNSURE);
  const result = await runtime.step('Open Members');
  assert.equal(result.status, 'checkpoint');
  assert.equal(bridge.executions.length, 1);
  assert.equal(result.needs.alternatives, undefined);
});

test('below the link floor nothing executes; needs carries the top five executable alternatives and the revision',
  async () => {
    const { bridge, runtime } = setup(UNSURE);
    const result = await runtime.run('Open Members', { thresholds: { linkFloor: 0.6 }, expectation: { urlIncludes: '/members' },
      retry: false });
    assert.equal(bridge.executions.length, 0);
    assert.equal(result.status, 'needs_host');
    assert.equal(result.code, 'low_confidence');
    assert.equal(result.needs.who, 'host');
    assert.match(result.needs.message, /needs\.alternatives/);
    assert.equal(result.needs.confidence, 0.42);
    assert.equal(result.needs.minConfidence, 0.6);
    assert.equal(result.needs.revision, '/about#1');
    assert.deepEqual(result.needs.alternatives.map(alternative => alternative.id), ['a0', 'a1', 'a4', 'a2', 'a3'],
      'sorted by probability; done and handoff are not executable alternatives');
    assert.deepEqual(result.needs.alternatives[0], { id: 'a0', description: 'Click link 1: Members', probability: 0.42 });
    assert.equal(result.steps.length, 0);
    assert.equal(result.cost.decisions, 1);
    assert.equal(result.page.url, `${ORIGIN}/about`);
    assert.equal(result.verification.passed, false);
    // The serialized result keeps the alternatives (they go to the trace and over the client API).
    assert.equal(JSON.parse(JSON.stringify(result)).needs.alternatives.length, 5);

    // The host picks an alternative with act(), using the same revision and no new observe.
    const acted = await runtime.act('a1', { revision: result.needs.revision, expectation: { titleEquals: 'Home' } });
    assert.equal(acted.status, 'completed');
    assert.equal(acted.steps[0].decision.by, 'host');
    assert.equal(bridge.executions.length, 1);
    assert.equal(bridge.executions[0].action.target, '2');
  });

test('a choice at or above the floor executes; a terminal choice is never blocked', async () => {
  const confident = setup({ ...UNSURE, confidence: 0.6 });
  const result = await confident.runtime.step('Open Members', { thresholds: { linkFloor: 0.6 } });
  assert.equal(result.status, 'checkpoint');
  assert.equal(confident.bridge.executions.length, 1);

  const finished = setup({ actionId: 'done', confidence: 0.1 });
  const done = await finished.runtime.run('Check the page', { thresholds: { linkFloor: 0.9 }, expectation: { titleEquals: 'About' } });
  assert.equal(done.status, 'completed', 'done is verified by the expectation, not by provider confidence');
});

test('without confidence the chosen probability is used; with neither the choice counts as below the floor',
  async () => {
    assert.equal(choiceConfidence({ actionId: 'a1', probabilities: { a1: 0.7 } }), 0.7);
    assert.equal(choiceConfidence({ actionId: 'a1', confidence: 0.3, probabilities: { a1: 0.7 } }), 0.3);
    assert.equal(choiceConfidence({ actionId: 'a1' }), null);

    const byProbability = setup({ actionId: 'a1', probabilities: { a1: 0.75, a0: 0.25 } });
    assert.equal((await byProbability.runtime.step('Go home', { thresholds: { linkFloor: 0.7 } })).status, 'checkpoint');

    const silent = setup({ actionId: 'a1' });
    const result = await silent.runtime.step('Go home', { thresholds: { linkFloor: 0.1 } });
    assert.equal(result.code, 'low_confidence');
    assert.equal(silent.bridge.executions.length, 0);
    assert.equal(result.needs.confidence, null);
    assert.deepEqual(result.needs.alternatives, [{ id: 'a1', description: 'Click link 2: Home', probability: null }]);
  });

test('minConfidence must be a number from 0 to 1', async () => {
  for (const value of [-0.1, 1.5, '0.5', Number.NaN]) {
    const { runtime } = setup(UNSURE);
    await assert.rejects(runtime.step('Go', { minConfidence: value }), /minConfidence/);
  }
});

test('minConfidence is an alias for controlFloor: links are not gated by it, links have their own floor', async () => {
  const { bridge, runtime } = setup(UNSURE);
  const result = await runtime.step('Open Members', { minConfidence: 0.6 });
  assert.equal(result.status, 'checkpoint', 'a link at 0.42 runs: linkFloor defaults to 0');
  assert.equal(bridge.executions.length, 1);
  await assert.rejects(setup(UNSURE).runtime.step('Go', { thresholds: { linkFloor: 2 } }), /linkFloor/);
  await assert.rejects(setup(UNSURE).runtime.step('Go', { thresholds: { nope: 0.1 } }), /Unknown threshold/);
});
