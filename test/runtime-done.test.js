// Doneness: a provider that reports `done` decides when the run is finished; the expectation verifies it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN } from './runtime-fixtures.js';

test('a same-origin link that opens a new tab is offered as navigation in the selected tab', async () => {
  const { legalActions } = await import('../src/runtime.js');
  const observation = {
    revision: 'r', url: `${ORIGIN}/`, title: 'Home', text: '',
    controls: [
      { id: '1', role: 'link', label: 'Account settings', href: `${ORIGIN}/settings`, linkTarget: '_blank' },
      { id: '2', role: 'link', label: 'Elsewhere', href: 'https://other.example/x', linkTarget: '_blank' },
    ],
  };
  const offered = legalActions(observation, { allowedOrigins: [ORIGIN] });
  const open = offered.filter(action => action.type === 'navigate_allowed_url');
  assert.deepEqual(open.map(action => [action.url, action.newTab]), [[`${ORIGIN}/settings`, true]]);
  assert.ok(!offered.some(action => action.type === 'click' && action.target === '1'), 'never a new-tab click');
  const { actionBrief } = await import('../src/result.js');
  assert.equal(actionBrief(open[0]), 'open "Account settings" in this tab');
});
