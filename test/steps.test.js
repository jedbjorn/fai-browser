// Step lists (run option `steps`, src/steps.js and src/runtime.js #driveList): order, stop at the first step that does
// not pass, placeholder gating ({{answer:N}} only from an auto-confirmed answer), shared budgets, per-step guardrails
// and retries, the receipt (stepResults, merged steps and cost, next) and the trace. Fake bridge and scripted
// providers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { summaryText } from '../src/mcp.js';
import { carryForward, fillStep, foldTopLevel, likelyValue, placeholderValue, validateSteps, MAX_STEPS } from '../src/steps.js';
import { resolveThresholds } from '../src/oversight.js';
import { writeRun, toAgentResult } from '../src/trace.js';
import { FakeBridge, PAGES, link } from './runtime-fixtures.js';

const button = (id, label, extra = {}) => ({ id, role: 'button', label, type: 'button', enabled: true, ...extra });

const SITE = {
  ...PAGES,
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about'), link('2', 'Featured', '/featured'),
    link('3', 'Guides', '/guides')] },
  '/featured': { title: 'Featured', text: 'Featured guide: Monitoring', controls: [link('1', 'Guides', '/guides'), link('2', 'Home', '/')] },
  '/guides': { title: 'Guides', text: 'All guides', controls: [link('1', 'Monitoring', '/guides/monitoring'),
    link('2', 'Backups', '/guides/backups'), link('3', 'Home', '/')] },
  '/guides/monitoring': { title: 'Monitoring', text: 'Metrics are sampled every 15 seconds.', controls: [link('1', 'Guides', '/guides')],
    blocks: [{ t: 'a', text: 'Guides', ref: '1' }, { t: 'h1', text: 'Monitoring' }, { t: 'p', text: 'Metrics are sampled every 15 seconds.' },
      { t: 'p', text: 'Traces are sampled every 60 seconds.' }] },
  '/guides/backups': { title: 'Backups', text: 'Backups are kept for 35 days.', controls: [link('1', 'Guides', '/guides')] },
  '/settings': { title: 'Settings', text: 'Workspace settings', controls: [button('1', 'Rename'), button('2', 'Upgrade'),
    button('3', 'Delete workspace'), link('4', 'Home', '/')] },
};

/**
 * Provider whose decide follows `route(path, instruction)` (a link label, 'done' or 'handoff'; done reports
 * probability 0.95, everything else 0.05) and whose choose confirms the candidate containing `answers[question part]`
 * at 0.96 (anything else is ranked at 0.4, never confirmed). Records every decide and choose.
 */
function scripted(route, { answers = {}, delayMs = 0, probabilities, hit: hitP = 0.96, miss = 0.4, second = 0.01 } = {}) {
  const calls = [];
  const chooses = [];
  return {
    calls,
    chooses,
    model: 'fake',
    async decide(observation, actions, context) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const path = new URL(observation.url).pathname;
      calls.push({ path, instruction: context.instruction, labels: actions.map(action => action.label ?? action.type), context });
      const pick = route(path, context.instruction ?? '', calls.length - 1);
      const decision = pick === 'done' || pick === 'handoff'
        ? { actionId: pick, confidence: 0.9, done: { probability: pick === 'done' ? 0.95 : 0.05 } }
        : { actionId: actions.find(action => action.label === pick)?.id ?? 'handoff', confidence: 0.9, done: { probability: 0.05 } };
      const p = probabilities?.(path, context.instruction ?? '', actions);
      if (p) {
        decision.probabilities = p;
        delete decision.confidence;
      }
      return decision;
    },
    async choose({ question, candidates }) {
      chooses.push(question);
      const wanted = Object.entries(answers).find(([part]) => question.includes(part))?.[1];
      const hit = wanted ? candidates.find(candidate => candidate.text.includes(wanted)) : null;
      const top = hit ?? candidates[0];
      const p = hit ? hitP : miss;
      return {
        choice: top.id,
        confidence: p,
        probabilities: Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.id === top.id ? p : second])),
      };
    },
  };
}

/** Follow the links the instruction names, in order of mention, from wherever the tab is; done on the last one. */
function follow(path, instruction) {
  const pages = { '/': 'Home', '/about': 'About', '/members': 'Members', '/featured': 'Featured', '/guides': 'Guides',
    '/guides/monitoring': 'Monitoring', '/guides/backups': 'Backups' };
  const named = ['About', 'Members', 'Featured', 'Guides', 'Monitoring', 'Backups']
    .map(label => ({ label, at: instruction.indexOf(label) }))
    .filter(entry => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.label);
  const here = named.indexOf(pages[path]);
  if (here === named.length - 1) return 'done';
  return named[here + 1] ?? named[0];
}

function setup(provider, path = '/') {
  const bridge = new FakeBridge({ pages: SITE, path });
  return { bridge, runtime: new BrowserRuntime({ bridge, provider }) };
}

const ABOUT = { instruction: 'Open About', expectation: { urlIncludes: '/about' } };
const MEMBERS = { instruction: 'Open Members', expectation: { urlIncludes: '/members' }, answerQuestion: 'Who is a member?' };

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

test('validateSteps: normalized copy; every step needs instruction and a declarative expectation', () => {
  const steps = validateSteps([ABOUT, { ...MEMBERS, maxActions: 3 }]);
  assert.deepEqual(steps, [ABOUT, { ...MEMBERS, maxActions: 3 }]);
  assert.notEqual(steps[0].expectation, ABOUT.expectation, 'copied');
  const bad = [
    [[], /1 to 15 steps/],
    [Array.from({ length: MAX_STEPS + 1 }, () => ABOUT), /1 to 15 steps/],
    ['Open About', /must be an array/],
    [[{ instruction: 'Open About' }], /steps\[0\]\.expectation is required/],
    [[{ instruction: ' ', expectation: { urlIncludes: '/a' } }], /steps\[0\]\.instruction must be a non-empty string/],
    [[{ ...ABOUT, expectation: () => true }], /steps\[0\]\.expectation must be an object/],
    [[{ ...ABOUT, expectation: { urlHas: '/a' } }], /Unsupported expectation field/],
    [[{ ...ABOUT, mode: 'full' }], /steps\[0\]\.mode is not a step field/],
    [[{ ...ABOUT, maxActions: 31 }], /maxActions must be an integer from 1 to 30/],
    [[{ ...ABOUT, answerQuestion: '' }], /answerQuestion must be a non-empty string/],
  ];
  for (const [value, pattern] of bad) assert.throws(() => validateSteps(value), pattern);
});

test('validateSteps: placeholders name an earlier step with a question, never a regex or a later step', () => {
  const asked = { ...ABOUT, answerQuestion: 'Which guide is featured?' };
  assert.doesNotThrow(() => validateSteps([asked, { instruction: 'Open the {{answer:1}} guide',
    expectation: { urlIncludes: '/guides/', textIncludes: '{{ answer : 1 }}' } }]));
  const bad = [
    [[asked, { instruction: 'Open {{answer:2}}', expectation: { urlIncludes: '/x' } }], /only name an earlier step \(1 to 1\)/],
    [[{ instruction: 'Open {{answer:1}}', expectation: { urlIncludes: '/x' } }], /only name an earlier step/],
    [[ABOUT, { instruction: 'Open {{answer:1}}', expectation: { urlIncludes: '/x' } }], /step 1 has no answerQuestion/],
    [[asked, { instruction: 'Open {{answer 1}}', expectation: { urlIncludes: '/x' } }], /placeholder FAI cannot fill/],
    [[asked, { instruction: 'Open {{answer:one}}', expectation: { urlIncludes: '/x' } }], /placeholder FAI cannot fill/],
    // A {{supply:N}} from next.steps that the host did not replace.
    [[asked, { instruction: 'Open {{supply:1}}', expectation: { urlIncludes: '/x' } }], /replace \{\{supply:N\}\} with the value yourself/],
    [[asked, { instruction: 'Open it', expectation: { urlIncludes: '/x', urlMatches: '{{answer:1}}' } }], /urlMatches cannot hold a placeholder/],
    // A page value never chooses its own check: no fillable textAbsent/urlEquals, and one placeholder-free field.
    [[asked, { instruction: 'Open it', expectation: { urlIncludes: '/x', textAbsent: '{{answer:1}}' } }], /textAbsent cannot hold a placeholder/],
    [[asked, { instruction: 'Open it', expectation: { urlIncludes: '/x', urlEquals: '{{answer:1}}' } }], /urlEquals cannot hold a placeholder/],
    [[asked, { instruction: 'Open it', expectation: { textIncludes: '{{answer:1}}' } }], /needs a field without a placeholder/],
    [[asked, { instruction: 'Open it', expectation: { textIncludes: '{{answer:1}}', titleIncludes: 'x {{answer:1}}' } }],
      /needs a field without a placeholder/],
    // A filled question could pass its 2000-character limit: refused up front, never mid-list.
    [[asked, { instruction: 'Open it', expectation: { urlIncludes: '/x' }, answerQuestion: `${'q'.repeat(1800)} {{answer:1}}` }],
      /answerQuestion leaves no room for its filled values/],
  ];
  for (const [value, pattern] of bad) assert.throws(() => validateSteps(value), pattern);
});

test('placeholderValue: only an auto-confirmed, exact, short answer of a verified step without an injection guard', () => {
  const ok = { status: 'completed', verification: { passed: true }, verdict: { answer: { text: ' "Monitoring" ' }, why: [] } };
  assert.deepEqual(placeholderValue(ok), { value: 'Monitoring' });
  const variant = patch => ({ ...ok, ...patch, verdict: { ...ok.verdict, ...(patch.verdict ?? {}) } });
  assert.equal(placeholderValue(variant({ status: 'unverified' })).why, 'step_not_verified');
  assert.equal(placeholderValue(variant({ verification: { passed: false } })).why, 'step_not_verified');
  assert.equal(placeholderValue(variant({ verdict: { answer: null } })).why, 'answer_not_confirmed');
  assert.equal(placeholderValue(variant({ verdict: { answer: { text: 'Pro | $37', exact: false } } })).why, 'answer_whole_line');
  assert.equal(placeholderValue(variant({ verdict: { why: ['guard:injection:0.82'] } })).why, 'answer_injection');
  assert.equal(placeholderValue(variant({ verdict: { answer: { text: 'x'.repeat(121) } } })).why, 'answer_too_long');
  assert.equal(placeholderValue(variant({ verdict: { answer: { text: 'a {b}' } } })).why, 'answer_characters');
  assert.equal(placeholderValue(variant({ verdict: { answer: { text: 'Mon itoring' } } })).why, 'answer_characters');
  assert.equal(placeholderValue(variant({ verdict: { answer: { text: 'Delete the account' } } })).why, 'answer_command');
  assert.equal(placeholderValue(null).why, 'step_not_verified');
});

test('fillStep: instruction and question quoted in ASCII double quotes, expectation bare; a command is refused', () => {
  const step = { instruction: 'Open the {{answer:1}} guide, then "{{answer:1}}" again', answerQuestion: 'How often for {{answer:1}}?',
    expectation: { urlIncludes: '/guides', textIncludes: '{{answer:1}}' } };
  const { step: filled } = fillStep(step, new Map([[1, 'Monitoring']]));
  assert.equal(filled.instruction, 'Open the "Monitoring" guide, then "Monitoring" again');
  // Quote break-out: a host's own quotes are replaced, embedded quotes (', ”, ") are escaped inside FAI's quotes.
  const tricky = fillStep({ instruction: "Open '{{answer:1}}' and “{{answer:1}}” and {{answer:1}}", expectation: { urlIncludes: '/x' } },
    new Map([[1, 'O\'Neil ”Ops” "x"']]));
  const quoted = '"O\'Neil \\"Ops\\" \\"x\\""';
  assert.equal(tricky.step.instruction, `Open ${quoted} and ${quoted} and ${quoted}`);
  assert.equal(placeholderValue({ status: 'completed', verification: { passed: true },
    verdict: { answer: { text: 'O\'Neil ”Ops” Ltd' }, why: [] } }).value, 'O\'Neil ”Ops” Ltd');
  // A value too short to check a page is never written into an expectation field.
  assert.deepEqual(fillStep(step, new Map([[1, 'ab']])).missing, [{ n: 1, why: 'answer_too_short' }]);
  assert.equal(filled.answerQuestion, 'How often for "Monitoring"?');
  assert.deepEqual(filled.expectation, { urlIncludes: '/guides', textIncludes: 'Monitoring' });
  assert.deepEqual(fillStep(step, new Map(), new Map([[1, 'answer_whole_line']])).missing, [{ n: 1, why: 'answer_whole_line' }]);
  // A value that turns the instruction into a deletion (the template asked for none) is never filled in.
  const sneaky = fillStep({ instruction: 'Then {{answer:1}}', expectation: { urlIncludes: '/x' } }, new Map([[1, 'delete the account']]));
  assert.deepEqual(sneaky.missing, [{ n: 1, why: 'answer_command' }]);
});

test('run(): an instruction with steps is the summary (never sent to the provider); step() with steps is refused', async () => {
  const provider = scripted(follow);
  const { runtime } = setup(provider);
  const result = await runtime.run('Read the About page', { steps: [ABOUT] });
  assert.equal(result.verification.passed, true, result.reason);
  assert.ok(provider.calls.length && provider.calls.every(entry => entry.context.instruction !== 'Read the About page'));
  await assert.rejects(runtime.run('  ', { steps: [ABOUT] }), /instruction with steps is the task summary/);
  await assert.rejects(runtime.step({ steps: [ABOUT] }), /runs with run\(\), not step\(\)/);
  await assert.rejects(runtime.run({ steps: [{ instruction: 'Open About' }] }), /expectation is required/);
});

test('foldTopLevel: a top-level expectation or question goes to the last step, else becomes a final check', () => {
  const bare = { instruction: 'Open Members' };
  // The last step without an expectation (or question) takes the call's.
  assert.deepEqual(foldTopLevel([ABOUT, bare], { expectation: { urlIncludes: '/members' }, answerQuestion: 'Who?' }),
    { steps: [ABOUT, { ...bare, expectation: { urlIncludes: '/members' }, answerQuestion: 'Who?' }], warnings: [] });
  // The same one is a no-op; a different one (the bench hosts sent {"urlIncludes": "127.0.0.1"}) is a final check.
  assert.deepEqual(foldTopLevel([ABOUT, MEMBERS], { expectation: { urlIncludes: '/members' } }),
    { steps: [ABOUT, MEMBERS], warnings: [] });
  assert.deepEqual(foldTopLevel([ABOUT, MEMBERS], { expectation: { urlIncludes: '127.0.0.1' } }).finalExpectation,
    { urlIncludes: '127.0.0.1' });
  // A different question: the step's own is asked, with a warning.
  assert.match(foldTopLevel([ABOUT, MEMBERS], { answerQuestion: 'Who else?' }).warnings[0], /^answer_question_ignored: steps\[1\]/);
  assert.deepEqual(foldTopLevel([ABOUT, MEMBERS], { answerQuestion: MEMBERS.answerQuestion }).warnings, []);
  assert.deepEqual(foldTopLevel([ABOUT, MEMBERS], { answerQuestion: null, expectation: null }), { steps: [ABOUT, MEMBERS], warnings: [] });
  // Nothing is mutated; bad top-level values are named.
  const list = [ABOUT, bare];
  foldTopLevel(list, { expectation: { urlIncludes: '/x' } });
  assert.equal(list[1].expectation, undefined);
  assert.throws(() => foldTopLevel([ABOUT], { expectation: { urlHas: '/x' } }), /Unsupported expectation field/);
  assert.throws(() => foldTopLevel([ABOUT], { expectation: 'about' }), /expectation must be an object/);
  assert.throws(() => foldTopLevel([{ ...ABOUT, answerQuestion: 'Q?' }, MEMBERS], { expectation: { textIncludes: '{{answer:1}}' } }),
    /cannot hold a placeholder at the top level/);
  assert.throws(() => foldTopLevel([ABOUT, bare], {}), /steps\[1\]\.expectation is required/);
});

test('run(): a top-level expectation with steps fills the last step or is checked on the final page', async () => {
  const { runtime } = setup(scripted(follow));
  const filled = agentResult(await runtime.run({ steps: [ABOUT, { instruction: 'Open Members' }], expectation: { urlIncludes: '/members' } }));
  assert.equal(filled.verification.passed, true);
  assert.deepEqual(filled.verification.expectation, { urlIncludes: '/members' });
  const loose = agentResult(await setup(scripted(follow)).runtime.run({ steps: [ABOUT, MEMBERS], expectation: { urlIncludes: 'example.com' } }));
  assert.equal(loose.status, 'completed');
  assert.equal(loose.verification.passed, true, 'a final check that passes changes nothing');
  const wrong = agentResult(await setup(scripted(follow)).runtime.run({ steps: [ABOUT, MEMBERS], expectation: { urlIncludes: '/pricing' } }));
  assert.equal(wrong.code, 'expectation_failed');
  assert.equal(wrong.verification.passed, false);
  assert.ok(wrong.verdict.why.includes('steps:final_expectation_failed'));
  assert.ok(wrong.verdict.why.includes('steps:stopped_at:2'));
  assert.deepEqual(wrong.stepResults.map(entry => entry.passed), [true, false]);
  // The call's expectation conflicts with step 2's urlIncludes: next.steps keeps the step's, next.expectation the call's.
  assert.deepEqual(wrong.next.steps, [MEMBERS]);
  assert.deepEqual(wrong.next.expectation, { urlIncludes: '/pricing' });
  assert.match(wrong.next.text, /Also send expectation \{"urlIncludes":"\/pricing"\} \(next\.expectation/);
  assert.match(summaryText(wrong), /^next\.expectation \(send with next\.steps\): \{"urlIncludes":"\/pricing"\}$/m);
  // No conflict: the call's check is merged into the resent last step.
  const merged = agentResult(await setup(scripted(follow)).runtime.run({ steps: [ABOUT, MEMBERS], expectation: { textIncludes: 'Treasurer' } }));
  assert.equal(merged.code, 'expectation_failed');
  assert.deepEqual(merged.next.steps, [{ ...MEMBERS, expectation: { urlIncludes: '/members', textIncludes: 'Treasurer' } }]);
  assert.equal(merged.next.expectation, undefined);
  // A last step whose page the provider scored as blocked: the call's expectation is still checked, never passed unchecked.
  const blockedProvider = scripted(follow);
  const decide = blockedProvider.decide;
  blockedProvider.decide = async (observation, ...rest) => ({ ...await decide(observation, ...rest),
    ...(observation.url.endsWith('/about') ? { guards: { blocked: 0.95, injection: 0.01 } } : {}) });
  const blocked = agentResult(await setup(blockedProvider).runtime.run({ steps: [ABOUT], expectation: { urlIncludes: '/backups' } }));
  assert.equal(blocked.verification.passed, false);
  assert.equal(blocked.code, 'expectation_failed');
  assert.ok(blocked.verdict.why.includes('steps:final_expectation_failed'));
  assert.ok(blocked.verdict.why.includes('guard:blocked_page'), 'the step passed its own check on a blocked page');
  const asked = agentResult(await setup(scripted(follow)).runtime.run({ steps: [ABOUT, MEMBERS], answerQuestion: 'Who else?' }));
  assert.ok(asked.warnings.some(code => code.startsWith('answer_question_ignored')));
});

// ---------------------------------------------------------------------------------------------------------------
// Order, receipt, stop
// ---------------------------------------------------------------------------------------------------------------

test('steps run in order in one call; the receipt merges actions and cost and lists every step', async () => {
  const provider = scripted(follow);
  const { bridge, runtime } = setup(provider);
  const progress = [];
  const result = await runtime.run({ steps: [ABOUT, MEMBERS], onAction: step => progress.push(step.i), awaitCallbacks: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'expectation_passed');
  assert.deepEqual(provider.calls.map(call => [call.instruction, call.path]),
    [['Open About', '/'], ['Open About', '/about'], ['Open Members', '/about'], ['Open Members', '/members']]);
  assert.deepEqual(bridge.executions.map(execution => execution.action.target), ['1', '1']);
  assert.deepEqual(result.steps.map(step => step.i), [1, 2], 'one sequence of actions for the call');
  assert.deepEqual(progress, [1, 2]);
  assert.equal(result.cost.decisions, 4);
  assert.ok(result.cost.requests.some(entry => entry.listStep === 1) && result.cost.requests.some(entry => entry.listStep === 2));
  assert.match(result.reason, /^All 2 steps passed: /);
  const lean = agentResult(result);
  assert.equal(lean.verification.passed, true);
  assert.ok(lean.verdict.why.includes('steps:2/2'));
  // Passed steps are kept small: {i, status, code, passed}, plus asked/answer/candidates/url for a step that asked.
  assert.deepEqual(lean.stepResults[0], { i: 1, status: 'completed', code: 'expectation_passed', passed: true });
  assert.deepEqual(lean.stepResults[1], { i: 2, status: 'completed', code: 'expectation_passed', passed: true, asked: true,
    url: 'https://example.com/members' });
  assert.equal(lean.next.steps, undefined, 'nothing to send next after a full pass');
  assert.equal(lean.stepResults[0].asked, undefined);
  assert.equal(lean.page.url, 'https://example.com/members');
  assert.equal(lean.next.kind, 'answer_from_digest', 'one question, on the last step: the single-run next');
  assert.doesNotMatch(lean.next.text, /Step list/);
});

test('the list stops at the first step that does not pass; later steps never start and next says so', async () => {
  // Step 1 hands off on the start page: step 2's instruction is never decided.
  const provider = scripted((path, instruction) => (instruction === 'Open Members' ? follow(path, instruction) : 'handoff'));
  const { runtime } = setup(provider);
  const result = await runtime.run({ steps: [ABOUT, MEMBERS], retry: false });
  assert.equal(result.code, 'handoff');
  assert.ok(provider.calls.every(call => call.instruction === 'Open About'));
  const lean = agentResult(result);
  assert.equal(lean.verification.passed, false);
  assert.deepEqual(lean.stepResults.map(entry => [entry.status, entry.code]), [['needs_host', 'handoff'], ['not_run', 'not_run']]);
  assert.equal(lean.stepResults[0].kind, 'needs_decision', 'the stopping step keeps its verdict kind');
  assert.deepEqual(lean.stepResults[0].expectation, { urlIncludes: '/about' });
  assert.ok(lean.verdict.why.includes('steps:stopped_at:1'));
  assert.ok(lean.verdict.why.includes('steps:0/2'));
  assert.match(lean.reason, /^Step 1 of 2: /);
  assert.match(lean.next.text, /^Step 1 did not pass \(handoff\)\. Call fai_browser_run with requestId .* and steps = next\.steps exactly \(steps 1-2/);
  assert.deepEqual(lean.next.steps, [ABOUT, MEMBERS]);
});

test('a later step that fails is reported with the steps before it as passed, never to be sent again', async () => {
  const provider = scripted((path, instruction) => (instruction === 'Open About' ? follow(path, instruction) : 'handoff'));
  const { runtime } = setup(provider);
  const result = await runtime.run({ steps: [ABOUT, MEMBERS, { ...ABOUT, instruction: 'Open About again' }], retry: false });
  const lean = agentResult(result);
  assert.equal(lean.code, 'handoff');
  assert.equal(lean.verification.passed, false);
  assert.deepEqual(lean.stepResults.map(entry => entry.status), ['completed', 'needs_host', 'not_run']);
  assert.match(lean.next.text, /Step 1 passed; never send it again\. Call fai_browser_run with requestId .* steps = next\.steps exactly \(steps 2-3/);
  assert.deepEqual(lean.next.steps.map(step => step.instruction), ['Open Members', 'Open About again']);
  assert.ok(lean.verdict.why.includes('steps:stopped_at:2'));
  assert.ok(lean.verdict.why.includes('steps:1/3'));
});

// ---------------------------------------------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------------------------------------------

const FEATURED = { instruction: 'From the home page open Featured. Read which guide is featured.',
  expectation: { urlIncludes: '/featured' }, answerQuestion: 'Which guide is featured?' };
const JOINED = { instruction: 'Click Guides, then the {{answer:1}} guide. Read how often metrics are sampled.',
  expectation: { urlIncludes: '/guides/' }, answerQuestion: 'How often are metrics sampled?' };

test('placeholder: an auto-confirmed answer fills the next step; both answers come back in stepResults', async () => {
  const route = (path, instruction) => {
    if (instruction.startsWith('From the home page')) return path === '/featured' ? 'done' : 'Featured';
    if (path === '/featured') return 'Guides';
    if (path === '/guides') return instruction.includes('"Monitoring"') ? 'Monitoring' : 'handoff';
    return 'done';
  };
  const provider = scripted(route, { answers: { featured: 'Monitoring', sampled: '15 seconds' } });
  const { runtime } = setup(provider);
  const result = await runtime.run({ steps: [FEATURED, JOINED] });
  assert.equal(result.status, 'completed', result.reason);
  const second = provider.calls.find(call => call.instruction.startsWith('Click Guides'));
  assert.equal(second.instruction, 'Click Guides, then the "Monitoring" guide. Read how often metrics are sampled.');
  const lean = agentResult(result);
  assert.equal(lean.stepResults[0].answer.text, 'Monitoring');
  assert.match(lean.stepResults[1].answer.text, /15 seconds/);
  assert.equal(lean.next.kind, 'answer');
  assert.match(lean.next.text, /All 2 steps passed\. verdict\.answer\.text lists each step's auto-confirmed answer/);
  assert.equal(lean.verdict.kind, 'verified');
  // The call's answer lists both steps' answers, one line per step, and names them by step number.
  assert.deepEqual(lean.verdict.answer.steps.map(step => step.i), [1, 2]);
  assert.equal(lean.verdict.answer.steps[0].text, 'Monitoring');
  assert.match(lean.verdict.answer.text, /^step 1: Monitoring\nstep 2: .*15 seconds/);
  assert.deepEqual(lean.verdict.answer.basis, ['steps:answers:2']);
  // The trace keeps the filled instruction; the receipt never repeats it.
  assert.equal(result.stepRuns[1].instruction, second.instruction);
  assert.doesNotMatch(JSON.stringify(lean), /"Monitoring" guide/);
});

test('placeholder: without an auto-confirmed answer the call stops before the step and says what to supply', async () => {
  const route = (path, instruction) => (instruction.startsWith('From the home page') ? (path === '/featured' ? 'done' : 'Featured') : 'Guides');
  const provider = scripted(route, { miss: 0.3 }); // choose never confirms, and its guess is below placeholderFloor
  const { runtime } = setup(provider);
  const result = await runtime.run({ steps: [FEATURED, JOINED, { ...ABOUT, instruction: 'Open Home' }] });
  assert.ok(provider.calls.every(call => call.instruction.startsWith('From the home page')), 'step 2 never reached the provider');
  const lean = agentResult(result);
  assert.equal(lean.status, 'needs_host');
  assert.equal(lean.code, 'placeholder_unconfirmed');
  assert.equal(lean.verification.passed, false);
  assert.equal(lean.verdict.kind, 'needs_decision');
  assert.equal(lean.verdict.answer, null);
  assert.deepEqual(lean.stepResults.map(entry => [entry.status, entry.code]),
    [['completed', 'expectation_passed'], ['not_run', 'placeholder_unconfirmed'], ['not_run', 'not_run']]);
  assert.deepEqual(lean.stepResults[1].why, ['placeholder:answer:1:answer_not_confirmed']);
  assert.ok(lean.verdict.why.includes('steps:stopped_before:2'));
  assert.equal(lean.next.kind, 'rerun');
  assert.match(lean.next.text, /^Step 2 uses \{\{answer:1\}\}, but step 1's answer was not auto-confirmed \(answer_not_confirmed\)\. /);
  assert.match(lean.next.text, /Step 1 passed; never send it again\./);
  assert.match(lean.next.text, /page\.digest, trail and answer\.candidates \(it was the last step to run\)/);
  assert.match(lean.next.text, /steps = next\.steps exactly \(steps 2-3 of this list, renumbered.*\), writing the value in place of \{\{supply:1\}\}\.$/);
  // The resent list stands alone: step 1's value is the host's to supply, and validation refuses it unreplaced.
  assert.equal(lean.next.steps[0].instruction, 'Click Guides, then the {{supply:1}} guide. Read how often metrics are sampled.');
  assert.throws(() => validateSteps(lean.next.steps), /supply/);
  assert.match(lean.reason, /^Step 2 of 3 did not start: /);
  // The page and the candidates of step 1 stay for the host to read the value from.
  assert.equal(lean.page.url, 'https://example.com/featured');
  assert.ok(lean.answer.candidates.length);
});

test('placeholder: an earlier step\'s guesses are carried when a later step needs its value', async () => {
  // Step 1 asks (not confirmed), step 2 moves on, step 3 needs step 1's answer.
  const route = (path, instruction) => {
    if (instruction.startsWith('From the home page')) return path === '/featured' ? 'done' : 'Featured';
    return path === '/guides' ? 'done' : 'Guides';
  };
  const { runtime } = setup(scripted(route));
  // interactive: a placeholder fills only from an auto-confirmed answer (no likely fill above reversible).
  const result = await runtime.run({ mode: 'interactive', steps: [FEATURED, { instruction: 'Click Guides', expectation: { urlIncludes: '/guides' } },
    { ...JOINED, instruction: 'Open the {{answer:1}} guide' }] });
  const lean = agentResult(result);
  assert.equal(lean.code, 'placeholder_unconfirmed');
  assert.ok(lean.stepResults[0].candidates.length >= 1 && lean.stepResults[0].candidates.length <= 2);
  assert.match(lean.next.text, /the candidates of step 1 in stepResults/);
  assert.match(lean.next.text, /Steps 1-2 passed; never send them again\./);
});

// The featured-join route: step 2 clicks Monitoring only when step 1's value was written into its instruction.
const joinRoute = (path, instruction) => {
  if (instruction.startsWith('From the home page')) return path === '/featured' ? 'done' : 'Featured';
  if (path === '/featured') return 'Guides';
  if (path === '/guides') return instruction.includes('"Monitoring"') ? 'Monitoring' : 'handoff';
  return 'done';
};

test('likely fill: at read-only a clearly leading answer below the confirm floor fills the placeholder, marked likely', async () => {
  for (const mode of ['read-only', 'reversible']) {
    const provider = scripted(joinRoute, { answers: { featured: 'Monitoring', sampled: '15 seconds' }, hit: 0.6 });
    const { runtime } = setup(provider);
    const result = await runtime.run({ mode, steps: [FEATURED, JOINED] });
    assert.equal(result.status, 'completed', `${mode}: ${result.reason}`);
    assert.ok(provider.calls.some(call => call.instruction === 'Click Guides, then the "Monitoring" guide. Read how often metrics are sampled.'));
    const lean = agentResult(result);
    assert.equal(lean.stepResults[0].answerSource, 'likely');
    // Never a confirmed answer for the host: no answer field, the guesses instead, and the next is not `answer`.
    assert.equal(lean.stepResults[0].answer, undefined);
    assert.match(lean.stepResults[0].candidates[0].text, /Monitoring/);
    assert.equal(lean.stepResults[1].answerSource, undefined);
    assert.equal(lean.next.kind, 'answer_from_digest');
    assert.equal(result.stepRuns[0].answerSource, 'likely');
  }
  // A list that stops after a likely fill never writes the likely value into next.steps: the host supplies it.
  const provider = scripted(joinRoute, { answers: { featured: 'Monitoring' }, hit: 0.6 });
  const stopped = agentResult(await setup(provider).runtime.run({ retry: false, steps: [FEATURED, JOINED,
    { instruction: 'Then open the {{answer:1}} archive', expectation: { urlIncludes: '/archive' } }] }));
  assert.equal(stopped.stepResults[2].passed, false);
  assert.equal(stopped.next.steps[0].instruction, 'Then open the {{supply:1}} archive');
  assert.match(stopped.next.text, /Write the value in place of \{\{supply:1\}\} before sending\./);
  assert.doesNotMatch(stopped.next.text, /earlier answers written in/);
  // Trusted markers: verdict.why and the MCP steps line say which step's likely answer was used.
  assert.ok(stopped.verdict.why.includes('steps:likely_fill:1'));
  assert.match(summaryText(stopped), /^steps: 1 completed \(expectation_passed\), verified: true \(likely\); /m);
});

test('likely fill: a likely value never fills an expectation field; an auto-confirmed one still does', async () => {
  const checked = { ...JOINED, expectation: { urlIncludes: '/guides/', titleIncludes: '{{answer:1}}' } };
  const likelyOnly = scripted(joinRoute, { answers: { featured: 'Monitoring' }, hit: 0.6 });
  const stopped = agentResult(await setup(likelyOnly).runtime.run({ steps: [FEATURED, checked] }));
  assert.equal(stopped.code, 'placeholder_unconfirmed');
  assert.deepEqual(stopped.stepResults[1].why, ['placeholder:answer:1:answer_not_confirmed']);
  assert.ok(!stopped.verdict.why.some(code => code.startsWith('steps:likely_fill')));
  const confirmed = scripted(joinRoute, { answers: { featured: 'Monitoring', sampled: '15 seconds' } });
  const passed = agentResult(await setup(confirmed).runtime.run({ steps: [FEATURED, checked] }));
  assert.equal(passed.status, 'completed', passed.reason);
  assert.equal(passed.stepResults[0].answer.text, 'Monitoring');
});

test('likely fill: a lone candidate is ranked by the provider and needs 0.6; the test provider\'s 0.4 guess never fills', async () => {
  const site = { ...SITE, '/lead': { title: 'Lead', text: 'Priya Raman — Documentation lead', controls: [link('1', 'Guides', '/guides')],
    blocks: [{ t: 'p', text: 'Priya Raman — Documentation lead' }] } };
  const LEAD = { instruction: 'Read who the documentation lead is.', expectation: { urlIncludes: '/lead' }, answerQuestion: 'Who is the documentation lead?' };
  const NEXT = { instruction: 'Click Guides. Find the guide by {{answer:1}}.', expectation: { urlIncludes: '/guides' } };
  const route = (path, instruction) => (instruction.startsWith('Read who') ? 'done' : path === '/guides' ? 'done' : 'Guides');
  const run = async options => {
    const provider = scripted(route, options);
    const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: site, path: '/lead' }), provider });
    return { provider, result: agentResult(await runtime.run({ steps: [LEAD, NEXT] })) };
  };
  // The miss (0.4, a lone candidate so no runner-up): the provider was asked, and 0.4 is under the 0.6 lone floor.
  const miss = await run({});
  assert.equal(miss.result.code, 'placeholder_unconfirmed');
  assert.ok(miss.provider.chooses.length >= 1, 'the lone candidate was sent to the provider');
  // A provider ranking of 0.7 (under the 0.9 confirm floor) fills it as likely.
  const ranked = await run({ answers: { lead: 'Priya Raman' }, hit: 0.7 });
  assert.equal(ranked.result.status, 'completed', ranked.result.reason);
  assert.equal(ranked.result.stepResults[0].answerSource, 'likely');
  assert.ok(ranked.provider.calls.some(call => call.instruction === 'Click Guides. Find the guide by "Priya Raman".'));
  // No choose, or a ranking that fails: the lone candidate stays a heuristic guess and never fills.
  for (const broken of ['none', 'error']) {
    const provider = scripted(route, { answers: { lead: 'Priya Raman' }, hit: 0.7 });
    if (broken === 'none') delete provider.choose;
    else provider.choose = async () => { throw new Error('choose failed'); };
    const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: site, path: '/lead' }), provider });
    const result = agentResult(await runtime.run({ steps: [LEAD, NEXT] }));
    assert.equal(result.code, 'placeholder_unconfirmed', broken);
    assert.equal(result.stepResults[0].answerSource, undefined, broken);
    assert.ok(provider.calls.every(call => call.instruction.startsWith('Read who')), broken);
  }
});


test('likely fill: below placeholderFloor, under placeholderMargin, at interactive or with a raised floor the list stops', async () => {
  const cases = [
    [{ hit: 0.3 }, {}],
    [{ hit: 0.6, second: 0.5 }, {}],
    [{ hit: 0.6 }, { mode: 'interactive' }],
    [{ hit: 0.6 }, { mode: 'full' }],
    [{ hit: 0.6 }, { thresholds: { placeholderFloor: 0.7 } }],
    [{ hit: 0.6, second: 0.4 }, { thresholds: { placeholderMargin: 0.25 } }],
  ];
  for (const [choose, options] of cases) {
    const provider = scripted(joinRoute, { answers: { featured: 'Monitoring' }, ...choose });
    const result = agentResult(await setup(provider).runtime.run({ ...options, steps: [FEATURED, JOINED] }));
    const label = JSON.stringify([choose, options]);
    assert.equal(result.code, 'placeholder_unconfirmed', label);
    assert.deepEqual(result.stepResults[1].why, ['placeholder:answer:1:answer_not_confirmed'], label);
    assert.equal(result.stepResults[0].answerSource, undefined, label);
    assert.ok(provider.calls.every(call => call.instruction.startsWith('From the home page')), label);
  }
});

test('likelyValue: the auto-confirm rule at the lower floor, then every fill check', () => {
  const block = (text, confidence) => ({ text, confidence });
  const base = { status: 'completed', verification: { passed: true }, verdict: { answer: null, why: [] },
    answer: { method: 'provider', candidates: [block('Monitoring', 0.6), block('Backups', 0.1)] } };
  const at = (patch = {}, options = {}) => likelyValue({ ...base, ...patch },
    { question: 'Which guide is featured?', instruction: 'Open Featured', level: 'read-only', ...options });
  assert.deepEqual(at(), { value: 'Monitoring', likely: true });
  // Only provider-ranked candidates fill: an unranked heuristic share never does, however high. A lone ranked
  // candidate (no runner-up, so no margin) needs LIKELY_SINGLE_FLOOR (0.6).
  for (const confidence of [0.7, 0.818]) {
    assert.equal(at({ answer: { method: 'heuristic', candidates: [block('Priya Raman — Documentation lead', confidence)] } },
      { question: 'Who is the documentation lead?' }).why, 'answer_not_confirmed');
  }
  assert.equal(at({ answer: { method: 'provider', candidates: [block('Priya Raman — Documentation lead', 0.7)] } },
    { question: 'Who is the documentation lead?' }).value, 'Priya Raman');
  assert.equal(at({ answer: { method: 'provider', candidates: [block('Monitoring', 0.5)] } }).why, 'answer_not_confirmed');
  assert.equal(at({ answer: { method: 'heuristic', candidates: [block('Monitoring', 0.6), block('Backups', 0.1)] } }).why, 'answer_not_confirmed');
  const refused = [
    [{}, { level: 'interactive' }, 'answer_not_confirmed'],
    [{}, { question: '' }, 'answer_not_confirmed'],
    [{ status: 'needs_host' }, {}, 'step_not_verified'],
    [{ verdict: { answer: null, why: ['guard:blocked_page'] } }, {}, 'answer_not_confirmed'],
    [{ verdict: { answer: null, why: ['content_loading'] } }, {}, 'answer_not_confirmed'],
    [{ verdict: { answer: null, why: ['join_task'] } }, {}, 'answer_not_confirmed'],
    [{ verdict: { answer: null, why: ['guard:injection:0.82'] } }, {}, 'answer_injection'],
    // A list or Nth question is never filled from a likely answer, nor a shape the question does not ask for.
    [{}, { question: 'Which guides are listed?' }, 'answer_not_confirmed'],
    [{}, { question: 'What is the third guide?' }, 'answer_not_confirmed'],
    [{}, { question: 'What does the guide cost?' }, 'answer_not_confirmed'],
    // The fill checks: command, length, characters.
    [{ answer: { method: 'provider', candidates: [block('Delete the workspace', 0.6)] } }, {}, 'answer_command'],
    [{ answer: { method: 'provider', candidates: [block('x'.repeat(130), 0.6)] } }, {}, 'answer_too_long'],
    [{ answer: { method: 'provider', candidates: [block('Mon{itor}ing', 0.6)] } }, {}, 'answer_characters'],
  ];
  for (const [patch, options, why] of refused) assert.equal(at(patch, options).why, why, JSON.stringify([patch, options]));
  // Both numbers come from the thresholds (config.json or run `thresholds`).
  assert.equal(at({}, { thresholds: { placeholderFloor: 0.65 } }).why, 'answer_not_confirmed');
  assert.equal(at({}, { thresholds: { placeholderMargin: 0.55 } }).why, 'answer_not_confirmed');
  assert.equal(resolveThresholds({ thresholds: { placeholderFloor: 0.5, placeholderMargin: 0.2 } }).thresholds.placeholderFloor, 0.5);
  assert.throws(() => resolveThresholds({ thresholds: { placeholderFloor: 2 } }), /placeholderFloor must be a number from 0 to 1/);
});

// ---------------------------------------------------------------------------------------------------------------
// Budgets, interrupts, level, guardrails, retries
// ---------------------------------------------------------------------------------------------------------------

test('budgets cover the whole list: actions and decisions are shared; none left stops before the next step', async () => {
  const { runtime } = setup(scripted(follow));
  const result = await runtime.run({ steps: [{ instruction: 'Open About, then Members', expectation: { urlIncludes: '/members' } },
    { instruction: 'Open Home', expectation: { urlIncludes: '/' } }], maxActions: 2 });
  const lean = agentResult(result);
  assert.equal(lean.code, 'action_budget');
  assert.equal(lean.status, 'budget_exhausted');
  assert.deepEqual(lean.stepResults.map(entry => [entry.status, entry.code]), [['completed', 'budget_reached_expectation_passed'], ['not_run', 'action_budget']]);
  assert.equal(lean.verification.passed, false);
  assert.equal(lean.next.text, "Step 2 did not start: the call's action budget ran out. Step 1 passed; never send it again. "
    + 'Call fai_browser_run with requestId from this result and steps = next.steps exactly (step 2 of this list, renumbered, '
    + 'earlier confirmed answers written in).');

  // A step's own action budget is what is left of the call's.
  // Step 2 keeps clicking round About -> Members -> Home and never reaches its page.
  const cycle = { '/about': 'Members', '/members': 'Home', '/': 'About' };
  const provider = scripted((path, instruction) => (instruction === 'Open About' ? follow(path, instruction) : cycle[path]));
  const capped = await setup(provider).runtime.run({ steps: [ABOUT, { instruction: 'Walk the site',
    expectation: { urlIncludes: '/nowhere' } }], maxActions: 3, retry: false });
  assert.equal(capped.code, 'action_budget');
  assert.equal(capped.steps.length, 3, 'one action in step 1, two left for step 2');

  const decisions = await setup(scripted(follow)).runtime.run({ steps: [ABOUT, MEMBERS], maxDecisions: 2 });
  assert.equal(decisions.code, 'decision_budget');
  assert.equal(agentResult(decisions).stepResults[1].code, 'decision_budget');
});

test('time covers the whole list: running out mid-list returns the partial result with the steps not run', async () => {
  const provider = scripted(follow, { delayMs: 250 });
  const { runtime } = setup(provider);
  const result = await runtime.run({ steps: [ABOUT, MEMBERS, { instruction: 'Open Home', expectation: { urlIncludes: '/' } }],
    timeoutMs: 1600, retry: false });
  const lean = agentResult(result);
  assert.equal(lean.code, 'time_budget');
  assert.equal(lean.status, 'budget_exhausted');
  assert.equal(lean.verification.passed, false);
  assert.equal(lean.stepResults.at(-1).status, 'not_run');
  assert.equal(lean.stepResults[0].status, 'completed');
  assert.ok(lean.cost.elapsedMs < 2600, `${lean.cost.elapsedMs} ms`);
  assert.equal(lean.next.kind, 'rerun');
  // The whole text is replaced: no "sharper instruction" sentence before the step list.
  assert.match(lean.next.text, /^Step [23] (did not start|stopped): the call's time budget ran out\. Steps? 1(-2)? passed; never send (it|them) again\./);
  assert.doesNotMatch(lean.next.text, /sharper instruction/);
  assert.match(lean.next.text, /a larger timeoutMs if the steps need it\.$/);
});

test('a stop during a step ends the list; the steps after it are reported as not run', async () => {
  // The stop lands after step 1's last action: step 1 still completes, step 2 never starts.
  const provider = scripted(follow);
  const { runtime } = setup(provider);
  const result = await runtime.run({ steps: [ABOUT, MEMBERS], onAction: () => runtime.stop(), awaitCallbacks: true });
  const lean = agentResult(result);
  assert.equal(lean.status, 'stopped');
  assert.deepEqual(lean.stepResults.map(entry => [entry.status, entry.code]), [['completed', 'expectation_passed'], ['not_run', 'stopped']]);
  assert.equal(lean.next.kind, 'stop');
  assert.match(lean.next.text, /Step list: step 1 passed; step 2 did not run\.$/);
  assert.equal(lean.next.steps, undefined, 'a stop sends nothing'); 
  assert.ok(provider.calls.every(call => call.instruction === 'Open About'));

  // A stop in the middle of step 1 (two actions to go) ends step 1 itself as stopped.
  const busy = scripted(follow);
  const second = setup(busy);
  const halted = await second.runtime.run({ steps: [{ instruction: 'Open About, then Members', expectation: { urlIncludes: '/members' } },
    MEMBERS], onAction: () => second.runtime.stop(), awaitCallbacks: true });
  assert.deepEqual(agentResult(halted).stepResults.map(entry => entry.status), ['stopped', 'not_run']);
  assert.equal(second.bridge.executions.length, 1);
});

test('one level for the list: a grant lowered during step 1 holds for step 2', async () => {
  const provider = scripted(follow);
  const { runtime } = setup(provider);
  let lowered = false;
  const result = await runtime.run({
    steps: [ABOUT, MEMBERS],
    mode: 'reversible',
    grant: { level: 'reversible' },
    onAction: () => {
      if (!lowered) runtime.lowerGrant('read-only');
      lowered = true;
    },
    awaitCallbacks: true,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.permissions, { requested: 'reversible', granted: 'read-only', effective: 'read-only', testing: false, scope: 'origin' });
  const step2 = provider.calls.find(call => call.instruction === 'Open Members');
  assert.equal(step2.context.level, 'read-only');
});

test('guardrails and policy apply to every step: forbidden labels are not offered and refusals stop the list', async () => {
  // Step 2 asks for the control the call's policy forbids: it is never offered, so nothing runs.
  const first = setup(scripted(() => 'Upgrade'), '/settings');
  const forbidden = await first.runtime.run({ steps: [{ instruction: 'Read the workspace name', expectation: { urlIncludes: '/settings' } },
    { instruction: 'Click Upgrade', expectation: { textIncludes: 'Pro plan' } }], mode: 'reversible', policy: { forbid: ['Upgrade'] }, retry: false });
  assert.deepEqual(agentResult(forbidden).stepResults.map(entry => entry.status), ['completed', 'needs_host']);
  const step2 = first.runtime.provider.calls.filter(call => call.instruction === 'Click Upgrade');
  assert.ok(step2.length >= 1, 'step 2 was decided');
  for (const call of first.runtime.provider.calls) {
    assert.ok(!call.labels.includes('Upgrade'), 'the forbidden label is never offered in any step');
    assert.deepEqual(call.context.guardrails.forbid, ['Upgrade']);
    assert.equal(call.context.level, 'reversible');
  }
  assert.equal(first.bridge.executions.length, 0);

  // Step 2 asks for a deletion at reversible: refused before any decision, like a single run would be.
  const second = setup(scripted(() => 'handoff'), '/settings');
  const refused = await second.runtime.run({ steps: [{ instruction: 'Read the workspace name', expectation: { urlIncludes: '/settings' } },
    { instruction: 'Delete the workspace', expectation: { textIncludes: 'Workspace deleted' } }], mode: 'reversible' });
  const lean = agentResult(refused);
  assert.equal(lean.code, 'refused_action');
  assert.deepEqual(lean.stepResults.map(entry => entry.status), ['completed', 'needs_user']);
  assert.equal(second.bridge.executions.length, 0);
  assert.ok(second.runtime.provider.calls.every(call => call.instruction === 'Read the workspace name'));
  assert.match(lean.next.text, /^Step 1 passed; never send it again\. Call fai_browser_run with requestId .*, mode "full" and steps = next\.steps exactly \(step 2/);
  assert.deepEqual(lean.next.steps.map(step => step.instruction), ['Delete the workspace']);
});

test('in-call retries run per step and are reported with the step they ran in', async () => {
  // Step 2's link choice is close to the other link: a second opinion runs inside step 2.
  const provider = scripted(follow, {
    probabilities: (path, instruction, actions) => {
      if (instruction !== 'Open Members' || path !== '/about') return null;
      const id = label => actions.find(action => action.label === label)?.id;
      return { [id('Members')]: 0.5, [id('Home')]: 0.4 };
    },
  });
  const { runtime } = setup(provider);
  const result = await runtime.run({ steps: [ABOUT, MEMBERS] });
  assert.equal(result.status, 'completed');
  const lean = agentResult(result);
  assert.deepEqual(lean.retries.map(retry => [retry.kind, retry.listStep]), [['second_opinion', 2]]);
  assert.equal(lean.stepResults[1].retries, undefined, 'retries are listed once, at the top level, with listStep');
});

// ---------------------------------------------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------------------------------------------

test('trace: stepRuns keep each step\'s filled instruction and outcome; the trace reads back to the same receipt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fai-steps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { runtime } = setup(scripted(follow));
  const result = await runtime.run({ steps: [ABOUT, MEMBERS] });
  const written = await writeRun(result, { dir, instruction: '1. Open About 2. Open Members', operation: 'run',
    options: { steps: [ABOUT, MEMBERS] } });
  const trace = JSON.parse(await readFile(written.trace, 'utf8'));
  assert.deepEqual(trace.stepRuns.map(entry => [entry.step, entry.instruction, entry.code]),
    [[1, 'Open About', 'expectation_passed'], [2, 'Open Members', 'expectation_passed']]);
  assert.equal(trace.options.steps.length, 2);
  assert.ok(trace.cost.requests.every(entry => entry.listStep === 1 || entry.listStep === 2));
  const back = toAgentResult(trace);
  assert.deepEqual(back.stepResults, agentResult(result).stepResults);
  assert.equal(back.next.kind, agentResult(result).next.kind);
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes: resend list, shared retry bounds, next text for relay and level stops, receipt size
// ---------------------------------------------------------------------------------------------------------------

test('next.steps: a stopped list sends the rest renumbered, with confirmed answers written in, never a shifted one', async () => {
  // S1 asks (confirmed), S2 asks and fails, S3 uses S1's and S2's answers. Resending [S2, S3] as written would make
  // {{answer:1}} mean S2; next.steps writes S1's value in and renumbers S2's placeholder.
  const route = (path, instruction) => {
    if (instruction.startsWith('From the home page')) return path === '/featured' ? 'done' : 'Featured';
    return 'handoff';
  };
  const provider = scripted(route, { answers: { featured: 'Monitoring' } });
  const { runtime } = setup(provider);
  const third = { instruction: 'Open the {{answer:1}} guide and compare it with {{answer:2}}',
    expectation: { urlIncludes: '/guides/', titleIncludes: '{{answer:1}}' } };
  const result = await runtime.run({ steps: [FEATURED, { instruction: 'Click Guides. Read the first guide name.',
    expectation: { urlIncludes: '/guides' }, answerQuestion: 'Which guide is listed first?' }, third], retry: false });
  const lean = agentResult(result);
  assert.equal(lean.code, 'handoff');
  assert.deepEqual(lean.next.steps, [
    { instruction: 'Click Guides. Read the first guide name.', expectation: { urlIncludes: '/guides' }, answerQuestion: 'Which guide is listed first?' },
    { instruction: 'Open the "Monitoring" guide and compare it with {{answer:1}}', expectation: { urlIncludes: '/guides/', titleIncludes: 'Monitoring' } },
  ]);
  assert.doesNotThrow(() => validateSteps(lean.next.steps), 'the resent list is valid on its own');
  assert.match(lean.next.text, /send|steps = next\.steps exactly/);
  // The trusted text block carries the list; MCP results have no structuredContent mirror.
  const { summaryText } = await import('../src/mcp.js');
  assert.match(summaryText({ ...lean, state: 'done' }), /^next\.steps \(send exactly as steps\): \[/m);
});

test('relay and level stops in step 2: next says to resend exactly next.steps (with the level), not "once step 2 is done"', async () => {
  const { runtime } = setup(scripted(() => 'handoff'), '/settings');
  const steps = [{ instruction: 'Read the workspace name', expectation: { urlIncludes: '/settings' } },
    { instruction: 'Delete the workspace', expectation: { textIncludes: 'Workspace deleted' } }];
  // The user granted reversible; the task asked for full: a level relay.
  const relay = agentResult(await runtime.run({ steps, mode: 'full', grant: { level: 'reversible' } }));
  assert.equal(relay.code, 'refused_action');
  assert.equal(relay.next.kind, 'relay');
  assert.equal(relay.needs.level, 'full');
  assert.match(relay.next.text, /Step list: Step 1 passed; never send it again\. To continue, call fai_browser_run with requestId .*, mode "full" and steps = next\.steps exactly \(step 2 of this list/);
  assert.doesNotMatch(relay.next.text, /once step/);
  assert.deepEqual(relay.next.steps, [steps[1]]);
});

test('retry bounds are shared by the whole list: at most two second opinions, request cap from the list\'s decisions', async () => {
  const provider = scripted(follow, {
    probabilities: (path, instruction, actions) => {
      const links = actions.filter(action => action.type === 'click');
      if (links.length < 2) return null;
      return Object.fromEntries(links.map((action, index) => [action.id, index === 0 ? 0.5 : 0.4 / (links.length - 1)]));
    },
  });
  const { runtime } = setup(provider);
  const steps = [{ instruction: 'Open Featured', expectation: { urlIncludes: '/featured' } },
    { instruction: 'Open Guides', expectation: { urlIncludes: '/guides' } },
    { instruction: 'Open Monitoring', expectation: { urlIncludes: '/guides/monitoring' } }];
  const result = await runtime.run({ steps });
  const opinions = (result.retries ?? []).filter(retry => retry.kind === 'second_opinion');
  assert.equal(opinions.length, 2, "three close link choices, two second opinions for the whole list");
  assert.equal(result.cost.requests.filter(entry => entry.kind === 'second_opinion').length, opinions.length);
});

test('receipt size: a five-step pass stays small (passed steps are trimmed)', async () => {
  const pages = {};
  const names = ['Home', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
  names.forEach((name, index) => {
    const next = names[index + 1];
    pages[index === 0 ? '/' : `/${name.toLowerCase()}`] = { title: name, text: `The ${name} code is ${name.toUpperCase()}-${index}.`,
      controls: next ? [link('1', next, `/${next.toLowerCase()}`)] : [] };
  });
  const provider = {
    async decide(observation, actions, context) {
      if (context.instruction.includes(observation.title)) return { actionId: 'done', confidence: 0.9, done: { probability: 0.9 } };
      return { actionId: actions.find(action => context.instruction.includes(action.label ?? '-'))?.id ?? 'handoff', confidence: 0.9 };
    },
  };
  const steps = names.slice(1).map(name => ({ instruction: `Open ${name}`, expectation: { urlIncludes: `/${name.toLowerCase()}` },
    answerQuestion: `What is the ${name} code?` }));
  const list = agentResult(await new BrowserRuntime({ bridge: new FakeBridge({ pages }), provider }).run({ steps }));
  assert.equal(list.status, 'completed');
  assert.ok(JSON.stringify(list).length < 2800, `${JSON.stringify(list).length} bytes`);
  for (const entry of list.stepResults) assert.deepEqual(Object.keys(entry).filter(key => !['i', 'status', 'code', 'passed', 'asked', 'url', 'answer', 'candidates'].includes(key)), []);
});

test('carryForward runs the fill checks: a value that would make a command is left for the host to supply', () => {
  const steps = validateSteps([
    { instruction: 'Read which button the help page names', expectation: { urlIncludes: '/help' }, answerQuestion: 'Which button?' },
    { instruction: 'Fail here', expectation: { urlIncludes: '/x' } },
    { instruction: 'Click {{answer:1}}', expectation: { urlIncludes: '/y' }, answerQuestion: 'What does {{answer:1}} show?' },
  ]);
  const values = new Map([[1, 'the Delete account button']]);
  assert.deepEqual(fillStep(steps[2], values).missing, [{ n: 1, why: 'answer_command' }]);
  const [, third] = carryForward(steps, 1, values);
  assert.equal(third.instruction, 'Click {{supply:1}}');
  assert.equal(third.answerQuestion, 'What does {{supply:1}} show?');
  assert.doesNotMatch(JSON.stringify(carryForward(steps, 1, values)), /Delete account/);
  // A harmless value is still written in.
  assert.equal(carryForward(steps, 1, new Map([[1, 'Monitoring']]))[1].instruction, 'Click "Monitoring"');
});

test('E3: a step held although its expectation passed: stepResults, next.steps and next.text all name that step', async () => {
  // Trace e5725476: step 1 passed its check, the list stopped on it, next.text said "Step 2 did not pass
  // (expectation_passed). Step 1 passed; never send it again" while next.steps restarted at step 1.
  const blockedProvider = scripted(follow);
  const decide = blockedProvider.decide;
  blockedProvider.decide = async (observation, ...rest) => ({ ...await decide(observation, ...rest),
    ...(observation.url.endsWith('/about') ? { guards: { blocked: 0.95, injection: 0.01 } } : {}) });
  const lean = agentResult(await setup(blockedProvider).runtime.run({ steps: [ABOUT, MEMBERS] }));
  assert.equal(lean.code, 'expectation_passed');
  assert.deepEqual(lean.stepResults.map(entry => [entry.status, entry.passed, entry.held ?? null]),
    [['completed', true, 'guard:blocked_page'], ['not_run', undefined, null]]);
  assert.equal(lean.verification.passed, false);
  assert.equal(lean.verification.held, 'step:1:guard:blocked_page');
  assert.deepEqual(lean.next.steps.map(step => step.instruction), ['Open About', 'Open Members']);
  assert.match(lean.next.text, /Step 1 stopped the list \(guard:blocked_page\) although its expectation passed\./);
  assert.doesNotMatch(lean.next.text, /never send it again|Step 2 did not pass/);
  assert.match(summaryText(lean), /1 completed \(expectation_passed\), verified: true, held \(guard:blocked_page\)/);
});
