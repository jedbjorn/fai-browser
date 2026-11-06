// Per-request provider usage: cost.requests on the in-memory result (non-enumerable), in the trace, and in the QA
// bench aggregation. Numbers and fixed codes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { writeRun } from '../src/trace.js';
import { requestBreakdown, requestsFromTrace } from '../bench/qa/lib.mjs';
import { FakeBridge, link } from './runtime-fixtures.js';

const PAGES = {
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
  '/about': {
    title: 'About',
    text: 'About\nMembers\nAda Lovelace\nGrace Hopper\nLinus Torvalds\nFormer members are in the changelog.',
    controls: [link('1', 'Home', '/')],
    blocks: [
      { t: 'a', text: 'Home', ref: '1' },
      { t: 'h1', text: 'About' },
      { t: 'h2', text: 'Members' },
      { t: 'li', text: 'Ada Lovelace' },
      { t: 'li', text: 'Grace Hopper' },
      { t: 'li', text: 'Linus Torvalds' },
      { t: 'p', text: 'Former members are in the changelog.' },
    ],
  },
};

/** Done-aware provider: clicks About, reports done 0.9 on /about, usage and latency on every reply. */
function usageProvider({ choose = true } = {}) {
  let n = 0;
  const provider = {
    model: 'fake-usage',
    async decide(observation, actions) {
      n++;
      const onAbout = new URL(observation.url).pathname === '/about';
      const about = actions.find(a => a.type === 'click' && a.label === 'About');
      return {
        actionId: onAbout ? 'handoff' : about.id,
        confidence: 0.9,
        done: { probability: onAbout ? 0.9 : 0.05 },
        usage: { input_tokens: 100 * n, output_tokens: 10 * n },
        latencyMs: 7,
        model: 'fake-usage',
      };
    },
  };
  if (choose) {
    provider.choose = async ({ candidates }) => ({
      choice: candidates.find(candidate => candidate.text === 'Grace Hopper').id,
      confidence: 0.9,
      usage: { input_tokens: 40, output_tokens: 2 },
      latencyMs: 5,
    });
  }
  return provider;
}

const RUN = ['Open About and find a member', { answerQuestion: 'Who is a member?', expectation: { urlIncludes: '/about' },
  capture: 'none' }];

test('cost.requests records every provider request: executed decide, terminal decide and choose', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES }), provider: usageProvider() });
  const result = await runtime.run(...RUN);
  assert.equal(result.status, 'completed');
  // Entries are recorded as requests finish; the answer ranking runs next to the final decide.
  const order = { decide: 0, choose: 1 };
  const requests = [...result.cost.requests].sort((a, b) => (a.step ?? 9) - (b.step ?? 9) || order[a.kind] - order[b.kind]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(entry => [entry.kind, entry.step]), [['decide', 1], ['decide', undefined], ['choose', undefined]]);
  assert.deepEqual(requests.map(entry => [entry.inputTokens, entry.outputTokens]), [[100, 10], [200, 20], [40, 2]]);
  assert.deepEqual(requests.map(entry => entry.providerMs), [7, 7, 5]);
  for (const entry of requests) {
    assert.ok(Number.isFinite(entry.ms) && entry.ms >= 0);
    assert.equal(entry.error, undefined);
    for (const value of Object.values(entry)) assert.ok(['number', 'string'].includes(typeof value), 'numbers and codes only');
  }
  // The per-request numbers add up to the run totals.
  assert.equal(result.cost.inputTokens, requests.reduce((sum, entry) => sum + entry.inputTokens, 0));
  assert.equal(result.cost.outputTokens, requests.reduce((sum, entry) => sum + entry.outputTokens, 0));
  assert.equal(result.cost.decisions, requests.filter(entry => entry.kind === 'decide').length);
});

test('cost.requests stays out of serialized and agent results and goes to the trace', async () => {
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES }), provider: usageProvider() });
  const result = await runtime.run(...RUN);
  assert.equal(JSON.parse(JSON.stringify(result)).cost.requests, undefined);
  assert.deepEqual(Object.keys(agentResult(result).cost), ['decisions', 'inputTokens', 'outputTokens', 'elapsedMs']);

  const dir = await mkdtemp(join(tmpdir(), 'fai-requests-'));
  try {
    const written = await writeRun(result, { dir, instruction: RUN[0], options: RUN[1] });
    const trace = JSON.parse(await readFile(written.trace, 'utf8'));
    assert.deepEqual(trace.cost.requests, JSON.parse(JSON.stringify(result.cost.requests)));
    assert.equal(trace.cost.inputTokens, result.cost.inputTokens);
    assert.deepEqual(Object.keys(written.result.cost), ['decisions', 'inputTokens', 'outputTokens', 'elapsedMs']);

    // The QA bench reads it per kind.
    const rows = requestsFromTrace(trace);
    assert.deepEqual(rows.map(row => row.kind).sort(), ['choose', 'decide_executed', 'decide_terminal']);
    const breakdown = requestBreakdown([{ requests: rows }, { requests: rows }]);
    assert.equal(breakdown.choose.requests, 2);
    assert.equal(breakdown.decide_terminal.meanInputTokens, 200);
    assert.equal(breakdown.decide_executed.meanOutputTokens, 10);
    assert.equal(requestsFromTrace({ cost: { decisions: 1 } }), null, 'older traces have no per-request data');
    assert.equal(requestBreakdown([{ requests: null }]), null);
    // Failed decides are their own kind; failed and discarded requests stay out of the latency percentiles.
    const mixed = requestsFromTrace({ cost: { requests: [
      { kind: 'decide', ms: 9000, error: 'provider_error' },
      { kind: 'choose', ms: 250 },
      { kind: 'choose', ms: 5, discarded: true },
      { kind: 'choose', ms: 3000, error: 'timeout' },
    ] } });
    assert.equal(mixed[0].kind, 'decide_failed');
    const split = requestBreakdown([{ requests: mixed }]);
    assert.equal(split.decide_terminal, undefined);
    assert.deepEqual([split.choose.requests, split.choose.errors, split.choose.discarded, split.choose.p50Ms, split.choose.p90Ms],
      [3, 1, 1, 250, 250]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed decide and a failed choose are recorded with a fixed error code and no usage', async () => {
  const failing = new BrowserRuntime({
    bridge: new FakeBridge({ pages: PAGES }),
    provider: { async decide() { throw new Error('upstream said: secret page text'); } },
  });
  const failed = await failing.run(...RUN);
  assert.equal(failed.code, 'provider_error');
  assert.equal(failed.cost.requests.length, 1);
  assert.equal(failed.cost.requests[0].kind, 'decide');
  assert.equal(failed.cost.requests[0].error, 'provider_error');
  assert.equal(failed.cost.requests[0].inputTokens, undefined);
  assert.ok(!JSON.stringify(failed.cost.requests).includes('secret'), 'no error text');

  const provider = usageProvider();
  provider.choose = async () => {
    throw new Error('choose unavailable');
  };
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES }), provider }).run(...RUN);
  assert.equal(result.status, 'completed');
  const choose = result.cost.requests.find(entry => entry.kind === 'choose');
  assert.equal(choose.error, 'provider_error');
  assert.equal(result.answer.method, 'heuristic');
});

test('without choose() only decide requests are recorded; act() purchase guard requests are kind guard', async () => {
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES }), provider: usageProvider({ choose: false }) })
    .run(...RUN);
  assert.deepEqual(result.cost.requests.map(entry => entry.kind), ['decide', 'decide']);

  const bridge = new FakeBridge({ pages: { '/': { title: 'Checkout', text: 'Continue charges your saved card $49.',
    controls: [{ id: '1', role: 'button', label: 'Continue', enabled: true, risk: 'reversible' }] } } });
  const runtime = new BrowserRuntime({ bridge, provider: { async decide() {
    return { actionId: 'handoff', guards: { purchase_control: 0.1, purchase_page: 0.1 }, usage: { input_tokens: 9, output_tokens: 1 } };
  } } });
  const grant = { mode: 'full', grant: { level: 'full' }, capture: 'none' };
  const offer = await runtime.observe(grant);
  const acted = await runtime.act(offer.actions.find(a => a.target === '1').id, { revision: offer.observation.revision });
  assert.equal(acted.code, 'step_complete');
  assert.deepEqual(acted.cost.requests.map(entry => [entry.kind, entry.step, entry.inputTokens]), [['guard', undefined, 9]]);
});
