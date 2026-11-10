import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

test('codex: observe snapshots supplied values before act', async () => {
  const bridge = new FakeBridge({ path: '/form' });
  const runtime = new BrowserRuntime({ bridge });
  const suppliedText = { name: 'Approved' };
  const { actions } = await runtime.observe({ mode: 'reversible', suppliedText });
  suppliedText.name = 'Mutated';
  await runtime.act(actions.find(a => a.type === 'fill_supplied_text').id, { capture: 'none' });
  assert.equal(bridge.lastText, 'Approved');
});

test('codex: destructive label heuristic applies only to buttons', () => {
  const observation = { url: ORIGIN, controls: [
    { id: '1', role: 'checkbox', type: 'checkbox', label: 'Save receipts', risk: 'reversible' },
    { id: '2', role: 'radio', type: 'radio', label: 'Pay monthly', risk: 'reversible' },
    { id: '3', role: 'button', label: 'Pay now', risk: 'reversible' },
  ] };
  assert.deepEqual(legalActions(observation, { mode: 'reversible' }).filter(a => a.type === 'click').map(a => a.target), ['1', '2']);
});

