// Configurable guardrails (docs/proposals/configurable-guardrails.md), host side: levels and capabilities, the
// PURCHASE / COMMIT_OTHER split, purchases never offered below testing, the clamp of a run's mode to the user's grant
// and the receipt's `permissions` block, the purchase guard (Jev nouls), level requests instead of plain refusals,
// lease `level` validation, and that no config, policy, MCP or CLI input can grant `testing`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITIES, CAPABILITY_NAMES, COMMIT_OTHER, DELETE_WORDS, LEVELS, PAYMENT_AUTOCOMPLETE, PAYMENT_FIELD,
  PURCHASE, SAFE_SUBMIT, SIGN_IN_WORDS, SUBMIT_WORDS, capabilitiesOf, clampLevel, guardrailPolicy, jevPolicy,
  DANGEROUS, labelClasses, normalizeAdditions, paymentField,
} from '../src/guardrails.js';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { writeRun } from '../src/trace.js';
import { createHub } from '../src/bridge.js';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths, loadConfig } from '../src/home.js';
import { TOOLS } from '../src/mcp.js';
import { FakeBridge, ORIGIN, clickProvider, link } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, SECRET } from './helpers/fake-extension.js';

const grant = level => ({ grant: { level } });

// ---------------------------------------------------------------------------------------------------------------
// Levels and capabilities
// ---------------------------------------------------------------------------------------------------------------

test('every capability at every level (the design table)', () => {
  const table = {
    navigate: ['read-only', 'reversible', 'interactive', 'full', 'testing'],
    controls: ['reversible', 'interactive', 'full', 'testing'],
    submit_safe: ['interactive', 'full', 'testing'],
    submit: ['full', 'testing'],
    delete: ['full', 'testing'],
    consent_accept: ['full', 'testing'],
    sign_in: ['testing'],
    purchase: ['testing'],
  };
  assert.deepEqual(LEVELS, ['read-only', 'reversible', 'interactive', 'full', 'testing']);
  assert.deepEqual(CAPABILITY_NAMES, Object.keys(table));
  for (const level of LEVELS) {
    const caps = capabilitiesOf(level);
    for (const [capability, levels] of Object.entries(table)) {
      assert.equal(caps.has(capability), levels.includes(level), `${capability} at ${level}`);
      assert.equal(guardrailPolicy({ level }).allows(capability), levels.includes(level), `policy ${capability} at ${level}`);
    }
    assert.ok(Object.isFrozen(CAPABILITIES[level]));
  }
  // Anything but a level fails closed.
  for (const bogus of [undefined, null, 'root', 'TESTING', 'full ', 3]) assert.deepEqual([...capabilitiesOf(bogus)], ['navigate']);
  assert.throws(() => guardrailPolicy({ level: 'root' }), /Unknown action policy/);
});

test('clampLevel: the lower of requested and granted; unknown or missing grants fail closed', () => {
  for (const requested of LEVELS) {
    for (const granted of LEVELS) {
      const expected = LEVELS[Math.min(LEVELS.indexOf(requested), LEVELS.indexOf(granted))];
      assert.equal(clampLevel(requested, granted), expected, `${requested} / ${granted}`);
    }
  }
  assert.equal(clampLevel('testing', undefined), 'read-only');
  assert.equal(clampLevel('testing', null), 'read-only');
  assert.equal(clampLevel('testing', 'admin'), 'read-only');
  assert.equal(clampLevel('admin', 'testing'), 'read-only');
});

// ---------------------------------------------------------------------------------------------------------------
// Label sets
// ---------------------------------------------------------------------------------------------------------------

test('PURCHASE: purchases match; carts, lists, history and filters do not', () => {
  const positives = ['Book now', 'Place your order', 'Donate', 'Place bid', 'Start free trial', 'Buy it now', 'Pay €45.00',
    'Checkout', 'Proceed to checkout', 'Subscribe', 'Upgrade plan', 'Upgrade to Pro', 'Reserve a table', 'Transfer funds',
    'Send money', 'Withdraw', 'Complete order', 'Confirm booking', 'Add payment method', 'Add a credit card', 'Bid',
    'Renew subscription', 'Pre-order', 'Make a payment', 'Continue to payment', 'Order', 'ORDER NOW!', 'Purchase'];
  const negatives = ['Add to cart', 'Book list', 'Order history', 'Apply filters', 'Bookmarks', 'Orders', 'Sort order',
    'Apply', 'Payments', 'PayPal help', 'Buyer guide', 'Unsubscribe', 'Subscriber list', 'Checklist', 'Upgrade guide',
    'Trial terms', 'Bid history', 'Donations page', 'Transfer history', 'Apply now', 'Cancel subscription', 'Save',
    'View cart', 'Continue shopping'];
  for (const label of positives) assert.ok(PURCHASE.test(label), `should catch "${label}"`);
  for (const label of negatives) assert.ok(!PURCHASE.test(label), `should not catch "${label}"`);
  // The rest of the old commit set lives in COMMIT_OTHER: applications and cancellations.
  for (const label of ['Apply now', 'Apply for this job', 'Apply changes', 'Cancel my subscription', 'Cancel order']) {
    assert.ok(COMMIT_OTHER.test(label), label);
    assert.ok(!PURCHASE.test(label), label);
  }
  assert.ok(!COMMIT_OTHER.test('Apply filters') && !COMMIT_OTHER.test('Apply'));
  const policy = guardrailPolicy({ level: 'full' });
  assert.equal(policy.matches('Apply now'), 'submit');
  assert.equal(policy.matches('Cancel my subscription'), 'delete');
});

test('split word lists and the safe-submit and payment-field patterns', () => {
  assert.equal(String(SUBMIT_WORDS), String.raw`/\b(save(?!\s+(?:up\s+to\s+|over\s+|an\s+extra\s+|extra\s+)?(?:[$€£¥₹]\s?\d|\d[\d.,]*\s?(?:%|percent\b|[$€£¥₹]|(?:usd|eur|gbp)\b)))|submit|send|confirm|invite|publish)\b/i`);
  assert.equal(String(DELETE_WORDS), '/\\b(delete|remove)\\b/i');
  assert.equal(String(SIGN_IN_WORDS), '/\\b(sign ?in|log ?in)\\b/i');
  for (const label of ['Search', 'Search flights', 'Go', 'Filter', 'Apply filters', 'Sort', 'Show more', 'Load more', 'Next page'])
    assert.ok(SAFE_SUBMIT.test(label), label);
  for (const label of ['Submit', 'Save', 'Search and delete everything', 'Send', 'Continue', 'Sign in'])
    assert.ok(!SAFE_SUBMIT.test(label), label);
  assert.ok(PAYMENT_AUTOCOMPLETE.test('cc-number') && PAYMENT_AUTOCOMPLETE.test('billing cc-exp'));
  assert.ok(!PAYMENT_AUTOCOMPLETE.test('email') && !PAYMENT_AUTOCOMPLETE.test('accent-color'));
  for (const name of ['cardnumber', 'card_number', 'cc-exp', 'CVC', 'cvv2', 'Security code', 'IBAN', 'Expiry date', 'Card expiration'])
    assert.ok(PAYMENT_FIELD.test(name), name);
  for (const name of ['Email', 'Name', 'Search', 'Discount code', 'Card title', 'Postcode'])
    assert.ok(!PAYMENT_FIELD.test(name), name);
  assert.equal(paymentField({ autocomplete: 'cc-csc', label: 'Code' }), true);
  assert.equal(paymentField({ label: 'Card number' }), true);
  assert.equal(paymentField({ label: 'Email' }), false);
});

// Discount and price wording (tier 1): "save" before an amount is not a save, and price or billing words on a plan
// picker are no class by themselves; real saves, subscriptions and payments keep their class.
const CLEARED_LABELS = ['Save 30%', 'Save €20', 'Save $5', 'save up to 40%', 'Two years (save 30%)', 'Save 20 percent',
  'Save 20€', 'Save 15 EUR', 'Save an extra 10%', 'Save over 50%', 'Save 20% today', '€9/month', '$9 / month',
  'Billed yearly', 'Billed annually', 'per year', '€90 per year', 'Monthly plan €9/month',
  'Yearly – €90/year, billed yearly (save 17%)'];
const FLAGGED_LABELS = [['Save', 'submit'], ['Save changes', 'submit'], ['Save draft', 'submit'], ['Save card', 'submit'],
  ['Save a copy', 'submit'], ['Save 2 files', 'submit'], ['Subscribe for €9/month', 'purchase'], ['Pay €9', 'purchase'],
  ['Pay now', 'purchase'], ['Buy for €9/month', 'purchase'], ['Subscribe and save 20%', 'purchase'],
  ['Save 20% and pay now', 'purchase'], ['Upgrade now – save 30%', 'purchase'], ['Save 30% and send', 'submit']];

test('discount and plan-picker wording is no class; saves, subscriptions and payments keep theirs', () => {
  for (const label of CLEARED_LABELS) {
    assert.deepEqual(labelClasses(label), [], label);
    assert.ok(!SUBMIT_WORDS.test(label) && !DANGEROUS.test(label), label);
  }
  for (const [label, kind] of FLAGGED_LABELS) assert.equal(labelClasses(label)[0], kind, label);
  // At reversible a discount option is offered like any option; a real save is still refused below full.
  const observation = { url: `${ORIGIN}/plans`, controls: [
    { id: '1', role: 'option', label: 'Two years (save 30%)', enabled: true, risk: 'reversible' },
    { id: '2', role: 'button', label: 'Save changes', enabled: true, risk: 'submit' },
  ] };
  const offered = legalActions(observation, { mode: 'reversible' }).map(action => action.label);
  assert.ok(offered.includes('Two years (save 30%)'));
  assert.ok(!offered.includes('Save changes'));
});

// ---------------------------------------------------------------------------------------------------------------
// legalActions per level
// ---------------------------------------------------------------------------------------------------------------

const MIXED = {
  url: `${ORIGIN}/shop`,
  controls: [
    { id: '1', role: 'button', label: 'Add to cart', enabled: true, risk: 'reversible' },
    { id: '2', role: 'button', label: 'Place order', enabled: true, risk: 'reversible' },
    { id: '3', role: 'button', label: 'Buy now', enabled: true, risk: 'purchase' },
    { id: '4', role: 'button', label: 'Save draft', enabled: true, risk: 'reversible' },
    { id: '5', role: 'button', label: 'Delete draft', enabled: true, risk: 'reversible' },
    { id: '6', role: 'button', label: 'Search', type: 'submit', enabled: true, risk: 'submit' },
    { id: '7', role: 'button', label: 'Sign in', enabled: true, risk: 'reversible' },
    { id: '8', role: 'textbox', label: 'Card number', type: 'text', enabled: true, risk: 'reversible' },
    { id: '9', role: 'textbox', label: 'Coupon', type: 'text', enabled: true, risk: 'reversible' },
    link('10', 'Checkout', '/checkout'),
    link('11', 'Delete account', '/delete'),
    link('12', 'Order history', '/orders'),
    { id: '13', role: 'button', label: 'Publish', type: 'submit', enabled: true, risk: 'submit' },
    { id: '14', role: 'button', label: 'Gift wrap', enabled: true, risk: 'reversible' },
  ],
};

function offeredTargets(level, extra = {}) {
  const actions = legalActions(MIXED, { mode: level, suppliedText: { code: 'SPRING10' }, policy: ['Gift wrap'], ...extra });
  return new Set(actions.filter(action => action.target !== undefined).map(action => action.target));
}

test('legalActions offers each control class only at the levels that allow it; additions block at every level', () => {
  // The page has a payment field (Card number): it is a purchase page (the Approve gate's rule, src/guardrails.js
  // purchasePage), where only a commit-like label (Place order) or a button in the checkout region is a purchase; Add
  // to cart, Save draft, Delete draft, Search and Publish keep their own classes (Search is a full submit next to a
  // payment field).
  const expected = {
    'read-only': ['12'],
    reversible: ['1', '9', '12'],
    interactive: ['1', '9', '12'],
    full: ['1', '4', '5', '6', '9', '11', '12', '13'],
    testing: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'],
  };
  for (const level of LEVELS) {
    assert.deepEqual([...offeredTargets(level)].sort((a, b) => a - b), expected[level], level);
  }
  // `Gift wrap` (a policy addition) is refused even at testing.
  assert.ok(!offeredTargets('testing').has('14'));
});

test('purchases are never offered below testing, even at full: labels, risk class, payment fields, checkout links', () => {
  for (const level of ['read-only', 'reversible', 'interactive', 'full']) {
    const targets = offeredTargets(level);
    for (const id of ['2', '3', '8', '10']) assert.ok(!targets.has(id), `${id} offered at ${level}`);
  }
  // A payment field by autocomplete, and a select option that purchases.
  const page = {
    url: `${ORIGIN}/pay`,
    controls: [
      { id: '1', role: 'textbox', label: 'Number', type: 'text', autocomplete: 'cc-number', enabled: true, risk: 'reversible' },
      { id: '2', role: 'combobox', label: 'Plan', enabled: true, risk: 'reversible', selectedValue: 'free',
        options: [{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Upgrade to Pro' }, { value: 'team', label: 'Team' }] },
    ],
  };
  const full = legalActions(page, { mode: 'full', suppliedText: { n: '4242424242424242' } });
  assert.ok(!full.some(action => action.target === '1'), 'payment field filled at full');
  assert.deepEqual(full.filter(action => action.type === 'select').map(action => action.value), ['team']);
  const testing = legalActions(page, { mode: 'testing', suppliedText: { n: '4242424242424242' }, guardrails: guardrailPolicy({ level: 'testing' }) });
  assert.ok(testing.some(action => action.target === '1'));
  assert.deepEqual(testing.filter(action => action.type === 'select').map(action => action.value), ['pro', 'team']);
});

test('interactive: a safe submit only on a page without password or payment fields', () => {
  const search = { id: '1', role: 'button', label: 'Search', type: 'submit', enabled: true, risk: 'submit' };
  const plain = { url: `${ORIGIN}/`, controls: [search] };
  assert.ok(legalActions(plain, { mode: 'interactive' }).some(action => action.target === '1'));
  assert.ok(!legalActions(plain, { mode: 'reversible' }).some(action => action.target === '1'));
  const withPassword = { url: `${ORIGIN}/`, controls: [search, { id: '2', role: 'textbox', type: 'password', label: 'Password', enabled: true }] };
  assert.ok(!legalActions(withPassword, { mode: 'interactive' }).some(action => action.target === '1'));
  const withCard = { url: `${ORIGIN}/`, controls: [search, { id: '2', role: 'textbox', type: 'text', label: 'CVC', enabled: true }] };
  assert.ok(!legalActions(withCard, { mode: 'interactive' }).some(action => action.target === '1'));
  // At full any submit is allowed (no purchase label), password field or not.
  assert.ok(legalActions(withPassword, { mode: 'full' }).some(action => action.target === '1'));
});

test('sign_in: password fields are fill targets only at testing, and marked sensitive', () => {
  const page = { url: `${ORIGIN}/login`, controls: [
    { id: '1', role: 'textbox', type: 'email', label: 'Email', enabled: true },
    { id: '2', role: 'textbox', type: 'password', label: 'Password', enabled: true },
  ] };
  for (const level of ['reversible', 'full']) {
    assert.ok(!legalActions(page, { mode: level, suppliedText: { pw: 'x' } }).some(action => action.target === '2'), level);
  }
  const fills = legalActions(page, { mode: 'testing', suppliedText: { pw: 'x' } }).filter(action => action.target === '2');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].sensitive, true);
  assert.equal(fills[0].type, 'fill_supplied_text');
});

// ---------------------------------------------------------------------------------------------------------------
// The runtime: clamp, permissions, purchase guard, level requests, consent, login, redaction
// ---------------------------------------------------------------------------------------------------------------

test('the runtime clamps the mode to the grant; testing needs a grant; the receipt reports permissions', async () => {
  const run = async options => {
    const bridge = new FakeBridge();
    const result = await new BrowserRuntime({ bridge, provider: clickProvider(['About']) }).step('Open About', options);
    return { result, bridge };
  };
  let { result, bridge } = await run({ mode: 'full', ...grant('reversible') });
  assert.deepEqual(result.permissions, { requested: 'full', granted: 'reversible', effective: 'reversible', testing: false, scope: 'origin', tabMode: 'single' });
  assert.equal(bridge.observeOptions[0].level, 'reversible', 'the effective level goes to the extension');
  assert.equal(bridge.executions[0] !== undefined, true);
  ({ result } = await run({ mode: 'testing' }));
  assert.deepEqual(result.permissions, { requested: 'testing', granted: null, effective: 'full', testing: false, scope: 'origin', tabMode: 'single' },
    'without a grant testing is never effective');
  ({ result } = await run({ mode: 'testing', ...grant('testing') }));
  assert.deepEqual(result.permissions, { requested: 'testing', granted: 'testing', effective: 'testing', testing: true, scope: 'origin', tabMode: 'single' });
  assert.deepEqual(agentResult(result).permissions, result.permissions);
  ({ result } = await run({ mode: 'reversible', ...grant('full') }));
  assert.equal(result.permissions.effective, 'reversible', 'the grant is a ceiling, never a floor');
});

function guardProvider(label, guards) {
  const calls = [];
  return {
    calls,
    async decide(observation, actions, context) {
      calls.push({ actions, context });
      const action = actions.find(item => item.label === label) ?? actions.find(item => item.type === 'handoff');
      return { actionId: action.id, confidence: 0.95, guards, done: { probability: 0.05 } };
    },
  };
}

const CHECKOUT = {
  '/review': {
    title: 'Review', text: 'Card charged when you continue',
    controls: [{ id: '1', role: 'button', label: 'Continue', enabled: true, risk: 'reversible' }, link('2', 'Help', '/help')],
  },
  '/help': { title: 'Help', text: 'Help', controls: [] },
};

test('purchase guard: a chosen control with purchase_control or purchase_page at the veto is refused below testing', async () => {
  for (const level of ['reversible', 'interactive', 'full']) {
    for (const guards of [{ purchase_control: 0.9 }, { purchase_page: 0.7 }]) {
      const bridge = new FakeBridge({ pages: CHECKOUT, path: '/review' });
      const provider = guardProvider('Continue', guards);
      const result = await new BrowserRuntime({ bridge, provider }).run('Continue the checkout review.', { mode: level, ...grant(level) });
      assert.equal(result.code, 'refused_action', `${level} ${JSON.stringify(guards)}`);
      assert.equal(bridge.executions.length, 0, 'nothing executed');
      assert.ok(result.verdict.why.includes('guard:purchase_veto'));
      assert.equal(result.next.kind, 'stop');
      assert.equal(result.needs.message, 'FAI never purchases outside testing mode. Tell the user what to do in the tab.');
      assert.deepEqual(result.needs.control, { ref: '1', label: 'Continue' });
      assert.equal(result.needs.level, undefined);
      assert.equal(provider.calls[0].context.level, level);
      assert.ok(provider.calls[0].context.capabilities.includes('controls'));
    }
  }
  // Below the threshold, or at testing, the control runs; a link proceeds whatever the guard says.
  const below = new FakeBridge({ pages: CHECKOUT, path: '/review' });
  await new BrowserRuntime({ bridge: below, provider: guardProvider('Continue', { purchase_control: 0.69 }) })
    .step('Continue.', { mode: 'full', ...grant('full') });
  assert.equal(below.executions.length, 1);
  const testing = new FakeBridge({ pages: CHECKOUT, path: '/review' });
  await new BrowserRuntime({ bridge: testing, provider: guardProvider('Continue', { purchase_control: 0.99, purchase_page: 0.99 }) })
    .step('Continue.', { mode: 'testing', ...grant('testing') });
  assert.equal(testing.executions.length, 1, 'no purchase veto at testing');
  const linked = new FakeBridge({ pages: CHECKOUT, path: '/review' });
  await new BrowserRuntime({ bridge: linked, provider: guardProvider('Help', { purchase_page: 0.99 }) })
    .step('Open Help.', { mode: 'full', ...grant('full') });
  assert.equal(linked.executions.length, 1);
  // A handoff while the purchase guard is high and a control is offered stops too.
  const handoff = new FakeBridge({ pages: CHECKOUT, path: '/review' });
  const stopped = await new BrowserRuntime({ bridge: handoff, provider: guardProvider('nothing', { purchase_page: 0.95 }) })
    .run('Finish the review.', { mode: 'full', ...grant('full') });
  assert.equal(stopped.code, 'refused_action');
  assert.ok(stopped.verdict.why.includes('guard:purchase_veto'));
  // A run may lower the veto threshold.
  const lowered = new FakeBridge({ pages: CHECKOUT, path: '/review' });
  const strict = await new BrowserRuntime({ bridge: lowered, provider: guardProvider('Continue', { purchase_control: 0.5 }) })
    .run('Continue.', { mode: 'full', ...grant('full'), thresholds: { commitVeto: 0.4 } });
  assert.equal(strict.code, 'refused_action');
});

const WORKSPACE = {
  '/settings': {
    title: 'Workspace settings', text: 'Danger zone',
    controls: [{ id: '1', role: 'button', label: 'Delete workspace', enabled: true, risk: 'delete' }],
  },
};

test('a refusal a higher level would lift relays a level request (needs.level); purchases still stop', async () => {
  const bridge = new FakeBridge({ pages: WORKSPACE, path: '/settings' });
  const provider = clickProvider([]);
  const result = await new BrowserRuntime({ bridge, provider }).run('Delete this workspace.', { mode: 'reversible', ...grant('reversible') });
  assert.equal(result.code, 'refused_action');
  assert.equal(provider.calls.length, 0);
  assert.equal(result.status, 'needs_user');
  assert.equal(result.needs.level, 'full');
  assert.equal(result.needs.who, 'user');
  assert.equal(result.needs.message, 'The user approved Use (no submit) for this tab; this task needs Act. Ask them to '
    + 'approve the new request at Act in FAI Browser (it is preselected).');
  assert.equal(result.verdict.kind, 'needs_user');
  assert.equal(result.next.kind, 'relay');
  assert.match(result.next.text, /mode "full"/);
  assert.ok(result.verdict.why.includes('refused:delete') && result.verdict.why.includes('level:full'));
  const lean = agentResult(result);
  assert.equal(lean.needs.level, 'full');
  assert.equal(lean.next.kind, 'relay');

  // The grant already covers it: the host runs again with that mode.
  const covered = await new BrowserRuntime({ bridge: new FakeBridge({ pages: WORKSPACE, path: '/settings' }), provider })
    .run('Delete this workspace.', { mode: 'reversible', ...grant('full') });
  assert.equal(covered.needs.who, 'host');
  assert.equal(covered.next.kind, 'rerun');
  assert.match(covered.next.text, /mode "full"/);

  // At full the control is offered and the task is not refused.
  const runs = await new BrowserRuntime({ bridge: new FakeBridge({ pages: WORKSPACE, path: '/settings' }), provider: clickProvider(['Delete workspace']) })
    .step('Delete this workspace.', { mode: 'full', ...grant('full') });
  assert.notEqual(runs.code, 'refused_action');

  // Sign-in needs testing: relayed with the test-environment note.
  const login = { '/': { title: 'Account', text: 'Account', controls: [{ id: '1', role: 'button', label: 'Log in', enabled: true, risk: 'reversible' }] } };
  const signIn = await new BrowserRuntime({ bridge: new FakeBridge({ pages: login }), provider })
    .run('Log in to my account.', { mode: 'full', ...grant('full') });
  assert.equal(signIn.needs.level, 'testing');
  assert.match(signIn.needs.message, /only on origins the user listed as test sites/);

  // A purchase below testing stops, at every level.
  const cart = { '/': { title: 'Cart', text: 'Cart', controls: [{ id: '1', role: 'button', label: 'Place order', enabled: true, risk: 'purchase' }] } };
  for (const level of ['read-only', 'reversible', 'interactive', 'full']) {
    const stop = await new BrowserRuntime({ bridge: new FakeBridge({ pages: cart }), provider }).run('Place my order.', { mode: level, ...grant(level) });
    assert.equal(stop.code, 'refused_action', level);
    assert.equal(stop.next.kind, 'stop', level);
    assert.equal(stop.needs.level, undefined, level);
    assert.equal(stop.next.text, 'FAI never purchases outside testing mode. Tell the user what to do in the tab.');
  }
  // A control the user forbade stops at every level, testing included.
  const forbidden = await new BrowserRuntime({ bridge: new FakeBridge({ pages: WORKSPACE, path: '/settings' }), provider })
    .run('Delete this workspace.', { mode: 'testing', ...grant('testing'), policy: ['Delete workspace'] });
  assert.equal(forbidden.code, 'refused_action');
  assert.equal(forbidden.next.kind, 'stop');
  assert.equal(forbidden.needs.message, 'The user reserved this control for themselves. Tell the user what to do in the tab.');
});

test('all controls blocked at reversible names the level that would allow one', async () => {
  const pages = { '/': { title: 'Form', text: 'Contact form', controls: [{ id: '1', role: 'button', label: 'Send', type: 'submit', enabled: true, risk: 'submit' }] } };
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider: clickProvider([], { fallback: 'handoff' }) })
    .run('Read the form.', { mode: 'reversible', ...grant('reversible') });
  assert.equal(result.code, 'refused_action');
  assert.ok(result.verdict.why.includes('refused:all_controls_blocked'));
  assert.equal(result.needs.level, 'full');
  assert.equal(result.next.kind, 'relay');
});

const CONSENT_PAGE = {
  '/': {
    title: 'News', text: 'Headlines',
    consent: { text: 'We use cookies', buttons: [{ id: '9', label: 'Accept all', kind: 'accept' }] },
    controls: [{ id: '9', role: 'button', label: 'Accept all', enabled: true, risk: 'consent_accept', consent: true, dismissesConsent: true }, link('2', 'About', '/about')],
  },
  '/about': { title: 'About', text: 'About us', controls: [] },
};

test('consent: an accept-only dialog stops below full; at full the accept button is offered to the provider', async () => {
  const blocked = await new BrowserRuntime({ bridge: new FakeBridge({ pages: CONSENT_PAGE }), provider: clickProvider(['Accept all']) })
    .run('Read the headlines.', { mode: 'reversible', ...grant('reversible') });
  assert.equal(blocked.code, 'consent_banner');
  const bridge = new FakeBridge({ pages: CONSENT_PAGE });
  const provider = clickProvider(['Accept all'], { fallback: 'done' });
  await new BrowserRuntime({ bridge, provider }).run('Read the headlines.', { mode: 'full', ...grant('full') });
  const offered = provider.calls[0].actions.filter(action => action.consent);
  assert.deepEqual(offered.map(action => action.label), ['Accept all']);
  assert.equal(bridge.executions[0].action.target, '9');
  // With a reject button the reject is still clicked mechanically at full.
  const both = structuredClone(CONSENT_PAGE);
  both['/'].consent.buttons.push({ id: '8', label: 'Reject all', kind: 'reject' });
  both['/'].controls.push({ id: '8', role: 'button', label: 'Reject all', enabled: true, risk: 'reversible', consent: true, dismissesConsent: true });
  const mech = new FakeBridge({ pages: both });
  await new BrowserRuntime({ bridge: mech, provider: clickProvider([], { fallback: 'done' }) }).run('Read the headlines.', { mode: 'full', ...grant('full') });
  assert.equal(mech.executions[0].action.target, '8');
});

class EchoBridge extends FakeBridge {
  async execute(action, ...rest) {
    const out = await super.execute(action, ...rest);
    if (action.type === 'fill_supplied_text') {
      this.pages[this.path].text = `Signed in as ada with ${action.text} (debug echo)`;
      this.pages[this.path].title = `Welcome ${action.text}`;
      this.version++;
      return { ...out, observation: this.observation };
    }
    return out;
  }
}

test('sign_in at testing: no login stop; the password value is redacted from steps, receipt and trace', async t => {
  const secret = 'hunter2-Secret!';
  const pages = { '/login': { title: 'Sign in', text: 'Sign in to continue', controls: [
    { id: '1', role: 'textbox', type: 'password', label: 'Password', enabled: true, risk: 'reversible' },
  ] } };
  // Below testing a login wall stops before any decision.
  const stopped = await new BrowserRuntime({ bridge: new FakeBridge({ pages, path: '/login' }), provider: clickProvider([]) })
    .run('Read the dashboard.', { mode: 'full', ...grant('full'), suppliedText: { pw: secret } });
  assert.equal(stopped.code, 'login');
  const bridge = new EchoBridge({ pages, path: '/login' });
  const provider = {
    calls: [],
    async decide(observation, actions) {
      this.calls.push(JSON.stringify({ observation, actions }));
      const fill = actions.find(action => action.type === 'fill_supplied_text');
      return { actionId: fill && this.calls.length === 1 ? fill.id : 'done', confidence: 0.9 };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Sign in with the test password and read the greeting.', {
    mode: 'testing', ...grant('testing'), suppliedText: { pw: secret }, expectation: { textIncludes: 'Signed in' },
  });
  assert.equal(bridge.lastText, secret, 'the extension received the real value');
  assert.equal(result.steps[0].action.sensitive, true);
  assert.equal(result.steps[0].action.text, undefined, 'the step never records the value');
  assert.equal(result.steps[0].action.label, 'Password');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret), 'receipt redacted');
  assert.ok(!JSON.stringify(result.observation).includes(secret), 'diagnostic observation redacted');
  assert.match(result.page.title, /\[redacted\]/);
  const lean = agentResult(result);
  assert.ok(!JSON.stringify(lean).includes(secret));
  const dir = await mkdtemp(join(tmpdir(), 'fai-levels-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = await writeRun(result, { dir, instruction: 'x', operation: 'run', options: { suppliedText: { pw: secret } } });
  const trace = await readFile(written.trace, 'utf8');
  assert.ok(!trace.includes(secret), 'trace redacted');
  assert.ok(!JSON.stringify(written.result).includes(secret));
  for (const payload of provider.calls) assert.ok(!payload.includes(secret), 'provider payloads never carry it');
});

test('secret supplied values: password fields take only them; a text field only when meant for one or asked for', async t => {
  const login = { url: `${ORIGIN}/login`, revision: 'r1', title: 'Test app', controls: [
    { id: '1', role: 'textbox', type: 'text', label: 'Username', enabled: true, risk: 'reversible' },
    { id: '2', role: 'textbox', type: 'password', label: 'Password', enabled: true, risk: 'reversible' },
    { id: '3', role: 'textbox', type: 'text', label: 'API key', enabled: true, risk: 'reversible' },
  ] };
  const fills = (instruction, suppliedText = { username: 'tester', password: 'synthetic-pass-9' }) => legalActions(login,
    { mode: 'testing', suppliedText, instruction })
    .filter(action => action.type === 'fill_supplied_text')
    .map(action => `${action.target}:${action.suppliedName}${action.sensitive ? ':sensitive' : ''}`).sort();
  assert.deepEqual(fills('Sign in: fill Username with the supplied username and Password with the supplied password.'),
    ['1:username', '2:password:sensitive', '3:password:sensitive', '3:username'],
    'the password goes to the password field (and a field meant for a secret), never to Username');
  assert.deepEqual(fills('Fill the Username field with the supplied password.').filter(f => f.startsWith('1:')),
    ['1:password:sensitive', '1:username'], 'asked for explicitly: offered, and still treated as a secret');
  assert.deepEqual(fills('Put the password into the Username field.').filter(f => f.startsWith('1:')),
    ['1:password:sensitive', '1:username']);
  assert.deepEqual(fills(undefined, { first: 'a-value', second: 'b-value' }).filter(f => f.startsWith('2:')),
    ['2:first:sensitive', '2:second:sensitive'], 'no secret names: every value is offered, a password fill is a secret');

  // A secret filled into a text field (asked for) is never recorded and is redacted from receipt and trace.
  const secret = 'synthetic-pass-9';
  const pages = { '/': { title: 'Test app', text: 'Account', controls: [login.controls[0]] } };
  const bridge = new FakeBridge({ pages, path: '/' });
  const provider = { async decide(_observation, actions) {
    const fill = actions.find(action => action.type === 'fill_supplied_text' && action.suppliedName === 'password');
    return { actionId: fill && !bridge.lastText ? fill.id : 'done', confidence: 0.9 };
  } };
  const result = await new BrowserRuntime({ bridge, provider }).run('Fill the Username field with the supplied password.', {
    mode: 'testing', ...grant('testing'), suppliedText: { password: secret }, maxActions: 1 });
  assert.equal(bridge.lastText, secret);
  assert.equal(result.steps[0].action.sensitive, true);
  assert.equal(result.steps[0].action.text, undefined);
  assert.ok(!JSON.stringify(result).includes(secret));
  const dir = await mkdtemp(join(tmpdir(), 'fai-levels-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = await writeRun(result, { dir, instruction: 'x', operation: 'run', options: {} });
  assert.ok(!(await readFile(written.trace, 'utf8')).includes(secret));
});

test('at testing a high blocked guard on a sign-in page is ignored but logged in the receipt and the trace', async t => {
  const pages = { '/login': { title: 'Sign in', text: 'Sign in to the test app', controls: [
    { id: '1', role: 'textbox', type: 'password', label: 'Password', enabled: true, risk: 'reversible' }] } };
  const bridge = new FakeBridge({ pages, path: '/login' });
  const provider = { async decide(_observation, actions) {
    const fill = actions.find(action => action.type === 'fill_supplied_text');
    return { actionId: fill && !bridge.lastText ? fill.id : 'handoff', confidence: 0.9, guards: { blocked: 0.78 } };
  } };
  const result = await new BrowserRuntime({ bridge, provider }).run('Fill the password.', {
    mode: 'testing', ...grant('testing'), suppliedText: { password: 'synthetic-pass-9' } });
  assert.equal(bridge.executions.length, 1, 'the run went on');
  assert.ok(result.verdict.why.includes('guard:blocked:0.78'), JSON.stringify(result.verdict.why));
  const dir = await mkdtemp(join(tmpdir(), 'fai-levels-blocked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = await writeRun(result, { dir, instruction: 'x', operation: 'run', options: {} });
  const trace = JSON.parse(await readFile(written.trace, 'utf8'));
  assert.equal(trace.steps[0].decision.guards.blocked, 0.78);
});

// ---------------------------------------------------------------------------------------------------------------
// Jev policy per level
// ---------------------------------------------------------------------------------------------------------------

test('jevPolicy: a mode line per level; level-specific user_actions', () => {
  assert.match(jevPolicy({ mode: 'interactive' }).mode, /search, filter, sort and paging submits/);
  assert.match(jevPolicy({ mode: 'full' }).user_actions, /^Buying, paying, subscribing and logging in belong to the user/);
  assert.match(jevPolicy({ mode: 'testing' }).user_actions, /^This is a test environment the user controls/);
  assert.equal(guardrailPolicy({ level: 'full' }).jev(), jevPolicy({ mode: 'full' }));
});

// ---------------------------------------------------------------------------------------------------------------
// The daemon and the hub: lease level, grant, clamp, command args
// ---------------------------------------------------------------------------------------------------------------

async function daemonSetup(t, { config } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-levels-daemon-'));
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const hub = createFakeHub();
  const env = { TYPESAFE_API_KEY: 'jev-test-key' };
  const log = createLogger(homePaths({ home, env }));
  const daemon = createDaemon({ driver: 'jev', home, env, port: 0, hub, log, sweepIntervalMs: 60_000, providerFactory: () => clickProvider(['About']) });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    log.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const request = async (mode, extra = {}) => {
    const response = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Levels', mode, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.requestId;
  };
  return { hub, daemon, api, request };
}

test('daemon: lease level is validated and stored as the grant; missing level keeps the old default', async t => {
  const ctx = await daemonSetup(t);
  for (const mode of LEVELS) {
    const id = await ctx.request(mode);
    assert.equal(ctx.daemon.request(id).mode, mode, `request at ${mode} is accepted (the agent states a need)`);
    await ctx.hub.approve(id, { level: 'read-only' });
  }
  const bad = await ctx.request('full');
  for (const level of ['root', 'TESTING', 7, '']) {
    const reply = await ctx.hub.approve(bad, { level });
    assert.equal(reply.error?.code, 'bad_request', JSON.stringify(level));
  }
  assert.equal(ctx.daemon.request(bad).state, 'pending', 'a bad level grants nothing');

  const full = await ctx.request('testing');
  const reply = await ctx.hub.approve(full, { level: 'full' });
  assert.deepEqual({ ...reply.grant, grantedAt: undefined }, { level: 'full', testing: false, grantedAt: undefined, scope: 'origin', tabMode: 'single' });
  const view = (await ctx.api('GET', `/v1/requests/${full}`)).body;
  assert.equal((view.request ?? view).grant.level, 'full');
  assert.equal(ctx.hub.bound.at(-1).level, 'full', 'the hub lease carries the grant');
  const run = await ctx.api('POST', '/v1/runs', { requestId: full, instruction: 'Open About', operation: 'step', waitMs: 5000 });
  assert.deepEqual(run.body.result.permissions, { requested: 'testing', granted: 'full', effective: 'full', testing: false, scope: 'origin', tabMode: 'single' });

  // An older extension (no level): reversible for a reversible-or-higher request, else read-only.
  const legacy = await ctx.request('interactive');
  assert.equal((await ctx.hub.approve(legacy)).grant.level, 'reversible');
  const legacyRead = await ctx.request('read-only');
  assert.equal((await ctx.hub.approve(legacyRead)).grant.level, 'read-only');

  // Testing is granted only by the lease message (the user's choice in the popup).
  const testing = await ctx.request('testing');
  assert.equal((await ctx.hub.approve(testing, { level: 'testing' })).grant.testing, true);
  const ran = await ctx.api('POST', '/v1/runs', { requestId: testing, instruction: 'Open About', operation: 'step', mode: 'testing', waitMs: 5000 });
  assert.equal(ran.body.result.permissions.effective, 'testing');

  // Re-approval of the active lease on the same tab changes the grant without a new lease.
  const before = ctx.daemon.request(testing).lease.leaseId;
  const regrant = await ctx.hub.approve(testing, { level: 'reversible' });
  assert.equal(regrant.leaseId, before);
  assert.equal(regrant.grant.level, 'reversible');
});

const LOGIN_PAGE = { title: 'Sign in', text: 'Sign in to the test app', controls: [
  { id: '1', role: 'textbox', type: 'text', label: 'Username', enabled: true, risk: 'reversible' },
  { id: '2', role: 'textbox', type: 'password', label: 'Password', enabled: true, risk: 'reversible' },
  { id: '3', role: 'button', label: 'Sign in', enabled: true, risk: 'sign_in' },
] };

test('daemon: the extension lowers a testing grant (lease_level); raising is refused; receipts and offers follow', async t => {
  const ctx = await daemonSetup(t);
  const id = await ctx.request('testing');
  await ctx.hub.approve(id, { level: 'testing' });
  const leaseId = ctx.daemon.request(id).lease.leaseId;
  const bridge = ctx.hub.bridgeForTab(1);
  bridge.pages['/'] = LOGIN_PAGE;
  const signIn = { requestId: id, mode: 'testing', instruction: 'Sign in: fill Username and Password, then click Sign in.',
    suppliedText: { username: 'tester', password: 'synthetic-pass-1' }, capture: 'none', waitMs: 5000 };
  const seen = (await ctx.api('POST', '/v1/observe', { requestId: id, mode: 'testing', capture: false,
    suppliedText: signIn.suppliedText })).body;
  assert.ok(seen.actions.some(action => action.target === '3'), 'Sign in offered at testing');

  // Raising is refused with a clear error and changes nothing.
  await ctx.hub.approve(id, { level: 'testing' }); // a no-op re-grant at the same level
  const lowFirst = await ctx.request('full');
  await ctx.hub.approve(lowFirst, { level: 'full' });
  const raise = await ctx.hub.lowerLevel(ctx.daemon.request(lowFirst).lease.leaseId, 'testing');
  assert.equal(raise.error?.code, 'level_not_granted');
  assert.match(raise.error.message, /new approval in the FAI Browser popup/);
  assert.equal(ctx.daemon.request(lowFirst).grant.level, 'full');
  const bad = await ctx.hub.lowerLevel(ctx.daemon.request(lowFirst).lease.leaseId, 'root');
  assert.equal(bad.error?.code, 'bad_request');
  assert.equal((await ctx.hub.lowerLevel('no-such-lease', 'full')).error?.code, 'no_request');

  // Back to the testing request (approving it again supersedes lowFirst).
  const again = await ctx.request('testing');
  await ctx.hub.approve(again, { level: 'testing' });
  const testingLease = ctx.daemon.request(again).lease.leaseId;
  assert.notEqual(testingLease, leaseId);
  const lowered = await ctx.hub.lowerLevel(testingLease, 'full');
  assert.equal(lowered.grant.level, 'full');
  assert.equal(lowered.grant.testing, false);
  const view = (await ctx.api('GET', `/v1/requests/${again}`)).body;
  assert.equal((view.request ?? view).grant.level, 'full', 'the view (and the popup\'s request list) shows Full');
  assert.equal(ctx.hub.lease(testingLease).level, 'full', 'the hub clamps later commands to Full');
  assert.equal(ctx.hub.published.at(-1).find(item => item.requestId === again).grant.level, 'full');

  const after = (await ctx.api('POST', '/v1/observe', { requestId: again, mode: 'testing', capture: false,
    suppliedText: signIn.suppliedText })).body;
  assert.ok(!after.actions.some(action => action.target === '3' || action.target === '2'), 'no sign-in actions offered');
  const run = await ctx.api('POST', '/v1/runs', { ...signIn, requestId: again, operation: 'run' });
  const result = run.body.result;
  assert.deepEqual(result.permissions, { requested: 'testing', granted: 'full', effective: 'full', testing: false, scope: 'origin', tabMode: 'single' });
  assert.equal(result.code, 'refused_action');
  assert.equal(result.needs.level, 'testing');
  assert.equal(result.next.kind, 'relay');
  assert.match(result.needs.message, /approved Act.*needs Test site/s);
  assert.equal(bridge.executions.length, 0, 'nothing was clicked or filled');
  // A repeat at the same level is a no-op; raising back is refused.
  assert.equal((await ctx.hub.lowerLevel(testingLease, 'full')).grant.level, 'full');
  assert.equal((await ctx.hub.lowerLevel(testingLease, 'testing')).error?.code, 'level_not_granted');
});

test('daemon: a hello carrying a lower session level lowers the grant; a higher one is ignored', async t => {
  const ctx = await daemonSetup(t);
  const id = await ctx.request('testing');
  await ctx.hub.approve(id, { level: 'testing' });
  const { leaseId } = ctx.daemon.request(id).lease;
  const session = level => ({ requestId: id, leaseId, tabId: 1, origin: ORIGIN, status: 'active', level });
  await ctx.hub.emit({ type: 'hello', session: session('testing') });
  assert.equal(ctx.daemon.request(id).grant.level, 'testing');
  await ctx.hub.emit({ type: 'hello', session: session('full') });
  assert.equal(ctx.daemon.request(id).grant.level, 'full');
  await ctx.hub.emit({ type: 'hello', session: session('testing') });
  assert.equal(ctx.daemon.request(id).grant.level, 'full', 'a hello never raises');
});

test('runtime: a grant lowered mid-run takes effect on the next decision and in the receipt', async () => {
  // Not a login wall (no sign-in title or heading), so the run goes on to a second decision.
  const bridge = new FakeBridge({ pages: { '/': { ...LOGIN_PAGE, title: 'Test app', text: 'Account details' } }, path: '/' });
  let runtime;
  const offeredTargets = [];
  const provider = {
    async decide(_observation, actions) {
      offeredTargets.push(actions.map(action => action.target).filter(Boolean));
      if (offeredTargets.length === 1) {
        runtime.lowerGrant('full');
        return { actionId: actions.find(action => action.target === '1').id, confidence: 0.9 };
      }
      return { actionId: 'handoff', confidence: 0.9 };
    },
  };
  runtime = new BrowserRuntime({ bridge, provider });
  const result = await runtime.run('Fill the username field with the supplied username.', {
    mode: 'testing', ...grant('testing'), suppliedText: { username: 'tester' } });
  assert.ok(offeredTargets[0].includes('3'), 'Sign in offered before the revocation');
  assert.ok(!offeredTargets[1].includes('3') && !offeredTargets[1].includes('2'), 'not after it');
  assert.deepEqual(result.permissions, { requested: 'testing', granted: 'full', effective: 'full', testing: false, scope: 'origin', tabMode: 'single' });
  assert.ok(result.verdict.why.includes('grant:lowered:full'), JSON.stringify(result.verdict.why));
  assert.throws(() => runtime.lowerGrant('admin'), /level/);

  // On a login wall the lowered run stops before any decision; asked for testing, it names the level.
  const wall = await new BrowserRuntime({ bridge: new FakeBridge({ pages: { '/': LOGIN_PAGE }, path: '/' }), provider })
    .run('Read the account page.', { mode: 'testing', ...grant('full') });
  assert.equal(wall.code, 'login');
  assert.equal(wall.needs.level, 'testing');
  assert.equal(wall.next.kind, 'relay');
  assert.match(wall.needs.message, /approved Act.*needs Test site/s);
  assert.match(wall.next.text, /mode "testing"/);
  const plain = await new BrowserRuntime({ bridge: new FakeBridge({ pages: { '/': LOGIN_PAGE }, path: '/' }), provider })
    .run('Read the account page.', { mode: 'full', ...grant('full') });
  assert.equal(plain.code, 'login');
  assert.equal(plain.needs.level, undefined, 'a run that did not ask for testing is told to let the user sign in');
});

test('no act or observe field, config key, policy, CLI flag or MCP argument grants a level', async t => {
  const ctx = await daemonSetup(t);
  const requestId = await ctx.request('testing');
  await ctx.hub.approve(requestId, { level: 'reversible' });
  for (const route of ['/v1/act', '/v1/observe']) {
    for (const field of [{ grant: { level: 'testing' } }, { level: 'testing' }, { permissions: { granted: 'testing' } }]) {
      const response = await ctx.api('POST', route, { requestId, ...(route === '/v1/act' ? { actionId: 'a0' } : {}), ...field });
      assert.equal(response.status, 400, `${route} ${JSON.stringify(field)}`);
      assert.equal(response.body.error.code, 'invalid_options');
    }
  }
  const asked = await ctx.api('POST', '/v1/observe', { requestId, mode: 'testing' });
  assert.equal(asked.body.permissions.effective, 'reversible');
  // A policy is restrict-only: no level or allow keys.
  for (const policy of [{ level: 'testing' }, { allow: ['Place order'] }, { testing: true }]) {
    assert.throws(() => normalizeAdditions(policy), /unknown key/);
  }
  // config.json has no key that grants anything.
  const home = await mkdtemp(join(tmpdir(), 'fai-levels-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const config of [{ level: 'testing' }, { mode: 'full' }, { testing: true }, { testOrigins: [ORIGIN] }]) {
    await writeFile(join(home, 'config.json'), JSON.stringify(config));
    assert.throws(() => loadConfig(homePaths({ home, env: {} })), /Unknown|unknown/, JSON.stringify(config));
  }
  // MCP: `mode` states a need (five levels); there is no grant argument.
  const open = TOOLS.find(tool => tool.name === 'fai_browser_open').inputSchema;
  assert.deepEqual(open.properties.mode.enum, LEVELS);
  assert.match(open.properties.mode.description, /testing: user-granted on test origins only/);
  for (const tool of TOOLS) {
    for (const name of ['grant', 'level', 'permissions', 'testing']) assert.equal(tool.inputSchema.properties?.[name], undefined, `${tool.name}.${name}`);
  }
});

async function hubServer(t) {
  const hub = createHub({ secret: SECRET, extensionId: EXTENSION_ID, mode: 'daemon' });
  const server = http.createServer((req, res) => {
    if (hub.handleHttp(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const events = [];
  hub.onEvent(event => {
    events.push(event);
    if (event.type === 'hello') event.reply({ mode: 'daemon', endSession: false });
    if (event.type === 'lease') {
      hub.bindLease({ leaseId: 'lease-1', requestId: event.requestId, tabId: event.tabId, origin: event.origin, allowedOrigins: [ORIGIN], level: event.level ?? 'read-only' });
      event.reply({ leaseId: 'lease-1', level: event.level });
    }
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body = {}) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { Origin: EXTENSION_ORIGIN, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  return { hub, post, events };
}

test('hub: the lease message level is validated; command args carry the level clamped to the grant', async t => {
  const { hub, post, events } = await hubServer(t);
  await post('/hello', { v: 3, ext: { version: '0.3.0', protocol: 3 }, session: null });
  const bad = await post('/lease', { requestId: 'req_1', tabId: 3, origin: ORIGIN, level: 'god' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_request');
  assert.equal(events.filter(event => event.type === 'lease').length, 0, 'an invalid level never reaches the daemon');
  const lease = await post('/lease', { requestId: 'req_1', tabId: 3, origin: ORIGIN, level: 'reversible' });
  assert.equal(lease.body.leaseId, 'lease-1');
  assert.equal(events.at(-1).level, 'reversible');
  assert.equal(hub.lease('lease-1').level, 'reversible');

  const bridge = hub.bridgeFor('lease-1');
  const observe = bridge.observe(undefined, { level: 'testing', forbid: ['Upgrade'] });
  const polled = await post('/commands?wait=1000');
  assert.deepEqual(polled.body.command.args, { forbid: ['Upgrade'], level: 'reversible' }, 'never above the grant');
  await post('/results', { id: polled.body.command.id, result: { revision: 'doc:1' } });
  await observe;
  const plain = bridge.observe(undefined, {});
  const second = await post('/commands?wait=1000');
  assert.deepEqual(second.body.command.args, { level: 'reversible' }, 'no level asked: the lease grant (the extension intersects it with the user\'s choice)');
  await post('/results', { id: second.body.command.id, result: { revision: 'doc:2' } });
  await plain;
  // A lower re-grant lowers every later command.
  assert.equal(hub.setLeaseLevel('lease-1', 'read-only'), true);
  const lowered = bridge.observe(undefined, { level: 'full' });
  const third = await post('/commands?wait=1000');
  assert.equal(third.body.command.args.level, 'read-only');
  await post('/results', { id: third.body.command.id, result: { revision: 'doc:3' } });
  await lowered;
});

test('hub: lease_level is validated like lease.level, only lowers, and clamps later commands at once', async t => {
  const { hub, post, events } = await hubServer(t);
  await post('/hello', { v: 3, ext: { version: '0.3.0', protocol: 3 }, session: null });
  await post('/lease', { requestId: 'req_1', tabId: 3, origin: ORIGIN, level: 'testing' });
  assert.equal(hub.lease('lease-1').level, 'testing');
  for (const level of ['god', '', undefined, 3]) {
    const bad = await post('/lease-level', { leaseId: 'lease-1', level });
    assert.equal(bad.status, 400, String(level));
    assert.equal(bad.body.code, 'bad_request');
  }
  assert.equal((await post('/lease-level', { leaseId: 'nope', level: 'full' })).body.code, 'no_request');
  assert.equal(events.filter(event => event.type === 'lease_level').length, 0, 'invalid messages never reach the daemon');
  // The test listener answers nothing for lease_level: reply on its behalf, as the daemon would.
  hub.onEvent(event => {
    if (event.type === 'lease_level') event.reply({ leaseId: event.leaseId, grant: { level: event.level } });
  });
  const lowered = await post('/lease-level', { leaseId: 'lease-1', level: 'full' });
  assert.equal(lowered.status, 200);
  assert.equal(lowered.body.grant.level, 'full');
  assert.equal(hub.lease('lease-1').level, 'full');
  const raised = await post('/lease-level', { leaseId: 'lease-1', level: 'testing' });
  assert.equal(raised.status, 403);
  assert.equal(raised.body.code, 'level_not_granted');
  assert.match(raised.body.error, /new approval in the FAI Browser popup/);
  assert.equal(hub.lease('lease-1').level, 'full');
  const observe = hub.bridgeFor('lease-1').observe(undefined, { level: 'testing' });
  const polled = await post('/commands?wait=1000');
  assert.equal(polled.body.command.args.level, 'full', 'later commands are clamped to the lowered level');
  await post('/results', { id: polled.body.command.id, result: { revision: 'doc:1' } });
  await observe;
});

