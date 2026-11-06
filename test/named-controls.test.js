// Named controls (round 6 E1): the buttons an instruction names as click targets. The `named` guidance line
// (src/typesafe.js), the matcher (src/relevance.js namedControls) and the runtime's two named rules
// (named:done_pending, named:clicks_done).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { bareLabel, nameableControl, namedControls } from '../src/relevance.js';
import { DEFAULT_GUIDANCE, GUIDANCE_KEYS, decideBody, namedPolicyLine, requestSizes, resolveGuidance } from '../src/typesafe.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id: `a${id}`, type: 'click', target: String(id), role: 'button', label, ...extra });
const OFFERED = [
  button(1, 'Next'), button(2, 'Submit order'), button(3, 'Next page'), button(4, 'Continue →'), button(5, 'Delete'),
  button(6, 'Show 4 more flights'), button(7, 'Upgrade'), button(8, 'Apply'),
  { id: 'a9', type: 'click', target: '9', role: 'link', label: 'Back', href: `${ORIGIN}/back` },
  { id: 'a10', type: 'fill_supplied_text', target: '10', role: 'textbox', label: 'Email', suppliedName: 'email' },
  { id: 'a11', type: 'click', target: '11', role: 'button', label: 'Reject all', consent: true },
];
const names = (instruction, options) => namedControls(instruction, OFFERED, options).map(entry => entry.label);

test('namedControls: a click verb before an offered button label names it, in the instruction spelling', () => {
  assert.deepEqual(names('Fill Full name with full_name and Email with email, then click Next.'), ['Next']);
  assert.deepEqual(names('Then press the "Show 4 more flights" button.'), ['Show 4 more flights']);
  assert.deepEqual(names('tap on Next'), ['Next']);
  assert.deepEqual(names('Click next.'), ['next'], 'case-insensitive; the host spelling is kept');
  assert.deepEqual(names('Click Continue.'), ['Continue'], 'trailing arrows and symbols are not part of the label');
  assert.deepEqual(names('Click Apply.'), ['Apply'], 'an ordinary view control (harmlessControlLabel) is nameable');
  assert.deepEqual(names('Click Next page.'), ['Next page'], 'the longer label wins over its prefix');
  assert.deepEqual(namedControls('click Next', OFFERED)[0].ids, ['a1']);
});

test('namedControls: never without a click verb, in a negated clause, or for links, fills, consent and commit labels', () => {
  for (const instruction of ['Go to the next step.', 'Answer Yes', 'clicking Next', 'Do not click Next.',
    'never click Next', 'Next, then Continue', 'Click Back.', 'Click Email.', 'Click Reject all.', 'Click Submit order.',
    'Click Delete.', '', undefined]) {
    assert.deepEqual(names(instruction), [], String(instruction));
  }
  assert.deepEqual(names('Step 6 (Review): click Next; never click Submit order.'), ['Next']);
  assert.deepEqual(names('Click Upgrade.'), [], 'a commit-intent label (Upgrade) is never named');
  assert.deepEqual(names('Click Show 4 more flights.', { forbid: ['more flights'] }), [], "the user's forbid phrases are never named");
  assert.equal(nameableControl(button(1, 'Place order')), false);
  assert.equal(nameableControl(button(1, 'Sign in')), false);
  assert.equal(nameableControl(button(1, 'Send')), false);
  assert.equal(nameableControl({ ...button(1, 'Next'), href: `${ORIGIN}/x` }), false);
  assert.equal(nameableControl({ id: 'a1', type: 'select', target: '1', role: 'combobox', label: 'Next' }), false);
  assert.equal(bareLabel('  ‹ Back  '), 'Back');
});

test('namedControls: a label is used up once the run has clicked it as often as the instruction names it', () => {
  const click = label => ({ i: 1, type: 'click', label, changed: true });
  assert.deepEqual(names('Fill Email, then click Next.', { history: [click('Next')] }), []);
  assert.deepEqual(names('Fill Email, then click Next.', { history: [click('Next page')] }), ['Next']);
  assert.deepEqual(names('Fill Email, then click Next.', { history: [{ i: 1, type: 'fill_supplied_text', label: 'Next' }] }), ['Next']);
  const wizard = 'Step 1: click Next. Step 2: click Next. Step 3: click Next.';
  assert.deepEqual(names(wizard, { history: [click('Next'), click('Next')] }), ['Next']);
  assert.deepEqual(names(wizard, { history: [click('Next'), click('Next'), click('Next')] }), []);
  assert.equal(namedControls('click Next, click Next page, click Apply, click Show 4 more flights', OFFERED).length, 3, 'at most three');
});

const OBSERVATION = {
  url: `${ORIGIN}/wizard/step-1`, title: 'Step 1', text: 'Contact\nFull name\nEmail\nNext',
  controls: [{ id: '1', role: 'textbox', label: 'Email', filled: true }, { id: '3', role: 'button', label: 'Next' }],
};
const WIZARD_OFFERED = [
  { id: 'a0', type: 'fill_supplied_text', target: '1', role: 'textbox', label: 'Email', suppliedName: 'email' },
  button(3, 'Next'),
  { id: 'handoff', type: 'handoff', description: 'Stop' },
];

test('the named policy line: last in state.policy, only when the instruction names an offered button', () => {
  assert.ok(GUIDANCE_KEYS.includes('named'));
  assert.equal(DEFAULT_GUIDANCE.named, true);
  const context = { instruction: 'Fill Email with email, then click Next.', mode: 'reversible', level: 'reversible' };
  const body = decideBody({ model: 'm', observation: OBSERVATION, offered: WIZARD_OFFERED, context });
  assert.equal(body.state.policy.named, namedPolicyLine(['Next']));
  assert.equal(Object.keys(body.state.policy).at(-1), 'named');
  assert.match(body.state.policy.named, /^`instruction` names the offered button "Next": when the page does not say it orders/);
  assert.equal(requestSizes(body).named, 1, 'the trace marker counts the named buttons');
  // Off: byte-identical to a body whose instruction names nothing, apart from the instruction.
  const off = decideBody({ model: 'm', observation: OBSERVATION, offered: WIZARD_OFFERED, context,
    guidance: resolveGuidance({ named: false }) });
  assert.equal(off.state.policy.named, undefined);
  assert.equal(requestSizes(off).named, undefined);
  const { named, ...rest } = body.state.policy;
  assert.deepEqual(off.state.policy, rest);
  assert.deepEqual(off.questions, body.questions);
  // No named button (or the policy switch off): unchanged with the switch on.
  const plain = { ...context, instruction: 'Fill Email with email and continue.' };
  assert.equal(JSON.stringify(decideBody({ model: 'm', observation: OBSERVATION, offered: WIZARD_OFFERED, context: plain })),
    JSON.stringify(decideBody({ model: 'm', observation: OBSERVATION, offered: WIZARD_OFFERED, context: plain,
      guidance: resolveGuidance({ named: false }) })));
  const noPolicy = decideBody({ model: 'm', observation: OBSERVATION, offered: WIZARD_OFFERED, context,
    guidance: resolveGuidance({ policy: false }) });
  assert.equal(noPolicy.state.policy, undefined);
  // Used up by the history: the line goes away after the Next click.
  const after = decideBody({ model: 'm', observation: OBSERVATION, offered: WIZARD_OFFERED,
    context: { ...context, history: [{ i: 1, type: 'click', label: 'Next' }] } });
  assert.equal(after.state.policy.named, undefined);
  assert.equal(namedPolicyLine(['Next', 'Show "all"']),
    '`instruction` names the offered buttons "Next", "Show all": when the page does not say one orders, pays, books, '
    + 'subscribes, sends or deletes, choosing it is part of the request.');
});

// A wizard: step 4 has a select and a Next button (a script button that navigates), step 5 a Next of its own.
const WIZARD = {
  '/step-4': {
    title: 'Step 4', text: 'Delivery\nDelivery speed\nNext',
    controls: [
      { id: '1', role: 'combobox', label: 'Delivery speed', enabled: true, risk: 'reversible', selectedValue: '',
        options: [{ value: '', label: 'Choose…' }, { value: 'standard', label: 'Standard (3-5 days)' }] },
      { id: '2', role: 'button', label: 'Next', type: 'button', enabled: true, risk: 'reversible', href: `${ORIGIN}/step-5` },
    ],
  },
  '/step-5': {
    title: 'Step 5', text: 'Notes\nDelivery notes\nNext',
    controls: [{ id: '1', role: 'button', label: 'Next', type: 'button', enabled: true, risk: 'reversible', href: `${ORIGIN}/step-6` }],
  },
  '/step-6': { title: 'Step 6', text: 'Review', controls: [] },
};

/** Scripted provider: per path, a list of { pick: 'select'|label|'handoff', done, confidence }, consumed in order. */
function scripted(script) {
  const used = {};
  const calls = [];
  return {
    calls,
    model: 'fake-named',
    async decide(observation, actions, context) {
      const path = new URL(observation.url).pathname;
      const index = used[path] = (used[path] ?? -1) + 1;
      const step = script[path][Math.min(index, script[path].length - 1)];
      calls.push({ path, context });
      const action = step.pick === 'select'
        ? actions.find(a => a.type === 'select' && a.value === 'standard')
        : step.pick === 'handoff' ? { id: 'handoff' } : actions.find(a => a.type === 'click' && a.label === step.pick);
      const confidence = step.confidence ?? 0.95;
      return { actionId: action.id, confidence, done: { probability: step.done },
        probabilities: { [action.id]: confidence, handoff: 1 - confidence } };
    },
  };
}

const runWizard = (instruction, script, options = {}) => {
  const bridge = new FakeBridge({ pages: WIZARD, path: '/step-4' });
  const provider = scripted(script);
  const runtime = new BrowserRuntime({ bridge, provider });
  return runtime.run(instruction, { mode: 'reversible', expectation: { urlIncludes: '/step-5' }, maxActions: 4, ...options })
    .then(result => ({ result, bridge, provider }));
};

test('named:done_pending: a done claim does not count while the provider chooses the button the instruction names', async () => {
  // Live b runs: after the select, done read 0.75 and then 0.68 while Jev chose Next at 0.97; the second done claim
  // ended the step as expectation_failed before Next ran.
  const script = { '/step-4': [{ pick: 'select', done: 0.75 }, { pick: 'Next', done: 0.68 }], '/step-5': [{ pick: 'handoff', done: 0.9 }] };
  const { result, bridge } = await runWizard('Choose "Standard (3-5 days)" in Delivery speed, then click Next.', script);
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.status, 'completed');
  assert.deepEqual(bridge.executions.map(e => e.action.type), ['select', 'click']);
  assert.ok(result.verdict.why.includes('named:done_pending'));
  assert.equal(result.steps[1].decision.by, 'provider', 'the provider chose the click; the rule only kept it from being stopped');
  // Without a named button the old rule stands: two done claims on a failing expectation end the run.
  const plain = await runWizard('Choose "Standard (3-5 days)" in Delivery speed and continue.', script);
  assert.equal(plain.result.code, 'expectation_failed');
  assert.equal(plain.bridge.executions.length, 1);
  assert.ok(!plain.result.verdict.why.includes('named:done_pending'));
});

test('named:done_pending is bounded: once the named click ran, done claims count again', async () => {
  // Next does nothing here (no href): after one Next the instruction's one named click is used up, so the next two
  // done claims on the failing expectation end the run as before.
  const pages = structuredClone(WIZARD);
  delete pages['/step-4'].controls[1].href;
  const bridge = new FakeBridge({ pages, path: '/step-4' });
  const provider = scripted({ '/step-4': [{ pick: 'Next', done: 0.7 }] });
  const runtime = new BrowserRuntime({ bridge, provider });
  const result = await runtime.run('Click Next.', { mode: 'reversible', expectation: { urlIncludes: '/step-5' }, maxActions: 6 });
  assert.equal(result.code, 'expectation_failed');
  assert.ok(result.verdict.why.includes('named:done_pending'));
  assert.equal(bridge.executions.length, 2, 'the named click plus one the old rule allows');
});

test('named:clicks_done: after the named clicks ran, a doubtful choice on a passing page completes the step', async () => {
  // Live b runs: step 4's Next landed on step 5 (expectation passes, done 0.35-0.4), then step 5's own Next came back
  // at 0.48-0.52, under controlFloor: low_confidence ended the list.
  const script = {
    '/step-4': [{ pick: 'select', done: 0.2 }, { pick: 'Next', done: 0.3 }],
    '/step-5': [{ pick: 'Next', done: 0.35, confidence: 0.48 }],
  };
  const { result, bridge } = await runWizard('Choose "Standard (3-5 days)" in Delivery speed, then click Next.', script);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'handoff_expectation_passed');
  assert.ok(result.verdict.why.includes('named:clicks_done'));
  assert.equal(bridge.executions.length, 2, 'the doubtful click did not run');
  assert.equal(result.page.url, `${ORIGIN}/step-5`);
  // No named click in the instruction: the floor returns low_confidence as before.
  const plain = await runWizard('Choose "Standard (3-5 days)" in Delivery speed and continue.', script);
  assert.equal(plain.result.code, 'low_confidence');
  // A named click still to come (the instruction names Next twice, one ran): the floor still decides.
  const twice = await runWizard('Choose "Standard (3-5 days)" in Delivery speed, then click Next, then click Next.', script);
  assert.equal(twice.result.code, 'low_confidence');
  // A failing expectation is never completed by the rule.
  const failing = await runWizard('Choose "Standard (3-5 days)" in Delivery speed, then click Next.', script,
    { expectation: { urlIncludes: '/step-9' } });
  assert.equal(failing.result.code, 'low_confidence');
});

test('the named rules never run below controls (read-only offers no buttons) and never lift the commit guard', async () => {
  const bridge = new FakeBridge({ pages: WIZARD, path: '/step-4' });
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      const next = actions.find(a => a.type === 'click' && a.label === 'Next');
      return { actionId: next.id, confidence: 0.95, done: { probability: 0.7 }, guards: { commit: 0.9 } };
    },
  };
  const runtime = new BrowserRuntime({ bridge, provider });
  const result = await runtime.run('Click Next.', { mode: 'reversible', expectation: { urlIncludes: '/step-5' } });
  assert.equal(result.code, 'refused_action', 'the commit veto still refuses a named Next the guard scores as a commit');
  assert.equal(bridge.executions.length, 0);
  assert.ok(result.verdict.why.includes('guard:commit_veto'));
});

// Round 6 E1 review: attacks on the matcher's "plain button" gate, and the runtime rules' bounds.
test('namedControls review: negations with typographic apostrophes, contractions and except/instead are refused', () => {
  const offered = [button(1, 'Next'), button(2, 'Continue')];
  const named = instruction => namedControls(instruction, offered).map(entry => entry.label);
  for (const instruction of ['Don’t click Continue.', 'You shouldn’t press Continue', "Please don't press Continue",
    'You mustnʼt tap Continue', 'Never, ever press Continue', 'You cannot hit Continue', 'Do NOT click Continue',
    'Neither scroll nor click Continue', 'Instead, press Continue', 'Click everything except Continue']) {
    assert.deepEqual(named(instruction), [], instruction);
  }
  assert.deepEqual(named('Click Next but don’t click Continue.'), ['Next']);
  assert.deepEqual(named('Click Next, never Submit order.'), ['Next']);
  assert.deepEqual(named('Continue must not be clicked.'), [], 'no click verb before the label');
  assert.deepEqual(named('Klicke Weiter; haz clic en Siguiente'), [], 'non-English verbs name nothing');
});

test('namedControls review: homoglyph, invisible, descriptor and binding-verb labels are never named', () => {
  const one = (instruction, label) => namedControls(instruction, [button(1, label)]).map(entry => entry.label);
  // The deny list and the intents are checked on the folded safety spelling, as the guardrail classes are.
  assert.deepEqual(one('Click Deactivate', 'Deactivate'), []);
  assert.deepEqual(one('Click Deаctivate', 'Deаctivate'), [], 'Cyrillic a: still the deactivate intent');
  assert.deepEqual(one('Click Rеgister', 'Rеgister'), [], 'Cyrillic e: still the register intent');
  assert.deepEqual(one('Click Pl​ace order', 'Pl​ace order'), [], 'zero-width inside a purchase label');
  assert.deepEqual(one('Click Ne​xt', 'Ne​xt'), [], 'invisible characters never reach the policy line');
  assert.deepEqual(one('Click Next', 'N e x t'), [], 'spaced letters do not match the instruction');
  assert.deepEqual(one('Click unlabelled button 1 of 2 next to Review', 'unlabelled button 1 of 2 next to Review'), []);
  assert.deepEqual(one('Click unlabelled button 1 of 2 next to Place order', 'unlabelled button 1 of 2 next to Place order'), []);
  for (const label of ['Move to trash', 'Empty trash', 'Discard', 'Approve', 'Accept', 'Accept offer', 'I agree', 'Sign',
    'Merge', 'Deploy', 'Withdraw', 'Transfer funds', 'Enroll', 'Claim', 'Rent', 'Archive', 'Reset password', 'Share',
    'Cancel', 'Unsubscribe', 'Pay', 'Pay now', 'Next: Review and pay', 'Upgrade', 'Confirm', 'Register']) {
    assert.deepEqual(one(`Click "${label}".`, label), [], label);
  }
  // A prefix of a dangerous label names only an offered plain button of exactly that label.
  assert.deepEqual(namedControls('Click Pay.', [button(1, 'Pay now')]), []);
  assert.deepEqual(namedControls('Click Next.', [button(1, 'Next and pay')]), []);
  for (const label of ['Next', 'Continue', 'Yes', 'OK', 'Done', 'Show 4 more flights']) assert.deepEqual(one(`Click ${label}.`, label), [label]);
});

test('the named line respects the policy bound: three 60-character labels after every addition', async () => {
  const { jevPolicy } = await import('../src/guardrails.js');
  const labels = ['A', 'B', 'C'].map(letter => `${letter}${'x'.repeat(58)}`);
  const offered = [...labels.map((label, i) => button(i + 1, label)), { id: 'handoff', type: 'handoff', description: 'Stop' }];
  const forbid = Array.from({ length: 20 }, (_, i) => `${'y'.repeat(57)} ${String(i).padStart(2, '0')}`);
  const context = { instruction: labels.map(label => `click ${label}`).join(', then '), mode: 'reversible', level: 'reversible',
    guardrails: { forbid, note: 'n'.repeat(200) } };
  const body = decideBody({ model: 'm', observation: OBSERVATION, offered, context });
  assert.equal(Object.keys(body.state.policy).at(-1), 'named');
  assert.equal(requestSizes(body).named, 3);
  const max = jevPolicy({ mode: 'reversible', forbid, note: 'n'.repeat(200) });
  assert.ok(JSON.stringify(body.state.policy).startsWith(JSON.stringify(max).slice(0, -1) + ','), 'the core and additions prefix is unchanged');
  assert.ok(JSON.stringify(body.state.policy).length - JSON.stringify(max).length < 400);
});

test('named:clicks_done needs a named click that changed the page: a pre-passing start page does not qualify', async () => {
  // The expectation already passes on the start page.
  const loose = { expectation: { urlIncludes: '/step-' } };
  const doubtful = { '/step-4': [{ pick: 'Next', done: 0.3, confidence: 0.48 }] };
  const first = await runWizard('Choose "Standard (3-5 days)" in Delivery speed, then click Next.', doubtful, loose);
  assert.equal(first.result.code, 'low_confidence', 'no named click ran yet');
  // A named Next that changes nothing, then a doubtful choice on the same pre-passing page: not a completion.
  const pages = structuredClone(WIZARD);
  delete pages['/step-4'].controls[1].href;
  const bridge = new FakeBridge({ pages, path: '/step-4' });
  // A click that changes nothing: same revision, same URL.
  bridge.execute = async function (action, expectedRevision, { capture } = {}) {
    this.executions.push({ action, expectedRevision, capture });
    return { observation: this.observation, settle: { reason: 'quiet', ms: 3 }, screenshot: Promise.resolve(null) };
  };
  const provider = scripted({ '/step-4': [{ pick: 'Next', done: 0.3 }, { pick: 'Next', done: 0.3, confidence: 0.48 }] });
  const result = await new BrowserRuntime({ bridge, provider }).run('Click Next.', { mode: 'reversible', ...loose, maxActions: 4 });
  assert.equal(result.code, 'low_confidence');
  assert.ok(!result.verdict.why.includes('named:clicks_done'));
});

test('named:done_pending never extends a run past maxActions and never fires for a choice that is not named', async () => {
  const chain = {};
  for (let i = 1; i <= 6; i++) {
    chain[`/s${i}`] = { title: `S${i}`, text: 'Next', controls: [{ id: '1', role: 'button', label: 'Next', type: 'button',
      enabled: true, risk: 'reversible', href: `${ORIGIN}/s${i + 1}` }] };
  }
  chain['/s7'] = { title: 'S7', text: 'End', controls: [] };
  const script = Object.fromEntries(Object.keys(chain).map(path => [path, [{ pick: 'Next', done: 0.7 }]]));
  const bridge = new FakeBridge({ pages: chain, path: '/s1' });
  const result = await new BrowserRuntime({ bridge, provider: scripted(script) })
    .run('Click Next. Click Next. Click Next. Click Next. Click Next. Click Next.', { mode: 'reversible', expectation: { urlIncludes: '/s9' }, maxActions: 2 });
  assert.ok(bridge.executions.length <= 2, `${bridge.executions.length} executions`);
  assert.notEqual(result.status, 'completed');
  // The named Next is offered, but the provider chooses another button both times: both done claims count.
  const pages = structuredClone(WIZARD);
  pages['/step-4'].controls.push({ id: '3', role: 'button', label: 'Show tips', type: 'button', enabled: true, risk: 'reversible' });
  const otherBridge = new FakeBridge({ pages, path: '/step-4' });
  const other = await new BrowserRuntime({ bridge: otherBridge, provider: scripted({ '/step-4': [{ pick: 'Show tips', done: 0.75 }] }) })
    .run('Click Next.', { mode: 'reversible', expectation: { urlIncludes: '/step-5' }, maxActions: 6 });
  assert.ok(!other.verdict.why.includes('named:done_pending'));
  assert.equal(other.code, 'expectation_failed');
  assert.ok(otherBridge.executions.every(entry => entry.action.label !== 'Next'));
});

test('a named Next the purchase guard scores as paying is refused, never executed', async () => {
  const bridge = new FakeBridge({ pages: WIZARD, path: '/step-4' });
  const provider = {
    model: 'fake',
    async decide(observation, actions) {
      const next = actions.find(a => a.type === 'click' && a.label === 'Next');
      return { actionId: next.id, confidence: 0.97, done: { probability: 0.7 }, guards: { purchase_control: 0.9, purchase_page: 0.9 } };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Review and pay: click Next.', { mode: 'reversible', expectation: { urlIncludes: '/step-5' } });
  assert.equal(bridge.executions.length, 0);
  assert.ok(result.verdict.why.includes('guard:purchase_veto'), result.verdict.why.join(','));
});

test('a list step "Choose X, then click Next" ends on its own pass after the named Next, no named:clicks_done needed', async () => {
  // The select does the first hop (control label and option), Next the second: step:expectation_end after Next, with
  // the step_guards request; the next page's own Next is never decided on, so named:clicks_done has nothing to do.
  const bridge = new FakeBridge({ pages: WIZARD, path: '/step-4' });
  const base = scripted({ '/step-4': [{ pick: 'select', done: 0.2 }, { pick: 'Next', done: 0.3 }],
    '/step-5': [{ pick: 'Next', done: 0.35, confidence: 0.48 }] });
  const confirms = [];
  const provider = { ...base, async confirm(observation) {
    confirms.push(new URL(observation.url).pathname);
    return { done: { probability: 0.3 }, guards: { blocked: 0.01, injection: 0.01 } };
  } };
  const result = await new BrowserRuntime({ bridge, provider }).run({ mode: 'reversible', capture: 'none', steps: [
    { instruction: 'Choose "Standard (3-5 days)" in Delivery speed, then click Next.', expectation: { urlIncludes: '/step-5' }, maxActions: 4 }] });
  assert.equal(result.status, 'completed');
  assert.deepEqual(bridge.executions.map(e => e.action.type), ['select', 'click']);
  assert.ok(result.verdict.why.includes('step:expectation_end'));
  assert.ok(!result.verdict.why.includes('named:clicks_done'));
  assert.deepEqual(confirms, ['/step-5']);
  assert.deepEqual(base.calls.map(call => call.path), ['/step-4', '/step-4'], 'no decide on step 5');
});
