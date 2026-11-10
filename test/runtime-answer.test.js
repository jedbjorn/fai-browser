// Answer candidates on results: provider choose(), heuristic fallback, bounds, statuses and the lean result shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { FakeBridge, clickProvider, link } from './runtime-fixtures.js';

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

