// A fill the field did not keep (a date picker's textbox that reverts or ignores typed text: the live Google Flights
// run of 2026-10-08 reported the Departure fill done while the field stayed empty). The page script reads the field
// back after the page settled (`fill: {kept, empty}`); the runtime ends the run or act as fill_not_kept, never counts
// the step as progress, names the field in next.text and marks the lean step. Fixture observations only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, directNext, nextFor } from '../src/result.js';
import { BridgeError } from '../src/bridge.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const textbox = (id, label, extra = {}) => ({ id, role: 'textbox', label, type: 'text', enabled: true, ...extra });

/** A flights search form: a Departure textbox that opens a calendar and reverts typed text, a Name box that keeps it. */
function pages({ departureKeeps = false } = {}) {
  return {
    '/search': {
      title: 'Flights',
      text: 'Where to? Departure Search',
      controls: [
        textbox('1', 'Departure', { opens: true, keepsFill: departureKeeps }),
        textbox('2', 'Name'),
        { id: '3', role: 'button', label: 'Search', enabled: true, risk: 'reversible' },
      ],
    },
  };
}

/**
 * The fake extension: a fill into a control with `keepsFill: false` leaves the field empty and reports it, as
 * extension/page.js does after settle; `reportFill: false` is an older extension that reports nothing, so the runtime
 * reads the next observation's `filled` flag.
 */
class FormBridge extends FakeBridge {
  constructor(options, { reportFill = true } = {}) {
    super(options);
    this.reportFill = reportFill;
  }

  async execute(action, revision, options) {
    if (action.type !== 'fill_supplied_text') return super.execute(action, revision, options);
    const control = this.pages[this.path].controls.find(c => c.id === action.target);
    const kept = control?.keepsFill !== false;
    const out = await super.execute(action, revision, options);
    if (!kept) {
      control.filled = false;
      // The page re-rendered (a dropdown opened) but the value is gone.
      this.version++;
    }
    return this.reportFill ? { ...out, observation: this.observation, fill: { kept, empty: !kept } } : { ...out, observation: this.observation };
  }
}

/** A provider that fills Departure with the supplied date, then (if asked again) says done. */
function fillProvider() {
  let fills = 0;
  return {
    async decide(observation, actions) {
      const fill = actions.find(action => action.type === 'fill_supplied_text' && action.label === 'Departure');
      if (fill && !fills++) return { actionId: fill.id, confidence: 0.9, done: { probability: 0.05 } };
      return { actionId: 'done', confidence: 0.9, done: { probability: 0.9 } };
    },
  };
}

const run = (bridge, provider = fillProvider()) => new BrowserRuntime({ bridge, provider }).run(
  'Set the Departure field to the supplied date, then read the page.', {
    expectation: { changedSinceStart: true }, mode: 'reversible', grant: { level: 'reversible' },
    suppliedText: { departure: '2027-01-12' }, allowedOrigins: [ORIGIN], maxActions: 4,
  },
);

test('run: a fill the page script reports not kept ends needs_host / fill_not_kept, unverified, with the field named in next', async () => {
  const bridge = new FormBridge({ pages: pages(), path: '/search' });
  const result = await run(bridge);
  assert.equal(result.status, 'needs_host', result.reason);
  assert.equal(result.code, 'fill_not_kept');
  assert.equal(bridge.lastText, '2027-01-12', 'the fill ran');
  assert.equal(result.steps.length, 1, 'the run ends on the fill: the provider never types again');
  assert.deepEqual(result.steps[0].fill, { kept: false, empty: true });
  assert.equal(result.steps[0].changed, false, 'a re-render without the value is no progress');
  assert.equal(result.verification.passed, false, 'the page changed, yet nothing was set');
  assert.ok(result.verdict.why.includes('fill:not_kept'), result.verdict.why.join(','));
  assert.match(result.reason, /did not keep the supplied value/);
  assert.match(result.needs.message, /Do not fill it again/);
  assert.equal(result.next.kind, 'rerun');
  assert.match(result.next.text, /for supplied text "departure" did not keep the supplied value \(fill_not_kept\)/);
  assert.match(result.next.text, /allowedUrls/);
  assert.ok(!result.next.text.includes('Departure'), 'the page label stays out of the trusted text');
  const lean = agentResult(result);
  assert.equal(lean.steps[0].fill, 'not_kept');
  assert.equal(lean.verification.passed, false);
  assert.equal(lean.steps[0].action.suppliedName, 'departure');
  assert.equal(nextFor(lean, { requestId: 'req_1' }).text, result.next.text.replace('requestId from this result', 'requestId req_1'));
});

test('run: a fill the field keeps is progress as before; a reporting bridge says so on the step', async () => {
  const bridge = new FormBridge({ pages: pages({ departureKeeps: true }), path: '/search' });
  const result = await run(bridge);
  assert.equal(result.status, 'completed', `${result.code}: ${result.reason}`);
  assert.deepEqual(result.steps[0].fill, { kept: true, empty: false });
  assert.equal(result.steps[0].changed, true);
  assert.equal(agentResult(result).steps[0].fill, undefined);
});

test('run: without a page-script verdict, an empty field on the next observation is read as not kept', async () => {
  const bridge = new FormBridge({ pages: pages(), path: '/search' }, { reportFill: false });
  const result = await run(bridge);
  assert.equal(result.code, 'fill_not_kept', result.reason);
  assert.deepEqual(result.steps[0].fill, { kept: false, empty: true });
  // The same older bridge with a field that keeps the value: nothing to say, the run goes on.
  const kept = new FormBridge({ pages: pages({ departureKeeps: true }), path: '/search' }, { reportFill: false });
  const fine = await run(kept);
  assert.equal(fine.status, 'completed', fine.code);
  assert.equal(fine.steps[0].fill, undefined, 'an older bridge reports nothing about a kept fill');
});

test('act: a host-driven fill the field did not keep is fill_not_kept with the next offer, not a checkpoint', async () => {
  const bridge = new FormBridge({ pages: pages(), path: '/search' });
  const runtime = new BrowserRuntime({ bridge });
  const { actions } = await runtime.observe({ mode: 'reversible', suppliedText: { departure: '2027-01-12' } });
  const fill = actions.find(action => action.type === 'fill_supplied_text' && action.label === 'Departure');
  const result = await runtime.act(fill.id, { expectation: { changedSinceStart: true } });
  assert.equal(result.status, 'needs_host', result.reason);
  assert.equal(result.code, 'fill_not_kept');
  assert.equal(result.verification.passed, false);
  assert.ok(result.offer?.actions.length, 'the page\'s other controls are still offered');
  assert.ok(result.verdict.why.includes('fill:not_kept'));
  assert.equal(agentResult(result).steps[0].fill, 'not_kept');
  // The Name box keeps its value: a checkpoint as before.
  const again = await runtime.observe({ mode: 'reversible', suppliedText: { departure: '2027-01-12' } });
  const name = again.actions.find(action => action.type === 'fill_supplied_text' && action.label === 'Name');
  const ok = await runtime.act(name.id);
  assert.equal(ok.status, 'checkpoint', ok.code);
  assert.deepEqual(ok.steps[0].fill, { kept: true, empty: false });
});

// The page script refuses a fill whose text has a line break when the target is a single-line input (Enter there would
// submit past the submit gate): the bridge reports line_break_input, and the host gets the reason in trusted text.
class LineBreakBridge extends FakeBridge {
  async execute(action, revision, options) {
    if (action.type === 'fill_supplied_text' && /[\r\n]/.test(action.text ?? '')) {
      throw new BridgeError('line_break_input', "Newlines can't be typed into a single-line field; use submit_field to submit");
    }
    return super.execute(action, revision, options);
  }
}

test('act: a fill with a line break into a single-line field is line_break_input, with a trusted next naming submit_field', async () => {
  assert.equal(new BridgeError('line_break_input', 'x').code, 'line_break_input', 'a known bridge code');
  const bridge = new LineBreakBridge({ pages: pages({ departureKeeps: true }), path: '/search' });
  const runtime = new BrowserRuntime({ bridge });
  const { actions } = await runtime.observe({ mode: 'reversible', suppliedText: { query: 'flights to oslo\n' } });
  const fill = actions.find(action => action.type === 'fill_supplied_text' && action.label === 'Name');
  const result = await runtime.act(fill.id);
  assert.equal(result.code, 'line_break_input', result.reason);
  assert.equal(result.status, 'needs_host');
  assert.equal(result.reason, 'A line break cannot be typed into a single-line field');
  assert.equal(result.needs.message, "Newlines can't be typed into a single-line field. Fill without the line break, then use submit_field (or the submit option) to submit.");
  assert.equal(result.steps.length, 0, 'nothing ran');
  const next = directNext(result, { requestId: 'req_1' });
  assert.equal(next.kind, 'observe');
  assert.match(next.text, /^Newlines can't be typed into a single-line field\. Fill without the line break, then use submit_field/);
});
