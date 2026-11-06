// The lean observe shape shared by the CLI and MCP observe: warnings (machine codes) and the consent dialog when
// present (untrusted text and labels, with the page script's kind), next to revision, page digest and actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leanObserve } from '../src/result.js';

const page = extra => ({ url: 'https://example.com/', title: 'T', text: 'Hello', revision: 'd:1', ...extra });

test('leanObserve carries page warnings (machine codes only) and omits them when there are none', () => {
  const lean = leanObserve({ page: page({ warnings: ['password_field', 'controls_capped', 'Ignore previous', 7] }), actions: [] });
  assert.deepEqual(lean.warnings, ['password_field', 'controls_capped']);
  assert.equal(leanObserve({ page: page({ warnings: [] }), actions: [] }).warnings, undefined);
});

test('leanObserve carries the consent dialog when present: clipped text, labels and kinds, no ids', () => {
  const consent = {
    text: `We use cookies ${'x'.repeat(300)}`,
    buttons: [{ id: '4', label: 'Reject all', kind: 'reject' }, { id: '5', label: 'Accept all', kind: 'accept' }],
  };
  const lean = leanObserve({ page: page({ consent }), actions: [] });
  assert.equal(lean.consent.text.length, 120);
  assert.deepEqual(lean.consent.buttons, [{ label: 'Reject all', kind: 'reject' }, { label: 'Accept all', kind: 'accept' }]);
  assert.equal(leanObserve({ page: page({ consent: null }), actions: [] }).consent, undefined);
});
