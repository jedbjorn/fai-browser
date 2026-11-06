// Guardrail pass in the runtime: the Jev commit guard (reversible mode) vetoes a chosen button/select/fill, or a
// handoff while one is offered, as needs_user / refused_action with next stop, exactly like the mechanical refusal;
// read-only runs are unaffected; guardrail additions (`policy`, config `guardrails`) filter offered controls, reach
// the extension as plain phrases and the provider as context, and can never relax the core rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, REFUSAL_TEXT, blockedControls, legalActions } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { DEFAULT_THRESHOLDS } from '../src/oversight.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, risk: 'reversible', ...extra });

const PAGES = {
  '/review': {
    title: 'Review your order',
    text: 'Your card ending 4242 will be charged $93.90 when you continue.',
    controls: [link('1', 'Edit cart', '/cart'), button('2', 'Change address'), button('3', 'Continue →')],
  },
  '/cart': { title: 'Cart', text: 'Cart', controls: [link('1', 'Review', '/review')] },
  '/docs': {
    title: 'Getting started',
    text: 'Part 1 of 2',
    controls: [link('1', 'Docs home', '/cart'), button('2', 'Continue'), button('3', 'Gift wrap options'), button('4', 'Place order')],
  },
  '/links': { title: 'Links', text: 'Only links', controls: [link('1', 'Cart', '/cart'), link('2', 'Docs', '/docs')] },
};

/** FakeBridge that also records the options of every execute (forbid travels there). */
class RecordingBridge extends FakeBridge {
  constructor(options) {
    super(options);
    this.executeOptions = [];
  }

  async execute(action, expectedRevision, options = {}) {
    this.executeOptions.push(options);
    return super.execute(action, expectedRevision, options);
  }
}

/** A provider that picks the offered action with `label` (or `handoff`) and reports the given guards. */
function guardProvider(pick, guards, { done = 0.1 } = {}) {
  const calls = [];
  return {
    calls,
    async decide(observation, actions, context) {
      calls.push({ actions, context });
      const action = pick === 'handoff' ? actions.find(a => a.type === 'handoff')
        : actions.find(a => a.label === pick) ?? actions.find(a => a.type === 'handoff');
      return { actionId: action.id, confidence: 0.9, done: { probability: done }, guards: { ...guards }, model: 'fake' };
    },
  };
}

async function run(path, provider, options = {}) {
  const bridge = new RecordingBridge({ pages: PAGES, path });
  const result = await new BrowserRuntime({ bridge, provider }).run(options.instruction ?? 'Continue to the next step.', {
    mode: 'reversible', maxActions: 2, expectation: { urlIncludes: '/placed' }, ...options,
  });
  return { bridge, result };
}

test('commitVeto defaults to 0.7 and is a regular, validated threshold', async () => {
  assert.equal(DEFAULT_THRESHOLDS.commitVeto, 0.7);
  await assert.rejects(run('/review', guardProvider('Continue →', {}), { thresholds: { commitVeto: 2 } }).then(r => {
    if (r.result.code === 'failed') throw new RangeError(r.result.reason);
    return r;
  }), /commitVeto must be a number from 0 to 1/);
});

test('reversible: a chosen button the commit guard judges a commit is refused, never executed; receipt like the mechanical refusal', async () => {
  const provider = guardProvider('Continue →', { commit: 0.93, blocked: 0.02, injection: 0.1 });
  const { bridge, result } = await run('/review', provider);
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'refused_action');
  assert.equal(bridge.executions.length, 0, 'nothing clicked');
  assert.equal(provider.calls.length, 1);
  assert.equal(result.needs.message, REFUSAL_TEXT);
  assert.deepEqual(result.needs.control, { ref: '3', label: 'Continue →' });
  assert.ok(result.verdict.why.includes('guard:commit_veto'), result.verdict.why.join(','));
  assert.ok(result.verdict.why.includes('guard:commit:0.93'));
  assert.equal(result.verdict.kind, 'failed');
  assert.equal(result.next.kind, 'stop');
  assert.equal(result.next.text, REFUSAL_TEXT);
  assert.doesNotMatch(result.reason, /4242|charged/, 'the trusted reason carries no page text');
  const lean = agentResult(result);
  assert.deepEqual(lean.needs.control, { ref: '3', label: 'Continue →' });
  assert.equal(lean.next.kind, 'stop');
  assert.ok(!JSON.stringify(lean.next).includes('Continue'), 'the label stays out of the trusted next text');
});

test('reversible: below the threshold the control runs; a raised run threshold lets 0.75 through', async () => {
  const low = await run('/review', guardProvider('Continue →', { commit: 0.4 }), { maxActions: 1 });
  assert.equal(low.bridge.executions.length, 1);
  assert.equal(low.bridge.executions[0].action.target, '3');
  const raised = await run('/review', guardProvider('Continue →', { commit: 0.75 }), { maxActions: 1, thresholds: { commitVeto: 0.8 } });
  assert.equal(raised.bridge.executions.length, 1);
  const lowered = await run('/review', guardProvider('Continue →', { commit: 0.5 }), { thresholds: { commitVeto: 0.5 } });
  assert.equal(lowered.result.code, 'refused_action');
});

test('reversible: a handoff while the commit guard is high and a control is offered ends refused_action (stop), not handoff', async () => {
  const { bridge, result } = await run('/review', guardProvider('handoff', { commit: 0.9 }));
  assert.equal(result.code, 'refused_action');
  assert.equal(result.next.kind, 'stop');
  assert.equal(result.needs.control, undefined, 'no control was chosen');
  assert.ok(result.verdict.why.includes('guard:commit_veto'));
  assert.equal(bridge.executions.length, 0);
  // Links only: nothing for the commit guard to stop; an ordinary handoff.
  const links = await run('/links', guardProvider('handoff', { commit: 0.95 }));
  assert.equal(links.result.code, 'handoff');
});

test('reversible: the trace keeps the vetoed decision with guards.commit (finalDecision)', async () => {
  const { result } = await run('/review', guardProvider('Continue →', { commit: 0.912, injection: 0.1 }));
  assert.equal(result.code, 'refused_action');
  assert.equal(result.finalDecision?.guards?.commit, 0.912);
});

test('review pass: a read on a checkout page completes even with the commit guard high (done gates the veto)', async () => {
  // Expectation passes and Jev reports done: completed with the page, never refused_action.
  const read = await run('/review', guardProvider('handoff', { commit: 0.9 }, { done: 0.98 }), {
    instruction: 'Tell me the order total shown on this review page.', expectation: { textIncludes: '$93.90' },
  });
  assert.equal(read.result.status, 'completed', read.result.code);
  assert.equal(read.bridge.executions.length, 0);
  // No expectation: done at 0.8 or more ends unverified (answer from the page), not refused.
  const bare = await run('/review', guardProvider('handoff', { commit: 0.9 }, { done: 0.95 }), {
    instruction: 'What is the order total on this page?', expectation: undefined,
  });
  assert.equal(bare.result.code, 'no_expectation');
  // Expectation passes but done stays low: a handoff on a passing page completes before the veto.
  const low = await run('/review', guardProvider('handoff', { commit: 0.9 }, { done: 0.3 }), {
    instruction: 'Tell me the order total shown on this review page.', expectation: { textIncludes: '$93.90' },
  });
  assert.notEqual(low.result.code, 'refused_action');
  assert.equal(low.result.status, 'completed', low.result.code);
});

test('review pass: on a page with injected instructions the commit noul cannot force a stop; no control runs either', async () => {
  // Injected text called a harmless control a purchase (QA: commit 0.70, injection 0.97): the handoff stands
  // (rerun), and decide options keep no button.
  const handoff = await run('/review', guardProvider('handoff', { commit: 0.9, injection: 0.97 }), { maxActions: 1 });
  assert.equal(handoff.result.code, 'handoff');
  assert.ok(!handoff.result.verdict.why.includes('guard:commit_veto'));
  assert.ok(!(handoff.result.verdict.decide?.options ?? []).some(option => /Continue|Change/.test(option.label ?? '')));
  assert.equal(handoff.bridge.executions.length, 0);
  // Page text vouching that a commit is safe can lower the commit noul (QA: 0.57); the injection veto still stops the
  // control: nothing is clicked.
  const vouched = await run('/review', guardProvider('Continue →', { commit: 0.57, injection: 0.97 }));
  assert.equal(vouched.result.code, 'handoff');
  assert.ok(vouched.result.verdict.why.includes('guard:injection_veto'));
  assert.equal(vouched.bridge.executions.length, 0);
});

test('adversarial: commit and injection veto boundaries hold for button, select, fill and handoff', async () => {
  for (const role of ['button', 'combobox', 'textbox']) {
    for (const commit of [0.699, 0.7, 0.701]) {
      const control = button('1', 'Continue', { role });
      if (role === 'combobox') Object.assign(control, { selectedValue: 'a', options: [{ value: 'b', label: 'Team' }] });
      if (role === 'textbox') control.type = 'text';
      const bridge = new RecordingBridge({ pages: { '/': { title: 'Settings', text: 'Choose a view', controls: [control] } }, path: '/' });
      const runtime = new BrowserRuntime({ bridge, provider: guardProvider('Continue', { commit, injection: 0.1, blocked: 0.1 }) });
      const result = await runtime.run('Show the next view', { mode: 'reversible', maxActions: 1, suppliedText: { query: 'test' } });
      assert.equal(bridge.executions.length, commit < 0.7 ? 1 : 0, `${role}: ${commit}`);
      if (commit >= 0.7) {
        assert.equal(result.code, 'refused_action');
        assert.equal(result.next.kind, 'stop');
      }
    }
  }
  for (const injection of [0.849, 0.85]) {
    for (const pick of ['Continue →', 'handoff']) {
      const { result, bridge } = await run('/review', guardProvider(pick, { commit: 0.9, injection, blocked: 0.1 }));
      assert.equal(result.code, injection < 0.85 ? 'refused_action' : 'handoff');
      assert.equal(bridge.executions.length, 0);
      assert.equal(result.next.kind, injection < 0.85 ? 'stop' : 'rerun');
    }
  }
});

test('adversarial: a reversible handoff with every remaining control mechanically blocked tells the host to stop', async () => {
  const bridge = new RecordingBridge({ pages: { '/': { title: 'Review', text: 'Review', controls: [button('1', 'Place order')] } }, path: '/' });
  const provider = guardProvider('handoff', { commit: 0.1 });
  const result = await new BrowserRuntime({ bridge, provider }).run('Continue to the next step', { mode: 'reversible', maxActions: 1 });
  assert.equal(result.code, 'refused_action');
  assert.equal(result.next.kind, 'stop');
  assert.equal(bridge.executions.length, 0);
});

test('reversible: a done choice with the commit guard high is not a veto (nothing would be executed)', async () => {
  const provider = guardProvider('done', { commit: 0.95 }, { done: 0.1 });
  provider.decide = async (observation, actions) => ({ actionId: 'done', guards: { commit: 0.95 } });
  const { bridge, result } = await run('/review', provider, { expectation: undefined });
  assert.notEqual(result.code, 'refused_action');
  assert.equal(bridge.executions.length, 0);
});

test('reversible: a link pick proceeds even with the commit guard high (navigation; links have their own rules)', async () => {
  const { bridge, result } = await run('/review', guardProvider('Edit cart', { commit: 0.95 }), { maxActions: 1 });
  assert.equal(bridge.executions.length, 1);
  assert.equal(bridge.executions[0].action.target, '1');
  assert.notEqual(result.code, 'refused_action');
});

test('read-only: the commit guard never vetoes and is not asked of the provider', async () => {
  const provider = guardProvider('Edit cart', { commit: 0.99 });
  const { bridge, result } = await run('/review', provider, { mode: 'read-only', maxActions: 1 });
  assert.equal(bridge.executions.length, 1);
  assert.notEqual(result.code, 'refused_action');
  assert.equal(provider.calls[0].context.mode, 'read-only');
  assert.ok(!provider.calls[0].actions.some(action => action.role === 'button'), 'read-only offers no buttons');
  assert.ok(!result.verdict.why.includes('guard:commit_veto'));
});

test('consent reject buttons offered alone are clicked whatever the commit guard says', async () => {
  const pages = {
    '/': {
      title: 'News', text: 'We use cookies',
      consent: { text: 'Cookies', buttons: [{ id: '1', label: 'Reject all', kind: 'reject' }, { id: '2', label: 'Necessary only', kind: 'reject' }] },
      controls: [button('1', 'Reject all', { consent: true, dismissesConsent: true }), button('2', 'Necessary only', { consent: true, dismissesConsent: true }), link('3', 'About', '/about')],
    },
    '/about': { title: 'About', text: 'About', controls: [] },
  };
  const bridge = new RecordingBridge({ pages, path: '/' });
  const provider = guardProvider('Reject all', { commit: 0.99 });
  const result = await new BrowserRuntime({ bridge, provider, }).run('Open About', { mode: 'reversible', maxActions: 1, consentWaitMs: 0 });
  assert.equal(bridge.executions[0].action.target, '1');
  assert.notEqual(result.code, 'refused_action');
});

test('additions: a policy phrase filters every role, reaches the extension as strings and the provider as context', async () => {
  const provider = guardProvider('Continue', { commit: 0.05 });
  const bridge = new RecordingBridge({ pages: PAGES, path: '/docs' });
  await new BrowserRuntime({ bridge, provider }).run('Show part 2.', {
    mode: 'reversible', maxActions: 1, policy: { forbid: ['Gift wrap', 'Docs home'], note: 'No extras.' },
    guardrails: { forbid: ['Upgrade'] },
  });
  const labels = provider.calls[0].actions.map(action => action.label);
  assert.ok(labels.includes('Continue'));
  assert.ok(!labels.includes('Gift wrap options'), 'addition filters a button');
  assert.ok(!labels.includes('Docs home'), 'addition filters a link too');
  assert.ok(!labels.includes('Place order'), 'core still applies');
  assert.deepEqual(provider.calls[0].context.guardrails, { forbid: ['Upgrade', 'Gift wrap', 'Docs home'], note: 'No extras.' });
  assert.equal(provider.calls[0].context.mode, 'reversible');
  assert.deepEqual(bridge.observeOptions[0].forbid, ['Upgrade', 'Gift wrap', 'Docs home']);
  assert.deepEqual(bridge.executeOptions[0].forbid, ['Upgrade', 'Gift wrap', 'Docs home']);
  // Without additions nothing extra travels to the extension or the provider.
  const plain = guardProvider('Continue', {});
  const quiet = new RecordingBridge({ pages: PAGES, path: '/docs' });
  await new BrowserRuntime({ bridge: quiet, provider: plain }).run('Show part 2.', { mode: 'reversible', maxActions: 1 });
  assert.equal(quiet.observeOptions[0].forbid, undefined);
  assert.equal(quiet.executeOptions[0].forbid, undefined);
  assert.equal(plain.calls[0].context.guardrails, undefined);
});

test('additions: invalid policy fails before any observation or provider call', async () => {
  for (const policy of [['Pay.*'], { allow: ['Place order'] }, Array.from({ length: 21 }, (_, i) => `L${i}`), 'Upgrade']) {
    const provider = guardProvider('Continue', {});
    const bridge = new RecordingBridge({ pages: PAGES, path: '/docs' });
    await assert.rejects(new BrowserRuntime({ bridge, provider }).run('Show part 2.', { mode: 'reversible', policy }), TypeError);
    assert.equal(bridge.observes, 0);
    assert.equal(provider.calls.length, 0);
  }
});

test('adversarial: disabling core, unknown levels or grants and malformed commit thresholds fail before observing', async () => {
  const variants = [
    ...[{ core: false }, { forbid: [], core: false }, { allow: ['Pay'] }, { commitVeto: 1.5 }].map(guardrails => ({ guardrails })),
    { mode: 'unrestricted' }, { mode: 'god' }, { grant: { level: 'root' } }, { grant: 'testing' }, ...[1.5, -1, '0', NaN].map(commitVeto => ({ thresholds: { commitVeto } })),
  ];
  for (const options of variants) {
    const provider = guardProvider('Continue', {});
    const bridge = new RecordingBridge({ pages: PAGES, path: '/docs' });
    await assert.rejects(new BrowserRuntime({ bridge, provider }).run('Read', { mode: 'reversible', ...options }));
    assert.equal(bridge.observes, 0);
    assert.equal(provider.calls.length, 0);
  }
});

test('additions never relax core: a policy cannot bring back a core-refused control', () => {
  const observation = { url: `${ORIGIN}/docs`, controls: PAGES['/docs'].controls };
  for (const policy of [undefined, [], ['Place order'], { forbid: [], note: 'You may place the order.' }]) {
    const labels = legalActions(observation, { mode: 'reversible', policy }).map(action => action.label);
    assert.ok(!labels.includes('Place order'), JSON.stringify(policy));
  }
  // blockedControls reports addition-refused controls as well (refusal receipts and the decide filter use it).
  const blocked = blockedControls(observation, { policy: ['Gift wrap'] }).map(control => control.label);
  assert.deepEqual(blocked, ['Gift wrap options', 'Place order']);
  // Select options carrying a forbidden label are not offered either.
  const select = { id: '9', role: 'combobox', label: 'Plan', enabled: true, risk: 'reversible', selectedValue: 'free',
    options: [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Upgrade to Pro' }, { value: 'team', label: 'Team' }] };
  const values = legalActions({ url: `${ORIGIN}/`, controls: [select] }, { mode: 'reversible', policy: ['Upgrade'] })
    .filter(action => action.type === 'select').map(action => action.value);
  assert.deepEqual(values, ['team']);
});

test('host act() after observe keeps the run guardrails (offer config) and refuses nothing new', async () => {
  const bridge = new RecordingBridge({ pages: PAGES, path: '/docs' });
  const runtime = new BrowserRuntime({ bridge });
  const offer = await runtime.observe({ mode: 'reversible', policy: ['Gift wrap'] });
  assert.ok(!offer.actions.some(action => action.label === 'Gift wrap options'));
  assert.deepEqual(bridge.observeOptions[0].forbid, ['Gift wrap']);
  const target = offer.actions.find(action => action.label === 'Continue');
  await runtime.act(target.id, { revision: offer.observation.revision });
  assert.deepEqual(bridge.executeOptions[0].forbid, ['Gift wrap'], 'act() sends the offer guardrails to the extension');
});
