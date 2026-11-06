// bench/qa/sim-jev.mjs: the simulated Jev the QA runner's --sim-jev mode uses. It must speak the request format the
// real provider adapter sends, be deterministic per request, and react to option order (so second opinions differ).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { LocalSystemOneProvider } from '../src/typesafe.js';
import { simulateDecide, startSimJev } from '../bench/qa/sim-jev.mjs';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const body = ids => ({
  state: { instruction: 'Open Members and read the names', page: { url: `${ORIGIN}/about`, title: 'About', text: 'About us' } },
  questions: {
    action: { type: 'choice', criteria: Object.fromEntries(ids.map(id => [id, id === 'handoff' ? 'x' : `Click link: ${id}`])) },
    done: { type: 'noul' },
  },
});

test('sim-jev: deterministic per request, probabilities sum to one, option order changes the noise', () => {
  const a = simulateDecide(body(['Members', 'Home', 'handoff']));
  assert.deepEqual(simulateDecide(body(['Members', 'Home', 'handoff'])), a);
  const sum = Object.values(a.action.probabilities).reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(sum - 1) < 0.01);
  assert.equal(a.action.choice, 'Members');
  assert.ok(a.done.noul < 0.5, 'Members is not visited yet');
  const reversed = simulateDecide(body(['Home', 'Members', 'handoff']));
  assert.notDeepEqual(reversed.action.probabilities, a.action.probabilities);
});

test('sim-jev: the real local provider adapter completes a fixture run against it', async () => {
  const sim = await startSimJev({ latencyMs: 0 });
  try {
    const runtime = new BrowserRuntime({ provider: new LocalSystemOneProvider({ port: sim.port }), bridge: new FakeBridge() });
    const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' }, retry: false });
    assert.equal(result.status, 'completed');
    assert.ok(sim.stats.decide >= 1 && sim.stats.errors === 0);
  } finally {
    await sim.close();
  }
});
