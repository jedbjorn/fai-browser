// Machinery pass, item 1: the destructive-label gate on links. A short link label (at most 4 words) that leads with a
// destructive or commit verb is an action, never offered in any mode and never a decide option; longer descriptive
// labels and labels that only contain such a word later stay navigation. With the injection guard at or above the
// veto, decide options keep only plain navigation links to approved origins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../src/runtime.js';
import { destructiveLink } from '../src/oversight.js';
import { ORIGIN, link } from './runtime-fixtures.js';

const BLOCKED = [
  'Delete account', 'Delete this filter', 'Remove', 'Place order', 'Place your order', 'Checkout', 'Check out',
  'Proceed to checkout', 'Buy now', 'Pay now', 'Unsubscribe', 'Cancel subscription', 'Cancel my subscription',
  'Sign out', 'Log out', 'Logout', 'Subscribe now', 'Close my account', 'Confirm purchase', 'Send message',
];
const ALLOWED = [
  'Order history', 'Payments', 'Activity log', 'Saved addresses', 'Continue shopping', 'Account deletion policy',
  'How to delete your account safely', 'Delete your account: a step-by-step guide', 'Remove stains from linen fast now',
  'Cancellation terms', 'Subscriptions', 'Home',
];

test('destructiveLink: a leading destructive verb on a short label is blocked; longer descriptive labels pass', () => {
  for (const label of BLOCKED) assert.ok(destructiveLink(label), `should block "${label}"`);
  for (const label of ALLOWED) assert.ok(!destructiveLink(label), `should allow "${label}"`);
});

test('legalActions never offers a destructive link, in read-only or reversible mode, nor as a new-tab navigation', () => {
  const controls = [
    ...BLOCKED.map((label, i) => link(`b${i}`, label, `/b${i}`)),
    ...ALLOWED.map((label, i) => link(`k${i}`, label, `/k${i}`)),
    link('t1', 'Delete account', '/delete', { linkTarget: '_blank' }),
    link('t2', 'Order history', '/orders', { linkTarget: '_blank' }),
  ];
  for (const mode of ['read-only', 'reversible']) {
    const offered = legalActions({ url: `${ORIGIN}/`, controls }, { mode });
    const labels = offered.map(action => action.label);
    for (const label of BLOCKED) assert.ok(!labels.includes(label), `${mode}: offered "${label}"`);
    for (const label of ALLOWED) assert.ok(labels.includes(label), `${mode}: missing "${label}"`);
    assert.ok(offered.some(action => action.type === 'navigate_allowed_url' && action.label === 'Order history'));
    assert.ok(!offered.some(action => action.url?.endsWith('/delete')), `${mode}: new-tab delete link offered`);
  }
});

test('review A: the link gate anchors on a leading verb only', () => {
  for (const label of ['Where to buy', 'How to delete your account safely', 'Buyers guide', 'How to subscribe',
    'Your checkout history', 'Why we pay creators']) {
    assert.ok(!destructiveLink(label), `should allow "${label}"`);
  }
  for (const label of ['Buy now', 'Delete', 'Checkout', 'Place order', 'Remove item', 'Sign in', 'Log in',
    'Go to checkout', 'Subscribe']) {
    assert.ok(destructiveLink(label), `should block "${label}"`);
  }
  const controls = [link('1', 'Where to buy', '/stores'), link('2', 'Buy now', '/buy'), link('3', 'Log in', '/login')];
  const labels = legalActions({ url: `${ORIGIN}/`, controls }, { mode: 'read-only' }).map(action => action.label);
  assert.ok(labels.includes('Where to buy'));
  assert.ok(!labels.includes('Buy now'));
  assert.ok(!labels.includes('Log in'));
});
