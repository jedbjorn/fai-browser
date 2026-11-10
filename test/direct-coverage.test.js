// The host-driven loop (BrowserRuntime observe/act) keeps the protections the removed autopilot's run-loop tests used
// to cover: secret redaction of returned pages, guardrail refusals, policy.forbid, verification of an act's outcome
// and level refusals (error pages: test/machinery-runtime.test.js). In-memory bridge only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { directNext } from '../src/result.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';
import { leaks, loadFakes } from './helpers/secret-fakes.js';

const F = loadFakes();
const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, risk: 'reversible', ...extra });
const grant = level => ({ allowedOrigins: [ORIGIN], mode: level, grant: { level } });

test('observe and act never return a secret the page shows: page text, labels, URLs and the act result', async () => {
  const pages = {
    '/': { title: `Keys ${F.github}`, text: `Your token: ${F.openai} and ${F.awsId},${F.awsSecret}`,
      controls: [link('1', `Copy ${F.github}`, `/next?k=${F.github}`), link('2', 'Next', '/next')] },
    '/next': { title: 'Next', text: `Again ${F.openai}`, controls: [link('1', 'Home', '/')] },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }) });
  const page = await runtime.observe(grant('read-only'));
  assert.deepEqual(leaks(page), [], 'observe');
  const next = page.actions.find(action => action.label === 'Next');
  const result = await runtime.act(next.id, { expectation: { urlIncludes: '/next' } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(leaks(result), [], 'act result');
  assert.deepEqual(leaks(result.offer ?? {}), [], 'the landing offer');
});

test('a refused control is never offered, and an act on a forged or refused id runs nothing', async () => {
  const pages = { '/': { title: 'Shop', text: 'Cart', controls: [link('1', 'About', '/about'),
    button('2', 'Buy now', { risk: 'purchase' }), button('3', 'Delete account', { risk: 'destructive' }),
    button('4', 'Sign in', { risk: 'sign_in' })] }, '/about': { title: 'About', text: 'About', controls: [] } };
  const bridge = new FakeBridge({ pages });
  const runtime = new BrowserRuntime({ bridge });
  for (const level of ['read-only', 'reversible', 'interactive', 'full']) {
    const page = await runtime.observe(grant(level));
    const labels = page.actions.map(action => action.label);
    for (const refused of ['Buy now', 'Delete account', 'Sign in']) assert.ok(!labels.includes(refused), `${level}: ${refused}`);
    await assert.rejects(runtime.act('a99', { revision: page.observation.revision }));
  }
  assert.equal(bridge.executions.length, 0);
});

test('policy.forbid: a forbidden label is never offered at any level, testing included', async () => {
  const pages = { '/': { title: 'Account', text: 'Plan', controls: [button('1', 'Upgrade'), button('2', 'Gift wrap'),
    link('3', 'Help', '/help')] }, '/help': { title: 'Help', text: 'Help', controls: [] } };
  const bridge = new FakeBridge({ pages });
  const runtime = new BrowserRuntime({ bridge });
  for (const level of ['reversible', 'full', 'testing']) {
    const page = await runtime.observe({ ...grant(level), policy: { forbid: ['Upgrade', 'Gift wrap'] } });
    const labels = page.actions.map(action => action.label);
    assert.ok(!labels.includes('Upgrade') && !labels.includes('Gift wrap'), `${level}: ${labels.join(', ')}`);
    assert.ok(labels.includes('Help'));
  }
  // Without the policy the same buttons are offered at reversible: the refusal came from the policy alone.
  const open = await runtime.observe(grant('reversible'));
  assert.ok(open.actions.some(action => action.label === 'Gift wrap'));
  assert.equal(bridge.executions.length, 0);
});

test('an act whose expectation fails is not verified, and next says the expectation did not pass', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge() });
  const page = await runtime.observe(grant('read-only'));
  const about = page.actions.find(action => action.label === 'About');
  const result = await runtime.act(about.id, { expectation: { urlIncludes: '/members', textIncludes: 'Ada' } });
  assert.notEqual(result.status, 'completed');
  assert.equal(result.verification.checked, true);
  assert.equal(result.verification.passed, false);
  const next = directNext({ ...result, requestId: 'req-1' }, { requestId: 'req-1' });
  assert.match(next.text, /expectation did not pass/);
  assert.ok(['choose', 'observe'].includes(next.kind), next.kind);
  // The same act with a passing expectation is verified.
  const again = await runtime.observe(grant('read-only'));
  const members = again.actions.find(action => action.label === 'Members');
  const verified = await runtime.act(members.id, { expectation: { urlIncludes: '/members', textIncludes: 'Ada' } });
  assert.equal(verified.status, 'completed');
  assert.equal(verified.verification.passed, true);
  assert.equal(directNext(verified).kind, 'answer');
});

test('a level the grant lacks: the control is not offered below it and the grant clamps a higher asked mode', async () => {
  const pages = { '/': { title: 'Settings', text: 'Profile', controls: [button('1', 'Save', { risk: 'submit' }), link('2', 'Help', '/h')] },
    '/h': { title: 'Help', text: 'Help', controls: [] } };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }) });
  const low = await runtime.observe({ allowedOrigins: [ORIGIN], mode: 'full', grant: { level: 'reversible' } });
  assert.ok(!low.actions.some(action => action.label === 'Save'), 'submit needs full; the grant is reversible');
  const high = await runtime.observe({ allowedOrigins: [ORIGIN], mode: 'full', grant: { level: 'full' } });
  assert.ok(high.actions.some(action => action.label === 'Save'));
});
