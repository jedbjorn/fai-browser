// Answer candidates on results: provider choose(), heuristic fallback, bounds, statuses and the lean result shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { FakeBridge, ORIGIN, clickProvider, link } from './runtime-fixtures.js';

const PAGES = {
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
  '/about': {
    title: 'About',
    text: 'About\nMembers\nAda Lovelace\nGrace Hopper\nLinus Torvalds\nFormer members are in the changelog.',
    controls: [link('1', 'Home', '/')],
    blocks: [
      { t: 'a', text: 'Home', ref: '1' },
      { t: 'h1', text: 'About' },
      { t: 'h2', text: 'Members' },
      { t: 'li', text: 'Ada Lovelace' },
      { t: 'li', text: 'Grace Hopper' },
      { t: 'li', text: 'Linus Torvalds' },
      { t: 'p', text: 'Former members are in the changelog.' },
    ],
  },
};

// A single-member question: a list question ("Who are the members?") returns the whole run as one candidate.
const QUESTION = 'Who is a member?';

function setup(extra = {}) {
  const bridge = new FakeBridge({ pages: PAGES });
  const provider = Object.assign(clickProvider(['About'], { fallback: 'done' }), extra);
  return { bridge, provider, runtime: new BrowserRuntime({ bridge, provider }) };
}

function chooser(reply) {
  const calls = [];
  return {
    calls,
    async choose(request) {
      calls.push(request);
      return typeof reply === 'function' ? reply(request) : reply;
    },
  };
}

test('completed run: the provider chooses among page blocks and its pick is ranked first', async () => {
  const choose = chooser(({ candidates }) => ({
    choice: candidates.find(candidate => candidate.text === 'Grace Hopper').id,
    confidence: 0.9,
    probabilities: { c0: 0.05, c1: 0.9, c2: 0.03 },
    usage: { input_tokens: 30, output_tokens: 1 },
    model: 'fake-answer',
    requestId: 'req-a',
  }));
  const { runtime } = setup({ choose: choose.choose });
  const result = await runtime.run('Open About and find the members', {
    answerQuestion: QUESTION,
    expectation: { urlIncludes: '/about' },
  });
  assert.equal(result.status, 'completed');
  assert.equal(choose.calls.length, 1);
  const [request] = choose.calls;
  assert.equal(request.instruction, 'Open About and find the members');
  assert.equal(request.question, QUESTION);
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(request.candidates.slice(0, 3), [
    { id: 'c0', text: 'Ada Lovelace' }, { id: 'c1', text: 'Grace Hopper' }, { id: 'c2', text: 'Linus Torvalds' },
  ]);
  assert.ok(!request.candidates.some(candidate => candidate.text === 'Members'), 'headings are never candidates');

  assert.equal(result.answer.method, 'provider');
  assert.ok(result.answer.candidates.length <= 5);
  assert.deepEqual(result.answer.candidates[0], { text: 'Grace Hopper', confidence: 0.9, source: { t: 'li' } });
  assert.deepEqual(result.answer.candidates.slice(1, 3).map(candidate => candidate.text), ['Ada Lovelace', 'Linus Torvalds']);
  assert.equal(result.cost.decisions, 1, 'choose is not a decision');
  assert.equal(result.cost.inputTokens, 10 + 30);
  assert.equal(result.answerDetail.model, 'fake-answer');
  assert.equal(result.answerDetail.requestId, 'req-a');
  assert.equal(result.answerDetail.candidates[1].text, 'Grace Hopper');
  assert.ok(result.page.digest.some(block => block.text === 'Linus Torvalds'));
  assert.equal(result.page.controls, undefined);
});

test('a provider without choose() gets heuristic candidates', async () => {
  const { runtime } = setup();
  const result = await runtime.run('Open About', { answerQuestion: QUESTION, expectation: { urlIncludes: '/about' } });
  assert.equal(result.answer.method, 'heuristic');
  assert.deepEqual(result.answer.candidates.slice(0, 3).map(candidate => candidate.text),
    ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds']);
  for (const candidate of result.answer.candidates) assert.ok(candidate.confidence > 0 && candidate.confidence < 1);
  assert.equal(result.answerDetail.skipped, 'no_choose');
});

test('choose() failures and out-of-range choices degrade to the heuristic', async () => {
  const failing = setup({ choose: async () => { throw new Error('boom'); } });
  const failed = await failing.runtime.run('Open About', { answerQuestion: QUESTION, expectation: { urlIncludes: '/about' } });
  assert.equal(failed.status, 'completed', 'ranking never changes the outcome');
  assert.equal(failed.answer.method, 'heuristic');
  assert.deepEqual(failed.answerDetail.error, { code: 'provider_error', message: 'boom' });

  const stray = setup({ choose: async () => ({ choice: 'zz' }) });
  const strayed = await stray.runtime.run('Open About', { answerQuestion: QUESTION, expectation: { urlIncludes: '/about' } });
  assert.equal(strayed.answer.method, 'heuristic');
  assert.match(strayed.answerDetail.error.message, /outside the offered candidates/);

  const missing = setup({ choose: async () => undefined });
  const empty = await missing.runtime.run('Open About', { answerQuestion: QUESTION, expectation: { urlIncludes: '/about' } });
  assert.equal(empty.answer.method, 'heuristic');
});

test('choose() is bounded by the run time left and abandoned when it ignores its signal', async () => {
  let signal;
  const { runtime } = setup({
    choose: request => {
      signal = request.signal;
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  const result = await runtime.run('Open About', {
    answerQuestion: QUESTION, expectation: { urlIncludes: '/about' }, timeoutMs: 1200,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'completed');
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
  assert.equal(result.answer.method, 'heuristic');
  assert.equal(result.answerDetail.error.code, 'timeout');
  assert.equal(signal.aborted, true);
});

test('without answerQuestion the instruction is the question', async () => {
  const choose = chooser(({ candidates }) => ({ choice: candidates[0].id }));
  const { runtime } = setup({ choose: choose.choose });
  await runtime.run('Open About and list the members', { expectation: { urlIncludes: '/about' } });
  assert.equal(choose.calls[0].question, 'Open About and list the members');
  await assert.rejects(runtime.run('x', { answerQuestion: '  ' }), /answerQuestion/);
  await assert.rejects(runtime.run('x', { answerQuestion: 'q'.repeat(2001) }), /answerQuestion/);
});

test('checkpoint and unverified results carry answers; other statuses carry none and skip the provider', async () => {
  const choose = chooser(({ candidates }) => ({ choice: candidates[0].id, confidence: 0.6 }));
  const step = setup({ choose: choose.choose });
  const checkpoint = await step.runtime.step('Open About', { answerQuestion: QUESTION });
  assert.equal(checkpoint.status, 'checkpoint');
  assert.equal(checkpoint.answer.method, 'provider');

  const done = setup();
  const unverified = await done.runtime.run('Open About', { answerQuestion: QUESTION });
  assert.equal(unverified.status, 'unverified');
  assert.equal(unverified.answer.method, 'heuristic');

  const handoff = chooser({ choice: 'c0' });
  const bridge = new FakeBridge({ pages: PAGES, path: '/about' });
  const runtime = new BrowserRuntime({
    bridge, provider: { decide: async () => ({ actionId: 'handoff' }), choose: handoff.choose },
  });
  const result = await runtime.run(QUESTION);
  assert.equal(result.status, 'needs_host');
  assert.deepEqual(result.answer, { method: 'none', candidates: [] });
  assert.equal(handoff.calls.length, 0);
});

test('act() ranks heuristically for an answerQuestion and never asks the provider', async () => {
  const choose = chooser({ choice: 'c0' });
  const { runtime } = setup({ choose: choose.choose });
  const offer = await runtime.observe();
  const about = offer.actions.find(action => action.label === 'About');
  const result = await runtime.act(about.id, { answerQuestion: QUESTION });
  assert.equal(result.status, 'checkpoint');
  assert.equal(result.answer.method, 'heuristic');
  assert.equal(result.answer.candidates[0].text, 'Ada Lovelace');
  assert.equal(choose.calls.length, 0);

  const again = await runtime.observe();
  const home = again.actions.find(action => action.label === 'Home');
  const plain = await runtime.act(home.id);
  assert.deepEqual(plain.answer, { method: 'none', candidates: [] });
  assert.equal(plain.answerDetail.skipped, 'no_question');
});

test('the serialized result drops decision probabilities, page controls and diagnostics', async () => {
  const provider = {
    async decide(_, actions) {
      const about = actions.find(action => action.label === 'About');
      return { actionId: about.id, confidence: 0.8, probabilities: { [about.id]: 0.8, done: 0.2 } };
    },
  };
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES }), provider });
  const result = await runtime.step('Open About', { answerQuestion: QUESTION, minConfidence: 0.5 });
  assert.equal(result.status, 'checkpoint', 'minConfidence still gates on the decision confidence');
  assert.deepEqual(result.steps[0].decision.probabilities, { a0: 0.8, done: 0.2 }, 'still readable in memory');
  const json = JSON.parse(JSON.stringify(result));
  assert.deepEqual(Object.keys(json.steps[0].decision).sort(), ['actionId', 'by', 'confidence']);
  assert.equal(json.answerDetail, undefined);
  assert.equal(json.observation, undefined);
  assert.equal(json.page.url, `${ORIGIN}/about`);
  assert.ok(JSON.stringify(json.page).length < 1500);
});
