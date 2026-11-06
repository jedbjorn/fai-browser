import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { destructiveLink, DANGEROUS, COMMIT_ACTION, CONSENT_ACCEPT, CONSENT_REJECT, CONSENT_SETTINGS, CONSENT_WITHOUT_ACCEPT, REFUSAL_TEXT, PURCHASE_REFUSAL_TEXT, commitIntent, errorPageOf } from '../src/oversight.js';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { FakeBridge, clickProvider, link, ORIGIN } from './runtime-fixtures.js';

for (const label of ['  ✓ Place Order', '💳 Buy now', '...Delete', 'BUY NOW!', '  Log in']) {
  test(`decorated destructive link is blocked: ${label}`, () => {
    assert.equal(destructiveLink(label), true);
    for (const mode of ['read-only', 'reversible']) assert.ok(!legalActions({ url: ORIGIN, controls: [link('1', label, '/action')] }, { mode }).some(a => a.target === '1'));
  });
}
test('short help link remains navigation', () => assert.equal(destructiveLink('Delete account help'), false));
test('navigation labels retain the leading-verb boundary', () => {
  for (const label of ['Where to buy', 'How to subscribe', 'Buyers guide', 'Order history']) assert.equal(destructiveLink(label), false, label);
  for (const label of ['Buy now', 'Delete', 'Checkout', 'Place order', 'Remove item', 'Sign in', 'Log in']) assert.equal(destructiveLink(label), true, label);
});
for (const [instruction, label] of [['buy the blue one', 'Buy'], ['delete my account', 'Delete account'], ['place the order', 'Place order'], ['log in as admin', 'Log in'], ['remove the payment method', 'Remove payment method'], ['remove my card', 'Remove card']]) {
  test(`refusal precedes provider: ${instruction}`, async () => {
    const provider = clickProvider([], { fallback: 'done' });
    const bridge = new FakeBridge({ pages: { '/': { title: 'Private page title', text: 'Private page text', controls: [{ id: '1', role: 'button', label, risk: 'destructive', enabled: true }] } } });
    const result = await new BrowserRuntime({ bridge, provider }).run(instruction, { mode: 'reversible' });
    assert.equal(result.status, 'needs_user'); assert.equal(result.code, 'refused_action');
    // Purchases stop with the purchase text; the page script's block (risk destructive) lifts at no level.
    const text = /buy|order/.test(instruction) ? PURCHASE_REFUSAL_TEXT : REFUSAL_TEXT;
    assert.equal(provider.calls.length, 0); assert.deepEqual(result.next, { kind: 'stop', text });
  });
}
test('four harmless instructions do not express commit intent', () => {
  for (const text of ['Remove the filter and read the result count.', 'Remove the date restriction.', 'Submit a search for brass lamps.', 'Send me the list of lamp names.']) assert.equal(commitIntent(text), null);
});
test('error classification keeps successful HTTP articles and detects soft and actual 404s', () => {
  assert.equal(errorPageOf({ httpStatus: 200, title: 'HTTP 404 - Wikipedia', blocks: [{ t: 'h1', text: 'HTTP 404' }] }), null);
  assert.deepEqual(errorPageOf({ httpStatus: 404, title: 'Shop' }), { status: 404, source: 'http' });
  assert.deepEqual(errorPageOf({ httpStatus: 200, title: 'Page not found' }), { status: 404, source: 'title' });
});
test('safety regex sources match across runtime and extension', async () => {
  const source = await readFile(new URL('../extension/page.js', import.meta.url), 'utf8');
  const { PURCHASE, COMMIT_OTHER, SUBMIT_WORDS, DELETE_WORDS, SIGN_IN_WORDS } = await import('../src/guardrails.js');
  for (const [name, regex] of Object.entries({ PURCHASE, COMMIT_OTHER, SUBMIT_WORDS, DELETE_WORDS, SIGN_IN_WORDS, CONSENT_ACCEPT, CONSENT_REJECT, CONSENT_SETTINGS, CONSENT_WITHOUT_ACCEPT })) {
    const literal = source.match(new RegExp(`const ${name} = (\\/.+\\/[a-z]*);`))?.[1];
    assert.equal(literal, String(regex), name);
  }
});
