import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { bridgeError } from '../src/result.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

test('observe returns the compact page and offered actions without terminal choices', async () => {
  const bridge = new FakeBridge();
  const runtime = new BrowserRuntime({ bridge });
  const { observation, actions } = await runtime.observe();
  assert.equal(observation.revision, '/#1');
  assert.equal(observation.controls[0].label, 'About');
  assert.equal(observation.controls[0].bounds, undefined);
  assert.ok(actions.some(action => action.type === 'click' && action.label === 'About'));
  assert.ok(!actions.some(action => action.type === 'done' || action.type === 'handoff'));
  assert.equal(bridge.executions.length, 0);
});

test('act executes a host-chosen action and returns the result schema', async () => {
  const bridge = new FakeBridge();
  const runtime = new BrowserRuntime({ bridge });
  const { observation, actions } = await runtime.observe();
  const about = actions.find(action => action.label === 'About');
  const result = await runtime.act(about.id, { revision: observation.revision });
  assert.equal(result.v, 2);
  assert.equal(result.status, 'checkpoint');
  assert.deepEqual(result.steps[0].decision, { by: 'host', actionId: about.id });
  assert.equal(result.steps[0].action.toUrl, `${ORIGIN}/about`);
  assert.equal(result.steps[0].screenshot.revision, result.steps[0].observation.revision);
  assert.equal(result.cost.decisions, 0);
  assert.equal(bridge.executions[0].expectedRevision, '/#1');
});

test('act with an expectation completes when it passes', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge() });
  const { actions } = await runtime.observe();
  const result = await runtime.act(actions.find(a => a.label === 'About').id, { expectation: { urlIncludes: '/about' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.verification.passed, true);
});

test('act validates the action id and revision against the cache', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge() });
  await assert.rejects(runtime.act('a0'), /observe\(\) first/);
  const { observation, actions } = await runtime.observe();
  await assert.rejects(runtime.act('a99', { revision: observation.revision }), /not offered/);
  await assert.rejects(runtime.act(actions[0].id, { revision: 'unknown' }), /Unknown revision/);
  await runtime.act(actions[0].id, { revision: observation.revision });
  // An offer is spent once acted on.
  await assert.rejects(runtime.act(actions[0].id, { revision: observation.revision }), /Unknown revision/);
});

test('act on a page that changed since observe runs the same control when exactly one matches (stale re-resolve)', async () => {
  const bridge = new FakeBridge();
  const runtime = new BrowserRuntime({ bridge });
  const { actions } = await runtime.observe();
  // A late update from an earlier click moved the revision; the About link is still there, once.
  bridge.version++;
  const result = await runtime.act(actions.find(a => a.label === 'About').id);
  assert.equal(result.status, 'checkpoint', result.reason);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].decision.reason, 'stale_reresolve');
  assert.equal(result.steps[0].action.toUrl, `${ORIGIN}/about`);
  assert.ok(result.verdict.why.includes('act:stale_reresolve'));
  assert.ok(result.warnings.includes('act_reresolved'), 'the host is told its observation is out of date');
  assert.deepEqual(bridge.executions.map(entry => entry.expectedRevision), ['/#1', '/#2']);
});

test('act on a changed page stays needs_host/stale when the control is gone, doubled, or the path moved', async () => {
  const pages = { '/': { title: 'Home', text: 'Home', controls: [
    { id: '1', role: 'button', label: 'Next', enabled: true },
    { id: '2', role: 'button', label: 'Save draft', enabled: true },
  ] }, '/other': { title: 'Other', text: 'Other', controls: [{ id: '1', role: 'button', label: 'Next', enabled: true }] } };
  const cases = {
    gone: bridge => { bridge.pages['/'].controls = [bridge.pages['/'].controls[1]]; },
    // A second Next next to the first: neither one has the original's neighbours.
    doubled: bridge => { bridge.pages['/'].controls.splice(1, 0, { id: '3', role: 'button', label: 'Next', enabled: true }); },
    moved: bridge => { bridge.path = '/other'; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const bridge = new FakeBridge({ pages });
    const runtime = new BrowserRuntime({ bridge });
    const { actions } = await runtime.observe({ mode: 'reversible' });
    bridge.version++;
    change(bridge);
    const result = await runtime.act(actions.find(a => a.label === 'Next').id);
    assert.equal(result.status, 'needs_host', name);
    assert.equal(result.code, 'stale', name);
    assert.equal(result.steps.length, 0, name);
    assert.equal(bridge.executions.length, 1, `${name}: nothing ran on the fresh page`);
  }
  // Two same-label stepper arrows are told apart by their neighbours' labels: the one after "Return" is the one.
  const arrow = 'next-value button after "Departure" (unlabelled)';
  const twin = { '/': { title: 'Home', text: 'Home', controls: [
    { id: '1', role: 'button', label: arrow, unnamed: true, enabled: true },
    { id: '2', role: 'textbox', label: 'Return', type: 'text', enabled: true },
    { id: '3', role: 'button', label: arrow, unnamed: true, enabled: true },
  ] } };
  const bridge = new FakeBridge({ pages: twin });
  const runtime = new BrowserRuntime({ bridge });
  const { actions } = await runtime.observe({ mode: 'reversible' });
  bridge.version++;
  const result = await runtime.act(actions.find(a => a.label === arrow && a.target === '3').id);
  assert.equal(result.status, 'checkpoint', result.reason);
  assert.equal(bridge.executions.at(-1).action.target, '3');
});

test('act stale re-resolve refuses a list whose rows changed, delete and submit classes, and a dialog that appeared', async () => {
  const b = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, ...extra });
  const cases = {
    // Row B (controls 3, 4) was removed: the Delete before "Edit" and after "Edit" is now row A's, a unique match.
    rowShift: { controls: [b('1', 'Edit'), b('2', 'Delete'), b('3', 'Edit'), b('4', 'Delete'), b('5', 'Edit'), b('6', 'Delete')],
      target: '4', change: page => { page.controls.splice(2, 2); } },
    // Two rows, the first removed: the one Remove left is the other row's.
    lastRow: { controls: [b('1', 'Remove'), b('2', 'Remove')], target: '1', change: page => { page.controls.shift(); } },
    // A same-label Submit, whose form may now be another one: never re-resolved.
    submit: { controls: [b('1', 'Submit'), b('2', 'Back')], target: '1', change: () => {} },
    // A consent dialog that appeared in between: the host has not seen it.
    consent: { controls: [b('1', 'Show more')], target: '1', change: page => {
      page.consent = { text: 'Cookies', buttons: [{ id: '8', label: 'Reject all', kind: 'reject' }] };
    } },
  };
  for (const [name, { controls, target, change }] of Object.entries(cases)) {
    const bridge = new FakeBridge({ pages: { '/': { title: 'List', text: 'Rows', controls } } });
    const runtime = new BrowserRuntime({ bridge });
    const { actions } = await runtime.observe({ mode: 'full' });
    bridge.version++;
    change(bridge.pages['/']);
    const result = await runtime.act(actions.find(a => a.target === target && a.type === 'click').id);
    assert.equal(result.code, 'stale', name);
    assert.equal(bridge.executions.length, 1, `${name}: nothing ran on the fresh page`);
  }
});

test('act stale re-resolve leaves a named button stale: Next on a later wizard step, OK on another dialog', async () => {
  const cases = {
    wizard: { text: 'Step 1: your details', label: 'Next', later: 'Step 2: payment details' },
    dialog: { text: 'Save your changes?', label: 'OK', later: 'Delete every item?' },
  };
  for (const [name, { text, label, later }] of Object.entries(cases)) {
    const pages = { '/': { title: 'App', text, controls: [
      { id: '1', role: 'button', label, enabled: true }, { id: '2', role: 'button', label: 'Back', enabled: true }] } };
    const bridge = new FakeBridge({ pages });
    const runtime = new BrowserRuntime({ bridge });
    const { actions } = await runtime.observe({ mode: 'full' });
    bridge.version++;
    bridge.pages['/'].text = later;
    const result = await runtime.act(actions.find(a => a.label === label).id);
    assert.equal(result.code, 'stale', name);
    assert.equal(bridge.executions.length, 1, `${name}: nothing ran on the fresh page`);
  }
});

test('act stale re-resolve asks the commit guard again about the fresh page', async () => {
  // A picker-open click (one of the controls a stale act re-resolves) on a page that became a binding step.
  const pages = { '/': { title: 'Wizard', text: 'Step 1', controls: [{ id: '1', role: 'textbox', label: 'Departure', type: 'text', enabled: true }] } };
  const calls = [];
  const provider = {
    async decide(observation, actions) {
      calls.push(observation.text ?? '');
      // The step-2 page commits (a binding confirmation); step 1 did not.
      const commit = /Step 2/.test(JSON.stringify(observation)) ? 0.95 : 0.1;
      return { actionId: actions[0].id, confidence: 0.9, done: { probability: 0.1 }, guards: { commit, injection: 0.1, blocked: 0.1 }, model: 'fake' };
    },
  };
  const bridge = new FakeBridge({ pages });
  const runtime = new BrowserRuntime({ bridge, provider });
  const { actions } = await runtime.observe({ mode: 'reversible' });
  bridge.version++;
  bridge.pages['/'].text = 'Step 2: confirm the transfer';
  const result = await runtime.act(actions.find(a => a.label === 'Departure' && a.opens).id);
  assert.equal(result.code, 'refused_action', result.reason);
  assert.equal(bridge.executions.length, 1, 'the re-resolved click never ran');
  assert.equal(calls.length, 2);
});

test('act uses the authority fixed at observe time for supplied text', async () => {
  const bridge = new FakeBridge({ path: '/form' });
  const runtime = new BrowserRuntime({ bridge });
  const { actions } = await runtime.observe({ mode: 'reversible', suppliedText: { name: 'Alex' } });
  assert.ok(!JSON.stringify(actions).includes('Alex'));
  const fill = actions.find(action => action.type === 'fill_supplied_text');
  const result = await runtime.act(fill.id, { mode: 'read-only', suppliedText: { name: 'Mallory' } });
  assert.equal(bridge.lastText, 'Alex');
  assert.equal(result.status, 'checkpoint');
});

test('act stale supplied fill re-resolves only a unique search/filter control', async () => {
  const search = (id, label = 'Search messages') => ({
    id, role: 'textbox', label, type: 'text', enabled: true, risk: 'reversible', enter: 'submit_safe',
  });
  const cases = {
    search: { before: [search('old')], after: [search('new')], recovered: true },
    filter: { before: [search('old', 'Filter messages')], after: [search('new', 'Filter messages')], recovered: true },
    ordinary: { before: [search('old', 'Display name')], after: [search('new', 'Display name')], recovered: false },
    ambiguous: { before: [search('old')], after: [search('new'), search('other')], recovered: false },
  };
  for (const [name, fixture] of Object.entries(cases)) {
    const bridge = new FakeBridge({ pages: { '/': { title: 'Messages', text: 'Find messages', controls: fixture.before } } });
    const runtime = new BrowserRuntime({ bridge });
    const { observation, actions } = await runtime.observe({ mode: 'interactive', suppliedText: { query: 'project update' } });
    bridge.pages['/'].controls = fixture.after;
    bridge.version++;
    const fill = actions.find(action => action.type === 'fill_supplied_text');
    const result = await runtime.act(fill.id, { revision: observation.revision });
    assert.equal(result.code, fixture.recovered ? 'step_complete' : 'stale', `${name}: ${result.reason}`);
    assert.equal(bridge.executions.length, fixture.recovered ? 2 : 1, name);
    if (fixture.recovered) {
      assert.equal(bridge.executions[1].action.target, 'new', name);
      assert.equal(bridge.lastText, 'project update', name);
    }
  }
});

test('act never re-resolves Enter after the fill succeeded', async () => {
  const bridge = new FakeBridge({ pages: { '/': { title: 'Search', text: 'Find messages', controls: [
    { id: 'field', role: 'textbox', label: 'Search messages', type: 'search', enabled: true, risk: 'reversible', enter: 'submit_safe' },
  ] } } });
  const runtime = new BrowserRuntime({ bridge });
  const { observation, actions } = await runtime.observe({ mode: 'interactive', suppliedText: { query: 'project update' } });
  bridge.failNext.push(null, bridgeError('stale', 'Stale observation'));
  const fill = actions.find(action => action.type === 'fill_supplied_text');
  const result = await runtime.act({ actionId: fill.id, submit: true }, { revision: observation.revision });
  assert.equal(result.code, 'stale', result.reason);
  assert.equal(bridge.executions.length, 2, 'the fill ran once and Enter was not retried');
  assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['fill_supplied_text', 'submit_field']);
  assert.equal(result.steps.length, 1, 'only the completed fill is recorded');
  assert.equal(result.steps[0].action.type, 'fill_supplied_text');
});

test('act stale re-resolve reads a stepper label as lateLook does: next, increase and -value arrows alike', async () => {
  for (const arrow of ['next button after "Departure" (unlabelled)', 'increase button after "Adults" (unlabelled)',
    'next-value button after "Departure" (unlabelled)']) {
    const bridge = new FakeBridge({ pages: { '/': { title: 'Home', text: 'Home', controls: [
      { id: '1', role: 'textbox', label: 'Departure', type: 'text', enabled: true },
      { id: '2', role: 'button', label: arrow, unnamed: true, enabled: true },
    ] } } });
    const runtime = new BrowserRuntime({ bridge });
    const { actions } = await runtime.observe({ mode: 'reversible' });
    bridge.version++;
    const result = await runtime.act(actions.find(a => a.label === arrow).id);
    assert.equal(result.status, 'checkpoint', `${arrow}: ${result.code} ${result.reason}`);
  }
});
