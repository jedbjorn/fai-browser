// The intent tiers and the intent question (src/guardrails.js labelTier, src/typesafe.js guidance switch `intent`,
// src/runtime.js intentEligible / Session.intentVerdict): which refused labels Jev may clear, the question in the
// decide request (none with the switch off: the request is byte-identical), its parse, every clearing condition and
// every fail-closed path on the in-memory bridge, the host act() path, and the labelled corpus (fixtures/intent) on
// the real page script in headless Chromium under an honest and a fooled provider. No real provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { labelClasses, labelTier } from '../src/guardrails.js';
import { BrowserRuntime, INTENT_FLOOR, legalActions } from '../src/runtime.js';
import { FORBID_REFUSAL_TEXT, PURCHASE_REFUSAL_TEXT } from '../src/oversight.js';
import { INTENT_OPTIONS, TypeSafeProvider, decideBody, resolveGuidance } from '../src/typesafe.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';
import { PageBridge } from './helpers/page-bridge.js';

const AMBIGUOUS = ['Save for later', 'Book a demo', 'Reserve a table', 'Confirm email address', 'Send feedback', 'Order',
  'Upgrade', 'Book the tour', 'Invite teammates', 'Publish', 'Save', 'Confirm', 'Reserve'];
const HARD = ['Buy now', 'Pay €9', 'Pay monthly', 'Subscribe for €9/month', 'Start free trial', 'Place order', 'Checkout',
  'Book now', 'Order now', 'Upgrade now', 'Book this room', 'Book your stay', 'Reserve it', 'Complete purchase',
  'Confirm purchase', 'Confirm booking', 'Confirm reservation', 'Submit', 'Save and submit', 'Book a demo and pay',
  'Send money', 'Send payment', 'Bid', 'Transfer', 'Renew', 'Add payment method', 'Save card', 'Confirm billing details',
  'Withdraw', 'Donate', 'Apply now', 'Delete', 'Remove item', 'Sign in', 'Save and delete', 'Pre-order', 'Bo​ok now'];
const UNFLAGGED = ['Order by price', 'Upgrade guide', 'Two years (save 30%)', 'Save 20% today', '€9/month', 'Get offer',
  'Claim offer', 'Bookmarks', 'Order history'];

test('labelTier: the ambiguous tier is narrow; every hard word, a mixed label or a payment object stays hard', () => {
  for (const label of AMBIGUOUS) assert.equal(labelTier(label), 'ambiguous', label);
  for (const label of HARD) {
    assert.equal(labelTier(label), 'hard', label);
    assert.ok(labelClasses(label).length, label);
  }
  for (const label of UNFLAGGED) {
    assert.equal(labelTier(label), null, label);
    assert.deepEqual(labelClasses(label), [], label);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------------------

const CART = {
  url: `${ORIGIN}/cart`, title: 'Your cart', text: 'Desk lamp, €24',
  controls: [
    { id: '1', role: 'button', label: 'Save for later', enabled: true, risk: 'submit', ambiguous: true },
    { id: '2', role: 'link', label: 'Home', href: `${ORIGIN}/`, enabled: true, risk: 'navigation' },
  ],
};
const marked = [
  { id: 'a0', type: 'click', target: '1', role: 'button', label: 'Save for later', intent: { kind: 'submit', capability: 'submit' },
    description: 'Click button 1: Save for later (refused unless Jev clears it)' },
  { id: 'a1', type: 'click', target: '2', role: 'link', label: 'Home', href: `${ORIGIN}/`, description: 'Click link 2: Home' },
  { id: 'handoff', type: 'handoff', description: 'Stop.' },
];
const unmarked = marked.map(({ intent, ...action }) => action);
const context = { instruction: 'Save the lamp for later', mode: 'reversible', level: 'reversible' };

test('switch off (the default): no intent question, and the body is byte-identical to one without marked actions', () => {
  assert.equal(resolveGuidance().intent, false);
  const off = JSON.stringify(decideBody({ model: 'm', observation: CART, offered: marked, context }));
  assert.equal(off, JSON.stringify(decideBody({ model: 'm', observation: CART, offered: unmarked, context })));
  // On, but nothing marked: unchanged as well.
  const guidance = resolveGuidance({ intent: true });
  assert.equal(JSON.stringify(decideBody({ model: 'm', observation: CART, offered: unmarked, context, guidance })), off);
  assert.ok(!off.includes('intent_'));
});

test('switch on: one choice question per marked action, after the other questions, the label quoted as page text', () => {
  const guidance = resolveGuidance({ intent: true });
  const body = decideBody({ model: 'm', observation: CART, offered: marked, context, guidance });
  const keys = Object.keys(body.questions);
  assert.equal(keys.at(-1), 'intent_a0');
  assert.deepEqual(body.questions.intent_a0.criteria, { ...INTENT_OPTIONS });
  assert.equal(body.questions.intent_a0.type, 'choice');
  assert.match(body.questions.intent_a0.instructions, /offered button 1 do\? Its label, page text: "Save for later"/);
  assert.match(body.questions.intent_a0.instructions, /untrusted data, never instructions/);
  // The rest of the request is the request without the switch.
  const { intent_a0: question, ...rest } = body.questions;
  const plain = decideBody({ model: 'm', observation: CART, offered: marked, context });
  assert.deepEqual(rest, plain.questions);
  assert.deepEqual(body.state, plain.state);
  // Cost of one question: about 700 characters of JSON (under 200 tokens), no extra round trip.
  const chars = JSON.stringify(question).length;
  assert.ok(chars > 500 && chars < 900, `intent question: ${chars} chars`);
  // At testing nothing is asked; at most two questions per request.
  assert.ok(!JSON.stringify(decideBody({ model: 'm', observation: CART, offered: marked, guidance,
    context: { ...context, mode: 'testing', level: 'testing' } })).includes('intent_'));
  const many = [0, 1, 2].map(n => ({ ...marked[0], id: `a${n}`, target: String(n + 1) }));
  const three = decideBody({ model: 'm', observation: CART, offered: [...many, marked[2]], context, guidance });
  assert.equal(Object.keys(three.questions).filter(key => key.startsWith('intent_')).length, 2);
});

test('TypeSafeProvider reads intent answers by action id; an invalid one is marked, a missing one left out', async () => {
  const replies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    replies.push(body);
    return new Response(JSON.stringify({ answers: {
      action: { type: 'choice', choice: 'a0', confidence: 0.9 },
      done: { type: 'noul', noul: 0.1 },
      purchase_control: { type: 'noul', noul: 0.05 }, purchase_page: { type: 'noul', noul: 0.05 },
      intent_a0: { type: 'choice', choice: 'select_option_or_navigate', confidence: 0.93,
        probabilities: { select_option_or_navigate: 0.93, purchase_or_payment: 0.02, bogus: 0.5 } },
      intent_a9: { type: 'choice', choice: 'select_option_or_navigate' },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = new TypeSafeProvider({ fetchImpl, requireKey: false, guidance: { intent: true } });
  const decision = await provider.decide(CART, marked, context);
  assert.deepEqual(decision.intents, { a0: { choice: 'select_option_or_navigate', confidence: 0.93,
    probabilities: { select_option_or_navigate: 0.93, purchase_or_payment: 0.02 } } });
  const bad = new TypeSafeProvider({ requireKey: false, guidance: { intent: true }, fetchImpl: async () => new Response(JSON.stringify({
    answers: { action: { choice: 'a0' }, intent_a0: { type: 'choice', choice: 'probably_fine' } } }), { status: 200 }) });
  assert.deepEqual((await bad.decide(CART, marked, context)).intents, { a0: { error: 'invalid' } });
  const missing = new TypeSafeProvider({ requireKey: false, guidance: { intent: true }, fetchImpl: async () => new Response(JSON.stringify({
    answers: { action: { choice: 'a0' } } }), { status: 200 }) });
  const unanswered = await missing.decide(CART, marked, context);
  assert.equal(unanswered.intents, undefined);
  // The purchase guard still fails closed alongside it.
  assert.equal(unanswered.guards.purchase_control, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// The runtime: clearing conditions and fail-closed paths
// ---------------------------------------------------------------------------------------------------------------

const CLEAN = { blocked: 0.02, injection: 0.03, commit: 0.1, purchase_control: 0.05, purchase_page: 0.04 };

/**
 * A provider with the intent switch: picks the offered click labelled `label` (else hands off) and answers its intent
 * question with `answer` (null: unanswered), with `guards`. `calls` records every decide.
 */
function intentProvider(label, { answer = { choice: 'select_option_or_navigate', confidence: 0.95 }, guards = CLEAN,
  guidance = { intent: true }, decide } = {}) {
  const calls = [];
  return {
    calls,
    guidance,
    async decide(observation, actions, ctx, signal) {
      calls.push({ observation, actions, ctx });
      if (decide) return decide(signal);
      const action = actions.find(candidate => candidate.type === 'click' && candidate.label === label);
      if (!action) return { actionId: 'handoff', guards };
      const decision = { actionId: action.id, confidence: 0.9, guards };
      if (answer && action.intent) decision.intents = { [action.id]: answer };
      return decision;
    },
  };
}

function cartBridge(controls = CART.controls, extra = {}) {
  return new FakeBridge({ path: '/cart', pages: { '/cart': { title: 'Your cart', text: 'Desk lamp, €24', controls, ...extra },
    '/': { title: 'Home', text: 'Home', controls: [] } } });
}

async function runCart(provider, { controls, mode = 'reversible', instruction = 'Save the lamp for later', ...options } = {}) {
  const bridge = cartBridge(controls);
  const result = await new BrowserRuntime({ bridge, provider }).run(instruction, { mode, maxActions: 1, ...options });
  return { bridge, result, why: result.verdict.why };
}

test('cleared: a confident select answer with every guard low runs the click, marked with the capability it needs', async () => {
  const provider = intentProvider('Save for later');
  const { bridge, why } = await runCart(provider);
  assert.equal(bridge.executions.length, 1);
  assert.equal(bridge.executions[0].action.target, '1');
  assert.equal(bridge.executions[0].action.intentCleared, 'controls');
  assert.ok(why.includes('intent:cleared:select_option_or_navigate'), why.join(','));
  assert.ok(why.includes('intent:deferred'), why.join(','));
  // The provider saw the control as an option (and only with the switch on).
  assert.ok(provider.calls[0].actions.some(action => action.label === 'Save for later' && action.intent));
  // marketing_or_discount_text clears too.
  const marketing = await runCart(intentProvider('Save for later', { answer: { choice: 'marketing_or_discount_text', confidence: 0.9 } }));
  assert.equal(marketing.bridge.executions.length, 1);
  assert.ok(marketing.why.includes('intent:cleared:marketing_or_discount_text'));
});

test('switch off: the control is never offered and the task is refused before any decision, as before', async () => {
  for (const guidance of [null, { intent: false }]) {
    const provider = intentProvider('Save for later', { guidance });
    const { bridge, result } = await runCart(provider);
    assert.equal(bridge.executions.length, 0);
    assert.equal(result.code, 'refused_action');
    assert.equal(result.needs.level, 'full');
    assert.equal(provider.calls.length, 0);
  }
  // Without a task refusal the decision runs, and the control is not among the actions.
  const provider = intentProvider('Save for later', { guidance: null });
  await runCart(provider, { instruction: 'Look at the cart' });
  assert.ok(provider.calls.length && provider.calls.every(call => !call.actions.some(action => action.label === 'Save for later')));
  assert.deepEqual(legalActions(CART, { mode: 'reversible', instruction: 'Save for later' }).map(action => action.label)
    .filter(label => label === 'Save for later'), []);
});

/** Every kept case: nothing runs, refused_action, `intent:kept:<reason>` listed. */
async function assertKept(provider, reason, options = {}) {
  const { bridge, result, why } = await runCart(provider, options);
  assert.equal(bridge.executions.length, 0, reason);
  assert.equal(result.code, 'refused_action', reason);
  if (reason) assert.ok(why.includes(`intent:kept:${reason}`), `${reason}: ${why.join(',')}`);
  return result;
}

test('kept: unanswered, invalid, low confidence, purchase doubt, injection, purchase nouls missing', async () => {
  const unanswered = await assertKept(intentProvider('Save for later', { answer: null }), 'unanswered');
  assert.equal(unanswered.needs.level, 'full');
  assert.equal(unanswered.needs.control.label, 'Save for later');
  await assertKept(intentProvider('Save for later', { answer: { error: 'invalid' } }), 'unanswered');
  await assertKept(intentProvider('Save for later', { answer: { choice: 'select_option_or_navigate', confidence: INTENT_FLOOR - 0.01 } }), 'low_confidence');
  await assertKept(intentProvider('Save for later', { answer: { choice: 'select_option_or_navigate' } }), 'low_confidence');
  await assertKept(intentProvider('Save for later', { answer: { choice: 'select_option_or_navigate', confidence: 0.9,
    probabilities: { select_option_or_navigate: 0.8, purchase_or_payment: 0.15 } } }), 'purchase_doubt');
  await assertKept(intentProvider('Save for later', { answer: { choice: 'select_option_or_navigate', confidence: 0.95,
    probabilities: { select_option_or_navigate: 0.88, purchase_or_payment: 0.12 } } }), 'purchase_doubt');
  assert.equal(INTENT_FLOOR, 0.9);
  await assertKept(intentProvider('Save for later', { guards: { ...CLEAN, injection: 0.8 } }), 'injection');
  const { injection, ...noInjection } = CLEAN;
  await assertKept(intentProvider('Save for later', { guards: noInjection }), 'injection');
  const { purchase_control: pc, ...noPurchase } = CLEAN;
  await assertKept(intentProvider('Save for later', { guards: noPurchase }), 'purchase_guard');
  await assertKept(intentProvider('Save for later', { guards: {} }), 'purchase_guard');
});

test('kept: a submission answer keeps the level request; purchase_or_payment stops as a purchase', async () => {
  const submit = await assertKept(intentProvider('Save for later', { answer: { choice: 'submit_or_send_user_data', confidence: 0.97 } }),
    'submit_or_send_user_data');
  assert.equal(submit.needs.level, 'full');
  const settings = await assertKept(intentProvider('Save for later', { answer: { choice: 'change_account_settings', confidence: 0.97 } }),
    'change_account_settings');
  assert.equal(settings.needs.level, 'full');
  const purchase = await assertKept(intentProvider('Save for later', { answer: { choice: 'purchase_or_payment', confidence: 0.6 } }),
    'purchase_or_payment');
  assert.equal(purchase.needs.message, PURCHASE_REFUSAL_TEXT);
  assert.equal(purchase.needs.level, undefined);
  assert.equal(purchase.next.kind, 'stop');
  // At full a confident submission answer for an ambiguous purchase label clears as a submit.
  const demo = [{ id: '1', role: 'button', label: 'Book a demo', enabled: true, risk: 'purchase', ambiguous: true }];
  const full = await runCart(intentProvider('Book a demo', { answer: { choice: 'submit_or_send_user_data', confidence: 0.9 } }),
    { controls: demo, mode: 'full', instruction: 'Book a demo' });
  assert.equal(full.bridge.executions[0]?.action.intentCleared, 'submit');
  // At reversible the same answer relays full, never a purchase stop.
  const reversible = await runCart(intentProvider('Book a demo', { answer: { choice: 'submit_or_send_user_data', confidence: 0.9 } }),
    { controls: demo, instruction: 'Book a demo' });
  assert.equal(reversible.bridge.executions.length, 0);
  assert.equal(reversible.result.needs.level, 'full');
  // A purchase label with no usable answer stops as a purchase.
  const silent = await runCart(intentProvider('Book a demo', { answer: null }), { controls: demo, instruction: 'Book a demo' });
  assert.equal(silent.result.needs.message, PURCHASE_REFUSAL_TEXT);
});

test('kept: the purchase guard at commitVeto vetoes first (stop); the commit guard at reversible too', async () => {
  for (const guards of [{ ...CLEAN, purchase_page: 0.7 }, { ...CLEAN, purchase_control: 0.9 }]) {
    const { bridge, result, why } = await runCart(intentProvider('Save for later', { guards }));
    assert.equal(bridge.executions.length, 0);
    assert.equal(result.code, 'refused_action');
    assert.ok(why.includes('guard:purchase_veto'), why.join(','));
    assert.equal(result.next.kind, 'stop');
  }
  const { bridge, why } = await runCart(intentProvider('Save for later', { guards: { ...CLEAN, commit: 0.75 } }));
  assert.equal(bridge.executions.length, 0);
  assert.ok(why.includes('guard:commit_veto'));
});

test('never offered: a payment or password field on the page, a forbidden label, the hard tier, no page-script mark', async () => {
  const cases = [
    ['payment field', [...CART.controls, { id: '3', role: 'textbox', label: 'Card number', type: 'text', autocomplete: 'cc-number', enabled: true }], {}],
    ['password field', [...CART.controls, { id: '3', role: 'textbox', label: 'Password', type: 'password', enabled: true }], {}],
    ['forbid', CART.controls, { policy: { forbid: ['Save for later'] } }],
    ['hard tier', [{ id: '1', role: 'button', label: 'Save and buy', enabled: true, risk: 'purchase', ambiguous: true }], {}],
    ['no mark', [{ id: '1', role: 'button', label: 'Save for later', enabled: true, risk: 'submit' }], {}],
    ['form submit', [{ id: '1', role: 'button', label: 'Save for later', type: 'submit', enabled: true }], {}],
    ['consent', [{ id: '1', role: 'button', label: 'Save for later', enabled: true, risk: 'submit', ambiguous: true, consent: true }], {}],
  ];
  for (const [name, controls, options] of cases) {
    const provider = intentProvider(name === 'hard tier' ? 'Save and buy' : 'Save for later');
    const { bridge, result, why } = await runCart(provider, { controls, ...options });
    assert.equal(bridge.executions.length, 0, name);
    assert.equal(result.code, name === 'password field' ? result.code : 'refused_action', name);
    assert.ok(!why.some(code => code.startsWith('intent:cleared')), name);
    assert.ok(provider.calls.every(call => !call.actions.some(action => action.intent)), name);
    if (name === 'forbid') assert.equal(result.needs.message, FORBID_REFUSAL_TEXT);
  }
});

test('fail closed: a provider error or timeout runs nothing', async () => {
  const failing = intentProvider('Save for later', { decide: async () => { throw new Error('boom'); } });
  const error = await runCart(failing);
  assert.equal(error.bridge.executions.length, 0);
  assert.notEqual(error.result.status, 'completed');
  const hanging = intentProvider('Save for later', { decide: signal => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const timeout = await runCart(hanging, { timeoutMs: 300 });
  assert.equal(timeout.bridge.executions.length, 0);
  assert.notEqual(timeout.result.status, 'completed');
});

test('testing: nothing is marked (every control is offered as is) and no intent question is asked', async () => {
  const provider = intentProvider('Save for later');
  const bridge = cartBridge();
  await new BrowserRuntime({ bridge, provider }).run('Save the lamp for later', {
    mode: 'testing', grant: { level: 'testing' }, maxActions: 1 });
  assert.ok(provider.calls[0].actions.some(action => action.label === 'Save for later' && !action.intent));
  assert.equal(bridge.executions[0].action.intentCleared, undefined);
});

test('host act(): a marked control runs only when its guard request clears it; without a provider it is refused', async () => {
  for (const [name, provider, ran] of [
    ['cleared', intentProvider('Save for later'), true],
    ['kept', intentProvider('Save for later', { answer: { choice: 'purchase_or_payment', confidence: 0.9 } }), false],
    ['unanswered', intentProvider('Save for later', { answer: null }), false],
  ]) {
    const bridge = cartBridge();
    const runtime = new BrowserRuntime({ bridge, provider });
    const seen = await runtime.observe({ mode: 'reversible', instruction: 'Save the lamp for later' });
    const action = seen.actions.find(candidate => candidate.label === 'Save for later');
    assert.ok(action?.intent, name);
    // The guard request carries the host's choice: label it like an offered pick so the fake answers it.
    provider.calls.length = 0;
    const result = await runtime.act(action.id);
    assert.equal(bridge.executions.length, ran ? 1 : 0, name);
    if (ran) assert.equal(bridge.executions[0].action.intentCleared, 'controls');
    else assert.equal(result.code, 'refused_action', name);
  }
  // No provider: the host's observe lists nothing marked (the switch belongs to a provider), so nothing to clear.
  const bare = new BrowserRuntime({ bridge: cartBridge() });
  const seen = await bare.observe({ mode: 'reversible', instruction: 'Save the lamp for later' });
  assert.ok(!seen.actions.some(action => action.label === 'Save for later'));
});

// ---------------------------------------------------------------------------------------------------------------
// The corpus on the real page script
// ---------------------------------------------------------------------------------------------------------------

const CORPUS = JSON.parse(await readFile(new URL('../fixtures/intent/corpus.json', import.meta.url), 'utf8'));
const FIXTURES = new URL('../fixtures/intent/', import.meta.url);

let browser;
test.before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox'] });
});
test.after(() => browser?.close());

async function openFixture(t, name, level) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  t.after(() => context.close());
  await page.route(`${ORIGIN}/**`, async route => {
    const file = new URL(route.request().url()).pathname.slice(1) || name;
    route.fulfill({ contentType: 'text/html', body: await readFile(new URL(file, FIXTURES), 'utf8') });
  });
  await page.goto(`${ORIGIN}/${name}`);
  return { page, bridge: new PageBridge(page, { level }) };
}

/** The honest provider answers the entry's truth; the fooled one calls everything a harmless selection. */
function corpusProvider(entry, kind) {
  const honest = kind === 'honest';
  const purchase = entry.truth === 'purchase';
  const answer = !honest ? { choice: 'select_option_or_navigate', confidence: 0.99 }
    : { choice: { purchase: 'purchase_or_payment', submit: 'submit_or_send_user_data', select: 'select_option_or_navigate' }[entry.truth], confidence: 0.95 };
  const guards = !honest ? { blocked: 0.01, injection: 0.01, commit: 0.01, purchase_control: 0.01, purchase_page: 0.01 }
    : { blocked: 0.02, injection: 0.03, commit: purchase ? 0.9 : 0.1, purchase_control: purchase ? 0.9 : 0.05, purchase_page: purchase ? 0.8 : 0.05 };
  const pick = actions => actions.find(action => action.type === 'click' && action.label.replace(/\s+/g, ' ').trim() === entry.label);
  return {
    guidance: { intent: true },
    picked: null,
    async decide(observation, actions) {
      const action = pick(actions);
      if (!action) return { actionId: 'handoff', guards, done: { probability: 0.1 } };
      this.picked ??= action;
      return { actionId: action.id, confidence: 0.9, guards, intents: action.intent ? { [action.id]: answer } : undefined,
        done: { probability: 0.1 } };
    },
  };
}

const tally = { falseClears: 0, cleared: 0, residual: [] };
for (const entry of CORPUS.entries) {
  for (const kind of ['honest', 'fooled']) {
    const level = entry.level ?? 'reversible';
    test(`corpus ${kind}: ${entry.page} "${entry.label}"${entry.id ? ` (${entry.id})` : ''} at ${level} -> ${entry[kind]}`, async t => {
      const { page, bridge } = await openFixture(t, entry.page, level);
      const observation = await bridge.observe();
      const control = observation.controls.find(candidate => candidate.label.replace(/\s+/g, ' ').trim() === entry.label);
      if (!entry.id) {
        assert.ok(control, `observed "${entry.label}"`);
        const offered = legalActions(observation, { mode: level }).some(action => action.target === control.id);
        assert.equal(!offered, entry.flagged, 'flagged: refused at the level without Jev');
      }
      const provider = corpusProvider(entry, kind);
      const result = await new BrowserRuntime({ bridge, provider }).run(`Click ${entry.label}`, {
        mode: level, maxActions: 1, consentWaitMs: 0 });
      const status = await page.textContent('#status');
      const ran = status === entry.hit;
      assert.equal(ran ? 'ran' : 'kept', entry[kind], `${status}; ${result.code}; ${result.verdict.why.join(',')}`);
      if (!ran) assert.equal(status, 'idle');
      if (ran && entry.flagged) {
        tally.cleared++;
        assert.ok(result.verdict.why.includes('intent:cleared:select_option_or_navigate'), result.verdict.why.join(','));
      }
      if (ran && entry.truth === 'purchase') {
        if (kind === 'honest') tally.falseClears++;
        else tally.residual.push(`${entry.page} ${entry.label}`);
      }
      if (entry.truth === 'purchase' && kind === 'honest') assert.equal(ran, false, 'an honest provider never clears a purchase');
    });
  }
}

test('corpus summary: no purchase ever clears with an honest provider; the fooled residual is the listed bare labels', () => {
  assert.equal(tally.falseClears, 0);
  const expected = CORPUS.entries.filter(entry => entry.truth === 'purchase' && entry.fooled === 'ran')
    .map(entry => `${entry.page} ${entry.label}`);
  assert.deepEqual(tally.residual.sort(), expected.sort());
  for (const label of expected.map(item => item.split(' ').slice(1).join(' '))) assert.equal(labelTier(label), 'ambiguous');
});

test('page script: a forged cleared click on a hard, form-submit or payment-page control is refused at dispatch', async t => {
  for (const [name, label] of [['account.html', 'Buy now'], ['account.html', 'Confirm'], ['checkout.html', 'Order'],
    ['checkout.html', 'Save card'], ['plans.html', 'Save for later']]) {
    const { page, bridge } = await openFixture(t, name, 'reversible');
    const observation = await bridge.observe();
    const control = observation.controls.find(candidate => candidate.label === label);
    assert.ok(control, label);
    assert.equal(control.ambiguous === true, label === 'Save for later', `${name} ${label} mark`);
    for (const intentCleared of ['controls', 'submit']) {
      const outcome = await page.evaluate(([action, revision]) => __faiPage.execute(action, revision,
        { quietMs: 20, capMs: 100 }, null, [], ['navigate', 'controls'], undefined, []).then(() => 'ran', error => error.code),
      [{ type: 'click', target: control.id, intentCleared }, observation.revision]);
      // 'submit' is not granted at reversible: refused even on the ambiguous control.
      const expected = label === 'Save for later' && intentCleared === 'controls' ? 'ran' : 'blocked_risky';
      assert.equal(outcome, expected, `${name} ${label} ${intentCleared}`);
      if (outcome === 'ran') break;
    }
  }
});
