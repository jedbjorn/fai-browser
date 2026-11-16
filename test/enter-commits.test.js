// Enter declares commits (spec #79, docs/REFERENCE.md "Enter submits"): every act that presses Enter carries a
// required `commits` boolean on all four surfaces (SDK runtime, daemon, MCP, CLI). Missing, nothing runs and the error
// says how to resend; false runs under today's gate and warns enter_non_committing; true asks the user once (approval
// kind enter_commit, on the page the Enter runs on) and runs only after Approve; the flag never raises a level. The
// extension's side (minting, binding, the page script's recheck) is in test/approve-gate-extension.test.js and
// test/firefox-approve.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserRuntime, checkActChoice } from '../src/runtime.js';
import { ENTER_COMMITS_TEXT, ENTER_NON_COMMITTING_TEXT, directNext } from '../src/result.js';
import { warningLine } from '../src/mcp.js';
import { createDaemon } from '../src/daemon.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const field = (label, enter, extra = {}) => ({ id: '1', role: 'textbox', label, type: enter === 'submit_safe' ? 'search' : 'text',
  enabled: true, visible: true, risk: 'reversible', enter, ...extra });

// A search form and a plain form, each with an empty and a filled field (Enter is offered only in a filled one).
const PAGES = {
  '/': { title: 'Search', text: 'Find things', controls: [field('Search', 'submit_safe', { submitHref: `${ORIGIN}/results` })] },
  '/filled': { title: 'Search', text: 'Find things', controls: [field('Search', 'submit_safe', { filled: true, submitHref: `${ORIGIN}/results` })] },
  '/results': { title: 'Results', text: '3 results', controls: [] },
  '/contact': { title: 'Contact', text: 'Write to us', controls: [field('Message', 'submit', { submitHref: `${ORIGIN}/sent` })] },
  '/contact-filled': { title: 'Contact', text: 'Write to us', controls: [field('Message', 'submit', { filled: true, submitHref: `${ORIGIN}/sent` })] },
  '/sent': { title: 'Sent', text: 'message sent', controls: [] },
};

function runtimeOn(path, { approve } = {}) {
  const bridge = new FakeBridge({ pages: Object.fromEntries(Object.entries(PAGES).map(([key, page]) => [key, { ...page, url: ORIGIN + key }])), path });
  bridge.asked = [];
  if (approve) {
    bridge.approve = async (details, options, signal) => {
      bridge.asked.push({ details, options });
      return approve(details, options, signal);
    };
  }
  return { bridge, runtime: new BrowserRuntime({ bridge }) };
}

const byType = (actions, type) => actions.find(action => action.type === type);

// The three ways an act presses Enter, on a page where the field is filled (key, submit_field) or gets filled (submit).
async function enterPaths(mode) {
  const paths = [];
  for (const [name, path, choice] of [
    ['key Enter', '/filled', actions => ({ key: 'Enter', actionId: byType(actions, 'fill').id })],
    ['submit_field', '/filled', actions => ({ actionId: byType(actions, 'submit_field').id })],
    ['text + submit', '/', actions => ({ actionId: byType(actions, 'fill').id, text: 'cats', submit: true })],
  ]) {
    const { bridge, runtime } = runtimeOn(path, { approve: async () => ({ decision: 'approved', approvalId: 'x' }) });
    const { observation, actions } = await runtime.observe({ mode });
    paths.push({ name, bridge, runtime, observation, actions, choice: choice(actions) });
  }
  return paths;
}

// --- AC 1: a missing commits stops an Enter before anything runs -------------------------------------------------

test('AC1 runtime: an Enter without commits is refused before anything runs, on all three Enter paths', async () => {
  for (const { name, bridge, runtime, observation, choice } of await enterPaths('full')) {
    const offer = runtime.offers.get(observation.revision);
    assert.equal(checkActChoice(offer, choice), ENTER_COMMITS_TEXT, name);
    await assert.rejects(runtime.act(choice, { revision: observation.revision }), error => error.message === ENTER_COMMITS_TEXT, name);
    assert.equal(bridge.executions.length, 0, `${name}: no fill and no key dispatched`);
    assert.equal(bridge.asked.length, 0, `${name}: nothing asked`);
    // The revision was not spent: the same act with commits runs.
    for (const commits of [false, true]) assert.equal(checkActChoice(offer, { ...choice, commits }), null, `${name} ${commits}`);
  }
  assert.match(ENTER_COMMITS_TEXT, /^Enter needs commits: true if it commits the user \(purchase, payment, agreeing to terms, sending a message, submitting an application, booking or registration, deleting, publishing, transferring\), else false\. Send the act again with commits\.$/);
});

test('AC1 runtime: commits on any other act, or not a boolean, is refused', async () => {
  const { runtime, observation, actions } = await (async () => {
    const made = runtimeOn('/filled');
    return { ...made, ...(await made.runtime.observe({ mode: 'full' })) };
  })();
  const offer = runtime.offers.get(observation.revision);
  const fill = byType(actions, 'fill');
  assert.match(checkActChoice(offer, { actionId: fill.id, text: 'cats', commits: false }), /commits goes with an Enter only/);
  assert.match(checkActChoice(offer, { key: 'Escape', commits: true }), /commits goes with an Enter only/);
  assert.match(checkActChoice(offer, { nav: 'reload', commits: false }), /commits goes with an Enter only/);
  assert.equal(checkActChoice(offer, { key: 'Escape', commits: null }), null, 'null is no flag');
  assert.equal(checkActChoice(offer, { key: 'Enter', actionId: fill.id, commits: 'yes' }), ENTER_COMMITS_TEXT);
});

// --- AC 2: commits false runs under today's gate and warns --------------------------------------------------------

test('AC2 runtime: commits false at full runs the Enter as before on a search form and a plain form, and warns', async () => {
  for (const [path, landing] of [['/filled', '/results'], ['/contact-filled', '/sent']]) {
    const { bridge, runtime } = runtimeOn(path, { approve: async () => ({ decision: 'approved', approvalId: 'never' }) });
    const { observation, actions } = await runtime.observe({ mode: 'full' });
    const enter = byType(actions, 'submit_field');
    const result = await runtime.act({ actionId: enter.id, commits: false }, { revision: observation.revision, expectation: { urlIncludes: landing } });
    assert.equal(result.status, 'completed', `${path}: ${result.reason}`);
    assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['submit_field'], path);
    assert.equal(bridge.executions[0].action.approvalId, undefined, `${path}: no approval involved`);
    assert.equal(bridge.asked.length, 0, `${path}: never asks`);
    assert.deepEqual(result.warnings, ['enter_non_committing'], path);
  }
  assert.equal(warningLine('enter_non_committing'),
    'enter_non_committing (Enter sent as non-committing. If it committed the user, say so to the user now.)');
  assert.equal(ENTER_NON_COMMITTING_TEXT, 'Enter sent as non-committing. If it committed the user, say so to the user now.');
});

test('AC2 runtime: commits false keeps the level gate (a plain form submit below full is refused as today)', async () => {
  const { bridge, runtime } = runtimeOn('/contact');
  const { observation, actions } = await runtime.observe({ mode: 'interactive' });
  const fill = byType(actions, 'fill');
  const result = await runtime.act({ actionId: fill.id, text: 'hello', submit: true, commits: false }, { revision: observation.revision });
  assert.equal(result.code, 'refused_action');
  assert.equal(result.needs.level, 'full');
  assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['fill_supplied_text'], 'the fill ran, the Enter did not');
  assert.equal(result.warnings?.includes('enter_non_committing') ?? false, false, 'no Enter was sent');
});

// --- commits true asks once (runtime side; the extension side is in the browser tests) ---------------------------

test('commits true: every Enter path asks once (kind enter_commit, class submit) and runs with the minted id', async () => {
  for (const { name, bridge, runtime, observation, choice } of await enterPaths('full')) {
    const result = await runtime.act({ ...choice, commits: true }, { revision: observation.revision, reason: 'Sends your note',
      expectation: { urlIncludes: '/results' } });
    assert.equal(result.status, 'completed', `${name}: ${result.reason}`);
    assert.equal(bridge.asked.length, 1, `${name}: asked once`);
    const { details } = bridge.asked[0];
    assert.equal(details.kind, 'enter_commit', name);
    assert.equal(details.cls, 'submit', name);
    assert.equal(details.target, '1', name);
    assert.equal(details.note, 'Sends your note', name);
    // Asked on the page the Enter runs on: after the act's own fill, its revision.
    const enter = bridge.executions.at(-1);
    assert.equal(enter.action.type, 'submit_field', name);
    assert.equal(enter.action.approvalId, 'x', name);
    assert.equal(details.revision, enter.expectedRevision, `${name}: bound to the revision the Enter runs on`);
    assert.equal(bridge.executions.filter(entry => entry.action.type === 'submit_field').length, 1, `${name}: one Enter`);
    assert.equal(result.warnings?.includes('enter_non_committing') ?? false, false, name);
  }
});

test('commits true: pending names the field\'s Enter action on the page it would run on; the same act picks up the approval', async () => {
  let decision = { decision: 'pending' };
  const { bridge, runtime } = runtimeOn('/', { approve: async () => decision });
  const { observation, actions } = await runtime.observe({ mode: 'full' });
  const fill = byType(actions, 'fill');
  const pending = await runtime.act({ actionId: fill.id, text: 'cats', submit: true, commits: true }, { revision: observation.revision });
  assert.equal(pending.code, 'approval_pending', pending.reason);
  assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['fill_supplied_text'], 'the fill ran; no Enter yet');
  const { approval } = pending.needs;
  assert.equal(approval.kind, 'enter_commit');
  assert.equal(approval.class, 'submit');
  assert.equal(approval.revision, bridge.asked[0].details.revision, 'the revision the user was asked on');
  assert.equal(pending.needs.level, undefined, 'never a level request: the Enter\'s level was checked first');
  const offered = runtime.offers.get(approval.revision);
  assert.equal(offered.actions.find(action => action.id === approval.actionId)?.type, 'submit_field');
  const next = directNext(pending);
  assert.equal(next.kind, 'approve');
  assert.match(next.text, new RegExp(`actionId ${approval.actionId} and revision "${approval.revision}" and commits: true`));

  // Approved meanwhile: the field's Enter action on that revision, with commits true, runs once with the id.
  decision = { decision: 'approved', approvalId: 'later' };
  const done = await runtime.act({ actionId: approval.actionId, commits: true }, { revision: approval.revision,
    expectation: { urlIncludes: '/results' } });
  assert.equal(done.status, 'completed', done.reason);
  assert.equal(bridge.asked[1].details.revision, approval.revision);
  assert.deepEqual(bridge.executions.map(entry => entry.action.type), ['fill_supplied_text', 'submit_field']);
  assert.equal(bridge.executions[1].action.approvalId, 'later');
});

test('commits true: denied stops; a bridge that cannot ask refuses; a failed ask surfaces its code; nothing is pressed', async () => {
  for (const [answer, code, message] of [
    [{ decision: 'denied' }, 'refused_action', /denied this action/],
    [null, 'refused_action', /could not ask the user to approve this committing Enter/],
    [{ decision: 'refused', reason: 'class_mismatch' }, 'refused_action', /could not ask/],
    [{ decision: 'error', code: 'stale' }, 'stale', null],
  ]) {
    const { bridge, runtime } = runtimeOn('/filled', answer ? { approve: async () => answer } : {});
    const { observation, actions } = await runtime.observe({ mode: 'full' });
    const result = await runtime.act({ actionId: byType(actions, 'submit_field').id, commits: true }, { revision: observation.revision });
    assert.equal(result.code, code, JSON.stringify(answer));
    if (message) assert.match(result.needs.message, message);
    assert.equal(bridge.executions.length, 0, `${JSON.stringify(answer)}: no Enter`);
    assert.equal(result.needs.level, undefined);
  }
});

test('commits true: a search Enter at interactive asks too (always, whatever the settings) and never asks for a level', async () => {
  const { bridge, runtime } = runtimeOn('/filled', { approve: async () => ({ decision: 'approved', approvalId: 'y' }) });
  const { observation, actions } = await runtime.observe({ mode: 'interactive' });
  const result = await runtime.act({ actionId: byType(actions, 'submit_field').id, commits: true }, { revision: observation.revision });
  assert.notEqual(result.code, 'refused_action', result.reason);
  assert.equal(bridge.asked.length, 1);
  assert.equal(bridge.asked[0].options.level, 'interactive');
  assert.equal(bridge.executions[0].action.approvalId, 'y');
});

test('commits true at testing runs without asking; the receipt notes why commits:declared (decision #4)', async () => {
  const { bridge, runtime } = runtimeOn('/contact-filled', { approve: async () => ({ decision: 'pending' }) });
  const { observation, actions } = await runtime.observe({ mode: 'testing', grant: { level: 'testing' } });
  const result = await runtime.act({ actionId: byType(actions, 'submit_field').id, commits: true }, { revision: observation.revision,
    expectation: { urlIncludes: '/sent' } });
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(bridge.asked.length, 0);
  assert.equal(bridge.executions[0].action.approvalId, undefined);
  assert.ok(result.verdict.why.includes('commits:declared'), JSON.stringify(result.verdict.why));
});

test('commits true: the user\'s time to decide is not charged to the act\'s time budget', async () => {
  const { bridge, runtime } = runtimeOn('/filled', { approve: async () => {
    await delay(1300);
    return { decision: 'approved', approvalId: 'slow' };
  } });
  const { observation, actions } = await runtime.observe({ mode: 'full' });
  const result = await runtime.act({ actionId: byType(actions, 'submit_field').id, commits: true },
    { revision: observation.revision, timeoutMs: 1000, expectation: { urlIncludes: '/results' } });
  assert.equal(result.status, 'completed', result.reason);
  assert.ok(result.approvalMs >= 1200, String(result.approvalMs));
  assert.equal(bridge.executions[0].action.approvalId, 'slow');
});

// --- AC 4: commits never raises a level ----------------------------------------------------------------------------

test('AC4 runtime: at read-only an Enter with commits true is refused exactly as with false (and as before the flag)', async () => {
  const outcomes = [];
  for (const commits of [true, false]) {
    const { bridge, runtime } = runtimeOn('/filled', { approve: async () => ({ decision: 'approved', approvalId: 'z' }) });
    const { observation, actions } = await runtime.observe({ mode: 'read-only' });
    assert.equal(byType(actions, 'submit_field'), undefined, 'no Enter is offered at read-only');
    assert.equal(byType(actions, 'fill'), undefined, 'no fill either');
    // Enter in a field read-only does not offer: the act names the control by an offered id, and none is offered,
    // so the host-composed key is the only way to ask, and it is refused for its level.
    const result = await runtime.act({ key: 'Enter', actionId: undefined, commits }, { revision: observation.revision }).catch(error => error);
    outcomes.push(result instanceof Error ? result.message : { code: result.code, level: result.needs.level, executions: bridge.executions.length, asked: bridge.asked.length });
  }
  assert.deepEqual(outcomes[0], outcomes[1], 'commits true changes nothing at read-only');
  assert.match(String(outcomes[0]), /Enter is pressed in a filled field/);

  // A plain form submit at interactive: refused for full whatever commits says, and never asked.
  for (const commits of [true, false]) {
    const { bridge, runtime } = runtimeOn('/contact-filled', { approve: async () => ({ decision: 'approved', approvalId: 'z' }) });
    const { observation, actions } = await runtime.observe({ mode: 'interactive' });
    assert.equal(byType(actions, 'submit_field'), undefined, 'a form submit is not offered below full');
    const result = await runtime.act({ key: 'Enter', actionId: byType(actions, 'fill').id, commits }, { revision: observation.revision });
    assert.equal(result.code, 'refused_action', String(commits));
    assert.equal(result.needs.level, 'full', String(commits));
    assert.equal(bridge.executions.length, 0, String(commits));
    assert.equal(bridge.asked.length, 0, `${commits}: never asked`);
  }
});

// --- AC 1 through the daemon, the MCP server and the CLI (fake hub) -----------------------------------------------

async function served(t, path) {
  const home = await mkdtemp(join(tmpdir(), 'fai-commits-'));
  const pages = Object.fromEntries(Object.entries(PAGES).map(([key, page]) => [key, { ...page, url: ORIGIN + key }]));
  const hub = createFakeHub({ bridgeOptions: { pages, path } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, hub, daemon };
}

async function approvedRequest(hub, opening, level) {
  let pending;
  for (let i = 0; i < 400 && !pending; i++) {
    pending = hub.published.at(-1)?.find(item => item.state === 'pending');
    if (!pending) await delay(5);
  }
  await hub.approve(pending.requestId, { level });
  return { requestId: pending.requestId, opened: await opening };
}

test('AC1 MCP and daemon: an Enter without commits is an invalid-params error with the resend text; nothing runs', async t => {
  const { home, hub, daemon } = await served(t, '/');
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port) });
  t.after(() => mcp.close());
  await mcp.initialize();
  const { requestId, opened } = await approvedRequest(hub, mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Search',
    task: 'Search for cats', mode: 'full' }), 'full');
  const page = mcpData(opened);
  const fill = page.actions.find(action => /fill .*"Search"/.test(action.description));
  const missing = await mcp.callTool('fai_browser_act', { requestId, actionId: fill.id, text: 'cats', submit: true, revision: page.revision });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Enter needs commits: true if it commits the user .* Send the act again with commits\./);
  assert.equal(hub.bridgeForTab(1).executions.length, 0, 'no fill, no key');
  // The daemon kept the revision: the same act with commits false runs and warns.
  const done = await mcp.callTool('fai_browser_act', { requestId, actionId: fill.id, text: 'cats', submit: true, commits: false,
    revision: page.revision, expectation: { urlIncludes: '/results' } });
  const result = mcpData(done);
  assert.equal(result.status, 'completed', done.content[0].text);
  assert.deepEqual(result.warnings, [`enter_non_committing (${ENTER_NON_COMMITTING_TEXT})`]);
  assert.match(done.content[0].text, /warning: enter_non_committing \(Enter sent as non-committing\. If it committed the user, say so to the user now\.\)/);
  assert.deepEqual(hub.bridgeForTab(1).executions.map(entry => entry.action.type), ['fill_supplied_text', 'submit_field']);
});

test('AC1 daemon: POST /v1/act answers 400 with the resend text for an Enter without commits; nothing runs', async t => {
  const { hub, daemon } = await served(t, '/filled');
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const { requestId } = await approvedRequest(hub, api('POST', '/v1/requests', { origins: [ORIGIN], mode: 'full', reason: 'Search' }), 'full');
  const observed = await api('POST', '/v1/observe', { requestId });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const enter = observed.body.actions.find(action => action.type === 'submit_field');
  assert.ok(enter, JSON.stringify(observed.body.actions));
  const act = body => api('POST', '/v1/act', { requestId, actionId: enter.id, revision: observed.body.revision, waitMs: 5000, ...body });
  const missing = await act({});
  assert.equal(missing.status, 400);
  assert.match(JSON.stringify(missing.body), /Enter needs commits: true if it commits the user/);
  const bad = await act({ commits: 'yes' });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /commits must be a boolean/);
  assert.equal(hub.bridgeForTab(1).executions.length, 0, 'no key dispatched');
  // false is a declaration, kept by the daemon (not dropped as an absent flag).
  const done = await act({ commits: false });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(hub.bridgeForTab(1).executions.map(entry => entry.action.type), ['submit_field']);
  assert.ok(done.body.result.warnings.includes('enter_non_committing'), JSON.stringify(done.body.result.warnings));
});

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');

function runCli(args, { home, port }) {
  const child = spawn(process.execPath, [CLI, ...args, '--no-auto-start'], {
    env: { PATH: process.env.PATH, FAI_HOME: home, FAI_DAEMON_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolveRun => child.on('exit', code => resolveRun({ code, stdout, stderr })));
}

test('AC1 CLI: act on a "press Enter in" action without --commits fails before anything runs; --commits false runs it', async t => {
  const { home, hub, daemon } = await served(t, '/filled');
  const { requestId } = await approvedRequest(hub, runCli(['request-tab', '--origin', ORIGIN, '--reason', 'Search', '--mode', 'full'],
    { home, port: daemon.port }), 'full');
  const observed = await runCli(['observe', '--request', requestId], { home, port: daemon.port });
  const page = JSON.parse(observed.stdout.trim().split('\n').at(-1));
  const enter = page.actions.find(action => /^press Enter in /.test(action.description));
  assert.ok(enter, observed.stdout);
  const missing = await runCli(['act', '--request', requestId, '--action', enter.id, '--revision', page.revision], { home, port: daemon.port });
  assert.equal(missing.code, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /Enter needs commits: true if it commits the user/);
  assert.equal(hub.bridgeForTab(1).executions.length, 0, 'no key dispatched');
  const bad = await runCli(['act', '--request', requestId, '--action', enter.id, '--revision', page.revision, '--commits', 'maybe'],
    { home, port: daemon.port });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /--commits takes true or false/);
  const done = await runCli(['act', '--request', requestId, '--action', enter.id, '--revision', page.revision, '--commits', 'false'],
    { home, port: daemon.port });
  const result = JSON.parse(done.stdout.trim().split('\n').at(-1));
  assert.deepEqual(hub.bridgeForTab(1).executions.map(entry => entry.action.type), ['submit_field'], done.stdout);
  assert.ok(result.warnings?.includes('enter_non_committing'), done.stdout);
});
