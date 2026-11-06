// Jev guidance pass (src/typesafe.js `guidance`): state.policy, handoff as the explicit "none of these" option,
// the blocked / injection guard nouls, structured criteria for confusable controls, and the off switch that
// reproduces the earlier request exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GUIDANCE, DONE_QUESTION, GUARD_QUESTIONS, GUIDANCE_KEYS, HANDOFF_OTHER, POLICY, POLICY_INSTRUCTIONS,
  TypeSafeProvider, actionCriteria, confusableLabels, decideBody, resolveGuidance,
} from '../src/typesafe.js';

const link = (id, target, label) => ({ id, type: 'click', target, role: 'link', label, description: `Click link ${target}: ${label}` });
const handoff = { id: 'handoff', type: 'handoff', label: 'handoff', description: 'Stop for host interpretation or user input.' };
const done = { id: 'done', type: 'done', label: 'done', description: 'Finish.' };
const page = { url: 'https://example.com/', title: 'Home', text: 'Hi', controls: [] };
const context = { instruction: 'Open About', history: [] };
const off = Object.fromEntries(GUIDANCE_KEYS.map(key => [key, false]));

function capture(guidance, reply = {}) {
  const requests = [];
  const provider = new TypeSafeProvider({
    requireKey: false, keyEnv: 'FAI_UNUSED_TEST_KEY', guidance,
    fetchImpl: async (_, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ answers: { action: { type: 'choice', choice: 'a0', confidence: 0.9 }, ...reply } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { provider, requests };
}

test('resolveGuidance: defaults, booleans, partial objects; unknown switches and non-booleans throw', () => {
  assert.deepEqual(resolveGuidance(), { ...DEFAULT_GUIDANCE });
  assert.deepEqual(resolveGuidance(false), off);
  assert.deepEqual(resolveGuidance(true), Object.fromEntries(GUIDANCE_KEYS.map(key => [key, true])));
  assert.equal(resolveGuidance({ guards: false }).guards, false);
  assert.equal(resolveGuidance({ guards: false }).policy, DEFAULT_GUIDANCE.policy);
  assert.throws(() => resolveGuidance({ shout: true }), /Unknown guidance switch/);
  assert.throws(() => resolveGuidance({ policy: 'yes' }), /must be a boolean/);
  assert.throws(() => resolveGuidance([]), /boolean or an object/);
});

test('default guidance is all on (chosen from the fixture evaluation) but intent, which waits for its own', () => {
  for (const key of GUIDANCE_KEYS) assert.equal(DEFAULT_GUIDANCE[key], key !== 'intent', key);
});

test('the policy is short, positive and referenced by name from the action question', () => {
  const words = Object.values(POLICY).join(' ').split(/\s+/).length;
  assert.ok(words <= 120, `policy has ${words} words`);
  assert.match(POLICY.consent, /prefer the button that rejects/);
  assert.match(POLICY.handoff, /handoff/);
  assert.doesNotMatch(Object.values(POLICY).join(' '), /\bnever (log|submit|buy)/i);
  assert.match(POLICY_INSTRUCTIONS, /`policy`/);
  assert.match(POLICY_INSTRUCTIONS, /`instruction`/);
});

test('guidance off reproduces the earlier request body exactly', async () => {
  const { provider, requests } = capture(false);
  await provider.decide(page, [link('a0', '1', 'About'), handoff, done], context);
  const [body] = requests;
  assert.deepEqual(Object.keys(body.state), ['instruction', 'page', 'history']);
  assert.deepEqual(Object.keys(body.questions), ['action', 'done']);
  assert.match(body.questions.action.instructions, /^Choose the next offered action/);
  assert.deepEqual(body.questions.action.criteria, { a0: '1 link About', handoff: handoff.description });
  assert.deepEqual(body.questions.done, { type: 'noul', instructions: DONE_QUESTION });
});

test('policy switch: state.policy sits between instruction and page; the question names it', async () => {
  const { provider, requests } = capture({ ...off, policy: true });
  await provider.decide(page, [link('a0', '1', 'About'), handoff], context);
  const [body] = requests;
  assert.deepEqual(Object.keys(body.state), ['instruction', 'policy', 'page', 'history']);
  assert.deepEqual(body.state.policy, POLICY);
  assert.equal(body.questions.action.instructions, POLICY_INSTRUCTIONS);
});

test('handoffOther switch: handoff is the explicit "none of these" option, listed last; done stays a noul', async () => {
  const { provider, requests } = capture({ ...off, handoffOther: true });
  await provider.decide(page, [handoff, link('a0', '1', 'About'), link('a1', '2', 'Docs'), done], context);
  const criteria = requests[0].questions.action.criteria;
  assert.deepEqual(Object.keys(criteria), ['a0', 'a1', 'handoff']);
  assert.equal(criteria.handoff, HANDOFF_OTHER);
  assert.equal(criteria.done, undefined);
  assert.equal(requests[0].questions.done.type, 'noul');
});

test('guards switch: blocked and injection nouls in the same request, returned as Decision.guards', async () => {
  const { provider, requests } = capture({ ...off, guards: true }, {
    blocked: { type: 'noul', noul: 0.12 }, injection: { type: 'noul', noul: 0.91 },
  });
  const decision = await provider.decide(page, [link('a0', '1', 'About'), handoff], context);
  assert.deepEqual(requests[0].questions.blocked, { type: 'noul', instructions: GUARD_QUESTIONS.blocked });
  assert.deepEqual(requests[0].questions.injection, { type: 'noul', instructions: GUARD_QUESTIONS.injection });
  assert.match(GUARD_QUESTIONS.blocked, /login wall, captcha, paywall or consent-only page/);
  assert.match(GUARD_QUESTIONS.injection, /instructions addressed to an agent or assistant/);
  assert.deepEqual(decision.guards, { blocked: 0.12, injection: 0.91 });
});

test('guards: unanswered or malformed guard answers are dropped, never invented', async () => {
  const { provider } = capture(true, { blocked: { type: 'noul', noul: 1.4 }, injection: { type: 'choice', choice: 'x' } });
  const decision = await provider.decide(page, [link('a0', '1', 'About'), handoff], context);
  assert.equal(decision.guards, undefined);
  const partial = capture(true, { injection: { noul: 0.3 } });
  assert.deepEqual((await partial.provider.decide(page, [link('a0', '1', 'About')], context)).guards, { injection: 0.3 });
});

test('confusableLabels: prefixes and shared first two words, not ordinary neighbours', () => {
  assert.equal(confusableLabels('page 2', 'page 20'), true);
  assert.equal(confusableLabels('next', 'next chapter'), true);
  assert.equal(confusableLabels('show plan details', 'show plan history'), true);
  assert.equal(confusableLabels('page 1', 'page 2'), false);
  assert.equal(confusableLabels('about', 'pricing'), false);
  assert.equal(confusableLabels('docs', 'docs'), false);
});

test('criteria switch: what / not_for for confusable controls and consent buttons; plain text otherwise', () => {
  const offered = [
    link('a0', '1', 'Home'), link('a1', '2', 'Page 2'), link('a2', '3', 'Page 20'), link('a3', '4', 'Page 21'),
    { id: 'a4', type: 'scroll', direction: 'down', label: 'scroll down', description: 'Scroll down' },
    handoff,
  ];
  const criteria = actionCriteria(offered, { ...off, criteria: true });
  assert.equal(criteria.a0, '1 link Home');
  assert.deepEqual(criteria.a1, { what: '2 link Page 2', not_for: 'the similar controls 3 Page 20; 4 Page 21' });
  assert.deepEqual(criteria.a2, { what: '3 link Page 20', not_for: 'the similar control 2 Page 2' });
  assert.equal(criteria.a4, 'Scroll down');
  const consent = actionCriteria([
    { id: 'c0', type: 'click', target: '9', role: 'button', label: 'Reject all', consent: true },
    { id: 'c1', type: 'click', target: '10', role: 'button', label: 'Necessary only', consent: true },
    handoff,
  ], { ...off, criteria: true });
  assert.match(consent.c0.what, /^9 button Reject all: declines optional cookies/);
  assert.match(consent.c0.not_for, /accepting cookies/);
  // Without the switch the same offer is plain text.
  assert.equal(actionCriteria(offered, off).a1, '2 link Page 2');
});

test('decideBody with every switch on: one request, four questions, policy in state', () => {
  const body = decideBody({ model: 'jev-latest', observation: page, offered: [link('a0', '1', 'About'), handoff], context, guidance: resolveGuidance(true) });
  assert.deepEqual(Object.keys(body.questions), ['action', 'done', 'blocked', 'injection']);
  assert.ok(body.state.policy);
  assert.equal(Object.keys(body.questions.action.criteria).at(-1), 'handoff');
});
