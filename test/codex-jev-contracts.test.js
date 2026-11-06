import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { legalActions } from '../src/runtime.js';
import { leanObserve } from '../src/result.js';
import { decideBody, TypeSafeProvider } from '../src/typesafe.js';

test('codex Jev: 100 controls and 6000 page characters stay within provider field limits', () => {
  const observation = { url: 'https://example.com/', title: 'Home', text: 'x'.repeat(6000),
    controls: Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: 'button',
      label: 'Apply filters ' + 'z'.repeat(180), risk: 'reversible' })) };
  const offered = legalActions(observation, { mode: 'reversible' }).filter(a => a.type !== 'done');
  const body = decideBody({ observation, offered, context: { instruction: 'Read home' } });
  assert.equal(body.state.page.controls.length, 60);
  assert.equal(body.state.page.text.length, 6000);
  assert.ok(body.state.page.controls.every(control => control.label.length <= 120));
  assert.equal(Object.keys(body.questions.action.criteria).at(-1), 'handoff');
  assert.equal(body.questions.done.type, 'noul');
  assert.ok(!JSON.stringify(body.state.policy).includes('x'.repeat(30)));
  assert.ok(!JSON.stringify(body.questions.action.criteria).includes('x'.repeat(30)));
});

test('codex Jev: TypeSafe rejects an unoffered response id even with done and guards', async () => {
  const provider = new TypeSafeProvider({ requireKey: false, keyEnv: 'FAI_UNUSED_TEST_KEY',
    fetchImpl: async () => new Response(JSON.stringify({ answers: {
      action: { choice: 'invented' }, done: { noul: 0.99 }, blocked: { noul: 0.99 },
    } })) });
  await assert.rejects(provider.decide({}, [{ id: 'handoff', type: 'handoff' }]), /Invalid decision/);
});

test('codex Jev: emitted lean observation warnings and consent are declared', async () => {
  const emitted = leanObserve({ revision: 'doc:1', page: { url: 'https://example.com/', title: 'Home',
    warnings: ['controls_capped'], consent: { text: 'Cookies', buttons: [{ label: 'Reject', kind: 'reject' }] } },
    actions: [] });
  const declarations = await readFile(new URL('../src/index.d.ts', import.meta.url), 'utf8');
  const leanInterface = declarations.split('export interface LeanObserveResult {')[1].split('\n}')[0];
  for (const field of ['warnings', 'consent']) {
    assert.ok(Object.hasOwn(emitted, field));
    assert.match(leanInterface, new RegExp(`\\b${field}\\??:`), `missing emitted field ${field}`);
  }
});
