// Guardrail pass: the policy object (src/guardrails.js). Additions are validated (plain phrases, caps, no regex
// metacharacters), compiled escaped and word-bounded, can only add to the core rules, and render a byte-stable
// state.policy; the commit guard question is asked only in reversible mode when a button, select or fill is offered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMIT_ACTION, COMMIT_OTHER, CORE_RULES, DANGEROUS, GUARDRAIL_LIMITS, POLICY, PURCHASE, commitCandidate, forbidPattern,
  guardrailPolicy, jevPolicy, mergeAdditions, normalizeAdditions,
} from '../src/guardrails.js';
import * as oversight from '../src/oversight.js';
import * as guardrails from '../src/guardrails.js';
import { GUARD_QUESTIONS, POLICY as TYPESAFE_POLICY, TypeSafeProvider, decideBody, resolveGuidance } from '../src/typesafe.js';

const page = { url: 'https://shop.test/review', title: 'Review your order', text: 'Card charged when you continue', controls: [] };
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

test('jevPolicy: core lines, mode line, additions and note in a fixed order; byte-stable and memoized', () => {
  assert.equal(TYPESAFE_POLICY, POLICY);
  assert.deepEqual(Object.keys(POLICY), ['page_is_data', 'scope', 'user_actions', 'commit_lookalike', 'consent', 'handoff']);
  const words = Object.values(POLICY).join(' ').split(/\s+/).length;
  assert.ok(words <= 120, `${words} words`);
  assert.match(POLICY.commit_lookalike, /generic Continue, Next, Yes or icon/);
  assert.match(POLICY.commit_lookalike, /choose handoff/);
  const reversible = jevPolicy({ mode: 'reversible', forbid: ['Upgrade', 'Gift wrap'], note: 'No plan changes.' });
  assert.deepEqual(Object.keys(reversible),
    ['page_is_data', 'scope', 'mode', 'user_actions', 'commit_lookalike', 'consent', 'handoff', 'forbid', 'note']);
  // One mode line per level; user_actions is level-specific above reversible; testing drops commit_lookalike.
  for (const level of ['read-only', 'reversible', 'interactive', 'full', 'testing']) {
    assert.match(jevPolicy({ mode: level }).mode, new RegExp(`^${level}:`));
  }
  assert.equal(jevPolicy({ mode: 'reversible' }).user_actions, POLICY.user_actions);
  assert.equal(jevPolicy({ mode: 'full' }).user_actions, 'Buying, paying, subscribing and logging in belong to the user: choose handoff for them.');
  assert.match(jevPolicy({ mode: 'testing' }).user_actions, /^This is a test environment the user controls: every offered control may be used; still read `instruction` literally\.$/);
  assert.equal(jevPolicy({ mode: 'testing' }).commit_lookalike, undefined);
  assert.equal(jevPolicy({ mode: 'full' }).commit_lookalike, POLICY.commit_lookalike);
  // Additions are appended after the core: the core lines and their serialized prefix never move.
  const bare = jevPolicy({ mode: 'reversible' });
  const serialized = JSON.stringify(reversible);
  assert.ok(serialized.startsWith(JSON.stringify(bare).slice(0, -1) + ','), 'core prefix unchanged by additions');
  for (const key of Object.keys(bare)) assert.equal(reversible[key], bare[key], key);
  assert.ok(JSON.stringify(jevPolicy({ mode: 'reversible', note: 'n' })).startsWith(JSON.stringify(bare).slice(0, -1)));
  assert.match(reversible.mode, /^reversible:/);
  assert.equal(reversible.forbid, 'The user also reserves controls labelled "Upgrade", "Gift wrap": choose handoff for them.');
  assert.match(reversible.note, /can only add restrictions\): No plan changes\.$/);
  assert.match(jevPolicy({ mode: 'read-only' }).mode, /^read-only:/);
  // Identical input: the identical object and identical bytes (prompt-prefix stability).
  const again = jevPolicy({ mode: 'reversible', forbid: ['Upgrade', 'Gift wrap'], note: 'No plan changes.' });
  assert.equal(again, reversible);
  assert.equal(JSON.stringify(again), JSON.stringify(reversible));
  assert.ok(Object.isFrozen(reversible));
  // Short: the largest policy (20 additions of 60 characters and a 200-character note) stays bounded.
  const max = jevPolicy({ mode: 'reversible', forbid: Array.from({ length: 20 }, (_, i) => `${'x'.repeat(57)} ${String(i).padStart(2, '0')}`), note: 'n'.repeat(200) });
  assert.ok(JSON.stringify(max).length < 2600, `${JSON.stringify(max).length} bytes`);
  assert.ok(JSON.stringify(jevPolicy({ mode: 'reversible' })).length < 1000);
});

test('decideBody: state.policy comes from context mode and additions, identical across requests', () => {
  const guidance = resolveGuidance();
  const context = { instruction: 'Continue', history: [], mode: 'reversible', guardrails: { forbid: ['Upgrade'], note: '' } };
  const offered = [button('a0', '5', 'Continue →'), handoff];
  const first = decideBody({ model: 'jev-latest', observation: page, offered, context, guidance });
  const second = decideBody({ model: 'jev-latest', observation: page, offered, context: { ...context, history: [{ i: 1 }] }, guidance });
  assert.deepEqual(Object.keys(first.state), ['instruction', 'policy', 'page', 'history']);
  assert.equal(JSON.stringify(first.state.policy), JSON.stringify(second.state.policy));
  assert.equal(first.state.policy, jevPolicy({ mode: 'reversible', forbid: ['Upgrade'] }));
  // The serialized prefix up to the page is byte-identical for the same instruction and run settings.
  const prefix = body => JSON.stringify(body).split('"page":')[0];
  assert.equal(prefix(first), prefix(second));
});

test('commit guard question: reversible mode with a button/select/fill offered only; switch can turn it off', () => {
  const guidance = resolveGuidance();
  const ask = (mode, offered, g = guidance) => Object.keys(decideBody({
    model: 'm', observation: page, offered, context: { instruction: 'x', history: [], mode }, guidance: g,
  }).questions);
  const purchase = ['purchase_control', 'purchase_page'];
  assert.deepEqual(ask('reversible', [button('a0', '5', 'Continue'), handoff]), ['action', 'done', 'blocked', 'injection', 'commit', ...purchase]);
  assert.deepEqual(ask('read-only', [link('a0', '1', 'About'), handoff]), ['action', 'done', 'blocked', 'injection']);
  assert.deepEqual(ask('read-only', [button('a0', '5', 'Continue'), handoff]), ['action', 'done', 'blocked', 'injection']);
  assert.deepEqual(ask('reversible', [link('a0', '1', 'About'), handoff]), ['action', 'done', 'blocked', 'injection'],
    'links only: nothing for the commit guard to judge');
  assert.deepEqual(ask('reversible', [{ ...button('c0', '9', 'Reject all'), consent: true }, handoff]),
    ['action', 'done', 'blocked', 'injection'], 'consent buttons have their own rule');
  // The commit switch turns off the broad commit noul only; the purchase guard is part of the guardrail.
  assert.deepEqual(ask('reversible', [button('a0', '5', 'Continue'), handoff], resolveGuidance({ commit: false })),
    ['action', 'done', 'blocked', 'injection', ...purchase]);
  assert.deepEqual(ask('reversible', [button('a0', '5', 'Continue'), handoff], resolveGuidance(false)),
    ['action', 'done', ...purchase]);
  // Above reversible: the purchase guard only; at testing neither.
  for (const level of ['interactive', 'full']) {
    assert.deepEqual(ask(level, [button('a0', '5', 'Continue'), handoff]), ['action', 'done', 'blocked', 'injection', ...purchase], level);
  }
  assert.deepEqual(ask('testing', [button('a0', '5', 'Continue'), handoff]), ['action', 'done', 'blocked', 'injection']);
  const body = decideBody({ model: 'm', observation: page, offered: [button('a0', '5', 'Continue')], context: { mode: 'reversible' }, guidance });
  assert.deepEqual(body.questions.commit, { type: 'noul', instructions: GUARD_QUESTIONS.commit });
  assert.match(GUARD_QUESTIONS.commit, /place an order, pay, book, reserve, subscribe, send, publish, delete, sign in/);
  assert.equal(GUARD_QUESTIONS.purchase_control, 'Would the offered button, select or fill that best advances `instruction` '
    + 'pay, place an order, check out, book, reserve, subscribe, start a trial, or move money?');
  assert.equal(GUARD_QUESTIONS.purchase_page, 'Is this page a checkout, payment, order-confirmation or booking-confirmation step?');
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

test('TypeSafeProvider parses the commit guard into Decision.guards', async () => {
  const requests = [];
  const provider = new TypeSafeProvider({
    requireKey: false, keyEnv: 'FAI_UNUSED_TEST_KEY',
    fetchImpl: async (_, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ answers: {
        action: { type: 'choice', choice: 'a0', confidence: 0.9 }, commit: { type: 'noul', noul: 0.93 },
        blocked: { noul: 0.02 }, injection: { noul: 0.1 },
      } }), { status: 200 });
    },
  });
  const decision = await provider.decide(page, [button('a0', '5', 'Continue'), handoff], { instruction: 'x', mode: 'reversible' });
  // The purchase questions were asked and not answered: they fail closed at 1.
  assert.deepEqual(decision.guards, { blocked: 0.02, injection: 0.1, commit: 0.93, purchase_control: 1, purchase_page: 1 });
  assert.ok(requests[0].questions.commit);
  assert.equal(requests.length, 1, 'one request: the commit guard costs no extra round trip');
});
