import test from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../src/runtime.js';
import { evaluateExpectation, validateExpectation, verifyExpectation } from '../src/expectation.js';
import { ORIGIN, link } from './runtime-fixtures.js';

const page = (controls = []) => ({ revision: 'r1', url: `${ORIGIN}/`, title: 'Home', text: 'Home', controls });
const clicks = actions => actions.filter(action => action.type === 'click').map(action => action.target);

test('read-only offers only approved same-origin links', () => {
  const actions = legalActions(page([
    link('1', 'About', '/about'),
    { id: '2', role: 'button', label: 'Archive' },
    link('3', 'Elsewhere', 'https://elsewhere.com/'),
    link('4', 'Partner', 'https://partner.example.com/'),
  ]), { mode: 'read-only', allowedOrigins: [ORIGIN, 'https://partner.example.com'] });
  // The partner origin is approved but is not the lease origin; the extension would refuse the click.
  assert.deepEqual(clicks(actions), ['1']);
});

test('reversible offers link clicks only to the lease origin', () => {
  const actions = legalActions(page([
    link('1', 'About', '/about'),
    link('2', 'Partner', 'https://partner.example.com/'),
    { id: '3', role: 'button', label: 'Expand' },
  ]), { mode: 'reversible', allowedOrigins: [ORIGIN, 'https://partner.example.com'] });
  assert.deepEqual(clicks(actions), ['1', '3']);
});

test('checkbox and radio controls are offered as clicks in reversible mode only', () => {
  const controls = [
    { id: '1', role: 'checkbox', label: 'Subscribe', type: 'checkbox', checked: true },
    { id: '2', role: 'radio', label: 'Monthly', type: 'radio', checked: false },
    // A mislabelled checkbox (old page script reported role textbox) is still treated as a toggle.
    { id: '3', role: 'textbox', label: 'Agree', type: 'checkbox' },
  ];
  const reversible = legalActions(page(controls), { mode: 'reversible', suppliedText: { name: 'x' } });
  assert.deepEqual(clicks(reversible), ['1', '2', '3']);
  assert.equal(reversible.find(a => a.target === '1').checked, true);
  assert.match(reversible.find(a => a.target === '2').description, /unchecked/);
  assert.equal(reversible.some(a => a.type === 'fill_supplied_text'), false);
  assert.deepEqual(clicks(legalActions(page(controls), { mode: 'read-only' })), []);
});

test('reserved page actions survive the cap on busy pages', () => {
  const controls = Array.from({ length: 100 }, (_, i) => ({
    id: String(i + 1),
    role: 'combobox',
    label: `Choice ${i}`,
    options: Array.from({ length: 5 }, (__, j) => ({ value: `v${j}`, label: `Option ${j}` })),
  }));
  const actions = legalActions(page(controls), { mode: 'reversible', allowedUrls: [`${ORIGIN}/help`] });
  const types = actions.map(action => action.type);
  assert.equal(actions.length, 252);
  for (const type of ['scroll', 'wait', 'navigate_allowed_url', 'done', 'handoff']) assert.ok(types.includes(type), type);
  assert.deepEqual(actions.slice(-2).map(action => action.id), ['done', 'handoff']);
  assert.equal(new Set(actions.map(action => action.id)).size, actions.length);
});

test('navigation is offered only to approved lease-origin URLs', () => {
  const actions = legalActions(page(), {
    allowedOrigins: [ORIGIN, 'https://partner.example.com'],
    allowedUrls: [`${ORIGIN}/help`, 'https://partner.example.com/x', 'https://evil.com/'],
  });
  assert.deepEqual(actions.filter(a => a.type === 'navigate_allowed_url').map(a => a.url), [`${ORIGIN}/help`]);
});

test('danger heuristic uses word boundaries; links pass unless a short label leads with a destructive verb', () => {
  const actions = legalActions(page([
    link('1', 'Payments', '/payments'),
    link('2', 'Delete account help', '/help'),
    { id: '3', role: 'button', label: 'Pay now' },
    { id: '4', role: 'button', label: 'Savings' },
    { id: '5', role: 'button', label: 'Resend history' },
    { id: '6', role: 'button', label: 'Delete' },
    link('7', 'Remove', '/remove', { risk: 'destructive' }),
    { id: '8', role: 'button', label: 'Go', type: 'submit' },
    link('9', 'How to delete your account safely', '/help/delete'),
  ]), { mode: 'reversible' });
  // Account deletion help and longer descriptive labels stay navigation.
  assert.deepEqual(clicks(actions), ['1', '2', '4', '5', '9']);
});

test('supplied text is referenced by name; values never appear in actions; password excluded', () => {
  const actions = legalActions(page([
    { id: '1', role: 'textbox', label: 'Name', type: 'text' },
    { id: '2', role: 'textbox', label: 'Password', type: 'password' },
    { id: '3', role: 'combobox', label: 'City', type: 'text' },
  ]), { mode: 'reversible', suppliedText: { name: 'Alex-Secret' } });
  const fills = actions.filter(action => action.type === 'fill_supplied_text');
  assert.deepEqual(fills.map(action => [action.target, action.suppliedName]), [['1', 'name'], ['3', 'name']]);
  assert.ok(!JSON.stringify(actions).includes('Alex-Secret'));
  assert.match(fills[0].description, /supplied value name$/);
});

test('select options are offered in reversible mode, skipping the current value', () => {
  const actions = legalActions(page([{
    id: '1', role: 'combobox', label: 'Plan', selectedValue: 'free',
    options: [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }],
  }]), { mode: 'reversible' });
  assert.deepEqual(actions.filter(a => a.type === 'select').map(a => a.value), ['pro']);
});

test('validateExpectation rejects invalid shapes', () => {
  for (const bad of [{}, { textIncludes: '' }, { unsupported: 'x' }, { urlMatches: '[' }, [], 'x', 3, { urlEquals: 5 }]) {
    assert.throws(() => validateExpectation(bad), TypeError, JSON.stringify(bad));
  }
  for (const good of [undefined, null, () => true, { textAbsent: 'Error' }]) validateExpectation(good);
});

test('declarative expectations: case-insensitive text, textAbsent, urlMatches, titleIncludes', async () => {
  const observation = { url: 'https://example.com/team/42', title: 'Team Members', text: 'Ada, Grace' };
  const pass = [
    { textIncludes: 'ADA' },
    { textAbsent: 'error' },
    { urlMatches: '/team/\\d+$' },
    { titleIncludes: 'members' },
    { titleEquals: 'Team Members', urlIncludes: '/team' },
  ];
  const fail = [
    { textIncludes: 'Linus' },
    { textAbsent: 'grace' },
    { urlMatches: '^http:' },
    { titleEquals: 'team members' },
  ];
  for (const expectation of pass) {
    assert.equal(await evaluateExpectation(observation, expectation), true, JSON.stringify(expectation));
  }
  for (const expectation of fail) {
    assert.equal(await evaluateExpectation(observation, expectation), false, JSON.stringify(expectation));
  }
});

test('textIncludes also passes on textFound (the rendered page text past the viewport); textAbsent reads the viewport',
  async () => {
    const observation = { url: 'https://example.com/', title: 'Flights', text: 'View more flights',
      textFound: ['departing 2026-10-12'] };
    assert.equal(await evaluateExpectation(observation, { textIncludes: 'Departing 2026-10-12' }), true);
    assert.equal(await evaluateExpectation(observation, { textIncludes: 'returning' }), false);
    assert.equal(await evaluateExpectation(observation, { textAbsent: 'departing 2026-10-12' }), true);
    // A malformed textFound never passes anything.
    assert.equal(await evaluateExpectation({ ...observation, textFound: 'departing 2026-10-12' },
      { textIncludes: 'departing 2026-10-12' }), false);
  });

test('expectations guard missing text and verifyExpectation never throws', async () => {
  const observation = { url: 'https://example.com/', title: 'Home' };
  assert.equal(await evaluateExpectation(observation, { textAbsent: 'Error' }), true);
  assert.equal(await evaluateExpectation(observation, { textIncludes: 'Home' }), false);
  assert.equal(verifyExpectation(observation, { unsupported: 'x' }), false);
  assert.equal(verifyExpectation(observation, {}), false);
  assert.equal(verifyExpectation(observation, { titleEquals: 'Home' }), true);
});
