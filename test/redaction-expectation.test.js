import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, providerPayload, redactorFor, SUPPLIED_REDACTION_MIN_LENGTH } from '../src/runtime.js';
import { checkDeclarative, evaluateExpectation, validateExpectation, verifyExpectation } from '../src/expectation.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

test('redactor replaces exact and URL-encoded supplied values of 4+ characters only', () => {
  assert.equal(SUPPLIED_REDACTION_MIN_LENGTH, 4);
  const redact = redactorFor({ city: 'New York', pin: '123', name: 'Ada', note: 'abcd' });
  assert.equal(redact('Ship to New York'), 'Ship to [supplied:city]');
  assert.equal(redact('/search?q=New%20York'), '/search?q=[supplied:city]');
  assert.equal(redact('/search?q=New+York'), '/search?q=[supplied:city]');
  assert.equal(redact('abcdabcd'), '[supplied:note][supplied:note]');
  assert.equal(redact('new york'), 'new york', 'matching is exact and case-sensitive');
  assert.equal(redact('PIN 123 for Ada'), 'PIN 123 for Ada', 'short values are not redacted');
  assert.equal(redactorFor({})('unchanged'), 'unchanged');
});

test('provider payload redacts page, controls, options, criteria inputs and history', () => {
  const observation = {
    revision: 'r1',
    url: `${ORIGIN}/?q=secret-value`,
    title: 'secret-value results',
    text: 'You typed secret-value',
    controls: [{ id: '1', role: 'combobox', label: 'Pick secret-value', options: [{ value: 'secret-value', label: 'secret-value' }] }],
  };
  const actions = [{ id: 'a0', type: 'click', target: '1', label: 'secret-value', description: 'Click secret-value' }];
  const history = [{ i: 1, type: 'click', label: 'secret-value', fromUrl: `${ORIGIN}/secret-value`, toUrl: ORIGIN, changed: true }];
  const payload = providerPayload(observation, actions, history, { q: 'secret-value' });
  assert.ok(!JSON.stringify(payload).includes('secret-value'));
  assert.equal(payload.observation.text, 'You typed [supplied:q]');
  assert.equal(payload.actions[0].id, 'a0');
  assert.equal(actions[0].label, 'secret-value', 'inputs are not mutated');
});

test('changedSinceStart: validation, baseline required, run/step/act baselines', async () => {
  assert.throws(() => validateExpectation({ changedSinceStart: false }), /must be true/);
  validateExpectation({ changedSinceStart: true, urlIncludes: '/about' });
  const initial = { revision: 'r1', url: `${ORIGIN}/` };
  assert.equal(checkDeclarative({ revision: 'r1', url: `${ORIGIN}/` }, { changedSinceStart: true }, { initial }), false);
  assert.equal(checkDeclarative({ revision: 'r2', url: `${ORIGIN}/` }, { changedSinceStart: true }, { initial }), true);
  assert.equal(checkDeclarative({ revision: 'r1', url: `${ORIGIN}/x` }, { changedSinceStart: true }, { initial }), true);
  assert.equal(verifyExpectation({ revision: 'r2', url: ORIGIN }, { changedSinceStart: true }), false, 'no baseline');
  assert.equal(await evaluateExpectation({ revision: 'r2' }, (obs, context) => context.initial === initial, { initial }), true);

  // A scroll leaves the fake page unchanged, so the expectation must fail, then a click passes it.
  const bridge = new FakeBridge();
  const scroller = { decide: async (_, actions) => ({ actionId: actions.find(a => a.type === 'scroll').id }) };
  const unchanged = await new BrowserRuntime({ bridge, provider: scroller }).step('Scroll', {
    capture: 'none', expectation: { changedSinceStart: true },
  });
  assert.equal(unchanged.status, 'checkpoint');

  const runtime = new BrowserRuntime({ bridge });
  const { observation, actions } = await runtime.observe();
  const click = actions.find(a => a.type === 'click');
  const acted = await runtime.act(click.id, { revision: observation.revision, capture: 'none', expectation: { changedSinceStart: true } });
  assert.equal(acted.status, 'completed');
});

test('runtime accepts a caller runId and interrupt codes', async () => {
  const bridge = new FakeBridge();
  const provider = { decide: () => new Promise(() => {}) };
  const runtime = new BrowserRuntime({ bridge, provider });
  const pending = runtime.run('Open', { runId: 'my-run-1', capture: 'none' });
  await new Promise(resolve => setTimeout(resolve, 10));
  runtime.interrupt('tab_changed');
  const result = await pending;
  assert.equal(result.runId, 'my-run-1');
  assert.equal(result.code, 'tab_changed');
  assert.equal(result.status, 'needs_user');
  await assert.rejects(runtime.run('Open', { runId: '../x' }), /runId/);
});

test('textAbsent reads the whole document when textIncludes passed only past the viewport', async () => {
  const { checkDeclarative, expectationTexts } = await import('../src/expectation.js');
  const exp = { textIncludes: 'Confirmed', textAbsent: 'Error' };
  assert.deepEqual(expectationTexts(exp), ['confirmed', 'error']);
  const off = { url: 'https://e.com/', title: 'T', text: 'Footer' };
  assert.equal(checkDeclarative({ ...off, textFound: ['confirmed', 'error'] }, exp), false);
  assert.equal(checkDeclarative({ ...off, textFound: ['confirmed'], textCapped: true }, exp), false);
  assert.equal(checkDeclarative({ ...off, textFound: ['confirmed'] }, exp), true);
  // textIncludes in the viewport: textAbsent stays viewport-only.
  assert.equal(checkDeclarative({ ...off, text: 'Confirmed', textFound: ['confirmed', 'error'] }, exp), true);
});
