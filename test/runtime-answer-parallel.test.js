// The answer ranking (choose) runs next to the decision that may end the run, and is used only when the run ends
// there with the same request it would have sent afterwards; otherwise it is discarded as if it had never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/runtime.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const PAGES = {
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
  '/about': {
    title: 'About',
    text: 'About\nMembers\nAda Lovelace\nGrace Hopper\nLinus Torvalds\nFormer members are listed separately.',
    controls: [link('1', 'Former members', '/former'), link('2', 'Home', '/')],
    blocks: [
      { t: 'h1', text: 'About' },
      { t: 'h2', text: 'Members' },
      { t: 'li', text: 'Ada Lovelace' },
      { t: 'li', text: 'Grace Hopper' },
      { t: 'li', text: 'Linus Torvalds' },
      { t: 'p', text: 'Former members are listed separately.' },
      { t: 'a', text: 'Former members', ref: '1' },
    ],
  },
  '/former': {
    title: 'Former members',
    text: 'Former members\nCharles Babbage\nAlan Turing\nKaren Sparck Jones',
    controls: [link('1', 'About', '/about')],
    blocks: [
      { t: 'h1', text: 'Former members' },
      { t: 'li', text: 'Charles Babbage' },
      { t: 'li', text: 'Alan Turing' },
      { t: 'li', text: 'Karen Sparck Jones' },
    ],
  },
  '/solo': {
    title: 'Solo',
    text: 'Members\nAda Lovelace',
    controls: [link('1', 'Home', '/')],
    blocks: [{ t: 'h1', text: 'Members' }, { t: 'li', text: 'Ada Lovelace' }],
  },
};

const QUESTION = 'Who is a member?';
const EXPECTATION = { textIncludes: 'member' }; // passes on /about, /former and /solo, not on Home

/**
 * Done-aware provider driven by a per-path plan `{ click?, done, guards? }`, logging decide start/end; decide takes
 * `decideMs`. `choose` (optional) is wrapped to log its start and keep each request.
 */
function planProvider(plan, { decideMs = 20, choose, log = [] } = {}) {
  const chooseCalls = [];
  const provider = {
    log,
    chooseCalls,
    model: 'fake-plan',
    async decide(observation, actions) {
      const path = new URL(observation.url).pathname;
      log.push(`decide:start:${path}`);
      await delay(decideMs);
      log.push(`decide:end:${path}`);
      const step = plan[path] ?? { done: 0.05 };
      const action = step.click ? actions.find(a => a.type === 'click' && a.label === step.click) : null;
      return {
        actionId: action?.id ?? 'handoff',
        confidence: 0.9,
        done: { probability: step.done },
        ...(step.guards ? { guards: step.guards } : {}),
        usage: { input_tokens: 100, output_tokens: 10 },
      };
    },
  };
  if (choose) {
    provider.choose = async request => {
      chooseCalls.push(request);
      log.push(`choose:start:${request.candidates.map(candidate => candidate.text).join('|')}`);
      return choose(request, chooseCalls.length);
    };
  }
  return provider;
}

/** choose() reply picking the candidate with `text`, else the second one. */
function pick(request, text) {
  const chosen = request.candidates.find(candidate => candidate.text === text) ?? request.candidates[1];
  return { choice: chosen.id, confidence: 0.85, usage: { input_tokens: 40, output_tokens: 2 } };
}

const run = (provider, options = {}) => new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES }), provider })
  .run('Open About and find a member', { answerQuestion: QUESTION, expectation: EXPECTATION, capture: 'none', ...options });

test('the ranking starts while the final decide is in flight and its pick is the answer', async () => {
  const provider = planProvider({ '/': { click: 'About', done: 0.05 }, '/about': { done: 0.9 } }, {
    decideMs: 40,
    choose: async request => {
      await delay(30);
      return pick(request, 'Grace Hopper');
    },
  });
  const result = await run(provider);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  const { log } = provider;
  const chooseStart = log.findIndex(entry => entry.startsWith('choose:start'));
  assert.ok(chooseStart >= 0 && chooseStart < log.indexOf('decide:end:/about'), log.join(', '));
  assert.ok(log.indexOf('decide:end:/') < chooseStart, 'only next to the decision on the final page');
  assert.equal(provider.chooseCalls.length, 1);
  // Same request as the serial ranking: the final page's candidates and the earlier-page trail.
  assert.equal(provider.chooseCalls[0].question, QUESTION);
  assert.ok(provider.chooseCalls[0].candidates.some(candidate => candidate.text === 'Grace Hopper'));
  assert.equal(result.answer.method, 'provider');
  assert.equal(result.answer.candidates[0].text, 'Grace Hopper');
  assert.equal(result.answerDetail.choice, provider.chooseCalls[0].candidates.find(c => c.text === 'Grace Hopper').id);
  assert.equal(result.cost.decisions, 2);
  assert.equal(result.cost.inputTokens, 100 + 100 + 40);
  const choose = result.cost.requests.filter(entry => entry.kind === 'choose');
  assert.equal(choose.length, 1);
  assert.equal(choose[0].discarded, undefined);
});

test('a 0-hop read ranks next to its only decide', async () => {
  const provider = planProvider({ '/about': { done: 0.9 } }, { decideMs: 40, choose: request => pick(request, 'Ada Lovelace') });
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES, path: '/about' }), provider });
  const result = await runtime.run('Find a member', { answerQuestion: QUESTION, expectation: EXPECTATION, capture: 'none' });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.steps.length, 0);
  assert.ok(provider.log.findIndex(entry => entry.startsWith('choose:start')) < provider.log.indexOf('decide:end:/about'));
  assert.equal(result.answer.candidates[0].text, 'Ada Lovelace');
});

for (const [name, hang] of [['already answered', false], ['still in flight', true]]) {
  test(`the decide continues past a passing page: the ranking there (${name}) is discarded`, async () => {
    const signals = [];
    const provider = planProvider({
      '/': { click: 'About', done: 0.05 },
      '/about': { click: 'Former members', done: 0.1 }, // the expectation passes, done does not confirm it
      '/former': { done: 0.9 },
    }, {
      choose: (request, n) => {
        signals.push(request.signal);
        if (n === 1 && hang) {
          return new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          });
        }
        return pick(request, n === 1 ? 'Grace Hopper' : 'Alan Turing');
      },
    });
    const result = await run(provider);
    assert.equal(result.status, 'completed');
    assert.equal(result.page.url.endsWith('/former'), true);
    assert.equal(provider.chooseCalls.length, 2);
    assert.ok(provider.chooseCalls[0].candidates.some(candidate => candidate.text === 'Grace Hopper'), 'speculated on /about');
    assert.ok(signals[0].aborted, 'the discarded request is abandoned');
    // Exactly the serial outcome: the final page's ranking, with /about only in the trail.
    assert.equal(result.answer.method, 'provider');
    assert.equal(result.answer.candidates[0].text, 'Alan Turing');
    assert.ok(!result.answer.candidates.some(candidate => candidate.text === 'Grace Hopper'));
    assert.equal(result.answerDetail.choice, provider.chooseCalls[1].candidates.find(c => c.text === 'Alan Turing').id);
    assert.ok(result.trail.some(entry => entry.url.endsWith('/about')));
    assert.deepEqual(provider.chooseCalls[1].earlierPages, result.trail);

    const chooses = result.cost.requests.filter(entry => entry.kind === 'choose');
    assert.equal(chooses.length, 2);
    const discarded = chooses.filter(entry => entry.discarded);
    assert.equal(discarded.length, 1);
    if (hang) {
      assert.equal(discarded[0].error, 'cancelled');
      assert.equal(discarded[0].inputTokens, undefined);
      assert.equal(result.cost.inputTokens, 3 * 100 + 40, 'an abandoned request reported no usage');
    } else {
      assert.equal(discarded[0].inputTokens, 40);
      assert.equal(result.cost.inputTokens, 3 * 100 + 2 * 40, 'spent tokens still count');
    }
  });
}

test('guards that stop the run discard the ranking: no answer, as without it', async () => {
  const signals = [];
  const provider = planProvider({
    '/': { click: 'About', done: 0.05 },
    '/about': { done: 0.2, guards: { blocked: 0.95 } },
  }, { choose: request => {
    signals.push(request.signal);
    return pick(request, 'Grace Hopper');
  } });
  const result = await run(provider);
  assert.equal(result.status, 'needs_user');
  assert.equal(result.code, 'blocked');
  assert.equal(provider.chooseCalls.length, 1, 'started next to the decide');
  assert.ok(signals[0].aborted);
  assert.deepEqual(result.answer, { method: 'none', candidates: [] });
  assert.equal(result.answerDetail, undefined);
  assert.equal(result.cost.requests.find(entry => entry.kind === 'choose').discarded, true);
});

test('a failed early ranking falls back to a serial one, and early rankings stop for the rest of the run', async () => {
  // Fallback: the early request fails upstream on the final page; a fresh one runs after the loop.
  const provider = planProvider({ '/': { click: 'About', done: 0.05 }, '/about': { done: 0.9 } }, {
    choose: async (request, n) => {
      if (n === 1) throw new Error('upstream 503');
      return pick(request, 'Grace Hopper');
    },
  });
  const result = await run(provider);
  assert.equal(result.status, 'completed');
  assert.equal(provider.chooseCalls.length, 2);
  assert.equal(result.answer.method, 'provider');
  assert.equal(result.answer.candidates[0].text, 'Grace Hopper');
  assert.equal(result.answerDetail.early, 'fallback');
  assert.deepEqual(result.cost.requests.filter(entry => entry.kind === 'choose').map(entry => entry.error ?? 'ok').sort(),
    ['ok', 'provider_error']);

  // Off: an early ranking on /about fails while the run goes on; /former gets no early ranking, only the serial one.
  const later = planProvider({
    '/': { click: 'About', done: 0.05 },
    '/about': { click: 'Former members', done: 0.1 },
    '/former': { done: 0.9 },
  }, {
    choose: async (request, n) => {
      if (n === 1) throw new Error('upstream 503');
      return pick(request, 'Alan Turing');
    },
  });
  const off = await run(later);
  assert.equal(off.status, 'completed');
  assert.equal(later.chooseCalls.length, 2);
  const second = later.log.findIndex((entry, i) => entry.startsWith('choose:start') && i > later.log.indexOf('decide:start:/former'));
  assert.ok(second > later.log.indexOf('decide:end:/former'), later.log.join(', '));
  assert.equal(off.answerDetail.early, 'off');
  assert.equal(off.answer.candidates[0].text, 'Alan Turing');
});

test('the page changes under an early ranking (late navigation re-observe): ranked on the new page', async () => {
  const pages = structuredClone(PAGES);
  pages['/about'].controls[0] = link('1', 'Former members', '/former', { lateHref: `${ORIGIN}/former` });
  const provider = planProvider({
    '/': { click: 'About', done: 0.05 },
    '/about': { click: 'Former members', done: 0.1 },
    '/former': { done: 0.9 },
  }, { choose: (request, n) => pick(request, n === 1 ? 'Grace Hopper' : 'Alan Turing') });
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider });
  const result = await runtime.run('Open About and find a member', { answerQuestion: QUESTION, expectation: EXPECTATION,
    capture: 'none', reobserveDelayMs: 0 });
  assert.equal(result.status, 'completed');
  assert.ok(result.verdict.why.includes('late_navigation'));
  assert.ok(result.page.url.endsWith('/former'));
  assert.equal(result.answer.candidates[0].text, 'Alan Turing');
  assert.ok(result.cost.requests.some(entry => entry.kind === 'choose' && entry.discarded));
  assert.ok(provider.chooseCalls.at(-1).candidates.some(candidate => candidate.text === 'Alan Turing'));
});

test('the page changes under a loading placeholder (awaitContent): only the loaded page is ranked', async () => {
  const LOADING = [{ t: 'h1', text: 'Members' }, { t: 'p', text: 'The member list loads below.' },
    { t: 'p', text: 'Loading members…' }];
  const LOADED = [{ t: 'h1', text: 'Members' }, { t: 'li', text: 'Ada Lovelace' }, { t: 'li', text: 'Grace Hopper' }];
  class SlowBridge extends FakeBridge {
    constructor() {
      super({ pages: { ...PAGES, '/slow': { title: 'Members', text: '', controls: [], blocks: LOADING } } });
      this.slowSeen = 0;
    }

    get observation() {
      const observation = super.observation;
      if (this.path === '/slow' && this.slowSeen > 1) {
        observation.blocks = LOADED.map(block => ({ ...block }));
        observation.text = LOADED.map(block => block.text).join('\n');
        observation.revision += ':loaded';
      }
      return observation;
    }

    async observe(signal, options) {
      if (this.path === '/slow') this.slowSeen++;
      return super.observe(signal, options);
    }
  }
  const bridge = new SlowBridge();
  bridge.path = '/slow';
  const provider = planProvider({ '/slow': { done: 0.9 } }, { choose: request => pick(request, 'Grace Hopper') });
  const result = await new BrowserRuntime({ bridge, provider }).run('Wait for the member list to finish loading', {
    answerQuestion: 'Who is a member once the list has loaded?', expectation: { textIncludes: 'members' }, capture: 'none',
    contentWaitMs: 0,
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.verdict.why.includes('content_wait'));
  assert.ok(provider.chooseCalls.length >= 1);
  for (const request of provider.chooseCalls) {
    assert.ok(!request.candidates.some(candidate => /Loading/.test(candidate.text)), 'never ranked the placeholder');
  }
  assert.equal(result.answer.candidates[0].text, 'Grace Hopper');
});

test('a throw while starting an early ranking does not fail the run', async () => {
  const provider = planProvider({ '/': { click: 'About', done: 0.05 }, '/about': { done: 0.9 } });
  let reads = 0;
  Object.defineProperty(provider, 'choose', {
    get() {
      reads++;
      if (reads === 1) throw new Error('getter exploded');
      return request => pick(request, 'Grace Hopper');
    },
  });
  const result = await run(provider);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.equal(result.answer.candidates[0].text, 'Grace Hopper', 'the serial ranking still runs');
});

test('a run without an expectation starts no early ranking', async () => {
  const provider = planProvider({ '/about': { done: 0.9 } }, { choose: request => pick(request, 'Ada Lovelace') });
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES, path: '/about' }), provider });
  const result = await runtime.run('Find a member', { answerQuestion: QUESTION, capture: 'none' });
  assert.equal(result.status, 'unverified');
  assert.equal(provider.chooseCalls.length, 1);
  assert.ok(provider.log.findIndex(entry => entry.startsWith('choose:start')) > provider.log.indexOf('decide:end:/about'));
  assert.equal(result.answerDetail.early, undefined);
});

test('capture last still captures the final step when the run runs out of time', async () => {
  class CaptureBridge extends FakeBridge {
    async capture() {
      return { dataUrl: 'data:image/jpeg;base64,YQ==', revision: this.observation.revision, format: 'jpeg' };
    }
  }
  const bridge = new CaptureBridge({ pages: PAGES });
  let n = 0;
  const provider = {
    async decide(observation, actions) {
      n++;
      if (n > 1) await new Promise(() => {}); // never answers: the run hits its time budget
      return { actionId: actions.find(a => a.label === 'About').id, confidence: 0.9 };
    },
  };
  const result = await new BrowserRuntime({ bridge, provider }).run('Open About and wait', {
    capture: 'last', timeoutMs: 1000, expectation: { urlIncludes: '/nowhere' },
  });
  assert.equal(result.code, 'time_budget');
  assert.equal(result.steps.length, 1);
  assert.ok(bridge.executions.every(execution => execution.capture === false));
  assert.equal(result.steps[0].screenshot?.revision, result.steps[0].observation.revision);
});

test('no ranking starts without candidates to rank, without choose() or without a passing expectation', async () => {
  // A single candidate: nothing to ask, before or after the loop.
  const solo = planProvider({ '/': { click: 'About', done: 0.05 }, '/solo': { done: 0.9 } }, {
    choose: () => assert.fail('choose must not be called'),
  });
  const soloRuntime = new BrowserRuntime({ bridge: new FakeBridge({ pages: PAGES, path: '/solo' }), provider: solo });
  const single = await soloRuntime.run('Find a member', { answerQuestion: QUESTION, expectation: EXPECTATION, capture: 'none' });
  assert.equal(single.code, 'expectation_passed');
  assert.equal(single.answerDetail.skipped, 'single_candidate');

  // No choose(): the heuristic order, as before.
  const plain = await run(planProvider({ '/': { click: 'About', done: 0.05 }, '/about': { done: 0.9 } }));
  assert.equal(plain.answer.method, 'heuristic');
  assert.equal(plain.answerDetail.skipped, 'no_choose');
  assert.ok(!plain.cost.requests.some(entry => entry.kind === 'choose'));

  // A local SystemOne server (provider.local) keeps the serial order: the ranking starts after the last decide.
  const local = planProvider({ '/': { click: 'About', done: 0.05 }, '/about': { done: 0.9 } }, {
    choose: request => pick(request, 'Grace Hopper'),
  });
  local.local = true;
  const localResult = await run(local);
  assert.equal(localResult.answer.candidates[0].text, 'Grace Hopper');
  assert.ok(local.log.findIndex(entry => entry.startsWith('choose:start')) > local.log.indexOf('decide:end:/about'));

  // The expectation fails on Home, so the first decide gets no ranking; the one on About does.
  const provider = planProvider({ '/': { click: 'About', done: 0.05 }, '/about': { done: 0.9 } }, {
    choose: request => pick(request, 'Grace Hopper'),
  });
  await run(provider);
  assert.ok(provider.log.findIndex(entry => entry.startsWith('choose:start')) > provider.log.indexOf('decide:end:/'));
  assert.equal(provider.chooseCalls.length, 1);
});
