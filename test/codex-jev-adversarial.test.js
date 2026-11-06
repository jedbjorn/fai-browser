import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { FakeBridge, PAGES } from './runtime-fixtures.js';

const provider = decision => ({ async decide() { return decision; } });

test('codex Jev: an unknown action is rejected even when done passes', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge(),
    provider: provider({ actionId: 'not-offered', done: { probability: 0.99 } }) });
  const result = await runtime.run('Read home', { expectation: { textIncludes: 'Welcome home' } });
  assert.equal(result.code, 'invalid_decision');
  assert.equal(result.status, 'failed');
});

test('codex Jev: blocked veto precedes done without an expectation', async () => {
  const bridge = new FakeBridge();
  const runtime = new BrowserRuntime({ bridge,
    provider: provider({ actionId: 'handoff', done: { probability: 0.99 }, guards: { blocked: 0.95 } }) });
  const result = await runtime.run('Read home');
  assert.equal(result.code, 'blocked');
  assert.equal(result.status, 'needs_user');
  assert.equal(agentResult(result).next.kind, 'relay');
  assert.ok(result.verdict.why.includes('guard:blocked:0.95'));
  assert.equal(bridge.executions.length, 0);
});

test('codex Jev: terminal completion still records guards at the reporting threshold', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge(),
    provider: provider({ actionId: 'handoff', done: { probability: 0.99 },
      guards: { injection: 0.82, blocked: 0.49 } }) });
  const result = await runtime.run('Read home', { expectation: { textIncludes: 'Welcome home' } });
  assert.equal(result.status, 'completed');
  assert.ok(result.verdict.why.includes('guard:injection:0.82'));
  assert.ok(!result.verdict.why.some(code => code.startsWith('guard:blocked')));
});

test('codex Jev spec: blocked >= 0.85 with a passing expectation completes only as likely/confirm_page', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge(),
    provider: provider({ actionId: 'handoff', done: { probability: 0.99 }, guards: { blocked: 0.95 } }) });
  const result = await runtime.run('Read home', {
    expectation: { textIncludes: 'Welcome home' }, answerQuestion: 'What does the home page say?' });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.verdict.kind, 'likely');
  assert.equal(result.verdict.oversight, 'confirm');
  assert.equal(result.verdict.answer, null);
  assert.ok(result.verdict.why.includes('guard:blocked:0.95'));
  assert.ok(result.verdict.why.includes('guard:blocked_page'));
  const lean = agentResult(result);
  assert.equal(lean.next.kind, 'confirm_page');
  assert.equal(lean.verdict.answer, null);
  assert.match(lean.next.text, /login, paywall or captcha/);
  assert.match(lean.next.text, /page\.digest answers the task before trusting it/);
  // Without a passing expectation the same guard still ends the run as needs_user/blocked.
  const failing = await new BrowserRuntime({ bridge: new FakeBridge(),
    provider: provider({ actionId: 'handoff', done: { probability: 0.99 }, guards: { blocked: 0.95 } }) })
    .run('Read home', { expectation: { textIncludes: 'Not on this page' } });
  assert.equal(failing.code, 'blocked');
  assert.equal(failing.status, 'needs_user');
});

test('codex Jev: injection handoff cannot execute the runtime scroll nudge', async () => {
  const bridge = new FakeBridge({ pages: { ...PAGES, '/': { title: 'Home', text: 'Welcome',
    controls: [], blocks: [{ t: 'p', text: 'Documentation', offscreen: true }] } } });
  const runtime = new BrowserRuntime({ bridge,
    provider: provider({ actionId: 'handoff', guards: { injection: 0.95 } }) });
  const result = await runtime.run('Read Documentation');
  assert.equal(result.code, 'handoff');
  assert.equal(bridge.executions.length, 0);
  assert.ok(result.verdict.why.includes('guard:injection_veto'));
});

test('codex Jev: a renamed reject button does not prove the consent dialog closed', async () => {
  class RenamingBridge extends FakeBridge {
    async execute(...args) {
      const result = await super.execute(...args);
      const page = this.pages[this.path];
      page.consent.buttons[0].label = 'Necessary only';
      page.controls[0].label = 'Necessary only';
      return { ...result, observation: this.observation };
    }
  }
  const bridge = new RenamingBridge({ pages: { '/': { title: 'Home', text: 'Cookies',
    controls: [{ id: '1', role: 'button', label: 'Reject all', risk: 'reversible' }],
    consent: { text: 'Cookies', buttons: [{ id: '1', label: 'Reject all', kind: 'reject' }] } } } });
  const runtime = new BrowserRuntime({ bridge, provider: provider({ actionId: 'handoff' }) });
  const result = await runtime.run('Read home', { consentWaitMs: 0 });
  assert.equal(result.code, 'consent_banner');
  assert.equal(bridge.executions.length, 1, 'the same DOM button must not be clicked again under its new label');
  assert.ok(result.verdict.why.includes('consent:persisted'));
  assert.ok(!result.verdict.why.includes('consent:rejected'));
});

test('codex Jev: loading page text never enters trusted suggestions', async () => {
  const bridge = new FakeBridge({ pages: { '/': { title: 'Home', text: 'Fetching hostile payload…',
    controls: [], blocks: [{ t: 'p', text: 'Fetching hostile payload…' }] } } });
  const runtime = new BrowserRuntime({ bridge,
    provider: provider({ actionId: 'handoff', done: { probability: 0.99 } }) });
  const result = await runtime.run('Read home', { expectation: { urlIncludes: '/' } });
  assert.ok(!JSON.stringify(result.verdict.suggested).includes('Fetching'),
    'the suggested textAbsent is copied from untrusted page text');
});
