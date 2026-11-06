// Rung 1 stale re-resolve (src/runtime.js #loop): a provider-chosen link the page refuses as stale (it changed after
// it was observed, as MDN does when it adds ad and sign-in links 380-660 ms after load) runs on the fresh observation
// without a second decide, with the slim guards request next to it. Plus the final capture started next to the
// terminal decide. Fake bridge and scripted providers only. The instructions end with "Read every name." so they are
// not bounded imperatives (src/oversight.js boundedImperative): the landing page keeps its terminal decide here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, bridgeError } from '../src/result.js';
import { FakeBridge, ORIGIN, PAGES, link } from './runtime-fixtures.js';

const button = (id, label) => ({ id, role: 'button', label, type: 'button', enabled: true });
const AD = link('90', 'Try MDN Plus', '/plus');

/**
 * Provider with decide (per path: `{ pick: label|'done'|'handoff', done }`) and the slim guards request (confirm),
 * whose reply is `guards` (an object or a function of the call number). Logs every call.
 */
function provider(plan, { guards = { blocked: 0.01, injection: 0.01 }, confirm = true } = {}) {
  const log = [];
  const decides = [];
  const confirms = [];
  const out = {
    model: 'fake',
    log,
    decides,
    confirms,
    async decide(observation, actions) {
      const path = new URL(observation.url).pathname;
      decides.push(path);
      log.push(`decide:start:${path}`);
      const step = plan[path] ?? { pick: 'handoff' };
      const id = step.pick === 'done' || step.pick === 'handoff'
        ? step.pick
        : actions.find(action => action.label === step.pick)?.id ?? 'handoff';
      await new Promise(resolve => setTimeout(resolve, 5));
      log.push(`decide:end:${path}`);
      return { actionId: id, confidence: 0.9, done: { probability: step.done ?? 0.05 } };
    },
  };
  if (confirm) {
    out.confirm = async observation => {
      confirms.push(new URL(observation.url).pathname);
      const value = typeof guards === 'function' ? guards(confirms.length - 1) : guards;
      return { done: { probability: 0.05 }, guards: value };
    };
  }
  return out;
}

/** A failNext entry: the page gains late content (a new revision), then the extension refuses the click as stale. */
function lateContent(bridge, path, controls = [AD]) {
  return () => {
    bridge.pages[path].controls.push(...controls.map(control => ({ ...control })));
    bridge.version++;
    return bridgeError('stale', 'Stale observation');
  };
}

const kinds = result => result.cost.requests.map(entry => entry.kind);
const why = result => agentResult(result).verdict.why;
const RUN = { expectation: { urlIncludes: '/members' }, capture: 'none' };
const PLAN = { '/': { pick: 'About' }, '/about': { pick: 'Members' }, '/members': { pick: 'done', done: 0.95 } };

test('stale link: the same link runs on the fresh observation without a second decide', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'));
  const jev = provider(PLAN);
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(jev.decides, ['/', '/about', '/members'], 'one decide per page, none repeated after the stale');
  assert.deepEqual(jev.confirms, ['/'], 'the new content got the slim guards request');
  assert.equal(result.cost.decisions, 3);
  assert.deepEqual(kinds(result), ['decide', 'stale_guards', 'decide', 'decide']);
  const [first] = result.cost.requests;
  assert.equal(first.stale, true, 'the decide whose choice went stale is marked');
  assert.equal(first.step, 1, 'and carries the step its choice ran as');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].decision.by, 'provider');
  assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
  assert.equal(result.steps[0].action.label, 'About');
  assert.equal(result.steps[0].action.toUrl, `${ORIGIN}/about`);
  // The click ran against the fresh revision.
  assert.equal(bridge.executions[1].expectedRevision, '/#2');
  assert.ok(why(result).includes('retry:stale'));
  assert.ok(why(result).includes('retry:stale_reresolve'));
  assert.equal(result.steps[1].decision.reason, undefined);
});

test('stale button: always decided again', async () => {
  const pages = {
    ...PAGES,
    '/': { title: 'Home', text: 'Welcome', controls: [button('1', 'Show members')] },
  };
  const bridge = new FakeBridge({ pages });
  bridge.failNext.push(lateContent(bridge, '/'));
  const jev = provider({ '/': { pick: 'Show members' }, '/members': { pick: 'done', done: 0.95 } });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Show the members', {
    capture: 'none', mode: 'reversible', grant: { level: 'reversible' }, maxActions: 1,
  });
  assert.deepEqual(jev.decides.slice(0, 2), ['/', '/']);
  assert.deepEqual(jev.confirms, []);
  assert.ok(!kinds(result).includes('stale_guards'));
  assert.equal(result.cost.requests[0].stale, true);
  assert.ok(why(result).includes('retry:stale'));
  assert.ok(!why(result).includes('retry:stale_reresolve'));
  assert.ok(result.steps.every(step => step.decision.reason !== 'stale_reresolve'));
});

test('stale link without the slim guards request (no confirm): decided again', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'));
  const jev = provider(PLAN, { confirm: false });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(jev.decides, ['/', '/', '/about', '/members']);
  assert.ok(why(result).includes('retry:stale'));
  assert.ok(!why(result).includes('retry:stale_reresolve'));
});

for (const [name, guards] of [['blocked', { blocked: 0.9, injection: 0.01 }], ['injection', { blocked: 0.01, injection: 0.8 }]]) {
  test(`a ${name} score on the new content turns re-resolves off: the next stale link is decided again`, async () => {
    const bridge = new FakeBridge({ pages: PAGES });
    bridge.failNext.push(lateContent(bridge, '/'), null, lateContent(bridge, '/about'));
    const jev = provider(PLAN, { guards });
    const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
    assert.equal(result.code, 'expectation_passed');
    // '/': decided once, re-resolved (its guards stop further re-resolves); '/about': stale again, decided again.
    assert.deepEqual(jev.decides, ['/', '/about', '/about', '/members']);
    assert.deepEqual(jev.confirms, ['/']);
    assert.ok(why(result).includes(`retry:stale_reresolve:${name}`));
    assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
    assert.equal(result.steps[1].decision.reason, undefined);
    assert.equal(result.cost.requests.filter(entry => entry.stale).length, 2);
  });
}

test('a failed guards request turns re-resolves off as well', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'), null, lateContent(bridge, '/about'));
  const jev = provider(PLAN, { guards: () => { throw new Error('HTTP 502'); } });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(jev.decides, ['/', '/about', '/about', '/members']);
  assert.ok(why(result).includes('retry:stale_reresolve:guard_error'));
  assert.equal(result.cost.requests.find(entry => entry.kind === 'stale_guards').error, 'provider_error');
});

test('without a guard stop, every page gets its own re-resolve', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'), null, lateContent(bridge, '/about'));
  const jev = provider(PLAN);
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(jev.decides, ['/', '/about', '/members']);
  assert.deepEqual(jev.confirms, ['/', '/about']);
  assert.deepEqual(result.steps.map(step => step.decision.reason), ['stale_reresolve', 'stale_reresolve']);
});

test('ambiguity: two offered links with the label and destination of the stale choice decide again', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/', [link('91', 'About', '/about')]));
  const jev = provider(PLAN);
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(jev.decides, ['/', '/', '/about', '/members']);
  assert.deepEqual(jev.confirms, []);
  assert.ok(why(result).includes('retry:stale'));
  assert.ok(!why(result).includes('retry:stale_reresolve'));
});

test('a stale link that moved elsewhere (same label, other destination) or vanished decides again', async () => {
  for (const change of ['moved', 'gone']) {
    const bridge = new FakeBridge({ pages: PAGES });
    bridge.failNext.push(() => {
      const controls = bridge.pages['/'].controls;
      if (change === 'moved') controls[0] = link('1', 'About', '/about-us');
      else controls.splice(0, 1, link('2', 'Contact', '/contact'));
      bridge.version++;
      return bridgeError('stale', 'Stale observation');
    });
    const jev = provider(PLAN);
    await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', { ...RUN, maxActions: 1 });
    assert.deepEqual(jev.decides.slice(0, 2), ['/', '/'], change);
    assert.deepEqual(jev.confirms, [], change);
  }
});

test('at most one re-resolve per page: a re-resolved click that goes stale again is decided again', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'), lateContent(bridge, '/', [link('92', 'Docs', '/docs')]));
  const jev = provider(PLAN);
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(jev.decides, ['/', '/', '/about', '/members']);
  assert.deepEqual(jev.confirms, ['/']);
  assert.equal(result.steps[0].decision.reason, undefined, 'the step that ran came from the second decide');
  assert.equal(bridge.executions.length, 4);
});

test('budgets: the re-resolve spends no decision and still runs the last one; its action counts in maxActions', async () => {
  // maxDecisions 1: the only decide went stale; without the re-resolve the run would end decision_budget on Home.
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'));
  const jev = provider(PLAN);
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About. Read every name.', {
    expectation: { urlIncludes: '/about' }, capture: 'none', maxDecisions: 1, maxActions: 3,
  });
  assert.equal(result.cost.decisions, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
  assert.equal(result.page.url, `${ORIGIN}/about`);
  assert.equal(result.code, 'budget_reached_expectation_passed', 'the next page has no decision left');

  // maxActions 1: the re-resolved click is the run's one action.
  const second = new FakeBridge({ pages: PAGES });
  second.failNext.push(lateContent(second, '/'));
  const jev2 = provider(PLAN);
  const limited = await new BrowserRuntime({ bridge: second, provider: jev2 }).run('Open About, then Members. Read every name.', {
    ...RUN, maxActions: 1,
  });
  assert.equal(limited.code, 'action_budget');
  assert.equal(limited.steps.length, 1);
  assert.deepEqual(jev2.decides, ['/']);

  // Two stale hops and the terminal decide fit in 3 decisions (without the re-resolve they would need 5).
  const third = new FakeBridge({ pages: PAGES });
  third.failNext.push(lateContent(third, '/'), null, lateContent(third, '/about'));
  const full = await new BrowserRuntime({ bridge: third, provider: provider(PLAN) }).run('Open About, then Members. Read every name.', {
    ...RUN, maxActions: 3, maxDecisions: 3,
  });
  assert.equal(full.code, 'expectation_passed');
  assert.equal(full.cost.decisions, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// Final capture next to the terminal decide
// ---------------------------------------------------------------------------------------------------------------

class CaptureBridge extends FakeBridge {
  constructor(options) {
    super(options);
    this.captures = [];
  }

  async capture(details) {
    this.log.push('capture:start');
    this.captures.push(details);
    await new Promise(resolve => setTimeout(resolve, 15));
    this.log.push('capture:end');
    return { dataUrl: 'data:image/jpeg;base64,YQ==', revision: this.observation.revision, format: 'jpeg' };
  }

  async execute(...args) {
    this.log.push('execute');
    return super.execute(...args);
  }
}

test('capture last: the final capture runs next to the terminal decide, with the same evidence', async () => {
  const bridge = new CaptureBridge({ pages: PAGES, path: '/about' });
  const jev = provider({ '/about': { pick: 'Members' }, '/members': { pick: 'done', done: 0.95 } });
  // The provider log and the bridge log share one timeline.
  bridge.log = jev.log;
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open Members. Read every name.', {
    expectation: { urlIncludes: '/members' }, capture: 'last',
  });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(bridge.captures.length, 1);
  assert.deepEqual(bridge.captures[0], {
    action: { type: 'click', target: '1' }, target: { id: '1', label: 'Members' }, fromUrl: `${ORIGIN}/about`,
  });
  const step = result.steps.at(-1);
  assert.deepEqual(step.screenshot, { dataUrl: 'data:image/jpeg;base64,YQ==', revision: '/members#2', format: 'jpeg' });
  assert.ok(step.ms.capture >= 10);
  // Started before the terminal decide answered, not after it.
  assert.ok(jev.log.indexOf('capture:start') < jev.log.indexOf('decide:end:/members'), jev.log.join(' '));
});

test('capture last: an early capture next to a decide that moves on is dropped and never overlaps the next action',
  async () => {
    // The expectation (Linus in the text) passes on /about too, but the provider still clicks on.
    const pages = { ...PAGES, '/about': { ...PAGES['/about'], text: 'About us. Members: Ada, Grace, Linus' } };
    const bridge = new CaptureBridge({ pages, path: '/' });
    const jev = provider({ '/': { pick: 'About' }, '/about': { pick: 'Members' }, '/members': { pick: 'done', done: 0.95 } });
    bridge.log = jev.log;
    const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open Members. Read every name.', {
      expectation: { textIncludes: 'Linus' }, capture: 'last',
    });
    assert.equal(result.code, 'expectation_passed');
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].screenshot, null);
    assert.equal(result.steps[1].screenshot.revision, result.steps[1].observation.revision);
    assert.equal(bridge.captures.length, 2, 'one dropped early capture, one final');
    // Every capture finished before the next execute started.
    const log = jev.log.filter(entry => entry.startsWith('capture') || entry === 'execute');
    for (let i = 0; i < log.length; i++) if (log[i] === 'capture:start') assert.equal(log[i + 1], 'capture:end');
  });

test('capture last: a failed early capture falls back to the capture at the end', async () => {
  const bridge = new CaptureBridge({ pages: PAGES, path: '/about' });
  let calls = 0;
  const capture = bridge.capture.bind(bridge);
  bridge.capture = async details => {
    calls++;
    if (calls === 1) throw bridgeError('capture_failed', 'tab hidden');
    return capture(details);
  };
  const jev = provider({ '/about': { pick: 'Members' }, '/members': { pick: 'done', done: 0.95 } });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open Members. Read every name.', {
    expectation: { urlIncludes: '/members' }, capture: 'last',
  });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(calls, 2);
  assert.equal(result.steps.at(-1).screenshot.revision, '/members#2');
  assert.equal(result.steps.at(-1).captureError, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes: same-document hrefs, frames, the re-resolved step's record, call-wide state
// ---------------------------------------------------------------------------------------------------------------

test('a stale link whose href is the page itself ("#", "", a fragment) always decides again', async () => {
  for (const href of ['/#', '/', '/#confirm']) {
    const pages = {
      ...PAGES,
      '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'OK', href), link('2', 'About', '/about')] },
    };
    const bridge = new FakeBridge({ pages });
    // Late content: a "Confirm delete?" dialog whose button is the same-document "OK" link now.
    bridge.failNext.push(lateContent(bridge, '/', [{ id: '93', role: 'dialog', label: 'Confirm delete?', enabled: true }]));
    const jev = provider({ '/': { pick: 'OK' } });
    const result = await new BrowserRuntime({ bridge, provider: jev }).run('Press OK', { capture: 'none', maxActions: 1 });
    assert.deepEqual(jev.decides.slice(0, 2), ['/', '/'], href);
    assert.deepEqual(jev.confirms, [], href);
    assert.ok(why(result).includes('retry:stale'), href);
    assert.ok(!why(result).includes('retry:stale_reresolve'), href);
  }
});

test('a same-label link to the same place in another frame is not the stale choice', async () => {
  const pages = {
    ...PAGES,
    '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about', { frame: 1 })] },
  };
  const bridge = new FakeBridge({ pages });
  // The framed link goes away and the top document gets one with the same label and destination.
  bridge.failNext.push(() => {
    bridge.pages['/'].controls = [link('2', 'About', '/about')];
    bridge.version++;
    return bridgeError('stale', 'Stale observation');
  });
  const jev = provider(PLAN);
  await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', { ...RUN, maxActions: 1 });
  assert.deepEqual(jev.decides.slice(0, 2), ['/', '/']);

  // In the same frame, it re-resolves.
  const same = new FakeBridge({ pages });
  same.failNext.push(lateContent(same, '/'));
  const jev2 = provider(PLAN);
  const result = await new BrowserRuntime({ bridge: same, provider: jev2 }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
  assert.deepEqual(jev2.decides, ['/', '/about', '/members']);
});

test('the re-resolved step keeps the decide probabilities and carries the fresh guards, not the stale ones', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'));
  const jev = provider(PLAN, { guards: { blocked: 0.12345, injection: 0.2 } });
  const decide = jev.decide;
  jev.decide = async (observation, actions, context) => {
    const decision = await decide(observation, actions, context);
    decision.probabilities = { [decision.actionId]: 0.9 };
    decision.guards = { blocked: 0.01, injection: 0.01 };
    return decision;
  };
  const result = await new BrowserRuntime({ bridge, provider: jev }).run('Open About, then Members. Read every name.', RUN);
  const { decision } = result.steps[0];
  assert.equal(decision.reason, 'stale_reresolve');
  assert.deepEqual(decision.guards, { blocked: 0.123, injection: 0.2 });
  assert.deepEqual(decision.probabilities, { [decision.actionId]: 0.9 });
  assert.ok(!Object.keys(decision).includes('probabilities'), 'still non-enumerable');

  // A guards reply without guards leaves none on the step.
  const plain = new FakeBridge({ pages: PAGES });
  plain.failNext.push(lateContent(plain, '/'));
  const bare = provider(PLAN, { guards: () => undefined });
  const bareDecide = bare.decide;
  bare.decide = async (...args) => ({ ...(await bareDecide(...args)), guards: { blocked: 0.3, injection: 0.3 } });
  const second = await new BrowserRuntime({ bridge: plain, provider: bare }).run('Open About, then Members. Read every name.', RUN);
  assert.equal(second.steps[0].decision.reason, 'stale_reresolve');
  assert.equal(second.steps[0].decision.guards, undefined);
});

test('the tried pages and the guard stop are call-wide (retryState): a later list step keeps the stop', async () => {
  const bridge = new FakeBridge({ pages: PAGES });
  bridge.failNext.push(lateContent(bridge, '/'), null, lateContent(bridge, '/about'));
  // Step 1 ends on /about as soon as its expectation passes (a list step needs no terminal decide); step 2 clicks
  // Members from /about. Only the first guards request (the stale re-resolve's) scores the page blocked.
  const plan = { '/': { pick: 'About' }, '/about': { pick: 'Members' }, '/members': { pick: 'done', done: 0.95 } };
  const jev = provider(plan, { guards: n => (n === 0 ? { blocked: 0.9, injection: 0 } : { blocked: 0, injection: 0 }) });
  const result = await new BrowserRuntime({ bridge, provider: jev }).run({
    steps: [
      { instruction: 'Open About', expectation: { urlIncludes: '/about' } },
      { instruction: 'Open Members', expectation: { urlIncludes: '/members' } },
    ],
    capture: 'none',
  });
  assert.equal(result.status, 'completed');
  // Step 1 re-resolved on Home and its guards stopped re-resolves; step 2's stale on /about decided again.
  assert.deepEqual(jev.decides, ['/', '/about', '/about']);
  // The stale guards on Home, then each step's own end-of-step guards (step_guards) on /about and /members.
  assert.deepEqual(jev.confirms, ['/', '/about', '/members']);
  assert.deepEqual(result.stepResults.map(step => step.code), ['expectation_passed', 'expectation_passed']);
  assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
  assert.equal(result.steps[1].decision.reason, undefined);
});
