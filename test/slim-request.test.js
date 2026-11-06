// Request size accounting (cost.requests chars by section) and the slim request switches (src/runtime.js
// resolveSlim): compact controls, the slim terminal request and the option cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRuntime, DEFAULT_SLIM, SLIM_KEYS, legalActions, resolveSlim, slimFromText } from '../src/runtime.js';
import { TypeSafeProvider, decideBody, requestSizes } from '../src/typesafe.js';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths, loadConfig } from '../src/home.js';
import { DEFAULT_OPTION_CAP, capActions, relevanceHints } from '../src/relevance.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A TypeSafeProvider over a fake fetch: `answer(body)` returns the SystemOne answers; bodies are collected. */
function jev(answer) {
  const bodies = [];
  const provider = new TypeSafeProvider({
    requireKey: false,
    keyEnv: 'FAI_UNUSED_TEST_KEY',
    retryDelayMs: 1,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return jsonResponse({ model: 'jev-test', answers: answer(body), usage: { input_tokens: 50, output_tokens: 5 } });
    },
  });
  return { provider, bodies };
}

const PAGE = {
  revision: 'r1',
  url: 'https://example.com/',
  title: 'Home',
  text: 'Welcome home. About us and pricing.',
  controls: [link('1', 'About', '/about'), link('2', 'Pricing', '/pricing'),
    { id: '3', role: 'button', label: 'Menu', enabled: true }],
};
const OFFERED = [
  { id: 'a0', type: 'click', target: '1', role: 'link', label: 'About', href: 'https://example.com/about' },
  { id: 'a1', type: 'click', target: '2', role: 'link', label: 'Pricing', href: 'https://example.com/pricing' },
  { id: 'a2', type: 'scroll', direction: 'down', label: 'scroll down', description: 'Scroll down to see more of the page' },
  { id: 'handoff', type: 'handoff', label: 'handoff', description: 'Hand off' },
];

test('requestSizes splits a decide body by section, numbers only', () => {
  const body = decideBody({ model: 'm', observation: PAGE, offered: OFFERED, context: { instruction: 'Open About', history: [] } });
  const sizes = requestSizes(body);
  assert.equal(sizes.chars.total, JSON.stringify(body).length);
  assert.equal(sizes.options, 4);
  assert.equal(sizes.controls, 3);
  for (const key of ['instruction', 'policy', 'page', 'text', 'controls', 'history', 'options', 'questions']) {
    assert.ok(Number.isInteger(sizes.chars[key]) && sizes.chars[key] > 0, key);
  }
  const sections = Object.entries(sizes.chars).filter(([key]) => key !== 'total').reduce((sum, [, n]) => sum + n, 0);
  assert.ok(sections <= sizes.chars.total && sections > sizes.chars.total * 0.8, 'sections cover the body');
  assert.equal(sizes.chars.controls, JSON.stringify(body.state.page.controls).length);
  assert.equal(sizes.chars.options, JSON.stringify(body.questions.action.criteria).length);
});

test('decide() and choose() report their request size; the runtime records it in cost.requests', async () => {
  const { provider } = jev(body => (body.questions.answer
    ? { answer: { type: 'choice', choice: Object.keys(body.questions.answer.criteria)[1] } }
    : {
      action: { type: 'choice', choice: body.state.page.url.endsWith('/about') ? 'handoff' : 'a0', confidence: 0.9 },
      done: { type: 'noul', noul: body.state.page.url.endsWith('/about') ? 0.9 : 0.05 },
    }));
  const pages = {
    '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
    '/about': { title: 'About', text: 'About\nMembers\nAda Lovelace\nGrace Hopper', controls: [link('1', 'Home', '/')] },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider });
  const result = await runtime.run('Open About and find a member', {
    answerQuestion: 'Who is a member?', expectation: { urlIncludes: '/about' }, capture: 'none',
  });
  assert.equal(result.status, 'completed');
  const requests = result.cost.requests;
  assert.ok(requests.length >= 2);
  for (const entry of requests) {
    assert.ok(Number.isInteger(entry.chars?.total) && entry.chars.total > 0, entry.kind);
    assert.ok(Number.isInteger(entry.options));
    for (const value of Object.values(entry.chars)) assert.equal(typeof value, 'number');
  }
  const decide = requests.find(entry => entry.kind === 'decide');
  assert.ok(decide.chars.controls > 0 && decide.chars.policy > 0 && decide.controls >= 1);
  const choose = requests.find(entry => entry.kind === 'choose');
  if (choose) assert.ok(choose.chars.question > 0 && choose.chars.options > 0);
});

test('a provider-reported size is reduced to non-negative integers before it reaches the trace', async () => {
  const provider = {
    async decide(observation, actions) {
      return {
        actionId: actions.find(action => action.type === 'handoff').id,
        request: { chars: { total: 10, controls: 4, 'bad key': 3, text: -1, policy: 'x' }, options: 2, controls: 1.5 },
      };
    },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge(), provider });
  const result = await runtime.run('Open About', { capture: 'none' });
  const [entry] = result.cost.requests;
  assert.deepEqual(entry.chars, { total: 10, controls: 4 });
  assert.equal(entry.options, 2);
  assert.equal(entry.controls, undefined);
});

// ------------------------------------------------------------------------------------------------ slim switches

test('resolveSlim: defaults, booleans, single switches; unknown names and bad values throw', () => {
  assert.deepEqual(resolveSlim(), { ...DEFAULT_SLIM });
  for (const key of SLIM_KEYS) {
    assert.ok(resolveSlim(true)[key]);
    assert.ok(!resolveSlim(false)[key]);
  }
  assert.equal(resolveSlim({ controls: true }).controls, true);
  assert.throws(() => resolveSlim({ nope: true }), /Unknown slim switch/);
  assert.throws(() => resolveSlim({ controls: 'yes' }), /must be a boolean/);
  assert.throws(() => resolveSlim([]), /boolean or an object/);
  assert.equal(slimFromText('on'), true);
  assert.equal(slimFromText('off'), false);
  assert.equal(slimFromText('controls').controls, true);
  assert.deepEqual(slimFromText('{"controls":true}'), { controls: true });
  assert.throws(() => slimFromText('controls,bogus'), /Unknown slim switch/);
});

const BUSY = {
  revision: 'r1',
  url: 'https://example.com/list',
  title: 'Stories',
  text: 'Stories. Pricing plans. Read more below.',
  controls: [
    link('1', 'Pricing', '/pricing?ref=nav'),
    link('2', 'Read more', '/stories/1'),
    link('3', 'Comments', '/item?id=1'),
    link('4', 'Comments', '/item?id=2'),
    link('5', 'Blog', '/blog'),
    link('6', 'Elsewhere', 'https://other.example/x'),
    { id: '7', role: 'button', label: 'Menu', enabled: true },
  ],
};

const textOf = value => String(value?.what ?? value);

test('slim.controls: offered links are sent once (as options), other controls without hrefs, paths where needed', () => {
  const offered = legalActions(BUSY, { mode: 'read-only' }).filter(action => action.type !== 'done');
  const context = { instruction: 'Open the pricing page and read the plans', history: [] };
  const full = decideBody({ model: 'm', observation: BUSY, offered, context });
  const slim = decideBody({ model: 'm', observation: BUSY, offered, context: { ...context, compact: true } });
  // The full request lists every control with its href.
  assert.equal(full.state.page.controls.length, 7);
  assert.ok(full.state.page.controls.some(control => control.href));
  // Slim: the five offered same-origin links are only options; the cross-origin link and the button stay, no href.
  assert.deepEqual(slim.state.page.controls.map(control => control.id), ['6', '7']);
  assert.ok(slim.state.page.controls.every(control => control.href === undefined));
  const criteria = Object.values(slim.questions.action.criteria).map(textOf);
  const byLabel = label => criteria.find(text => text.includes(` ${label}`));
  assert.match(byLabel('Pricing'), /\(\/pricing\?ref=nav\)$/, 'relevant link keeps its path');
  assert.match(byLabel('Read more'), /\(\/stories\/1\)$/, 'vague label keeps its path');
  const comments = criteria.filter(text => text.includes('Comments'));
  assert.equal(comments.length, 2);
  assert.ok(comments.every(text => /\(\/item\?id=\d\)/.test(text)), 'same label: paths tell them apart');
  assert.equal(byLabel('Blog'), '5 link Blog', 'an irrelevant link with a clear label has no path');
  // Same options, same ids: only their text changed.
  assert.deepEqual(Object.keys(slim.questions.action.criteria), Object.keys(full.questions.action.criteria));
  assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length);
});

test('slim.controls through the runtime: the provider body is compact; refused controls are still never offered', async () => {
  const pages = {
    '/': {
      title: 'Home',
      text: 'Welcome home',
      controls: [link('1', 'About', '/about'), link('2', 'Delete account', '/account/delete'),
        { id: '3', role: 'button', label: 'Buy now', enabled: true }],
    },
    '/about': { title: 'About', text: 'About us', controls: [link('1', 'Home', '/')] },
  };
  const { provider, bodies } = jev(body => ({
    action: { type: 'choice', choice: body.state.page.url.endsWith('/about') ? 'handoff' : 'a0', confidence: 0.9 },
    done: { type: 'noul', noul: body.state.page.url.endsWith('/about') ? 0.9 : 0.05 },
  }));
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider });
  const result = await runtime.run('Open About', {
    expectation: { urlIncludes: '/about' }, capture: 'none', mode: 'reversible', slim: { controls: true },
  });
  assert.equal(result.status, 'completed');
  const first = bodies[0];
  const labels = Object.values(first.questions.action.criteria).map(textOf);
  assert.ok(labels.some(text => /link About \(\/about\)/.test(text)), labels.join(' | '));
  // The mechanical checks read the full observation: the delete link and the buy button are refused, not offered.
  assert.ok(!labels.some(text => /Delete account|Buy now/.test(text)));
  assert.deepEqual(first.state.page.controls.map(control => control.label), ['Delete account', 'Buy now']);
  assert.ok(first.state.page.controls.every(control => control.href === undefined));
  // Off: the full request as before.
  const off = jev(() => ({ action: { type: 'choice', choice: 'handoff' } }));
  await new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider: off.provider })
    .run('Open About', { capture: 'none', slim: false });
  assert.equal(off.bodies[0].state.page.controls.length, 3);
  assert.ok(off.bodies[0].state.page.controls[0].href);
});

test('slim: config.json and the daemon body validate it; the trace records the switches the run used', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-slim-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.json'), JSON.stringify({ slim: { bogus: true } }));
  assert.throws(() => loadConfig(homePaths({ home, env: {} })), /config.json Unknown slim switch/);
  await writeFile(join(home, 'config.json'), JSON.stringify({ slim: { controls: true } }));
  assert.deepEqual(loadConfig(homePaths({ home, env: {} })).slim, { controls: true });

  const hub = createFakeHub({ bridgeOptions: { path: '/' } });
  const env = { TYPESAFE_API_KEY: 'k-test' };
  const log = createLogger(homePaths({ home, env }));
  const contexts = [];
  const provider = {
    model: 'rec',
    async decide(observation, actions, context) {
      contexts.push(context);
      return { actionId: 'handoff', confidence: 0.9 };
    },
  };
  const daemon = createDaemon({ driver: 'jev', home, env, port: 0, hub, log, sweepIntervalMs: 60_000, providerFactory: () => provider, warm: false });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    log.close();
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const created = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' });
  await hub.approve(created.body.requestId);
  const bad = await api('POST', '/v1/runs', { requestId: created.body.requestId, instruction: 'Open About', slim: { nope: 1 } });
  assert.equal(bad.status, 400);
  // config.json turns controls on.
  const fromConfig = await api('POST', '/v1/runs', { requestId: created.body.requestId, instruction: 'Open About' });
  assert.equal(fromConfig.status, 200, JSON.stringify(fromConfig.body));
  assert.equal(contexts.at(-1).compact, true);
  const trace = JSON.parse(await readFile(fromConfig.body.result.trace, 'utf8'));
  assert.equal(trace.options.slim.controls, true);
  // The run's own value wins.
  const off = await api('POST', '/v1/runs', { requestId: created.body.requestId, instruction: 'Open About', slim: false });
  assert.equal(off.status, 200);
  assert.equal(contexts.at(-1).compact, undefined);
});

// ------------------------------------------------------------------------------------------------ slim.terminal

const HOP_PAGES = {
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
  '/about': {
    title: 'About',
    text: 'About\nMembers\nAda Lovelace\nGrace Hopper',
    controls: [link('1', 'Home', '/'), link('2', 'Careers', '/careers')],
  },
};
// Not a bounded imperative ("each"), so the passing page gets its terminal decide (or the slim one).
const HOP_RUN = ['Open About and find a member. Check each one.', {
  answerQuestion: 'Who is a member?', expectation: { urlIncludes: '/about' }, capture: 'none',
}];

/** Jev over fake fetch: clicks About on Home; on /about the decide hands off with `fullDone`; terminal says `slimDone`. */
function terminalJev({ slimDone = 0.9, fullDone = 0.9, blocked = 0.02, slimStatus = 200 } = {}) {
  const bodies = [];
  const provider = new TypeSafeProvider({
    requireKey: false,
    keyEnv: 'FAI_UNUSED_TEST_KEY',
    retryDelayMs: 1,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const about = body.state.page?.url?.endsWith('/about');
      let answers;
      if (body.questions.answer) {
        answers = { answer: { type: 'choice', choice: Object.keys(body.questions.answer.criteria)[0] } };
      } else if (!body.questions.action) {
        if (slimStatus !== 200) return new Response('no', { status: slimStatus });
        answers = { done: { type: 'noul', noul: slimDone }, blocked: { type: 'noul', noul: blocked }, injection: { type: 'noul', noul: 0.01 } };
      } else {
        answers = {
          action: { type: 'choice', choice: about ? 'handoff' : 'a0', confidence: 0.9 },
          done: { type: 'noul', noul: about ? fullDone : 0.05 },
          blocked: { type: 'noul', noul: about ? blocked : 0.01 },
          injection: { type: 'noul', noul: 0.01 },
        };
      }
      return jsonResponse({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 2 } });
    },
  });
  return { provider, bodies };
}

const decideKinds = result => result.cost.requests.filter(entry => entry.kind !== 'choose').map(entry => entry.kind);

test('slim.terminal: on the passing page only done and guards are asked; done at the threshold completes', async () => {
  const { provider, bodies } = terminalJev();
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES }), provider });
  const result = await runtime.run(HOP_RUN[0], { ...HOP_RUN[1], slim: { terminal: true } });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(decideKinds(result), ['decide', 'terminal']);
  const terminal = bodies.find(body => !body.questions.action && !body.questions.answer);
  assert.deepEqual(Object.keys(terminal.questions).sort(), ['blocked', 'done', 'injection']);
  assert.equal(terminal.state.page.controls, undefined);
  assert.ok(terminal.state.page.text.includes('Grace Hopper'));
  assert.ok(terminal.state.policy && terminal.state.instruction);
  const entry = result.cost.requests.find(request => request.kind === 'terminal');
  assert.equal(entry.fallback, undefined);
  assert.equal(entry.chars.controls, undefined);
  assert.equal(entry.options, 0);
  assert.equal(result.cost.decisions, 2);
  assert.equal(result.finalDecision.actionId, 'done');
  assert.ok(result.verdict.why.includes('done:0.9'));
  // The answer ranking still ran next to it.
  assert.equal(result.answer.method, 'provider');
});

test('slim.terminal: done below the threshold falls back to the full decide, outside maxDecisions', async () => {
  const { provider, bodies } = terminalJev({ slimDone: 0.2, fullDone: 0.9 });
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES }), provider });
  const result = await runtime.run(HOP_RUN[0], { ...HOP_RUN[1], maxDecisions: 2, slim: { terminal: true } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(decideKinds(result), ['decide', 'terminal', 'decide']);
  assert.equal(result.cost.requests.find(request => request.kind === 'terminal').fallback, true);
  assert.equal(result.cost.decisions, 3);
  // The fallback is the same full request as without the switch.
  const full = bodies.filter(body => body.questions.action);
  assert.ok(full.at(-1).state.page.url.endsWith('/about'));
  assert.ok(Object.keys(full.at(-1).questions.action.criteria).length >= 2);
});

test('slim.terminal: a low done in both requests ends exactly as without the switch', async () => {
  const off = await new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES }), provider: terminalJev({ slimDone: 0.1, fullDone: 0.1 }).provider })
    .run(HOP_RUN[0], { ...HOP_RUN[1], slim: false });
  const on = await new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES }), provider: terminalJev({ slimDone: 0.1, fullDone: 0.1 }).provider })
    .run(HOP_RUN[0], { ...HOP_RUN[1], slim: { terminal: true } });
  assert.equal(on.code, off.code);
  assert.equal(on.status, off.status);
  assert.equal(on.verdict.kind, off.verdict.kind);
});

test('slim.terminal: a blocked guard marks the completion (guard:blocked_page) as the full decide would', async () => {
  const run = async slim => new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES }), provider: terminalJev({ blocked: 0.95 }).provider })
    .run(HOP_RUN[0], { ...HOP_RUN[1], slim });
  const on = await run({ terminal: true });
  const off = await run(false);
  assert.equal(on.code, 'expectation_passed');
  assert.ok(on.verdict.why.includes('guard:blocked_page'));
  assert.equal(on.verdict.kind, off.verdict.kind);
  assert.deepEqual(on.verdict.why.filter(code => code.startsWith('guard:')), off.verdict.why.filter(code => code.startsWith('guard:')));
});

test('slim.terminal: a failed slim request falls back; providers without confirm() always get the full decide', async () => {
  const { provider } = terminalJev({ slimStatus: 400 });
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES }), provider })
    .run(HOP_RUN[0], { ...HOP_RUN[1], slim: { terminal: true } });
  assert.equal(result.status, 'completed');
  const terminal = result.cost.requests.find(request => request.kind === 'terminal');
  assert.equal(terminal.error, 'provider_error');
  assert.equal(terminal.fallback, true);
  assert.deepEqual(decideKinds(result), ['decide', 'terminal', 'decide']);

  const kinds = [];
  const plain = {
    async decide(observation, actions) {
      kinds.push('decide');
      const about = observation.url.endsWith('/about');
      return { actionId: about ? 'handoff' : actions.find(a => a.label === 'About').id, confidence: 0.9, done: { probability: about ? 0.9 : 0.05 } };
    },
  };
  const other = await new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES }), provider: plain })
    .run(HOP_RUN[0], { ...HOP_RUN[1], slim: { terminal: true } });
  assert.equal(other.status, 'completed');
  assert.deepEqual(kinds, ['decide', 'decide']);
});

test('slim.terminal: a 0-hop run whose start page passes sends the slim request first', async () => {
  const { provider, bodies } = terminalJev();
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages: HOP_PAGES, path: '/about' }), provider })
    .run('Find a member on this page', { expectation: { textIncludes: 'Grace' }, capture: 'none', slim: { terminal: true } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(decideKinds(result), ['terminal']);
  assert.ok(!bodies.some(body => body.questions.action));
});

// ------------------------------------------------------------------------------------------------ slim.cap

const manyLinks = (n, extra = []) => ({
  title: 'Index',
  text: 'An index of many pages',
  controls: [
    ...Array.from({ length: n }, (_, i) => link(String(i + 1), `Topic ${i + 1}`, `/topic/${i + 1}`)),
    ...extra,
  ],
});

test('capActions keeps essential, expectation-matching and relevant actions, in the offered order', () => {
  const observation = { revision: 'r', url: 'https://example.com/', ...manyLinks(70, [
    link('900', 'Pricing plans', '/pricing'),
    link('901', 'Go', '/reports/annual-2025'),
  ]) };
  const offered = legalActions(observation, { mode: 'read-only', allowedUrls: ['https://example.com/sitemap'] });
  const hints = relevanceHints({ instruction: 'Open the pricing page', expectation: { urlIncludes: 'annual-2025' } });
  const { actions, dropped } = capActions(offered, DEFAULT_OPTION_CAP, hints);
  const options = actions.filter(action => !['done', 'handoff'].includes(action.type));
  assert.equal(options.length, DEFAULT_OPTION_CAP);
  assert.equal(dropped, offered.filter(action => !['done', 'handoff'].includes(action.type)).length - DEFAULT_OPTION_CAP);
  const labels = options.map(action => action.label);
  for (const kept of ['Pricing plans', 'Go', 'scroll down', 'scroll up', 'wait', 'https://example.com/sitemap']) {
    assert.ok(labels.includes(kept), kept);
  }
  // Ties keep page order: the first topics stay, the last go.
  assert.ok(labels.includes('Topic 1') && !labels.includes('Topic 70'));
  // The offered order is kept and terminal actions stay last.
  const positions = options.map(action => offered.indexOf(action));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.deepEqual(actions.slice(-2).map(action => action.type).sort(), ['done', 'handoff']);
  // Under the cap nothing changes.
  const small = legalActions({ revision: 'r', url: 'https://example.com/', ...manyLinks(5) }, { mode: 'read-only' });
  assert.equal(capActions(small, DEFAULT_OPTION_CAP, hints).actions, small);
  // A reversed list (second opinion) keeps the same set, reversed.
  const reversed = [...offered.filter(action => action.type !== 'done' && action.type !== 'handoff').reverse(),
    ...offered.filter(action => action.type === 'done' || action.type === 'handoff')];
  const again = capActions(reversed, DEFAULT_OPTION_CAP, hints).actions;
  assert.deepEqual(new Set(again.map(action => action.id)), new Set(actions.map(action => action.id)));
});

test('slim.cap through the runtime: the provider sees at most 40 options; the trace records how many were dropped', async () => {
  const pages = { '/': manyLinks(80, [link('900', 'Members', '/members')]), '/members': { title: 'Members', text: 'Ada', controls: [] } };
  const seen = [];
  const provider = {
    async decide(observation, actions) {
      seen.push(actions.length);
      const members = actions.find(action => action.label === 'Members');
      if (members) return { actionId: members.id, confidence: 0.9, done: { probability: 0.05 } };
      return { actionId: 'handoff', confidence: 0.9, done: { probability: 0.9 } };
    },
  };
  const run = slim => new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider })
    .run('Open the Members page', { expectation: { urlIncludes: '/members' }, capture: 'none', slim });
  const on = await run({ cap: true });
  assert.equal(on.status, 'completed');
  // 40 options plus done and handoff on the busy page.
  assert.equal(seen[0], DEFAULT_OPTION_CAP + 2);
  const entry = on.cost.requests.find(request => request.kind === 'decide');
  assert.equal(entry.optionsDropped, 80 + 1 + 3 - DEFAULT_OPTION_CAP);
  seen.length = 0;
  const off = await run(false);
  assert.equal(off.status, 'completed');
  assert.equal(seen[0], 80 + 1 + 3 + 2);
  assert.equal(off.cost.requests[0].optionsDropped, undefined);
});

// ------------------------------------------------------------------------------------------------ review fixes

test('slim.cap keeps a supplied-text fill and its submit button on a page with many links (subscribe task)', () => {
  const observation = { revision: 'r', url: 'https://example.com/', ...manyLinks(60, [
    { id: '900', role: 'textbox', label: 'Your email address', type: 'email', enabled: true },
    { id: '901', role: 'button', label: 'Join', enabled: true },
  ]) };
  const options = { mode: 'reversible', suppliedText: { email: 'ada@example.com' }, instruction: 'Subscribe to the newsletter with my email' };
  const offered = legalActions(observation, options);
  const hints = relevanceHints({ instruction: options.instruction });
  const { actions, dropped } = capActions(offered, DEFAULT_OPTION_CAP, hints);
  assert.ok(dropped > 0);
  assert.ok(actions.some(action => action.type === 'fill_supplied_text' && action.suppliedName === 'email'), 'the fill stays');
  assert.ok(actions.some(action => action.label === 'Join'), 'the submit button stays');
});

test('slim.cap keeps a link whose label matches a text-only expectation', () => {
  const observation = { revision: 'r', url: 'https://example.com/', ...manyLinks(60, [link('900', 'Quarterly results', '/q')]) };
  const offered = legalActions(observation, { mode: 'read-only' });
  const hints = relevanceHints({ instruction: 'Find the numbers', expectation: { textIncludes: 'Quarterly results' } });
  // Fill the cap with links that score on the instruction, so only the expectation keeps it.
  const { actions } = capActions(offered, 5, hints);
  assert.ok(actions.some(action => action.label === 'Quarterly results'));
});

test('slim.terminal is sent at most once per URL and stops after the first fallback (6 decisions -> at most 7 calls)', async () => {
  const pages = {};
  for (let i = 1; i <= 9; i++) {
    pages[i === 1 ? '/' : `/p${i}`] = { title: `Page ${i}`, text: `Welcome to page ${i}`, controls: [link('1', 'Next', `/p${i + 1}`)] };
  }
  const bodies = [];
  const provider = new TypeSafeProvider({
    requireKey: false,
    keyEnv: 'FAI_UNUSED_TEST_KEY',
    retryDelayMs: 1,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const answers = body.questions.answer
        ? { answer: { type: 'choice', choice: Object.keys(body.questions.answer.criteria)[0] } }
        : body.questions.action
          ? { action: { type: 'choice', choice: 'a0', confidence: 0.9 }, done: { type: 'noul', noul: 0.1 } }
          : { done: { type: 'noul', noul: 0.1 } };
      return jsonResponse({ model: 'jev-test', answers });
    },
  });
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider })
    .run('Keep reading the pages', { expectation: { textIncludes: 'Welcome' }, maxDecisions: 6, maxActions: 8,
      capture: 'none', slim: { terminal: true } });
  const calls = bodies.filter(body => !body.questions.answer);
  assert.ok(calls.length <= 7, `calls ${calls.length}`);
  assert.equal(calls.filter(body => !body.questions.action).length, 1);
  assert.equal(result.cost.requests.filter(entry => entry.kind === 'terminal').length, 1);
  assert.ok(result.cost.decisions <= 7);
});

test('slim.controls keeps the path of every link in a same-label group, and hrefs of anchors styled as buttons', () => {
  const observation = {
    revision: 'r', url: 'https://example.com/',
    title: 'Threads', text: 'Threads',
    controls: [
      ...Array.from({ length: 30 }, (_, i) => link(String(i + 1), 'reply', `/reply?id=${i + 1}`)),
      { id: '99', role: 'button', label: 'Sign up', href: 'https://example.com/signup', enabled: true },
    ],
  };
  const offered = legalActions(observation, { mode: 'read-only' }).filter(action => action.type !== 'done');
  const body = decideBody({ model: 'm', observation, offered, context: { instruction: 'Open a thread', compact: true } });
  const replies = Object.values(body.questions.action.criteria).map(textOf).filter(text => text.includes(' reply'));
  assert.equal(replies.length, 30);
  assert.ok(replies.every(text => /\(\/reply\?id=\d+\)$/.test(text)));
  const button = body.state.page.controls.find(control => control.id === '99');
  assert.equal(button.href, '/signup');
});

test('requestSizes sections, framing included, sum exactly to the total', () => {
  for (const context of [{ instruction: 'Open About', history: [] }, { instruction: 'Open About', history: [], compact: true }]) {
    const sizes = requestSizes(decideBody({ model: 'm', observation: PAGE, offered: OFFERED, context }));
    const sum = Object.entries(sizes.chars).filter(([key]) => key !== 'total').reduce((total, [, n]) => total + n, 0);
    assert.equal(sum, sizes.chars.total);
    assert.ok(sizes.chars.framing > 0);
  }
});
