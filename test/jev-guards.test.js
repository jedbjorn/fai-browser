// Jev guidance pass, runtime side of the guard nouls: recorded on the step and in the receipt's why; at 0.85 or
// more, blocked ends the run as needs_user/blocked (after rung 0) and injection lets only an approved-origin link
// run. Code-side vetoes stay authoritative. Fake bridge and fake providers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, GUARD_VETO, guardsOf } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FakeBridge, PAGES, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, type: 'button', enabled: true, ...extra });

function guarded(labels, guards, { done = 0.05 } = {}) {
  const calls = [];
  return {
    calls,
    model: 'fake',
    async decide(observation, actions) {
      calls.push({ observation, actions });
      const action = labels.map(label => actions.find(a => a.label === label)).find(Boolean);
      return { actionId: action?.id ?? 'handoff', confidence: 0.9, done: { probability: done }, guards: guards(observation, actions) };
    },
  };
}

function setup(pages, provider) {
  const bridge = new FakeBridge({ pages: { ...PAGES, ...pages } });
  return { bridge, runtime: new BrowserRuntime({ bridge, provider }) };
}

test('guardsOf keeps only unit-interval blocked / injection values', () => {
  assert.deepEqual(guardsOf({ guards: { blocked: 0.2, injection: 2, other: 0.5 } }), { blocked: 0.2 });
  assert.equal(guardsOf({}), null);
  assert.equal(GUARD_VETO, 0.85);
});

test('low guards are recorded on the step and the run proceeds; blocked >= 0.5 and injection >= 0.8 reach the receipt why', async () => {
  const provider = guarded(['About', 'Members'], () => ({ blocked: 0.04, injection: 0.82 }));
  const { runtime } = setup({}, provider);
  const result = await runtime.run('Open About then Members', { expectation: { urlIncludes: '/members' } });
  assert.equal(result.steps[0].decision.guards.injection, 0.82);
  assert.equal(result.steps[0].decision.guards.blocked, 0.04);
  assert.ok(result.verdict.why.includes('guard:injection:0.82'));
  assert.ok(!result.verdict.why.some(code => code.startsWith('guard:blocked')));
});

test('blocked >= 0.85 ends the run as needs_user/blocked with nothing executed', async () => {
  const provider = guarded(['About'], () => ({ blocked: 0.93, injection: 0.01 }));
  const { bridge, runtime } = setup({}, provider);
  const result = await runtime.run('Open About');
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'blocked');
  assert.equal(bridge.executions.length, 0);
  assert.ok(result.verdict.why.includes('guard:blocked:0.93'));
  const lean = agentResult(result);
  assert.equal(lean.next.kind, 'relay');
  assert.match(lean.needs.message, /never signs in or solves captchas/);
});

test('blocked does not pre-empt rung 0: a login wall is still login, a consent dialog is still offered', async () => {
  const login = guarded([], () => ({ blocked: 0.99 }));
  const walled = setup({ '/': { title: 'Sign in', text: 'x', controls: [], warnings: ['password_field', 'login_wall'] } }, login);
  assert.equal((await walled.runtime.run('Open Home')).code, 'login');
  assert.equal(login.calls.length, 0);
  const consent = {
    title: 'Home', text: 'cookies', controls: [
      link('1', 'About', '/about'),
      button('7', 'Necessary only', { consent: true, dismissesConsent: true }),
      button('9', 'Reject all', { consent: true, dismissesConsent: true }),
    ],
    consent: { text: 'We use cookies', buttons: [{ id: '7', label: 'Necessary only', kind: 'reject' }, { id: '9', label: 'Reject all', kind: 'reject' }] },
  };
  // A consent-only page scores high on blocked; with reject buttons offered the run still dismisses it.
  const provider = guarded(['Reject all', 'About'], (_, actions) => ({ blocked: actions.some(a => a.consent) ? 0.95 : 0.01 }));
  const { runtime } = setup({ '/': consent }, provider);
  const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' }, consentWaitMs: 0 });
  assert.equal(result.status, 'completed', result.code);
  assert.equal(result.steps[0].class, 'consent');
});

test('blocked with a passing expectation completes as likely/confirm_page, never auto-confirmed', async () => {
  const provider = guarded([], () => ({ blocked: 0.97 }), { done: 0.9 });
  const { runtime } = setup({}, provider);
  const result = await runtime.run('Show home', {
    expectation: { textIncludes: 'Welcome home' }, answerQuestion: 'What does home say?' });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.verdict.kind, 'likely');
  assert.equal(result.verdict.oversight, 'confirm');
  assert.equal(result.verdict.answer, null);
  assert.ok(result.verdict.why.includes('guard:blocked:0.97'));
  assert.ok(result.verdict.why.includes('guard:blocked_page'));
  assert.equal(result.next.kind, 'confirm_page');
  assert.match(result.next.text, /login, paywall or captcha/);
  // A done below doneThreshold does not earn the exception: the blocked guard ends the run.
  const low = setup({}, guarded([], () => ({ blocked: 0.97 }), { done: 0.3 }));
  const blocked = await low.runtime.run('Show home', { expectation: { textIncludes: 'Welcome home' } });
  assert.equal(blocked.status, 'needs_user');
  assert.equal(blocked.code, 'blocked');
});

test('injection >= 0.85: an approved-origin link still runs', async () => {
  const provider = guarded(['About'], () => ({ injection: 0.95 }), { done: 0.9 });
  const { runtime } = setup({}, provider);
  const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.steps[0].action.label, 'About');
  assert.ok(result.verdict.why.includes('guard:injection:0.95'));
});

test('injection >= 0.85: a button, select or fill becomes a handoff (guard:injection_veto)', async () => {
  const provider = guarded(['Subscribe'], () => ({ injection: 0.9 }));
  const { bridge, runtime } = setup({}, provider);
  bridge.path = '/form';
  const result = await runtime.run('Tick Subscribe', { mode: 'reversible' });
  assert.equal(result.code, 'handoff');
  assert.equal(bridge.executions.length, 0);
  assert.ok(result.verdict.why.includes('guard:injection_veto'));
});

test('injection below 0.85 does not veto a control', async () => {
  const provider = guarded(['Subscribe'], () => ({ injection: 0.8 }));
  const { bridge, runtime } = setup({}, provider);
  bridge.path = '/form';
  const result = await runtime.run('Tick Subscribe', { mode: 'reversible', maxActions: 1 });
  assert.equal(bridge.executions.length, 1);
  assert.ok(!result.verdict.why.includes('guard:injection_veto'));
});
