// A fill the field did not keep (a date picker's textbox that reverts or ignores typed text: the live Google Flights
// run of 2026-10-08 reported the Departure fill done while the field stayed empty). The page script reads the field
// back after the page settled (`fill: {kept, empty}`); the runtime ends the run or act as fill_not_kept, never counts
// the step as progress, names the field in next.text and marks the lean step. Fixture observations only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, directNext } from '../src/result.js';
import { BridgeError } from '../src/bridge.js';
import { FakeBridge } from './runtime-fixtures.js';

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
