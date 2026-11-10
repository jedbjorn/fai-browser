// Guardrail pass: the policy object (src/guardrails.js). Additions are validated (plain phrases, caps, no regex
// metacharacters), compiled escaped and word-bounded, can only add to the core rules, and render a byte-stable
// state.policy; the commit guard question is asked only in reversible mode when a button, select or fill is offered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMIT_ACTION, COMMIT_OTHER, CORE_RULES, DANGEROUS, GUARDRAIL_LIMITS, PURCHASE, commitCandidate, forbidPattern,
  guardrailPolicy, mergeAdditions, normalizeAdditions,
} from '../src/guardrails.js';
import * as oversight from '../src/oversight.js';
import * as guardrails from '../src/guardrails.js';

const button = (id, target, label) => ({ id, type: 'click', target, role: 'button', label, description: `Click button ${target}: ${label}` });
const link = (id, target, label) => ({ id, type: 'click', target, role: 'link', label, description: `Click link ${target}: ${label}` });
const handoff = { id: 'handoff', type: 'handoff', label: 'handoff', description: 'Stop.' };

test('core: the exact regexes moved here and oversight.js re-exports the same objects', () => {
  assert.equal(oversight.COMMIT_ACTION, COMMIT_ACTION);
  assert.equal(oversight.DANGEROUS, DANGEROUS);
  assert.equal(String(DANGEROUS), String.raw`/\b(save(?!\s+(?:up\s+to\s+|over\s+|an\s+extra\s+|extra\s+)?(?:[$€£¥₹]\s?\d|\d[\d.,]*\s?(?:%|percent\b|[$€£¥₹]|(?:usd|eur|gbp)\b)))|submit|send|purchase|buy|pay|delete|remove|confirm|invite|publish|sign ?in|log ?in)\b/i`);
  assert.deepEqual(CORE_RULES.map(rule => rule.id), ['sign_in', 'purchase', 'commit', 'delete', 'send', 'browser_internal', 'consent']);
  assert.deepEqual(CORE_RULES.map(rule => rule.lifted), ['testing', 'testing', 'full', 'full', 'full', null, 'full']);
  assert.ok(Object.isFrozen(CORE_RULES) && CORE_RULES.every(Object.isFrozen));
  // interactive is a real level now: the deferred flag is gone.
  assert.equal(guardrails.INTERACTIVE_MODE, undefined);
  // COMMIT_ACTION is the composed compatibility pattern: PURCHASE or COMMIT_OTHER.
  assert.equal(COMMIT_ACTION.source, `${PURCHASE.source}|${COMMIT_OTHER.source}`);
});

test('normalizeAdditions: arrays and {forbid, note}, whitespace collapsed, duplicates dropped, order kept', () => {
  assert.deepEqual(normalizeAdditions(undefined), { forbid: [], note: '' });
  assert.deepEqual(normalizeAdditions(null), { forbid: [], note: '' });
  assert.deepEqual(normalizeAdditions(['  Gift   wrap ', 'Upgrade', 'gift wrap', "Add-ons & extras", 'Save 20%']),
    { forbid: ['Gift wrap', 'Upgrade', 'Add-ons & extras', 'Save 20%'], note: '' });
  assert.deepEqual(normalizeAdditions({ forbid: ['Ändern'], note: '  No plan changes. ' }), { forbid: ['Ändern'], note: 'No plan changes.' });
  assert.deepEqual(normalizeAdditions({ note: 'Read only, please' }), { forbid: [], note: 'Read only, please' });
});

test('normalizeAdditions rejects metacharacters, oversize input, wrong types and unknown keys before any use', () => {
  const bad = [
    [['Pay.*'], /regex metacharacters/],
    [['(Buy)'], /regex metacharacters/],
    [['a|b'], /regex metacharacters/],
    [['x'.repeat(GUARDRAIL_LIMITS.maxPhraseLength + 1)], /at most 60 characters/],
    [Array.from({ length: GUARDRAIL_LIMITS.maxForbid + 1 }, (_, i) => `Label ${i}`), /at most 20 phrases/],
    [[''], /must not be blank/],
    [['  '], /must not be blank/],
    [[42], /must be a string/],
    [['<script>'], /may contain only/],
    [['"quoted"'], /may contain only/],
    [{ forbid: 'Upgrade' }, /forbid must be an array/],
    [{ allow: ['Place order'] }, /unknown key "allow"/],
    [{ forbid: [], note: 'x'.repeat(201) }, /note must be at most 200/],
    [{ note: 'line\nbreak\u0007' }, /control, format or invisible characters/],
    ['Upgrade', /array of strings or an object/],
    [7, /array of strings or an object/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => normalizeAdditions(input, 'policy'), error => error instanceof TypeError && message.test(error.message)
      && error.message.startsWith('policy:'), JSON.stringify(input));
  }
  assert.throws(() => normalizeAdditions(['a.b'], 'config.json guardrails'), /^TypeError: config\.json guardrails:/);
});

test('forbidPattern: escaped, word-bounded (Unicode), case-insensitive, whitespace-tolerant; null without phrases', () => {
  assert.equal(forbidPattern([]), null);
  assert.equal(forbidPattern(undefined), null);
  const pattern = forbidPattern(['Upgrade', 'Gift wrap', 'Ändern', 'Add-ons']);
  for (const label of ['Upgrade', 'upgrade now', 'Upgrade →', 'Gift wrap', 'Add gift  wrap', 'ÄNDERN', 'Add-ons', 'Buy add-ons'])
    assert.ok(pattern.test(label), label);
  for (const label of ['Upgrades', 'Downgrade', 'Gift wrapping', 'Veränderung', 'Ändernd', 'Add-onsite'])
    assert.ok(!pattern.test(label), label);
  // A phrase that slipped past validation still cannot inject regex syntax.
  const raw = forbidPattern(['a.b', 'x+']);
  assert.ok(raw.test('a.b') && !raw.test('axb') && raw.test('x+') && !raw.test('xx'));
});

test('mergeAdditions: union (config first), notes joined; restrict-only', () => {
  const merged = mergeAdditions({ forbid: ['Upgrade', 'Gift wrap'], note: 'Config note.' }, { forbid: ['gift wrap', 'Donate'], note: 'Request note.' });
  assert.deepEqual(merged, { forbid: ['Upgrade', 'Gift wrap', 'Donate'], note: 'Config note. Request note.' });
  assert.deepEqual(mergeAdditions(undefined, { forbid: [], note: '' }), { forbid: [], note: '' });
});

test('guardrailPolicy: core first, additions for every label, wire() strings only, additions never relax core', () => {
  const policy = guardrailPolicy({ mode: 'reversible', request: ['Gift wrap'], config: { forbid: ['Upgrade plan options'], note: 'n' } });
  assert.equal(policy.matches('Place order'), 'purchase');
  assert.equal(policy.matches('Delete workspace'), 'delete');
  assert.equal(policy.matches('Save'), 'submit');
  assert.equal(policy.matches('Sign in'), 'sign_in');
  assert.equal(policy.matches('Add gift wrap'), 'forbid');
  assert.equal(policy.matches('Upgrade plan options'), 'purchase', 'purchase outranks the addition');
  assert.deepEqual(policy.classes('Upgrade plan options'), ['purchase', 'forbid']);
  assert.equal(policy.matches('Continue'), null);
  assert.deepEqual(policy.wire(), { forbid: ['Upgrade plan options', 'Gift wrap'], level: 'reversible' });
  assert.ok(policy.wire().forbid.every(item => typeof item === 'string'));
  assert.deepEqual(guardrailPolicy().wire(), { level: 'read-only' }, 'no additions: only the level on the wire');
  // Nothing in the request can remove a core rule: an empty list, a duplicate of a core label, or an "allow" key.
  for (const request of [[], ['Place order'], { forbid: [] }]) {
    const p = guardrailPolicy({ mode: 'reversible', request });
    assert.equal(p.matches('Place order'), 'purchase');
    assert.equal(p.matches('Sign in'), 'sign_in');
    assert.equal(p.blocks('Place order'), 'purchase');
  }
  assert.throws(() => guardrailPolicy({ request: { allow: ['Place order'] } }), /unknown key "allow"/);
  assert.throws(() => guardrailPolicy({ config: ['Pay.*'] }), /config\.json guardrails/);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.additions.forbid));
});

test('commitCandidate: buttons, selects and fills; not links, page actions or consent buttons', () => {
  assert.equal(commitCandidate(button('a0', '1', 'Yes')), true);
  assert.equal(commitCandidate({ id: 'a1', type: 'select', target: '2', role: 'combobox', value: 'x' }), true);
  assert.equal(commitCandidate({ id: 'a2', type: 'fill_supplied_text', target: '3', role: 'textbox' }), true);
  assert.equal(commitCandidate(link('a3', '4', 'Next')), false);
  assert.equal(commitCandidate({ id: 'a4', type: 'scroll', direction: 'down' }), false);
  assert.equal(commitCandidate({ id: 'a5', type: 'navigate_allowed_url', url: 'https://x.test/' }), false);
  assert.equal(commitCandidate({ ...button('c0', '9', 'Reject'), consent: true }), false);
  assert.equal(commitCandidate(handoff), false);
});

