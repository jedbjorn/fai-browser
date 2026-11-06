import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { bridgeError } from '../src/result.js';
import { FakeBridge, ORIGIN, clickProvider, tick } from './runtime-fixtures.js';

function setup({ labels = ['About', 'Members'], fallback, bridgeOptions, provider } = {}) {
  const bridge = new FakeBridge(bridgeOptions);
  const chosen = provider ?? clickProvider(labels, { fallback, log: bridge.log });
  const runtime = new BrowserRuntime({ bridge, provider: chosen });
  return { bridge, provider: chosen, runtime };
}

test('step executes one action and returns a checkpoint with schema v2 evidence', async () => {
  const { bridge, runtime } = setup();
  const result = await runtime.step('Open About');
  assert.equal(bridge.executions.length, 1);
  assert.equal(result.v, 2);
  assert.equal(result.status, 'checkpoint');
  assert.equal(result.code, 'step_complete');
  assert.deepEqual(result.needs.who, 'host');
  assert.equal(result.steps.length, 1);
  const [step] = result.steps;
  assert.equal(step.i, 1);
  assert.deepEqual(step.action, {
    type: 'click', ref: '1', label: 'About', fromUrl: `${ORIGIN}/`, toUrl: `${ORIGIN}/about`,
  });
  assert.equal(step.decision.by, 'provider');
  assert.equal(step.decision.model, 'fake');
  assert.equal(step.settle, 'quiet');
  assert.equal(step.changed, true);
  assert.equal(step.screenshot.revision, step.observation.revision);
  assert.equal(step.screenshot.format, 'jpeg');
  assert.equal(result.page.url, `${ORIGIN}/about`);
  assert.equal(result.page.textExcerpt, 'About us');
  assert.equal(result.cost.decisions, 1);
  assert.equal(result.cost.inputTokens, 10);
  assert.equal(result.cost.provider, 'fake');
  assert.equal(bridge.executions[0].expectedRevision, '/#1');
  // No pre-execute freshness observe: one initial observe only.
  assert.equal(bridge.observes, 1);
});

test('step with a passing expectation completes without a done decision', async () => {
  const { runtime, provider } = setup();
  const result = await runtime.step('Open About', { expectation: { urlIncludes: '/about' } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.verification, { checked: true, passed: true, expectation: { urlIncludes: '/about' } });
  assert.equal(provider.calls.length, 1);
});

test('run needing exactly maxActions actions completes (budget bug)', async () => {
  const { bridge, runtime, provider } = setup();
  const result = await runtime.run('Find members', { maxActions: 2, expectation: { textIncludes: 'ada, grace' } });
  assert.equal(result.status, 'completed');
  assert.equal(bridge.executions.length, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(result.cost.decisions, 2);
});

test('expectation is checked after every action and ends the run early', async () => {
  const { bridge, runtime } = setup();
  const result = await runtime.run('Open About', { maxActions: 5, expectation: { titleIncludes: 'about' } });
  assert.equal(result.status, 'completed');
  assert.equal(bridge.executions.length, 1);
});

test('action budget without a passing expectation is budget_exhausted', async () => {
  const { bridge, runtime } = setup({ labels: ['About', 'Home'] });
  const result = await runtime.run('Loop', { maxActions: 2, expectation: { textIncludes: 'Nowhere' } });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.code, 'action_budget');
  assert.equal(bridge.executions.length, 2);
  assert.equal(result.verification.passed, false);
});

test('without an expectation the provider gets one terminal-only decision after the budget', async () => {
  const { runtime, provider } = setup({ labels: ['About', 'Home'] });
  const result = await runtime.run('Loop', { maxActions: 2 });
  assert.equal(provider.calls.length, 3);
  assert.deepEqual(provider.calls[2].actions.map(a => a.id), ['done', 'handoff']);
  assert.equal(result.status, 'unverified');
  assert.equal(result.code, 'no_expectation');
});

test('done maps to completed only when an independent expectation passes', async () => {
  const cases = [
    [undefined, 'unverified', 'no_expectation'],
    [() => false, 'unverified', 'expectation_failed'],
    [() => { throw new Error('bad predicate'); }, 'unverified', 'expectation_error'],
    [() => true, 'completed', 'expectation_passed'],
    [{ urlEquals: `${ORIGIN}/`, textIncludes: 'WELCOME' }, 'completed', 'expectation_passed'],
    [{ textIncludes: 'Missing' }, 'unverified', 'expectation_failed'],
  ];
  for (const [expectation, status, code] of cases) {
    const { bridge, runtime } = setup({ labels: [] });
    const result = await runtime.run('Done', { expectation });
    assert.equal(result.status, status, String(expectation));
    assert.equal(result.code, code);
    assert.equal(bridge.executions.length, 0);
  }
});

test('invalid expectation shapes are rejected before the run starts', async () => {
  for (const expectation of [{}, { textIncludes: '' }, { unsupported: 'x' }, { urlMatches: '(' }, ['x']]) {
    const { bridge, runtime } = setup();
    await assert.rejects(runtime.run('Go', { expectation }), TypeError);
    assert.equal(bridge.observes, 0);
  }
});

test('unknown decision never executes', async () => {
  const { bridge, runtime } = setup({ provider: { decide: async () => ({ actionId: 'invented' }) } });
  const result = await runtime.step('Go');
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_decision');
  assert.equal(bridge.executions.length, 0);
});

test('provider failure is failed/provider_error', async () => {
  const { runtime } = setup({ provider: { decide: async () => { throw new Error('HTTP 500'); } } });
  const result = await runtime.step('Go');
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'provider_error');
  assert.match(result.errorDetail.message, /HTTP 500/);
  assert.equal(result.reason, 'The decision provider failed');
});

for (const code of ['stale', 'target_unavailable', 'capture_failed']) {
  test(`${code} re-observes once and lets the provider decide again`, async () => {
    const { bridge, runtime, provider } = setup();
    bridge.failNext.push(bridgeError(code, code));
    const result = await runtime.step('Open About', { expectation: { urlIncludes: '/about' } });
    assert.equal(result.status, 'completed');
    assert.equal(provider.calls.length, 2);
    assert.equal(bridge.observes, 2);
    assert.equal(bridge.executions.length, 2);
    if (code !== 'capture_failed') assert.equal(result.steps.length, 1);
  });
}

test('repeated stale errors hand off to the host instead of looping', async () => {
  const { bridge, runtime } = setup();
  bridge.failNext.push(bridgeError('stale'), bridgeError('stale'), bridgeError('stale'));
  const result = await runtime.run('Open About', { maxActions: 3, retry: false });
  assert.equal(result.status, 'needs_host');
  assert.equal(result.code, 'stale');
  assert.equal(result.steps.length, 0);
});

test('step stale retry is limited by its decision budget', async () => {
  const { bridge, runtime } = setup();
  bridge.failNext.push(bridgeError('stale'), bridgeError('stale'));
  const result = await runtime.step('Open About');
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.code, 'decision_budget');
});

const STATUS_BY_CODE = {
  blocked_risky: 'needs_user',
  cross_origin: 'needs_user',
  child_tab: 'needs_user',
  tab_changed: 'needs_user',
  origin_changed: 'needs_user',
  session_inactive: 'needs_user',
  disconnected: 'needs_user',
  paused: 'needs_user',
  stopped: 'stopped',
  timeout: 'failed',
};
// `unsupported` is retried once with the action excluded (rung 1b); see test/oversight-ladder.test.js.

test('bridge error codes map to the status taxonomy', async () => {
  for (const [code, status] of Object.entries(STATUS_BY_CODE)) {
    const { bridge, runtime } = setup();
    bridge.failNext.push(bridgeError(code, `bridge says ${code}`));
    const result = await runtime.step('Open About');
    assert.equal(result.status, status, code);
    assert.equal(result.code, code);
    assert.ok(result.needs.message.length > 0 || status === 'stopped', code);
    // The action may have been attempted; it stays in the trace marked as interrupted.
    assert.equal(result.steps[0].interrupted, true);
    assert.equal(result.steps[0].error.code, code);
  }
  const { bridge, runtime } = setup();
  bridge.failNext.push(new Error('Something odd'));
  const result = await runtime.step('Open About');
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'failed');
  assert.match(result.errorDetail.message, /Something odd/);
  assert.doesNotMatch(result.reason, /Something odd/);
});

test('observe errors map too: no lease is needs_user/session_inactive', async () => {
  const { bridge, runtime } = setup();
  bridge.observe = async () => { throw bridgeError('session_inactive', 'Select and start a browser tab'); };
  const result = await runtime.run('Go');
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'session_inactive');
  assert.equal(result.page, null);
});

test('pause during provider call prevents the pending action', async () => {
  let release;
  const { bridge, runtime } = setup({ provider: { decide: () => new Promise(resolve => { release = resolve; }) } });
  const running = runtime.step('Go');
  await tick();
  runtime.pause();
  release({ actionId: 'a0' });
  const result = await running;
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'paused');
  assert.equal(bridge.executions.length, 0);
});

test('user Stop reports stopped, not needs_user', async () => {
  const { runtime } = setup({ provider: { decide: () => new Promise(() => {}) } });
  const running = runtime.run('Go');
  await tick();
  runtime.stop();
  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.equal(result.code, 'stopped');
});

test('Stop during execution keeps the partial step in the trace', async () => {
  const { bridge, runtime } = setup();
  bridge.execute = () => new Promise(() => {});
  const running = runtime.step('Open About');
  await new Promise(resolve => setTimeout(resolve, 10));
  runtime.stop();
  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].interrupted, true);
  assert.equal(result.steps[0].action.label, 'About');
});

test('caller AbortSignal reports stopped/cancelled', async () => {
  const controller = new AbortController();
  const { runtime } = setup({ provider: { decide: () => new Promise(() => {}) } });
  const running = runtime.run('Go', { signal: controller.signal });
  await tick();
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.equal(result.code, 'cancelled');
});

test('provider that ignores abort is still time bounded', async () => {
  const { bridge, runtime } = setup({ provider: { decide: () => new Promise(() => {}) } });
  const keepalive = setTimeout(() => {}, 200);
  const result = await runtime.run('Go', { timeoutMs: 10 });
  clearTimeout(keepalive);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.code, 'time_budget');
  assert.equal(result.reason, 'Time budget reached');
  assert.equal(bridge.executions.length, 0);
});

test('actions that do not change the page end as needs_host/no_progress', async () => {
  const provider = { decide: async (_, actions) => ({ actionId: actions.find(a => a.type === 'wait').id }) };
  const { bridge, runtime } = setup({ provider });
  const result = await runtime.run('Wait', { maxActions: 5 });
  assert.equal(result.status, 'needs_host');
  assert.equal(result.code, 'no_progress');
  assert.equal(bridge.executions.length, 3);
  assert.equal(result.steps.every(step => step.changed === false), true);
});

test('reaching an unapproved origin is needs_user/cross_origin', async () => {
  const { bridge, runtime } = setup();
  bridge.pages['/about'].url = 'https://elsewhere.com/about';
  const result = await runtime.run('Open About', { allowedOrigins: [ORIGIN] });
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'cross_origin');
});

test('capture each: every step keeps its screenshot and capture overlaps the next decision', async () => {
  const { bridge, runtime } = setup({ bridgeOptions: { captureDelayMs: 30 } });
  const result = await runtime.run('Members', { maxActions: 2, capture: 'each', expectation: { textIncludes: 'Linus' } });
  assert.equal(result.status, 'completed');
  assert.ok(bridge.executions.every(execution => execution.capture === true));
  assert.ok(result.steps.every(step => step.screenshot?.revision === step.observation.revision));
  // The second decision started before the first screenshot was delivered.
  const decide2 = bridge.log.indexOf('decide:/about#2');
  const captured1 = bridge.log.indexOf('captured:/about#2');
  assert.ok(decide2 >= 0 && captured1 > decide2, bridge.log.join(','));
  assert.ok(result.steps[0].ms.capture >= 20);
});

test('capture defaults to last: only the final step keeps a screenshot', async () => {
  const { bridge, runtime } = setup();
  const result = await runtime.run('Members', { maxActions: 2, expectation: { textIncludes: 'Linus' } });
  assert.equal(result.status, 'completed');
  // FakeBridge has no on-demand capture(), so every action captures and only the final screenshot is kept.
  assert.ok(bridge.executions.every(execution => execution.capture === true));
  assert.equal(result.steps[0].screenshot, null);
  assert.equal(result.steps[1].screenshot.revision, result.steps[1].observation.revision);
});

test('capture last: only the final step keeps a screenshot', async () => {
  const { bridge, runtime } = setup();
  const result = await runtime.run('Members', { maxActions: 2, capture: 'last', expectation: { textIncludes: 'Linus' } });
  assert.ok(bridge.executions.every(execution => execution.capture === true));
  assert.equal(result.steps[0].screenshot, null);
  assert.equal(result.steps[1].screenshot.revision, result.steps[1].observation.revision);
});

test('capture last with an on-demand bridge: actions never capture, the final step is captured once', async () => {
  const { bridge, runtime } = setup();
  const captures = [];
  bridge.capture = async (details, signal) => {
    captures.push(details);
    assert.ok(signal instanceof AbortSignal);
    return { dataUrl: 'data:image/jpeg;base64,YQ==', revision: bridge.observation.revision, format: 'jpeg' };
  };
  const result = await runtime.run('Members', { maxActions: 2, capture: 'last', expectation: { textIncludes: 'Linus' } });
  assert.equal(result.status, 'completed');
  assert.ok(bridge.executions.every(execution => execution.capture === false));
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0], {
    action: { type: 'click', target: '1' }, target: { id: '1', label: 'Members' }, fromUrl: `${ORIGIN}/about`,
  });
  assert.equal(result.steps[0].screenshot, null);
  assert.equal(result.steps[1].screenshot.revision, result.steps[1].observation.revision);

  // A provider `done` after the last action still leaves that action as the captured final step.
  const done = setup({ labels: ['About'] });
  done.bridge.capture = async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', revision: done.bridge.observation.revision });
  const finished = await done.runtime.run('About', { capture: 'last' });
  assert.equal(finished.code, 'no_expectation');
  assert.equal(finished.steps.at(-1).screenshot.revision, finished.steps.at(-1).observation.revision);

  // A failing capture is recorded on the step and never changes the outcome.
  const failing = setup();
  failing.bridge.capture = async () => { throw bridgeError('capture_failed', 'tab hidden'); };
  const kept = await failing.runtime.run('Members', { capture: 'last', expectation: { textIncludes: 'Linus' } });
  assert.equal(kept.status, 'completed');
  assert.deepEqual(kept.steps.at(-1).captureError, { code: 'capture_failed', message: 'tab hidden' });
});

test('capture none: bridge is told not to capture and steps carry no screenshot', async () => {
  const { bridge, runtime } = setup();
  const result = await runtime.run('Members', { maxActions: 2, capture: 'none', expectation: { textIncludes: 'Linus' } });
  assert.equal(result.status, 'completed');
  assert.ok(bridge.executions.every(execution => execution.capture === false));
  assert.ok(result.steps.every(step => step.screenshot === null));
});

test('capture failure is recorded on the step and does not fail the run', async () => {
  const screenshot = () => ({ error: { code: 'capture_failed', message: 'Tab not visible' } });
  const { runtime } = setup({ bridgeOptions: { screenshot } });
  const result = await runtime.step('Open About', { expectation: { urlIncludes: '/about' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps[0].screenshot, null);
  assert.equal(result.steps[0].captureError.code, 'capture_failed');
});

test('mismatched screenshot revision is rejected as evidence', async () => {
  const screenshot = () => ({ dataUrl: 'data:image/png;base64,YQ==', revision: 'other', format: 'png' });
  const { runtime } = setup({ bridgeOptions: { screenshot } });
  const result = await runtime.step('Open About');
  assert.equal(result.steps[0].screenshot, null);
  assert.equal(result.steps[0].captureError.code, 'revision_mismatch');
});

test('a screenshot of a later revision of the same document is kept (live page); another document is not', async () => {
  // page.js revisions are "<documentId>:<sequence>"; this bridge uses that form.
  class LiveBridge extends FakeBridge {
    get observation() {
      return { ...super.observation, revision: `${this.path}:${this.version}` };
    }
  }
  for (const [shotRevision, kept] of [[obs => `${obs.revision.split(':')[0]}:99`, true], [() => '/other:99', false]]) {
    const bridge = new LiveBridge({
      screenshot: observation => ({ dataUrl: 'data:image/png;base64,YQ==', revision: shotRevision(observation), format: 'png' }),
    });
    const runtime = new BrowserRuntime({ bridge, provider: clickProvider(['About']) });
    const result = await runtime.step('Open About');
    const step = result.steps[0];
    if (kept) {
      assert.equal(step.screenshot.revision, '/about:99');
      assert.equal(step.screenshot.observedRevision, '/about:2');
      assert.equal(step.captureError, undefined);
    } else {
      assert.equal(step.screenshot, null);
      assert.equal(step.captureError.code, 'revision_mismatch');
    }
  }
});

test('onAction is fire-and-forget; slow or throwing callbacks never stall or fail the run', async () => {
  const callbacks = [
    () => new Promise(() => {}),
    () => { throw new Error('boom'); },
    async () => { throw new Error('x'); },
  ];
  for (const onAction of callbacks) {
    const { runtime } = setup();
    const result = await runtime.run('Members', { maxActions: 2, expectation: { textIncludes: 'Linus' }, onAction });
    assert.equal(result.status, 'completed');
  }
});

test('awaitCallbacks awaits onAction before the run returns', async () => {
  const seen = [];
  const { runtime } = setup();
  const result = await runtime.run('Members', {
    maxActions: 2,
    capture: 'each',
    expectation: { textIncludes: 'Linus' },
    awaitCallbacks: true,
    onAction: async (step, { observation }) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      seen.push([step.i, observation.url, Boolean(step.screenshot)]);
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, [[1, `${ORIGIN}/about`, true], [2, `${ORIGIN}/members`, true]]);
});

test('supplied text reaches the bridge but never the provider or the history', async () => {
  const secret = 'Alex-Secret-Value';
  const seen = [];
  const provider = {
    async decide(observation, actions, context) {
      seen.push(JSON.stringify({ actions, context }));
      const fill = actions.find(a => a.type === 'fill_supplied_text');
      return { actionId: context.history.length ? 'done' : fill.id };
    },
  };
  const { bridge, runtime } = setup({ provider, bridgeOptions: { path: '/form' } });
  const result = await runtime.run('Fill name', { mode: 'reversible', suppliedText: { name: secret } });
  assert.equal(bridge.lastText, secret);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(payload => !payload.includes(secret)));
  assert.match(seen[0], /supplied value name/);
  assert.equal(result.steps[0].action.suppliedName, 'name');
  assert.equal(result.status, 'unverified');
});

test('serialized result is lean: the full observation is not enumerable', async () => {
  const { runtime } = setup();
  const result = await runtime.step('Open About');
  assert.equal(result.events, undefined);
  assert.equal(result.observation.url, `${ORIGIN}/about`);
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(json.observation, undefined);
  assert.deepEqual(Object.keys(json), [
    'v', 'runId', 'status', 'reason', 'code', 'needs', 'verification', 'page', 'answer', 'steps', 'cost',
    'permissions', 'verdict', 'next',
  ]);
  // Without a grant (an SDK caller with its own bridge) the run reports no user grant.
  assert.deepEqual(json.permissions, { requested: 'read-only', granted: null, effective: 'read-only', testing: false, scope: 'origin' });
  assert.equal(json.secrets, undefined, 'the password list is never serialized');
  assert.deepEqual(Object.keys(json.page), ['url', 'title', 'digest', 'textExcerpt', 'truncated']);
});

test('provider probabilities are trimmed to the top five', async () => {
  const provider = {
    async decide(_, actions) {
      const probabilities = Object.fromEntries(actions.map((a, i) => [a.id, 1 / (i + 2)]));
      return { actionId: actions[0].id, confidence: 0.5, probabilities };
    },
  };
  const { runtime } = setup({ provider });
  const result = await runtime.step('Open About');
  assert.equal(Object.keys(result.steps[0].decision.probabilities).length, 5);
  assert.equal(result.steps[0].decision.confidence, 0.5);
});

test('a second concurrent run is rejected', async () => {
  const { runtime } = setup({ provider: { decide: () => new Promise(() => {}) } });
  const running = runtime.run('Go', { timeoutMs: 50 });
  await assert.rejects(runtime.run('Again'), /already active/);
  await running;
});
