// The short re-read after a host act whose expectation did not hold on the settled page (no browser): only an
// expectation that waits for something to show is re-read; a page that leaves the approved origins meanwhile ends as
// cross_origin with nothing offered; a lease error during the re-read surfaces as itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { bridgeError } from '../src/result.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, risk: 'reversible', ...extra });

// A page whose text changes on the Nth read after the click (a toast that clears, a line that shows late).
class LaterBridge extends FakeBridge {
  constructor(options, { after = 2, text } = {}) {
    super(options);
    this.after = after;
    this.laterText = text;
  }

  async execute(action, revision, options) {
    const out = await super.execute(action, revision, options);
    if (action.target === '1') {
      if (this.clickText) this.pages['/'].text = this.clickText;
      this.version++;
      this.reads = 0;
      return { ...out, observation: this.observation };
    }
    return out;
  }

  async observe(signal, options) {
    if (this.reads !== undefined && ++this.reads >= this.after) {
      this.pages['/'].text = this.laterText;
      this.version++;
      this.reads = undefined;
    }
    return super.observe(signal, options);
  }
}

async function clickWith(bridge, expectation) {
  const runtime = new BrowserRuntime({ bridge });
  const seen = await runtime.observe({ mode: 'reversible', allowedOrigins: [ORIGIN] });
  const started = Date.now();
  const result = await runtime.act(seen.actions.find(action => action.label === 'Apply').id, { revision: seen.observation.revision, expectation });
  return { result, ms: Date.now() - started, bridge };
}

const pages = () => ({ '/': { title: 'Settings', text: 'Settings form', controls: [button('1', 'Apply')] } });

test('a positive expectation that shows a moment later passes on the later read, with seenAfterMs', async () => {
  const bridge = new LaterBridge({ pages: pages() }, { after: 2, text: 'Saved' });
  const { result } = await clickWith(bridge, { textIncludes: 'Saved' });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.verification.passed, true);
  assert.ok(Number.isInteger(result.verification.seenAfterMs));
  assert.ok(result.verdict.why.includes('expect:late'));
});

test('textAbsent is never re-read: an error toast that clears itself does not turn a failure into a pass', async () => {
  const bridge = new LaterBridge({ pages: pages() }, { after: 2, text: 'Settings form' });
  bridge.clickText = 'Error: the form could not be saved';
  const { result, ms } = await clickWith(bridge, { textAbsent: 'Error' });
  assert.equal(result.verification.passed, false);
  assert.equal(result.code, 'step_complete');
  assert.equal(result.verification.seenAfterMs, undefined);
  assert.ok(ms < 1000, `no re-read wait (${ms} ms)`);
  // Mixed with a positive field it is not re-read either.
  const mixed = new LaterBridge({ pages: pages() }, { after: 2, text: 'Saved' });
  mixed.clickText = 'Error: retry';
  const both = await clickWith(mixed, { textIncludes: 'Saved', textAbsent: 'Error' });
  assert.equal(both.result.verification.passed, false);
});

test('changedSinceStart is never re-read: a change that comes later does not pass it', async () => {
  // The click itself changes nothing; the page changes on the next read (a late, unrelated update).
  const p = { '/': { title: 'Start', text: 'Start page', controls: [button('1', 'Apply', { lateHref: `${ORIGIN}/` })] } };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: p }) });
  const seen = await runtime.observe({ mode: 'reversible', allowedOrigins: [ORIGIN] });
  const result = await runtime.act(seen.actions.find(action => action.label === 'Apply').id,
    { revision: seen.observation.revision, expectation: { changedSinceStart: true } });
  assert.equal(result.verification.passed, false);
  assert.equal(result.verdict.why.includes('expect:late'), false);
});

test('a page that leaves the approved origins during the re-read is cross_origin with nothing offered', async () => {
  const p = {
    '/': { title: 'Start', text: 'Click continue', controls: [button('1', 'Continue', { lateHref: `${ORIGIN}/sso` })] },
    '/sso': { url: 'https://other.example/login', title: 'Other site', text: 'Other site page', controls: [
      button('1', 'Allow access'), { id: '2', role: 'textbox', label: 'Search', type: 'text', enabled: true },
    ] },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: p }) });
  const seen = await runtime.observe({ mode: 'reversible', allowedOrigins: [ORIGIN] });
  const result = await runtime.act(seen.actions.find(action => action.label === 'Continue').id,
    { revision: seen.observation.revision, expectation: { textIncludes: 'Done' } });
  assert.equal(result.code, 'cross_origin');
  assert.equal(result.offer, undefined, 'nothing of the other site is offered');
});

test('a lease error during the re-read surfaces as itself; a stale read is read again', async () => {
  class Leaving extends FakeBridge {
    async execute(action, revision, options) {
      const out = await super.execute(action, revision, options);
      this.armed = true;
      return out;
    }

    async observe(signal, options) {
      if (this.armed) throw bridgeError('origin_changed', 'Origin changed', false);
      return super.observe(signal, options);
    }
  }
  const p = { '/': { title: 'Start', text: 'Click continue', controls: [button('1', 'Continue')] } };
  const runtime = new BrowserRuntime({ bridge: new Leaving({ pages: p }) });
  const seen = await runtime.observe({ mode: 'reversible', allowedOrigins: [ORIGIN] });
  const result = await runtime.act(seen.actions[0].id, { revision: seen.observation.revision, expectation: { textIncludes: 'Done' } });
  assert.equal(result.code, 'origin_changed');
  assert.equal(result.offer, undefined);

  class Flaky extends LaterBridge {
    async observe(signal, options) {
      if (this.reads === 0 && !this.failed) {
        this.failed = true;
        throw bridgeError('stale', 'Stale observation', true);
      }
      return super.observe(signal, options);
    }
  }
  const flaky = new Flaky({ pages: pages() }, { after: 2, text: 'Saved' });
  const { result: late } = await clickWith(flaky, { textIncludes: 'Saved' });
  assert.equal(late.verification.passed, true, late.reason);
});
