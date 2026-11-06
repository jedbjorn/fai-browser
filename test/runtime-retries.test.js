// In-call retries (run option `retry`, src/runtime.js): the second-opinion decide, the read-only back-out and the
// self-rerun, each with the cases where it must never run. Fake bridge and scripted providers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRuntime, MAX_SECOND_OPINIONS, resolveRetry } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { writeRun } from '../src/trace.js';
import { FakeBridge, ORIGIN, PAGES, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, type: 'button', enabled: true, ...extra });

/**
 * Provider driven by `script(observation, actions, context, call)`, which returns
 * `{ pick: label|'handoff'|'done', confidence, probabilities: {label|'handoff': p}, done, guards }`; labels are
 * mapped to the offered ids. Records every call with the offered labels in order.
 */
function scripted(script) {
  const calls = [];
  return {
    calls,
    model: 'fake',
    async decide(observation, actions, context) {
      const call = calls.length;
      calls.push({ path: new URL(observation.url).pathname, labels: actions.map(a => a.label ?? a.type), context });
      const plan = script(observation, actions, context, call);
      const idOf = label => (label === 'handoff' || label === 'done'
        ? label
        : actions.find(action => action.label === label)?.id);
      const decision = { actionId: idOf(plan.pick) ?? 'handoff', done: { probability: plan.done ?? 0.05 } };
      if (plan.confidence !== undefined) decision.confidence = plan.confidence;
      if (plan.probabilities) {
        decision.probabilities = {};
        for (const [label, p] of Object.entries(plan.probabilities)) {
          const id = idOf(label);
          if (id) decision.probabilities[id] = p;
        }
      }
      if (plan.guards) decision.guards = plan.guards;
      return decision;
    },
  };
}

function setup(pages, provider, path = '/') {
  const bridge = new FakeBridge({ pages: { ...PAGES, ...pages }, path });
  return { bridge, runtime: new BrowserRuntime({ bridge, provider }) };
}

const requests = result => result.cost.requests.map(entry => entry.kind);

// Two plausible links on the start page; Members is the right one.
const FORK = {
  '/': { title: 'Home', text: 'Welcome', controls: [link('1', 'Team', '/team'), link('2', 'Members', '/members')] },
  '/team': { title: 'Team news', text: 'Our team blog', controls: [link('1', 'Home', '/')] },
};

test('resolveRetry: default on, false off, single switches, unknown names refused', () => {
  assert.deepEqual(resolveRetry(), { secondOpinion: true, backOut: true, rerun: true });
  assert.deepEqual(resolveRetry(false), { secondOpinion: false, backOut: false, rerun: false });
  assert.deepEqual(resolveRetry({ rerun: false }), { secondOpinion: true, backOut: true, rerun: false });
  assert.throws(() => resolveRetry({ retryAll: true }), /Unknown retry switch/);
  assert.throws(() => resolveRetry({ rerun: 'no' }), /must be a boolean/);
  assert.throws(() => resolveRetry('on'), /boolean or an object/);
});

// ---------------------------------------------------------------------------------------------------------------
// Second opinion
// ---------------------------------------------------------------------------------------------------------------

test('second opinion: a close link call is asked again with the options reversed; a more confident change wins',
  async () => {
    // Order bias: the first call prefers whichever link comes first; reversed, it sees Members first and is sure.
    const provider = scripted((observation, actions, context, call) => {
      if (new URL(observation.url).pathname !== '/') return { pick: 'done', done: 0.9 };
      if (call === 0) return { pick: 'Team', confidence: 0.48, probabilities: { Team: 0.48, Members: 0.42, handoff: 0.1 } };
      return { pick: 'Members', confidence: 0.81, probabilities: { Members: 0.81, Team: 0.14, handoff: 0.05 } };
    });
    const { bridge, runtime } = setup(FORK, provider);
    const result = await runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
    assert.equal(result.code, 'expectation_passed');
    assert.equal(bridge.executions.length, 1, 'only the agreed link ran');
    assert.equal(bridge.executions[0].action.target, '2');
    // The second call saw the non-terminal options in reverse order, done and handoff still last.
    const [first, second] = provider.calls;
    const terminal = ['done', 'handoff'];
    assert.deepEqual(second.labels.filter(l => !terminal.includes(l)), first.labels.filter(l => !terminal.includes(l)).reverse());
    assert.deepEqual(second.labels.slice(-2), first.labels.slice(-2));
    assert.deepEqual(requests(result), ['decide', 'second_opinion', 'decide']);
    assert.equal(result.cost.requests[1].step, 1, 'the second opinion is the request whose choice ran');
    assert.equal(result.cost.requests[0].step, 1, 'the first decide of the pair is marked with the step too');
    const lean = agentResult(result);
    assert.deepEqual(lean.retries, [{ kind: 'second_opinion', why: 'close', outcome: 'changed', step: 1,
      first: { p: 0.48 }, second: { p: 0.81, same: false } }]);
    assert.ok(lean.verdict.why.includes('retry:second_opinion:changed'));
    assert.equal(lean.next.kind, 'answer');
  });

test('second opinion: the same choice is kept (agreed); a different but less confident one is not taken (kept)',
  async () => {
    const agreeing = scripted((observation, actions, context, call) => {
      if (new URL(observation.url).pathname !== '/') return { pick: 'done', done: 0.9 };
      return { pick: 'Members', confidence: call === 0 ? 0.5 : 0.6, probabilities: { Members: 0.5, Team: 0.4 } };
    });
    const agreed = await setup(FORK, agreeing).runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
    assert.equal(agreed.code, 'expectation_passed');
    assert.equal(agreed.retries[0].outcome, 'agreed');

    const wavering = scripted((observation, actions, context, call) => {
      if (new URL(observation.url).pathname !== '/') return { pick: 'done', done: 0.9 };
      if (call === 0) return { pick: 'Members', confidence: 0.5, probabilities: { Members: 0.5, Team: 0.4 } };
      return { pick: 'Team', confidence: 0.45, probabilities: { Team: 0.45, Members: 0.44 } };
    });
    const { bridge, runtime } = setup(FORK, wavering);
    const kept = await runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
    assert.equal(kept.retries[0].outcome, 'kept');
    assert.equal(bridge.executions[0].action.target, '2');
    assert.equal(kept.code, 'expectation_passed');
  });

test('second opinion never for controls: a below-floor button keeps its floor and goes to the host', async () => {
  // The reviewer's probe: Archive at 0.40 (below controlFloor 0.5); a second look preferring Delete at 0.51 must
  // never be asked, let alone run.
  const pages = { '/': { title: 'Draft', text: 'Draft', controls: [button('1', 'Archive'), button('2', 'Delete')] } };
  const provider = scripted((observation, actions, context, call) => (call === 0
    ? { pick: 'Archive', confidence: 0.4, probabilities: { Archive: 0.4, Delete: 0.35 } }
    : { pick: 'Delete', confidence: 0.51, probabilities: { Delete: 0.51, Archive: 0.3 } }));
  for (const mode of ['reversible', 'full']) {
    provider.calls.length = 0;
    const { bridge, runtime } = setup(pages, provider);
    const result = await runtime.run('Tidy up the draft', { mode, grant: { level: mode } });
    assert.equal(bridge.executions.length, 0, mode);
    assert.equal(result.code, 'low_confidence');
    assert.equal(result.retries, undefined);
    assert.equal(provider.calls.length, 1, 'no second decide');
    assert.ok(result.needs.alternatives.length >= 1, 'the host gets the alternatives');
  }
});

test('second opinion: a close handoff never becomes a control, even at full', async () => {
  // The reviewer's probe: a 0.45 handoff whose second look picks "Delete draft" at 0.55.
  const pages = { '/': { title: 'Draft', text: 'Draft', controls: [button('1', 'Delete draft'), link('2', 'Help', '/help')] } };
  const provider = scripted((observation, actions, context, call) => (call === 0
    ? { pick: 'handoff', confidence: 0.45, probabilities: { handoff: 0.45, 'Delete draft': 0.4, Help: 0.3 } }
    : { pick: 'Delete draft', confidence: 0.55, probabilities: { 'Delete draft': 0.55, handoff: 0.3, Help: 0.1 } }));
  const { bridge, runtime } = setup(pages, provider);
  const result = await runtime.run('Look at the draft', { mode: 'full', grant: { level: 'full' } });
  assert.ok(!bridge.executions.some(e => e.action.target === '1'), 'the control never ran');
  assert.equal(result.code, 'handoff');
  assert.deepEqual(result.retries.map(r => [r.why, r.outcome]), [['handoff_close', 'kept']]);
});

test('second opinion: a close handoff can become the link a more confident second look picks', async () => {
  const provider = scripted((observation, actions, context, call) => {
    if (new URL(observation.url).pathname !== '/') return { pick: 'done', done: 0.9 };
    if (call === 0) return { pick: 'handoff', confidence: 0.4, probabilities: { handoff: 0.4, Members: 0.35, Team: 0.25 } };
    return { pick: 'Members', confidence: 0.7, probabilities: { Members: 0.7, handoff: 0.2 } };
  });
  const { runtime } = setup(FORK, provider);
  const result = await runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(result.retries.map(r => [r.why, r.outcome]), [['handoff_close', 'changed']]);
});

test('second opinion never: clear margins, no probabilities, scroll-only rivals, consent dialogs, injection, off',
  async () => {
    const clear = scripted(observation => (new URL(observation.url).pathname === '/'
      ? { pick: 'Members', confidence: 0.8, probabilities: { Members: 0.8, Team: 0.1 } }
      : { pick: 'done', done: 0.9 }));
    const a = await setup(FORK, clear).runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
    assert.deepEqual(requests(a), ['decide', 'decide']);
    assert.equal(a.retries, undefined);

    const bare = scripted(observation => (new URL(observation.url).pathname === '/'
      ? { pick: 'Members', confidence: 0.3 } : { pick: 'done', done: 0.9 }));
    const b = await setup(FORK, bare).runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
    assert.deepEqual(requests(b), ['decide', 'decide'], 'no probabilities: nothing to compare');

    // A handoff whose only rivals are scrolling or waiting is never second-guessed.
    const empty = { '/': { title: 'Home', text: 'Nothing here', controls: [] } };
    const lonely = scripted(() => ({ pick: 'handoff', confidence: 0.4, probabilities: { handoff: 0.4, 'scroll down': 0.39 } }));
    const c = await setup(empty, lonely).runtime.run('Open Members', { expectation: { urlIncludes: '/members' },
      retry: { rerun: false } });
    assert.equal(lonely.calls.length, 1);
    assert.equal(c.code, 'handoff');

    // The injection guard noted the page: no second chance for page text addressed to the agent.
    const injected = scripted((observation, actions, context, call) => (call === 0
      ? { pick: 'Team', confidence: 0.45, probabilities: { Team: 0.45, Members: 0.4 }, guards: { injection: 0.8 } }
      : { pick: 'done', done: 0.9 }));
    await setup(FORK, injected).runtime.run('Open Members', { expectation: { urlIncludes: '/members' }, retry: false });
    const d = await setup(FORK, injected).runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
    assert.ok(!requests(d).includes('second_opinion'));

    const close = () => scripted(observation => (new URL(observation.url).pathname === '/'
      ? { pick: 'Members', confidence: 0.5, probabilities: { Members: 0.5, Team: 0.45 } } : { pick: 'done', done: 0.9 }));
    const e = await setup(FORK, close()).runtime.run('Open Members', { expectation: { urlIncludes: '/members' }, retry: false });
    assert.deepEqual(requests(e), ['decide', 'decide']);
    const f = await setup(FORK, close()).runtime.run('Open Members', { expectation: { urlIncludes: '/members' },
      retry: { secondOpinion: false } });
    assert.deepEqual(requests(f), ['decide', 'decide']);
  });

test('second opinion never on a consent dialog with several reject buttons', async () => {
  const page = {
    title: 'Home', text: 'Welcome', controls: [link('1', 'Members', '/members'),
      button('8', 'Reject all', { consent: true, dismissesConsent: true }),
      button('9', 'Necessary only', { consent: true, dismissesConsent: true })],
    consent: { text: 'Cookies', buttons: [{ id: '8', label: 'Reject all', kind: 'reject' }, { id: '9', label: 'Necessary only', kind: 'reject' }] },
  };
  const provider = scripted((observation, actions) => (actions.some(a => a.label === 'Reject all')
    ? { pick: 'Reject all', confidence: 0.5, probabilities: { 'Reject all': 0.5, 'Necessary only': 0.45 } }
    : new URL(observation.url).pathname === '/' ? { pick: 'Members', confidence: 0.9 } : { pick: 'done', done: 0.9 }));
  const result = await setup({ '/': page }, provider).runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
  assert.equal(result.code, 'expectation_passed');
  assert.ok(!requests(result).includes('second_opinion'));
});

test('second opinion: at most MAX_SECOND_OPINIONS per call, and none counts against maxDecisions', async () => {
  const chain = {
    '/': { title: 'Home', text: 'x', controls: [link('1', 'Step one', '/s1'), link('2', 'Other', '/o')] },
    '/s1': { title: 'S1', text: 'x', controls: [link('1', 'Step two', '/s2'), link('2', 'Other', '/o')] },
    '/s2': { title: 'S2', text: 'x', controls: [link('1', 'Step three', '/s3'), link('2', 'Other', '/o')] },
    '/s3': { title: 'S3', text: 'x', controls: [link('1', 'Step four', '/s4'), link('2', 'Other', '/o')] },
    '/s4': { title: 'S4', text: 'done here', controls: [] },
  };
  const provider = scripted((observation, actions) => {
    const next = actions.find(a => a.label?.startsWith('Step'));
    if (!next) return { pick: 'done', done: 0.9 };
    return { pick: next.label, confidence: 0.5, probabilities: { [next.label]: 0.5, Other: 0.45 } };
  });
  const { runtime } = setup(chain, provider);
  const result = await runtime.run('Follow the steps', { expectation: { urlIncludes: '/s4' }, maxActions: 5, maxDecisions: 5 });
  assert.equal(result.code, 'expectation_passed');
  assert.equal(requests(result).filter(kind => kind === 'second_opinion').length, MAX_SECOND_OPINIONS);
  assert.equal(requests(result).filter(kind => kind === 'decide').length, 5, 'all five budgeted decisions still ran');
  assert.equal(result.cost.decisions, 5 + MAX_SECOND_OPINIONS);
});

test('second opinion: merged guards can add a veto, never lift one', async () => {
  // The blocked veto too: a second look that scores the page as a wall stops the run before the link runs.
  const walled = scripted((observation, actions, context, call) => (call === 0
    ? { pick: 'Team', confidence: 0.45, probabilities: { Team: 0.45, Members: 0.4 }, guards: { blocked: 0.3 } }
    : { pick: 'Members', confidence: 0.7, probabilities: { Members: 0.7 }, guards: { blocked: 0.92 } }));
  const wall = setup(FORK, walled);
  const stopped = await wall.runtime.run('Open Members', { expectation: { urlIncludes: '/members' } });
  assert.equal(stopped.code, 'blocked');
  assert.equal(wall.bridge.executions.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Back-out
// ---------------------------------------------------------------------------------------------------------------

/** First choice on Home: Team (wrong); on Team: handoff; back on Home (Team no longer offered): Members. */
function wrongLinkProvider() {
  return scripted((observation, actions) => {
    const path = new URL(observation.url).pathname;
    if (path === '/') return { pick: actions.some(a => a.label === 'Team') ? 'Team' : 'Members', confidence: 0.9 };
    if (path === '/team') return { pick: 'handoff', confidence: 0.9 };
    return { pick: 'done', done: 0.9 };
  });
}

test('back-out: a read-only run that followed a wrong link goes back once and finishes without that link', async () => {
  const provider = wrongLinkProvider();
  const { bridge, runtime } = setup(FORK, provider);
  const result = await runtime.run('Open Members and read the names', { expectation: { urlIncludes: '/members' } });
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(bridge.executions.map(e => e.action.type), ['click', 'navigate_allowed_url', 'click']);
  assert.equal(bridge.executions[1].action.url, `${ORIGIN}/`);
  const back = result.steps[1];
  assert.equal(back.class, 'link');
  assert.deepEqual(back.decision, { by: 'runtime', actionId: 'back', reason: 'back_out' });
  assert.ok(!provider.calls[2].labels.includes('Team'), 'the wrong link is not offered again');
  const lean = agentResult(result);
  assert.deepEqual(lean.retries, [{ kind: 'back_out', why: 'handoff', outcome: 'expectation_passed', step: 2,
    from: '/team', to: '/' }]);
  assert.ok(lean.verdict.why.includes('retry:back_out'));
  assert.equal(lean.steps.length, 3, 'every step, the back-out included, is in the receipt');
});

test('back-out never: above read-only, without an expectation, on a named page, twice, or switched off', async () => {
  // Reversible: a link at a level that can also press buttons is never undone by the runtime.
  const reversible = setup(FORK, wrongLinkProvider());
  const r1 = await reversible.runtime.run('Open Members', { expectation: { urlIncludes: '/members' }, mode: 'reversible',
    retry: { rerun: false } });
  assert.equal(r1.code, 'handoff');
  assert.ok(!reversible.bridge.executions.some(e => e.action.type === 'navigate_allowed_url'));

  const loose = setup(FORK, wrongLinkProvider());
  const r2 = await loose.runtime.run('Open Members', { retry: { rerun: false } });
  assert.equal(r2.code, 'handoff', 'no expectation: the runtime cannot tell the page is wrong');

  // The page the link reached is one the instruction names: an intermediate hop, not a wrong link.
  const named = setup(FORK, wrongLinkProvider());
  const r3 = await named.runtime.run('Open Team, then Members', { expectation: { urlIncludes: '/members' },
    retry: { rerun: false } });
  assert.equal(r3.code, 'handoff');
  assert.equal(r3.retries, undefined);

  // A second wrong page after the back-out goes to the host: one back-out per call.
  const twice = {
    '/': { title: 'Home', text: 'x', controls: [link('1', 'Team', '/team'), link('2', 'Blog', '/blog'), link('3', 'Members', '/members')] },
    '/team': { title: 'Team news', text: 'x', controls: [link('1', 'Home', '/')] },
    '/blog': { title: 'Blog', text: 'x', controls: [link('1', 'Home', '/')] },
  };
  const wanderer = scripted((observation, actions) => {
    const path = new URL(observation.url).pathname;
    if (path === '/') return { pick: actions.some(a => a.label === 'Team') ? 'Team' : 'Blog', confidence: 0.9 };
    return { pick: 'handoff', confidence: 0.9 };
  });
  const w = setup(twice, wanderer);
  const r4 = await w.runtime.run('Open Members', { expectation: { urlIncludes: '/members' }, retry: { rerun: false } });
  assert.equal(r4.code, 'handoff');
  assert.equal(w.bridge.executions.filter(e => e.action.type === 'navigate_allowed_url').length, 1);
  assert.equal(r4.page.url, `${ORIGIN}/blog`);

  const off = setup(FORK, wrongLinkProvider());
  const r5 = await off.runtime.run('Open Members', { expectation: { urlIncludes: '/members' }, retry: { backOut: false, rerun: false } });
  assert.equal(r5.code, 'handoff');
  assert.equal(r5.page.url, `${ORIGIN}/team`);
});

test('back-out never when the expectation passes on the page the link reached', async () => {
  const provider = scripted(observation => (new URL(observation.url).pathname === '/'
    ? { pick: 'Team', confidence: 0.9 } : { pick: 'handoff', confidence: 0.9, done: 0.1 }));
  const { bridge, runtime } = setup(FORK, provider);
  const result = await runtime.run('Open Members', { expectation: { textIncludes: 'team' } });
  assert.equal(result.code, 'handoff_expectation_passed');
  assert.ok(!bridge.executions.some(e => e.action.type === 'navigate_allowed_url'));
});

// ---------------------------------------------------------------------------------------------------------------
// Self-rerun
// ---------------------------------------------------------------------------------------------------------------

/** Clicks About on Home; on About it hands off unless the instruction is the suggested rerun, which opens Members. */
function rerunProvider() {
  return scripted((observation, actions, context) => {
    const path = new URL(observation.url).pathname;
    if (path === '/') return { pick: 'About', confidence: 0.9 };
    if (path === '/about') return { pick: context.instruction.startsWith('From the current page') ? 'Members' : 'handoff', confidence: 0.9 };
    return { pick: 'done', done: 0.9 };
  });
}

test('self-rerun: a rerun with a suggested instruction runs once in the same call; the receipt shows both attempts',
  async () => {
    const provider = rerunProvider();
    const { runtime } = setup({}, provider);
    const result = await runtime.run('Visit About, then Members, then read the member names.', {
      expectation: { urlIncludes: '/members' }, answerQuestion: 'Who are the members?', maxActions: 6, runId: 'run-1',
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.runId, 'run-1', 'the call keeps its run id');
    const lean = agentResult(result);
    assert.equal(lean.next.kind, 'answer_from_digest');
    assert.equal(lean.retries.length, 1);
    const [rerun] = lean.retries;
    assert.equal(rerun.kind, 'rerun');
    assert.equal(rerun.why, 'handoff');
    assert.equal(rerun.outcome, 'expectation_passed');
    assert.equal(rerun.status, 'completed');
    assert.deepEqual(rerun.first, { status: 'needs_host', code: 'handoff', steps: 1, url: '/about' });
    assert.match(rerun.instruction, /^From the current page, visit Members/);
    assert.equal(rerun.maxActions, 3);
    assert.ok(lean.verdict.why.includes('retry:rerun'));
    // The steps are every action of the call: the first attempt's About click, then the rerun's Members click,
    // numbered on; the decide that ran each one points at it.
    assert.deepEqual(result.steps.map(step => [step.i, step.action.label]), [[1, 'About'], [2, 'Members']]);
    assert.deepEqual(result.cost.requests.filter(entry => entry.step).map(entry => [entry.attempt, entry.step]), [[1, 1], [2, 2]]);
    // Cost covers both attempts; each provider request names its attempt.
    assert.equal(result.cost.decisions, 4);
    assert.deepEqual(result.cost.requests.map(entry => entry.attempt), [1, 1, 2, 2]);
    // The trail keeps what the first attempt saw.
    assert.equal(provider.calls[2].context.instruction, rerun.instruction);
    // The trace keeps the first attempt.
    const dir = await mkdtemp(join(tmpdir(), 'fai-retry-'));
    try {
      const written = await writeRun(result, { dir, instruction: 'x', operation: 'run' });
      const trace = JSON.parse(await readFile(written.trace, 'utf8'));
      assert.equal(trace.attempts.length, 1);
      assert.equal(trace.attempts[0].code, 'handoff');
      assert.equal(trace.attempts[0].steps, 1);
      assert.deepEqual(trace.steps.map(step => step.i), [1, 2]);
      assert.deepEqual(trace.retries.map(r => r.kind), ['rerun']);
      assert.deepEqual(trace.cost.requests.map(entry => entry.attempt), [1, 1, 2, 2]);
      assert.deepEqual(written.result.retries, lean.retries);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test('self-rerun without answerQuestion: answers are ranked for the original instruction, not the suggestion', async () => {
  const provider = rerunProvider();
  const questions = [];
  provider.choose = async request => {
    questions.push(request.question);
    return { choice: request.candidates[0].id, confidence: 0.6 };
  };
  const { runtime } = setup({
    '/members': { title: 'Members', text: 'Ada, Grace, Linus',
      blocks: [{ t: 'h1', text: 'Members' }, { t: 'p', text: 'Members: Ada, Grace, Linus' }, { t: 'p', text: 'Members since 2020' }],
      controls: [link('1', 'Home', '/')] },
  }, provider);
  const instruction = 'Visit About, then Members, then read the member names.';
  const result = await runtime.run(instruction, { expectation: { urlIncludes: '/members' }, maxActions: 6 });
  assert.equal(result.retries?.[0]?.kind, 'rerun');
  assert.match(result.retries[0].instruction, /^From the current page/);
  assert.deepEqual(questions, [instruction]);
});

test('self-rerun: the content-loading suggestion reruns the same instruction with the waiting expectation', async () => {
  let loads = 0;
  const pages = {
    '/': { title: 'Home', text: 'x', controls: [link('1', 'Status', '/status')] },
    '/status': { title: 'Status', text: 'Loading…', blocks: [{ t: 'h1', text: 'Status' }, { t: 'p', text: 'Loading…' }], controls: [] },
  };
  const bridge = new FakeBridge({ pages: { ...PAGES, ...pages }, path: '/' });
  const observe = bridge.observe.bind(bridge);
  bridge.observe = async (...args) => {
    const observation = await observe(...args);
    if (observation.url.endsWith('/status') && ++loads > 10) {
      observation.blocks = [{ t: 'h1', text: 'Status' }, { t: 'p', text: 'All systems normal' }];
      observation.text = 'All systems normal';
    }
    return observation;
  };
  const provider = scripted(observation => (new URL(observation.url).pathname === '/'
    ? { pick: 'Status', confidence: 0.9 } : { pick: 'done', done: 0.9 }));
  const runtime = new BrowserRuntime({ bridge, provider });
  const result = await runtime.run('Open the Status page and stop there.', {
    expectation: { urlIncludes: '/status' }, answerQuestion: 'What does the status say?', contentWaitMs: 0,
  });
  const lean = agentResult(result);
  assert.equal(lean.retries?.[0]?.kind, 'rerun');
  assert.equal(lean.retries[0].instruction, undefined, 'the same instruction');
  assert.deepEqual(lean.retries[0].expectation, { urlIncludes: '/status', textAbsent: 'Loading' });
  assert.ok(!lean.verdict.why.includes('content_loading'));
  assert.equal(lean.verdict.kind, 'verified');
  // The rerun ran no action: the first attempt's Status click (with its final screenshot) is still the call's step.
  assert.deepEqual(result.steps.map(step => [step.i, step.action.label]), [[1, 'Status']]);
  assert.ok(result.steps[0].screenshot, 'capture last kept the final screenshot');
});

test('self-rerun never: steps, level requests, relays, stops, side effects, a second rerun, little time, off',
  async () => {
    const instruction = 'Visit About, then Members, then read the member names.';
    const options = { expectation: { urlIncludes: '/members' }, answerQuestion: 'Who are the members?', maxActions: 6 };

    // A step is one action the host asked for: never extended.
    const step = setup({}, rerunProvider());
    const s = await step.runtime.step(instruction, options);
    assert.equal(s.retries, undefined);

    // Switched off.
    const off = await setup({}, rerunProvider()).runtime.run(instruction, { ...options, retry: { rerun: false } });
    assert.equal(off.code, 'handoff');
    assert.equal(agentResult(off).next.kind, 'rerun');

    // Not enough time left for a fair second attempt.
    const slow = rerunProvider();
    const decide = slow.decide.bind(slow);
    slow.decide = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return decide(...args);
    };
    const tight = await setup({}, slow).runtime.run(instruction, { ...options, timeoutMs: 5100 });
    assert.equal(tight.code, 'handoff');
    assert.equal(tight.retries, undefined);

    // A second rerun: the rerun itself hands off again; its own suggestion goes to the host.
    const stubborn = scripted(observation => (new URL(observation.url).pathname === '/' ? { pick: 'About', confidence: 0.9 }
      : { pick: 'handoff', confidence: 0.9 }));
    const again = await setup({}, stubborn).runtime.run('Visit About, then Members, then Team, then read the names.', {
      expectation: { urlIncludes: '/team' }, maxActions: 6,
    });
    assert.equal(again.retries.filter(r => r.kind === 'rerun').length, 1);

    // A button ran in the first attempt (reversible): the rerun could repeat a side effect, so it goes to the host.
    const pages = {
      '/': { title: 'Home', text: 'x', controls: [button('1', 'Expand'), link('2', 'About', '/about')] },
    };
    const pressed = scripted((observation, actions, context, call) => (call === 0
      ? { pick: 'Expand', confidence: 0.9 } : { pick: 'handoff', confidence: 0.9 }));
    const effect = await setup(pages, pressed).runtime.run(instruction, { ...options, mode: 'reversible' });
    assert.equal(effect.code, 'handoff');
    assert.equal(effect.retries, undefined);
    assert.equal(agentResult(effect).next.kind, 'rerun');
  });

test('self-rerun never for refusals or relays: a level request and a login wall reach the host unchanged', async () => {
  const pages = { '/': { title: 'Settings', text: 'Account', controls: [button('1', 'Delete account', { risk: 'destructive' })] } };
  const provider = scripted(() => ({ pick: 'handoff', confidence: 0.9 }));
  const refused = await setup(pages, provider).runtime.run('Delete the account', { mode: 'reversible', grant: { level: 'reversible' } });
  assert.equal(refused.code, 'refused_action');
  assert.equal(refused.retries, undefined);
  assert.notEqual(agentResult(refused).next.kind, 'rerun');

  const login = { '/': { title: 'Sign in', text: 'Email Password', controls: [
    { id: '1', role: 'textbox', label: 'Email', type: 'email', enabled: true },
    { id: '2', role: 'textbox', label: 'Password', type: 'password', enabled: true }] } };
  const walled = await setup(login, provider).runtime.run('Open the dashboard', { expectation: { urlIncludes: '/dashboard' } });
  assert.equal(walled.code, 'login');
  assert.equal(walled.retries, undefined);
  assert.equal(agentResult(walled).next.kind, 'relay');
});

test('a stop during the first attempt ends the call; no rerun starts', async () => {
  let runtime;
  const provider = scripted((observation, actions, context, call) => {
    if (call === 1) runtime.stop();
    return new URL(observation.url).pathname === '/' ? { pick: 'About', confidence: 0.9 } : { pick: 'handoff', confidence: 0.9 };
  });
  ({ runtime } = setup({}, provider));
  const result = await runtime.run('Visit About, then Members, then read the member names.', {
    expectation: { urlIncludes: '/members' }, maxActions: 6,
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.retries, undefined);
  assert.equal(provider.calls.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Review regressions: the rerun keeps the host's expectation, budgets and level
// ---------------------------------------------------------------------------------------------------------------

test('self-rerun never after expectation_failed: the wrong page is never verified by a swapped expectation', async () => {
  // The reviewer's probe: the host wants /members; attempt 1 stops sure-ish on /about, where its expectation fails.
  const provider = scripted(observation => (new URL(observation.url).pathname === '/'
    ? { pick: 'About', confidence: 0.9 } : { pick: 'wait', confidence: 0.9, done: 0.6 }));
  const { runtime } = setup({}, provider);
  const result = await runtime.run('Visit About, then Members, then read the member names.', {
    expectation: { urlIncludes: '/members' }, maxActions: 6,
  });
  assert.equal(result.code, 'expectation_failed');
  assert.notEqual(result.verification.passed, true);
  assert.notEqual(result.status, 'completed');
  assert.equal(result.retries, undefined);
});

test('self-rerun: the host call budget covers both attempts (maxActions 1 means one action in the whole call)', async () => {
  const one = setup({}, rerunProvider());
  const instruction = 'Visit About, then Members, then read the member names.';
  const r1 = await one.runtime.run(instruction, { expectation: { urlIncludes: '/members' }, maxActions: 1 });
  assert.equal(one.bridge.executions.length, 1);
  assert.equal(r1.retries, undefined);

  // maxDecisions used up by the first attempt: no rerun either.
  const two = setup({}, rerunProvider());
  const r2 = await two.runtime.run(instruction, { expectation: { urlIncludes: '/members' }, maxActions: 6, maxDecisions: 2 });
  assert.equal(r2.code, 'handoff');
  assert.equal(r2.retries, undefined);

  // With room left, the rerun gets only what remains: 3 actions, 2 taken, so at most 1 more.
  const three = setup({}, rerunProvider());
  const r3 = await three.runtime.run(instruction, { expectation: { urlIncludes: '/members' }, maxActions: 2 });
  assert.equal(r3.retries?.[0]?.kind, 'rerun');
  assert.equal(r3.retries[0].maxActions, 1);
  assert.ok(three.bridge.executions.length <= 2);
});

test('self-rerun only on read-only runs: at reversible and above the suggestion goes to the host', async () => {
  for (const mode of ['reversible', 'full']) {
    const { runtime } = setup({}, rerunProvider());
    const result = await runtime.run('Visit About, then Members, then read the member names.', {
      expectation: { urlIncludes: '/members' }, maxActions: 6, mode, grant: { level: mode },
    });
    assert.equal(result.code, 'handoff', mode);
    assert.equal(result.retries, undefined);
    assert.equal(agentResult(result).next.kind, 'rerun');
  }
});
