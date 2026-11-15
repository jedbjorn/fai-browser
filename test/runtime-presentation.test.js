import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, checkActChoice, legalActions, pointAction } from '../src/runtime.js';
import { agentResult, leanObserve, publicObservation, recordResultsOf } from '../src/result.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const HIDDEN = `${ORIGIN}/#private`;
const candidate = extra => link('1', 'Reference docs', HIDDEN, {
  actionability: 'reveal', actionabilityReason: 'outside_viewport', visible: false, offscreen: true, ...extra,
});
const options = { mode: 'read-only', allowedOrigins: [ORIGIN], capture: 'none' };

class PresentationBridge extends FakeBridge {
  constructor({ control = candidate(), hidden = [], successfulReveal = true, text = 'Start', records } = {}) {
    super({ pages: { '/': { title: 'Home', text, controls: [control], ...(records ? { records } : {}) } } });
    this.hidden = hidden;
    this.successfulReveal = successfulReveal;
  }
  get observation() { return { ...super.observation, unrevealedUrls: [...this.hidden] }; }
  async execute(action, revision, executionOptions) {
    if (action.type === 'reveal') {
      this.executions.push({ action, expectedRevision: revision });
      if (this.successfulReveal) Object.assign(this.pages['/'].controls[0], { actionability: 'ready', visible: true, offscreen: false });
      this.version++;
      return { observation: this.observation, settle: { reason: 'quiet', ms: 0 },
        reveal: { revealed: this.successfulReveal, ...(this.successfulReveal ? {} : { reason: 'no_progress' }) } };
    }
    return super.execute(action, revision, executionOptions);
  }
}

test('explicit presentation yields reveal only before every link route and blocked targets yield no action', () => {
  for (const extra of [{}, { linkTarget: '_blank' }, { href: 'https://other.example/hidden' }, { role: 'button' }]) {
    const actions = legalActions({ url: ORIGIN, controls: [candidate(extra)] }, options);
    assert.deepEqual(actions.filter(action => action.target === '1').map(action => action.type), ['reveal']);
    assert.equal(actions.some(action => action.url || action.href), false);
  }
  assert.equal(legalActions({ url: ORIGIN, controls: [candidate({ actionability: 'blocked' })] }, options)
    .some(action => action.target === '1'), false);
  assert.equal(legalActions({ url: ORIGIN, controls: [link('1', 'Legacy', '/legacy')] }, options)
    .some(action => action.type === 'click'), true);
});

test('reveal consumes an offer, scrolls once, returns fresh choices and cannot be composed into hover or key activation', async () => {
  const bridge = new PresentationBridge();
  const runtime = new BrowserRuntime({ bridge, expectLateMs: 0 });
  const initial = await runtime.observe(options);
  const reveal = initial.actions.find(action => action.type === 'reveal');
  assert.ok(reveal);
  for (const spec of [{ actionId: reveal.id, hover: true }, { actionId: reveal.id, key: 'Space' }]) {
    assert.match(checkActChoice(runtime.lastOffer, spec), /Reveal scrolls only/);
  }
  const after = await runtime.act(reveal.id, { revision: initial.observation.revision, expectation: { titleEquals: 'Home' } });
  assert.equal(after.status, 'checkpoint');
  assert.equal(after.verification.passed, false);
  assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['reveal']);
  assert.notEqual(after.offer.revision, initial.observation.revision);
  assert.ok(after.offer.actions.some(action => action.type === 'click'));
  await assert.rejects(runtime.act(reveal.id, { revision: initial.observation.revision }), /Unknown revision/);
});

test('unsuccessful reveal returns fresh reveal choices without clicking or claiming completion', async () => {
  const bridge = new PresentationBridge({ successfulReveal: false });
  const runtime = new BrowserRuntime({ bridge, expectLateMs: 0 });
  const initial = await runtime.observe(options);
  const after = await runtime.act(initial.actions.find(action => action.type === 'reveal').id, { revision: initial.observation.revision });
  assert.notEqual(after.offer.revision, initial.observation.revision);
  assert.ok(after.offer.actions.some(action => action.type === 'reveal'));
  assert.equal(after.offer.actions.some(action => action.type === 'click'), false);
  assert.equal(after.code, 'target_unavailable');
  assert.equal(after.verification.passed, false);
  assert.deepEqual(after.steps[0].reveal, { revealed: false, reason: 'no_progress' });
  assert.deepEqual(agentResult(after).steps[0].reveal, { revealed: false, reason: 'no_progress' });
  assert.equal(agentResult(after).next.kind, 'choose');
  assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['reveal']);
});

test('known hidden URL aliases refuse while supplied, previously visible and distinct-fragment URLs retain authority', async () => {
  for (const key of ['url', 'openTab']) {
    const bridge = new PresentationBridge({ control: candidate({ actionability: 'blocked' }), hidden: [HIDDEN], text: HIDDEN });
    const runtime = new BrowserRuntime({ bridge, expectLateMs: 0 });
    const initial = await runtime.observe({ ...options, grant: { level: 'full', tabMode: 'multiple' } });
    const result = await runtime.act({ [key]: HIDDEN }, { revision: initial.observation.revision });
    assert.equal(result.code, 'refused_action');
    assert.ok(result.verdict.why.includes('url:unrevealed'));
    assert.equal(bridge.executions.length, 0);
  }
  for (const source of ['supplied', 'previously-visible', 'task', 'distinct-fragment', 'recreated-runtime']) {
    const bridge = new PresentationBridge({ control: candidate({ actionability: 'ready', visible: true }), hidden: [] });
    let runtime = new BrowserRuntime({ bridge, expectLateMs: 0 });
    if (source === 'previously-visible' || source === 'recreated-runtime') await runtime.observe(options);
    if (source === 'recreated-runtime') {
      const authority = runtime.exposedUrls;
      runtime = new BrowserRuntime({ bridge, expectLateMs: 0 });
      runtime.exposedUrls = authority;
    }
    bridge.pages['/'].controls[0] = candidate({ actionability: 'blocked' });
    bridge.hidden = [HIDDEN];
    const initial = await runtime.observe({ ...options,
      ...(source === 'supplied' ? { allowedUrls: [HIDDEN] } : {}),
      ...(source === 'task' ? { instruction: `Open ${HIDDEN}` } : {}),
    });
    const target = source === 'distinct-fragment' ? `${ORIGIN}/#public` : HIDDEN;
    const result = await runtime.act({ url: target }, { revision: initial.observation.revision });
    assert.equal(result.code, 'step_complete', source);
    assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['navigate_allowed_url'], source);
  }
});

test('point resolution cannot promote a reveal candidate into a click', () => {
  const control = candidate();
  assert.equal(pointAction({ actions: [], observation: { url: ORIGIN, controls: [control] } },
    { id: '1', control }, options).refusal.kind, 'unavailable');
});

test('unverified modern text cannot mint visible authority before a hidden anchor is mounted', async () => {
  const bridge = new PresentationBridge({ control: link('1', 'Other', '/other', { actionability: 'ready' }), text: HIDDEN });
  const runtime = new BrowserRuntime({ bridge, expectLateMs: 0 });
  await runtime.observe(options);
  bridge.pages['/'].controls[0] = candidate({ actionability: 'blocked' });
  bridge.hidden = [HIDDEN];
  const initial = await runtime.observe(options);
  const result = await runtime.act({ url: HIDDEN }, { revision: initial.observation.revision });
  assert.equal(result.code, 'refused_action');
  assert.ok(result.verdict.why.includes('url:unrevealed'));
  assert.equal(bridge.executions.length, 0);
});

test('private hidden destinations are removed from direct observations, digests, records and receipts', async () => {
  const records = Array.from({ length: 3 }, (_, index) => ({ id: String(index), list: 0, title: `Document ${index}`,
    fields: [], blocks: [], href: HIDDEN, ref: '1' }));
  const bridge = new PresentationBridge({ hidden: [HIDDEN], text: `Documentation ${HIDDEN}`, records,
    control: candidate({ label: `Reference ${HIDDEN}` }) });
  const runtime = new BrowserRuntime({ bridge, expectLateMs: 0 });
  const observed = await runtime.observe(options);
  assert.equal(JSON.stringify(observed).includes(HIDDEN), false);
  assert.equal(JSON.stringify(leanObserve({ ...observed, page: observed.observation })).includes(HIDDEN), false);
  const recordsView = recordResultsOf(bridge.observation);
  assert.ok(recordsView.records.every(record => record.openRef === undefined && record.revealRef === '1'));
  const result = await runtime.act(observed.actions.find(action => action.type === 'reveal').id, { revision: observed.observation.revision });
  assert.equal(JSON.stringify(result.observation).includes('unrevealedUrls'), false);
  assert.equal(JSON.stringify(agentResult(result)).includes('unrevealedUrls'), false);
  const safe = publicObservation({ url: ORIGIN, controls: [candidate()], unrevealedUrls: [HIDDEN], records });
  assert.equal(JSON.stringify(safe).includes(HIDDEN), false);
});
