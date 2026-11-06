// Oversight ladder (docs/design/OVERSIGHT-SPEC.md section 3) in the runtime: rung 0 pre-checks (login, consent, cross-origin,
// expectation lint), rung 1b unsupported exclusion, rung 1c late navigation, the scroll nudge, decide options,
// per-class floors, suggestions and the split plan. Fake bridge and fake providers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult, bridgeError } from '../src/result.js';
import { DEFAULT_THRESHOLDS } from '../src/oversight.js';
import { FakeBridge, ORIGIN, PAGES, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, type: 'button', enabled: true, ...extra });

/** Provider that clicks the first offered action whose label is in `labels`, else `fallback`; records every call. */
function scripted(labels, { fallback = 'handoff', confidence = 0.9, done = () => 0.05, probabilities, onDecide } = {}) {
  const calls = [];
  return {
    calls,
    model: 'fake',
    async decide(observation, actions) {
      calls.push({ observation, actions });
      onDecide?.(observation, actions);
      const action = labels.map(label => actions.find(a => a.label === label)).find(Boolean);
      const decision = {
        actionId: action?.id ?? fallback,
        confidence,
        done: { probability: done(new URL(observation.url).pathname) },
      };
      if (probabilities) decision.probabilities = probabilities(actions);
      return decision;
    },
  };
}

function setup(pages, provider, path = '/') {
  const bridge = new FakeBridge({ pages: { ...PAGES, ...pages }, path });
  return { bridge, runtime: new BrowserRuntime({ bridge, provider }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Rung 0
// ---------------------------------------------------------------------------------------------------------------

test('rung 0 login: a password field with a sign-in title is needs_user/login before any provider call', async () => {
  const provider = scripted([]);
  const { runtime } = setup({
    '/': { title: 'Sign in to Example', text: 'Email\nPassword', controls: [
      { id: '1', role: 'textbox', label: 'Email', type: 'email', enabled: true },
      { id: '2', role: 'textbox', label: 'Password', type: 'password', enabled: true },
    ] },
  }, provider);
  const result = await runtime.run('Open the dashboard');
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'login');
  assert.equal(provider.calls.length, 0);
  assert.match(result.needs.message, /never logs in/);
  const lean = agentResult(result);
  assert.equal(lean.verdict.kind, 'needs_user');
  assert.equal(lean.verdict.oversight, 'user');
  assert.equal(lean.next.kind, 'relay');
});

test('rung 0 login: the page script login_wall warning also stops; a password field alone is only a warning',
  async () => {
    const walled = setup({ '/': { title: 'Home', text: 'x', controls: [], warnings: ['password_field', 'login_wall'] } },
      scripted([]));
    assert.equal((await walled.runtime.run('Open Home')).code, 'login');

    const provider = scripted(['About'], { fallback: 'done' });
    const { runtime } = setup({
      '/': { title: 'Home', text: 'Newsletter', controls: [
        link('1', 'About', '/about'),
        { id: '2', role: 'textbox', label: 'Password', type: 'password', enabled: true },
      ] },
    }, provider);
    const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' } });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.warnings, ['password_field']);
    assert.deepEqual(agentResult(result).warnings, ['password_field']);
  });

const CONSENT_HOME = {
  title: 'Home',
  text: 'Welcome home',
  controls: [
    link('1', 'About', '/about'),
    button('8', 'Accept all', { consent: true, risk: 'destructive' }),
    button('9', 'Reject all', { consent: true, dismissesConsent: true }),
  ],
  consent: {
    text: 'We use cookies to improve your experience.',
    buttons: [{ id: '8', label: 'Accept all', kind: 'accept' }, { id: '9', label: 'Reject all', kind: 'reject' }],
  },
};

test('consent with exactly one reject button: clicked mechanically in read-only mode, then the task continues',
  async () => {
    const provider = scripted(['About'], { fallback: 'done' });
    const { bridge, runtime } = setup({ '/': CONSENT_HOME }, provider);
    const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' } });
    assert.equal(result.status, 'completed');
    assert.equal(bridge.executions[0].action.target, '9', 'the reject button, never accept');
    assert.equal(result.steps[0].class, 'consent');
    assert.equal(result.steps[0].decision.by, 'runtime');
    assert.equal(result.steps[1].class, 'link');
    assert.ok(!provider.calls[0].actions.some(action => action.label === 'Accept all'));
    assert.equal(provider.calls[0].observation.url, `${ORIGIN}/`);
    assert.equal(provider.calls.length, 2, 'no provider call was spent on the dialog');
    assert.ok(result.verdict.why.includes('consent:rejected'));
    assert.deepEqual(agentResult(result).steps[0].class, 'consent');
  });

test('consent with several reject buttons: the provider chooses among those only; accept is never offered',
  async () => {
    const page = structuredClone(CONSENT_HOME);
    page.controls.push(button('7', 'Necessary only', { consent: true, dismissesConsent: true }));
    page.consent.buttons.push({ id: '7', label: 'Necessary only', kind: 'reject' });
    const provider = scripted(['Necessary only', 'About'], { fallback: 'done' });
    const { bridge, runtime } = setup({ '/': page }, provider);
    const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' } });
    const first = provider.calls[0].actions.map(action => action.label);
    assert.deepEqual(first, ['Reject all', 'Necessary only', 'done', 'handoff']);
    assert.equal(bridge.executions[0].action.target, '7');
    assert.equal(result.steps[0].class, 'consent');
    assert.equal(result.status, 'completed');
  });

test('consent kinds from the page script are authoritative: "Reject non-essential... accept" labels are skipped',
  async () => {
    const page = structuredClone(CONSENT_HOME);
    page.consent.buttons = [{ id: '8', label: 'Allow all and necessary', kind: 'accept' }];
    const provider = scripted([]);
    const { runtime } = setup({ '/': page }, provider);
    const result = await runtime.run('Open About');
    assert.equal(result.code, 'consent_banner');
  });

test('an accept-only consent dialog is needs_user/consent_banner with the dialog text kept apart, no provider call',
  async () => {
    const page = structuredClone(CONSENT_HOME);
    page.consent.buttons = [{ id: '8', label: 'Accept all', kind: 'accept' }];
    page.consent.text = `We use cookies. ${'x'.repeat(300)}`;
    const provider = scripted([]);
    const { runtime } = setup({ '/': page }, provider);
    const result = await runtime.run('Open About');
    assert.equal(result.status, 'needs_user');
    assert.equal(result.code, 'consent_banner');
    assert.equal(provider.calls.length, 0);
    assert.equal(result.needs.dialog.length, 120);
    assert.doesNotMatch(result.needs.message, /We use cookies/, 'page text never enters the trusted message');
    const lean = agentResult(result);
    assert.equal(lean.next.kind, 'relay');
    assert.equal(lean.needs.dialog, result.needs.dialog);
  });

test('a reject button is clicked only when it is an offered, unrefused control that stays on an approved origin',
  async () => {
    const variants = {
      'missing from controls': page => { page.controls = page.controls.filter(control => control.id !== '9'); },
      'refused by the page script': page => { page.controls.find(c => c.id === '9').risk = 'destructive'; },
      'a link to another origin': page => {
        Object.assign(page.controls.find(c => c.id === '9'), { role: 'link', href: 'https://cmp.example.net/optout' });
      },
    };
    for (const [name, mutate] of Object.entries(variants)) {
      const page = structuredClone(CONSENT_HOME);
      mutate(page);
      const provider = scripted(['About'], { fallback: 'done' });
      const { bridge, runtime } = setup({ '/': page }, provider);
      const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' } });
      assert.equal(result.code, 'consent_banner', name);
      assert.equal(bridge.executions.length, 0, `${name}: nothing was clicked`);
      assert.equal(provider.calls.length, 0, name);
    }
    // A same-origin link form of the reject button is still clicked.
    const page = structuredClone(CONSENT_HOME);
    Object.assign(page.controls.find(c => c.id === '9'), { role: 'link', href: `${ORIGIN}/` });
    const { bridge, runtime } = setup({ '/': page }, scripted(['About'], { fallback: 'done' }));
    const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' } });
    assert.equal(bridge.executions[0].action.target, '9');
    assert.equal(result.status, 'completed');
  });

test('rung 0 cross_origin names the origin and how to add it', async () => {
  const provider = scripted([]);
  const { runtime } = setup({
    '/': { url: 'https://consent.google.com/ml?continue=x', title: 'Before you continue', text: 'x', controls: [] },
  }, provider);
  const result = await runtime.run('Find flights', { allowedOrigins: ['https://www.google.com'] });
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'cross_origin');
  assert.match(result.needs.message, /https:\/\/consent\.google\.com/);
  assert.match(result.needs.message, /added to origins/);
  assert.equal(provider.calls.length, 0);
});

test('expectation lint: url guesses and menu words are flagged as expectation_weak, the run still proceeds',
  async () => {
    const menu = await setup({}, scripted(['About'], { fallback: 'done' })).runtime.run('Open About', {
      expectation: { textIncludes: 'About' },
    });
    assert.deepEqual(menu.warnings, ['expectation_weak']);
    assert.ok(menu.verdict.why.includes('expectation:text_menu'));
    const guess = await setup({}, scripted(['About'], { fallback: 'done' })).runtime.run('Open About', {
      expectation: { urlMatches: 'about$' },
    });
    assert.ok(guess.verdict.why.includes('expectation:url_guess'));
    const good = await setup({}, scripted(['About'], { fallback: 'done' })).runtime.run('Open About', {
      expectation: { urlIncludes: '/about' },
    });
    assert.equal(good.warnings, undefined);
    assert.ok(good.verdict.why.includes('expectation:url_path'));
  });

test('observe carries the instruction terms (lower-cased words of 4+ characters) for the control cap', async () => {
  const { bridge, runtime } = setup({}, scripted(['About'], { fallback: 'done' }));
  await runtime.run('Open the About page and read the Members list', { answerQuestion: 'Who is listed?' });
  assert.deepEqual(bridge.observeOptions[0].terms, ['about', 'members', 'list', 'listed']);
  const host = await runtime.observe();
  assert.ok(host.actions.length > 0);
  assert.deepEqual(bridge.observeOptions.at(-1), { level: 'read-only' }, 'host observe has no instruction terms; it carries the level');
});

test('observe carries the expectation texts, lower-cased, so the page script checks them past the viewport', async () => {
  const { bridge, runtime } = setup({}, scripted(['About'], { fallback: 'done' }));
  await runtime.run('Open the About page', {
    expectation: { urlIncludes: '/about', textIncludes: 'Departing 2026-10-12', textAbsent: 'Loading' },
  });
  assert.deepEqual(bridge.observeOptions[0].expectText, ['departing 2026-10-12', 'loading']);
  await runtime.run('Open the About page', { expectation: { urlIncludes: '/about' } });
  assert.equal(bridge.observeOptions.at(-1).expectText, undefined, 'no textIncludes, no expectText');
});

// ---------------------------------------------------------------------------------------------------------------
// Rungs 1b and 1c
// ---------------------------------------------------------------------------------------------------------------

test('rung 1b: unsupported is retried once with that action excluded; the provider decides again', async () => {
  const provider = scripted(['About', 'Members'], { fallback: 'handoff' });
  const { bridge, runtime } = setup({}, provider);
  bridge.failNext.push(bridgeError('unsupported', 'shadow host'));
  const result = await runtime.run('Open About', { retry: false });
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[0].actions.some(action => action.label === 'About'));
  assert.ok(!provider.calls[1].actions.some(action => action.label === 'About'), 'the failed action is not offered');
  assert.equal(result.steps.length, 0, 'the refused action leaves no step');
  assert.equal(result.code, 'handoff');
  assert.ok(result.verdict.why.includes('retry:unsupported'));
});

test('rung 1b: a second unsupported on another action is retried too, a third ends the run', async () => {
  const pages = { '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about'),
    link('2', 'Members', '/members'), link('3', 'Docs', '/docs')] } };
  const provider = scripted(['About', 'Members', 'Docs'], { fallback: 'handoff' });
  const { bridge, runtime } = setup(pages, provider);
  for (let i = 0; i < 3; i++) bridge.failNext.push(bridgeError('unsupported', 'widget'));
  const result = await runtime.run('Open About', { retry: false });
  assert.equal(result.code, 'unsupported');
  assert.equal(provider.calls.length, 3);
  assert.equal(agentResult(result).next.kind, 'rerun');
});

test('rung 1c: a link click that settles quiet on the same URL is re-observed once and the late navigation kept',
  async () => {
    const pages = { '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about',
      { lateHref: `${ORIGIN}/about` })] } };
    const provider = scripted(['About'], { fallback: 'done' });
    const { bridge, runtime } = setup(pages, provider);
    const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' }, reobserveDelayMs: 0 });
    assert.equal(result.status, 'completed');
    assert.equal(result.steps[0].action.toUrl, `${ORIGIN}/about`);
    assert.equal(result.steps[0].lateNavigation, true);
    assert.equal(bridge.observes, 2);
    assert.ok(result.verdict.why.includes('late_navigation'));
  });

test('rung 1c: a button click that settles quiet and changes nothing is re-observed once; a changing one is not',
  async () => {
    // An app's top nav of buttons whose navigation starts after the click settled (dos-arch, live 2026-10-06).
    const nav = { id: '1', role: 'button', label: 'Projects', lateHref: `${ORIGIN}/projects` };
    const pages = {
      '/workspace': { title: 'Workspace', text: 'Workspace home', controls: [nav] },
      '/projects': { title: 'Projects', text: 'Projects: Alpha, Beta', controls: [] },
    };
    const late = setup(pages, scripted(['Projects'], { fallback: 'done', done: path => (path === '/projects' ? 0.9 : 0.05) }), '/workspace');
    const result = await late.runtime.run('Click Projects', { mode: 'reversible', expectation: { urlIncludes: '/projects' },
      reobserveDelayMs: 0 });
    assert.equal(result.status, 'completed', result.reason);
    assert.equal(result.steps[0].lateNavigation, true);
    assert.equal(result.steps[0].action.toUrl, `${ORIGIN}/projects`);
    assert.ok(result.verdict.why.includes('late_navigation'));
    // The step-list shape of the live run: an expectation of the page being left no longer passes on its stale view.
    const stale = setup(pages, scripted(['Projects'], { fallback: 'handoff' }), '/workspace');
    const list = await stale.runtime.run({ mode: 'reversible', reobserveDelayMs: 0,
      steps: [{ instruction: 'Click Projects', expectation: { urlIncludes: '/workspace' } }] });
    assert.equal(list.verification.passed, false);
    assert.equal(list.page.url, `${ORIGIN}/projects`);
    // A button that changes the page in place (revision moved) is never re-observed.
    const toggle = { id: '2', role: 'button', label: 'Show details' };
    const inPlace = setup({ '/': { title: 'Home', text: 'Welcome', controls: [toggle] } },
      scripted(['Show details'], { fallback: 'done', done: () => 0.9 }));
    const shown = await inPlace.runtime.run('Click Show details', { mode: 'reversible', expectation: { textIncludes: 'Welcome' },
      reobserveDelayMs: 0 });
    assert.equal(shown.steps[0].lateNavigation, undefined);
    assert.ok(!shown.verdict.why.includes('late_navigation'));
  });

test('rung 1c: strong done with a failing expectation re-observes and completes when the navigation landed',
  async () => {
    let bridgeRef;
    const provider = scripted([], {
      done: path => (path === '/' ? 0.9 : 0.05),
      onDecide: () => { bridgeRef.pendingPath = '/about'; },
    });
    const { bridge, runtime } = setup({}, provider);
    bridgeRef = bridge;
    const result = await runtime.run('Open About', { expectation: { urlIncludes: '/about' }, reobserveDelayMs: 0 });
    assert.equal(result.code, 'expectation_passed');
    assert.equal(result.page.url, `${ORIGIN}/about`);
    assert.ok(result.verdict.why.includes('late_reobserve'));
    assert.equal(provider.calls.length, 1, 'no extra provider call');
  });

// ---------------------------------------------------------------------------------------------------------------
// Handoffs: scroll nudge, decide options, suggestions, split
// ---------------------------------------------------------------------------------------------------------------

test('scroll nudge: a handoff with off-screen blocks that match the task scrolls once and asks again', async () => {
  const pages = { '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'About', '/about')],
    blocks: [{ t: 'h1', text: 'Home' }, { t: 'p', text: 'Pricing table', offscreen: true }] } };
  const provider = scripted([], { fallback: 'handoff' });
  const { bridge, runtime } = setup(pages, provider);
  const result = await runtime.run('Read the pricing table');
  assert.equal(bridge.executions.length, 1);
  assert.equal(bridge.executions[0].action.type, 'scroll');
  assert.equal(result.steps[0].decision.by, 'runtime');
  assert.equal(provider.calls.length, 2, 'the provider decides again after the scroll');
  assert.equal(result.code, 'handoff');
  assert.ok(result.verdict.why.includes('scroll_nudge'));

  const plain = setup({}, scripted([], { fallback: 'handoff' }));
  await plain.runtime.run('Read the pricing table');
  assert.equal(plain.bridge.executions.length, 0, 'nothing off-screen matches: no nudge');
});

test('handoff with two or more term-matching options is a choose receipt that act() can run', async () => {
  const pages = { '/': { title: 'Docs', text: 'Library', controls: [
    link('1', 'pathlib - Object-oriented filesystem paths', '/pathlib'),
    link('2', 'pathlib.PurePath - pure paths', '/purepath'),
    link('3', 'Home', '/'),
  ] }, '/pathlib': { title: 'pathlib', text: 'Path.read_text()', controls: [] } };
  const provider = scripted([], { fallback: 'handoff',
    probabilities: actions => ({ [actions[1].id]: 0.22, [actions[0].id]: 0.31 }) });
  const { runtime } = setup(pages, provider);
  const result = await runtime.run('Find the pathlib documentation', { answerQuestion: 'What does pathlib provide?' });
  assert.equal(result.code, 'handoff');
  const lean = agentResult(result);
  assert.equal(lean.verdict.kind, 'needs_decision');
  assert.equal(lean.verdict.oversight, 'choose');
  assert.equal(lean.next.kind, 'choose');
  assert.deepEqual(lean.verdict.decide.options.map(option => option.p), [0.31, 0.22]);
  assert.equal(lean.verdict.decide.options[0].label, 'pathlib - Object-oriented filesystem paths');
  assert.match(lean.next.text, new RegExp(lean.verdict.decide.revision.replace(/[#/]/g, '.')));
  const acted = await runtime.act(lean.verdict.decide.options[0].id, { revision: lean.verdict.decide.revision,
    expectation: { urlIncludes: '/pathlib' } });
  assert.equal(acted.status, 'completed');
});

test('handoff on an intermediate page suggests the unvisited named pages, keeping a good expectation', async () => {
  const provider = scripted(['About'], { fallback: 'handoff' });
  const { runtime } = setup({}, provider);
  const result = await runtime.run('Visit About, then Members, then read the member names.', {
    expectation: { urlIncludes: '/members' }, answerQuestion: 'Who are the members?', maxActions: 6, retry: false,
  });
  assert.equal(result.code, 'handoff');
  const lean = agentResult(result);
  assert.equal(lean.next.kind, 'rerun');
  assert.deepEqual(lean.verdict.suggested, {
    instruction: 'From the current page, visit Members, in that order. Read the answer to: Who are the members? '
      + 'Stop there. Do not type into or submit forms.',
    expectation: { urlIncludes: '/members' },
    maxActions: 3,
  });
  assert.match(lean.next.text, /verdict\.suggested\.instruction/);
});

test('a join task or more than three named pages adds a split plan; next is split', async () => {
  const provider = scripted([], { fallback: 'handoff' });
  const { runtime } = setup({}, provider);
  const result = await runtime.run('Open About and find the documentation lead, then open Docs and find the guide '
    + 'that person wrote');
  const lean = agentResult(result);
  assert.deepEqual(lean.verdict.plan, { split: true, reason: 'join_task', hops: 2 });
  assert.equal(lean.next.kind, 'split');
  assert.ok(lean.verdict.why.includes('join_task'));

  const long = await setup({}, scripted([], { fallback: 'handoff' })).runtime.run(
    'Open Reference, then Standard objects, then Array, then the at method page');
  assert.equal(agentResult(long).verdict.plan.reason, 'hops>3');
});

test('three no-progress actions are needs_decision with a rerun next step', async () => {
  // Scrolls leave the fake page unchanged.
  const scroller = {
    async decide(_, actions) {
      return { actionId: actions.find(action => action.type === 'scroll').id, confidence: 0.9 };
    },
  };
  const stuck = new BrowserRuntime({ bridge: new FakeBridge(), provider: scroller });
  const result = await stuck.run('Find the archive');
  assert.equal(result.code, 'no_progress');
  const lean = agentResult(result);
  assert.equal(lean.verdict.kind, 'needs_decision');
  assert.equal(lean.next.kind, 'rerun');
});

// ---------------------------------------------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------------------------------------------

test('controlFloor defaults to 0.5 in reversible mode; links stay ungated; minConfidence aliases controlFloor',
  async () => {
    assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { linkFloor: 0, controlFloor: 0.5, doneThreshold: 0.5, strongDone: 0.8,
      answerConfirm: 0.8, answerMargin: 0.5, placeholderFloor: 0.35, placeholderMargin: 0.15, commitVeto: 0.7, secondOpinionMargin: 0.2 });
    const doubtful = scripted(['Subscribe'], { confidence: 0.3 });
    const form = setup({}, doubtful, '/form');
    const low = await form.runtime.step('Tick Subscribe', { mode: 'reversible' });
    assert.equal(low.code, 'low_confidence');
    assert.equal(low.needs.minConfidence, 0.5);
    assert.equal(form.bridge.executions.length, 0);
    assert.equal(agentResult(low).next.kind, 'choose');

    const sure = setup({}, scripted(['Subscribe'], { confidence: 0.6 }), '/form');
    assert.equal((await sure.runtime.step('Tick Subscribe', { mode: 'reversible' })).status, 'checkpoint');
    const raised = setup({}, scripted(['Subscribe'], { confidence: 0.6 }), '/form');
    assert.equal((await raised.runtime.step('Tick Subscribe', { mode: 'reversible', minConfidence: 0.7 })).code,
      'low_confidence');

    // A provider that reports no confidence is gated only by a floor the caller set explicitly.
    const silent = { async decide(_, actions) { return { actionId: actions.find(a => a.label === 'Subscribe').id }; } };
    const quiet = new BrowserRuntime({ bridge: new FakeBridge({ path: '/form' }), provider: silent });
    assert.equal((await quiet.step('Tick', { mode: 'reversible' })).status, 'checkpoint');
    const strict = new BrowserRuntime({ bridge: new FakeBridge({ path: '/form' }), provider: silent });
    assert.equal((await strict.step('Tick', { mode: 'reversible', thresholds: { controlFloor: 0.5 } })).code,
      'low_confidence');

    const linkRun = setup({}, scripted(['About'], { confidence: 0.1 }));
    assert.equal((await linkRun.runtime.step('Open About')).status, 'checkpoint', 'links: linkFloor 0');
  });
