// Combined approvals, daemon and MCP side (spec #87 AC 3, 4, 7, 8, 13; bridge contract decision #51): while the
// extension holds a bundle window open for a task tab (bundle_open), the request's owner session is paused (every
// observe, act, open, wait and evidence call gets the approval_open receipt and runs nothing); an ask on the same
// request joins first. The bundle's decision (bundle_decision) ends the pause and wakes the owner once, with ids only,
// unless a call waited for the answer. A bundle of one keeps today's messages and wakes, except a declined ask
// (ask_declined). Browserless: a fake hub stands in for the extension.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { bundleEvent } from '../src/bridge.js';
import { approvalOpenText, directNext } from '../src/result.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
import { ORIGIN } from './runtime-fixtures.js';

const ENTRY = '0b8e5c1a-6f0d-4b6a-9c2e-1f3a5b7c9d0e';
const OTHER_ENTRY = '1c9f6d2b-7a1e-4c7b-8d3f-2a4b6c8d0e1f';
const BROWSER = 'b-lease-browser-0001';
const END_TURN = 'End your turn now; the user\'s answer wakes you.';
const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, visible: true, risk: 'reversible', ...extra });
const PAGES = {
  '/settings': { url: `${ORIGIN}/settings`, title: 'Settings', text: 'Workspace', controls: [
    button('3', 'Save changes', { risk: 'submit' }),
    button('4', 'Remove member', { risk: 'delete' }),
  ] },
};

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'fai-bundle-'));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES, path: '/settings' } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
  const register = async repo => {
    const response = await api('POST', '/v1/sessions', { host: 'claude', repo, pid: process.pid,
      startedAt: new Date().toISOString(), wake: 'claude-socket' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const { sessionId, key } = response.body;
    return { sessionId, headers: { 'X-Fai-Session': `${sessionId}:${key}` } };
  };
  const poll = session => api('POST', `/v1/sessions/${session.sessionId}/poll`, { maxMs: 0 }, { headers: session.headers })
    .then(response => response.body.wakes);
  const owner = await register('owner');
  const bystander = await register('bystander');
  const as = session => ({ headers: session.headers });
  const created = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Tidy the workspace', mode: 'reversible' },
    as(owner));
  assert.equal(created.status, 201);
  const requestId = created.body.requestId;
  const lease = await hub.emit({ type: 'lease', requestId, tabId: 1, origin: ORIGIN, title: 'Home', level: 'reversible',
    browserId: BROWSER });
  assert.ok(lease.leaseId, JSON.stringify(lease));
  assert.deepEqual((await poll(owner)).map(wake => wake.kind), ['approved']);
  const bridge = hub.bridgeForTab(1);
  // The extension's answers to the Approve gate, in order (default: pending, naming ENTRY). A function answer runs.
  const answers = [];
  bridge.approve = async details => {
    const next = answers.shift() ?? { decision: 'pending', entryId: ENTRY };
    return typeof next === 'function' ? next(details) : next;
  };
  const observed = await api('POST', '/v1/observe', { requestId }, as(owner));
  assert.equal(observed.status, 200, JSON.stringify(observed.body).slice(0, 300));
  const offer = observed.body;
  const save = offer.actions.find(action => /Save changes/.test(action.description));
  assert.equal(save.needsApproval, 'submit', JSON.stringify(offer.actions));
  const actRaw = (body = {}) => api('POST', '/v1/act', { requestId, actionId: save.id, revision: offer.revision, ...body },
    as(owner));
  const act = body => actRaw(body).then(response => response.body.result);
  const ask = (body, id = requestId, session = owner) => api('POST', `/v1/requests/${id}/ask`, body, as(session));
  const view = () => api('GET', `/v1/requests/${requestId}`, undefined, as(owner)).then(response => response.body);
  const open = ({ askId = null, entryIds = [ENTRY], version = 1, bundleId = 'bundle-1' } = {}) => hub.emit({
    type: 'bundle_open', browserId: BROWSER, requestId, tabId: 1, bundleId, version, askId, entryIds });
  const decide = (decision, { askId = null, entryIds = [ENTRY], version = 1, bundleId = 'bundle-1' } = {}) => hub.emit({
    type: 'bundle_decision', browserId: BROWSER, requestId, tabId: 1, bundleId, version, askId, entryIds, decision });
  return { hub, bridge, api, as, owner, bystander, requestId, lease, answers, save, offer, act, actRaw, ask, view, open,
    decide, poll };
}

// The receipt every paused call gets: 409 approval_open, the spec's text, next end_turn.
function assertPaused(response, requestId, what) {
  assert.equal(response.status, 409, `${what}: ${JSON.stringify(response.body).slice(0, 300)}`);
  assert.deepEqual(response.body.error, { code: 'approval_open', message: approvalOpenText(requestId), retryable: false,
    requestId, status: 'needs_user', next: { kind: 'end_turn', text: approvalOpenText(requestId) } }, what);
}

test('bridge: bundle_open and bundle_decision carry ids only; anything malformed is dropped', () => {
  const message = { requestId: 'req_1', tabId: 4, bundleId: 'b-1', version: 2, askId: 'a1b2c3', entryIds: [ENTRY, ENTRY],
    label: 'Delete account', url: 'https://x.test' };
  assert.deepEqual(bundleEvent(message), { requestId: 'req_1', tabId: 4, bundleId: 'b-1', version: 2, askId: 'a1b2c3',
    entryIds: [ENTRY] });
  assert.deepEqual(bundleEvent({ ...message, askId: null, decision: 'expired' }, { decision: true }),
    { requestId: 'req_1', tabId: 4, bundleId: 'b-1', version: 2, askId: null, entryIds: [ENTRY], decision: 'expired' });
  for (const bad of [{ ...message, entryIds: ['a3'] }, { ...message, tabId: '4' }, { ...message, bundleId: 'b 1' },
    { ...message, version: -1 }, { ...message, askId: 'Delete it' }, { ...message, entryIds: Array(21).fill(ENTRY) },
    { ...message, requestId: undefined }]) {
    assert.equal(bundleEvent(bad), null, JSON.stringify(bad).slice(0, 120));
  }
  assert.equal(bundleEvent({ ...message, decision: 'maybe' }, { decision: true }), null);
});

test('AC7: while a bundle is open the owner\'s observe, act, open, wait and evidence return approval_open and run nothing; status, release and others go on', async t => {
  const ctx = await setup(t);
  const first = await ctx.actRaw();
  assert.equal(first.body.result.code, 'approval_pending');
  const runId = first.body.runId;
  await ctx.open();
  const observes = ctx.bridge.observes;
  const executions = ctx.bridge.executions.length;
  const listed = (await ctx.api('GET', '/v1/requests', undefined, ctx.as(ctx.owner))).body.requests.length;
  assertPaused(await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }, ctx.as(ctx.owner)), ctx.requestId, 'observe');
  assertPaused(await ctx.actRaw(), ctx.requestId, 'act');
  assertPaused(await ctx.api('POST', '/v1/requests', { origins: ['https://other.example'], reason: 'Something else' },
    ctx.as(ctx.owner)), ctx.requestId, 'open (another request)');
  assertPaused(await ctx.api('POST', '/v1/wait', { requestId: ctx.requestId, maxMs: 1000 }, ctx.as(ctx.owner)), ctx.requestId, 'wait');
  // A zero-length wait is a read of the request's state (the MCP server's open and act read it first).
  assert.equal((await ctx.api('POST', '/v1/wait', { requestId: ctx.requestId, maxMs: 0 }, ctx.as(ctx.owner))).status, 200);
  assertPaused(await ctx.api('POST', '/v1/wait', { runId, maxMs: 0 }, ctx.as(ctx.owner)), ctx.requestId, 'wait (a finished run)');
  assertPaused(await ctx.api('GET', `/v1/runs/${runId}/evidence?step=0`, undefined, ctx.as(ctx.owner)), ctx.requestId, 'evidence');
  // A caller without a session is paused per request: on the bundle's request only.
  assertPaused(await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }), ctx.requestId, 'observe without a session');
  assert.equal(ctx.bridge.observes, observes, 'nothing observed');
  assert.equal(ctx.bridge.executions.length, executions, 'nothing ran');
  assert.equal((await ctx.api('GET', '/v1/requests', undefined, ctx.as(ctx.owner))).body.requests.length, listed, 'no request made');
  // Status keeps working; another session is not paused.
  assert.equal((await ctx.api('GET', '/v1/status', undefined, ctx.as(ctx.owner))).status, 200);
  const other = await ctx.api('POST', '/v1/requests', { origins: ['https://other.example'], reason: 'Bystander task' },
    ctx.as(ctx.bystander));
  assert.equal(other.status, 201, JSON.stringify(other.body));
  // A bundle of one: Approve keeps today's action_decision and its wake; the decision ends the pause.
  await ctx.decide('approved');
  await ctx.hub.emit({ type: 'action_decision', entryId: ENTRY, decision: 'approved', browserId: BROWSER });
  assert.deepEqual((await ctx.poll(ctx.owner)).map(wake => wake.kind), ['action_approved']);
  // The repeat of the approved act runs at once under its approval.
  ctx.answers.push({ decision: 'approved', approvalId: 'ext-minted', entryId: ENTRY });
  const ran = await ctx.act();
  assert.notEqual(ran.code, 'approval_pending', JSON.stringify(ran).slice(0, 300));
  assert.equal(ctx.bridge.executions.at(-1).action.approvalId, 'ext-minted');
});

test('AC7: release still works while paused, and the lease ending drops the bundle and the pause without a wake', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.ask({ mode: 'full' });
  await ctx.open({ askId: (await ctx.view()).ask.id });
  const released = await ctx.api('DELETE', `/v1/requests/${ctx.requestId}`, {}, ctx.as(ctx.owner));
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const next = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Again' }, ctx.as(ctx.owner));
  assert.equal(next.status, 201, 'the pause went with the lease');
  await ctx.decide('approved');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
});

test('AC7: an ask on the same request joins the bundle, then returns the receipt; one on another request does not join', async t => {
  const ctx = await setup(t);
  const second = await ctx.api('POST', '/v1/requests', { origins: ['https://other.example'], reason: 'Second task' },
    ctx.as(ctx.owner));
  assert.equal(second.status, 201);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.open();
  assertPaused(await ctx.ask({ mode: 'full' }), ctx.requestId, 'ask on the same request');
  const asked = await ctx.view();
  assert.equal(asked.ask.level, 'full', 'the ask joined: the extension shows it in the window');
  assertPaused(await ctx.ask({ mode: 'full' }, second.body.requestId), ctx.requestId, 'ask on another request');
  const other = (await ctx.api('GET', `/v1/requests/${second.body.requestId}`, undefined, ctx.as(ctx.owner))).body;
  assert.equal(other.ask, undefined, 'nothing asked there');
  assert.equal(other.state, 'pending');
});

test('AC3/AC8: Approve applies the ask by its id and wakes once with bundle_approved, ids only; the bundled lease wakes nobody', async t => {
  const ctx = await setup(t);
  const pending = await ctx.act();
  assert.equal(pending.code, 'approval_pending');
  const asked = await ctx.ask({ mode: 'full' });
  assert.equal(asked.body.asked, true, JSON.stringify(asked.body));
  const askId = (await ctx.view()).ask.id;
  await ctx.open({ askId });
  // The extension applies each item: the ask through today's lease event, marked bundled.
  const lease = await ctx.hub.emit({ type: 'lease', requestId: ctx.requestId, tabId: 1, origin: ORIGIN, level: 'full',
    ask: true, askId, bundled: true, browserId: BROWSER });
  assert.equal(lease.grant?.level, 'full', JSON.stringify(lease));
  // Applied once: the same ask again is refused.
  const again = await ctx.hub.emit({ type: 'lease', requestId: ctx.requestId, tabId: 1, origin: ORIGIN, level: 'full',
    ask: true, askId, bundled: true, browserId: BROWSER });
  assert.equal(again.error?.code, 'ask_changed');
  assert.deepEqual(await ctx.poll(ctx.owner), [], 'no wake for the bundled ask');
  await ctx.decide('approved', { askId });
  const wakes = await ctx.poll(ctx.owner);
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.requestId]), [['bundle_approved', ctx.requestId]]);
  assert.deepEqual(wakes[0].items, [{ type: 'level', level: 'full' },
    { type: 'action', actionId: ctx.save.id, revision: ctx.offer.revision, commits: false }]);
  assert.doesNotMatch(JSON.stringify(wakes), /Save changes|example|https?:/, 'ids only');
  assert.deepEqual(await ctx.poll(ctx.bystander), []);
  // Once: the same decision again, or a stray action decision for its entry, wakes nobody.
  await ctx.decide('approved', { askId });
  await ctx.hub.emit({ type: 'action_decision', entryId: ENTRY, decision: 'approved', browserId: BROWSER });
  assert.deepEqual(await ctx.poll(ctx.owner), []);
  // The pause ended: the woken agent's repeat runs at once.
  ctx.answers.push({ decision: 'approved', approvalId: 'bundle-minted', entryId: ENTRY });
  assert.notEqual((await ctx.act()).code, 'approval_pending');
  assert.equal(ctx.bridge.executions.at(-1).action.approvalId, 'bundle-minted');
});

test('AC4/AC8: Deny declines the bundled ask without its own wake and wakes once with bundle_denied', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.ask({ mode: 'full', origins: ['https://help.example'] });
  const askId = (await ctx.view()).ask.id;
  await ctx.open({ askId });
  const denied = await ctx.hub.emit({ type: 'deny', requestId: ctx.requestId, ask: true, bundled: true, browserId: BROWSER });
  assert.equal(denied.state, 'active');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
  await ctx.decide('denied', { askId });
  const wakes = await ctx.poll(ctx.owner);
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.items]), [['bundle_denied', [{ type: 'level', level: 'full' },
    { type: 'sites', count: 1 }, { type: 'action', actionId: ctx.save.id, revision: ctx.offer.revision, commits: false }]]]);
  assert.doesNotMatch(JSON.stringify(wakes), /help\.example/);
  const after = await ctx.view();
  assert.equal(after.ask, undefined);
  assert.equal(after.grant.level, 'reversible', 'nothing granted');
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }, ctx.as(ctx.owner))).status, 200, 'not paused');
});

test('AC8: an expired bundle wakes once with bundle_expired; the pause ends', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.ask({ mode: 'full' });
  const askId = (await ctx.view()).ask.id;
  await ctx.open({ askId });
  await ctx.decide('expired', { askId });
  const wakes = await ctx.poll(ctx.owner);
  assert.deepEqual(wakes.map(wake => wake.kind), ['bundle_expired']);
  assert.equal(wakes[0].items.length, 2);
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }, ctx.as(ctx.owner))).status, 200);
});

test('AC8: no wake when the act that opened the bundle still waited and got the answer; one when it had ended pending', async t => {
  for (const ending of ['approved', 'pending']) {
    const ctx = await setup(t);
    await ctx.ask({ mode: 'full' });
    const askId = (await ctx.view()).ask.id;
    let answer;
    ctx.answers.push(() => new Promise(resolve => {
      answer = resolve;
    }));
    const running = ctx.act();
    while (!answer) await delay(5);
    await ctx.open({ askId });
    await ctx.hub.emit({ type: 'lease', requestId: ctx.requestId, tabId: 1, origin: ORIGIN, level: 'full', ask: true, askId,
      bundled: true, browserId: BROWSER });
    // Decided while the act is still running: it decides when it ends.
    await ctx.decide('approved', { askId });
    assert.deepEqual(await ctx.poll(ctx.owner), [], ending);
    answer(ending === 'approved' ? { decision: 'approved', approvalId: 'in-time', entryId: ENTRY }
      : { decision: 'pending', entryId: ENTRY });
    const result = await running;
    const wakes = await ctx.poll(ctx.owner);
    if (ending === 'approved') {
      assert.notEqual(result.code, 'approval_pending');
      assert.deepEqual(wakes, [], 'the call got the answer');
    } else {
      assert.equal(result.code, 'approval_pending');
      assert.deepEqual(wakes.map(wake => [wake.kind, wake.items.length]), [['bundle_approved', 2]]);
    }
  }
});

test('AC8: no wake when the open that asked was still waiting for its ask; its next wait round is not paused', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.ask({ mode: 'full' });
  const askId = (await ctx.view()).ask.id;
  const waiting = ctx.api('POST', '/v1/wait', { requestId: ctx.requestId, ask: true, maxMs: 5000 }, ctx.as(ctx.owner));
  await delay(20);
  await ctx.open({ askId });
  const round = await ctx.api('POST', '/v1/wait', { requestId: ctx.requestId, ask: true, maxMs: 0 }, ctx.as(ctx.owner));
  assert.equal(round.status, 200, 'the opener\'s own wait goes on');
  await ctx.hub.emit({ type: 'lease', requestId: ctx.requestId, tabId: 1, origin: ORIGIN, level: 'full', ask: true, askId,
    bundled: true, browserId: BROWSER });
  assert.equal((await waiting).status, 200);
  const after = await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId, afterAsk: true }, ctx.as(ctx.owner));
  assert.equal(after.status, 200, 'the open that asked finishes with the page');
  await ctx.decide('approved', { askId });
  assert.deepEqual(await ctx.poll(ctx.owner), []);
});

test('AC13: a declined ask (a bundle of one) wakes once with ask_declined; an approved one keeps approved', async t => {
  const ctx = await setup(t);
  await ctx.ask({ mode: 'full' });
  let askId = (await ctx.view()).ask.id;
  await ctx.open({ askId, entryIds: [] });
  await ctx.hub.emit({ type: 'deny', requestId: ctx.requestId, ask: true, browserId: BROWSER });
  assert.deepEqual((await ctx.poll(ctx.owner)).map(wake => [wake.kind, wake.requestId]), [['ask_declined', ctx.requestId]]);
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }, ctx.as(ctx.owner))).status, 200,
    'its own message ended the pause');
  await ctx.decide('denied', { askId, entryIds: [] });
  assert.deepEqual(await ctx.poll(ctx.owner), [], 'the decision of a bundle of one adds no wake');
  await ctx.ask({ mode: 'full' });
  askId = (await ctx.view()).ask.id;
  await ctx.open({ askId, entryIds: [], bundleId: 'bundle-2' });
  await ctx.hub.emit({ type: 'lease', requestId: ctx.requestId, tabId: 1, origin: ORIGIN, level: 'full', ask: true, askId,
    browserId: BROWSER });
  await ctx.decide('approved', { askId, entryIds: [], bundleId: 'bundle-2' });
  assert.deepEqual((await ctx.poll(ctx.owner)).map(wake => wake.kind), ['approved']);
});

test('a bundle of one whose waiting act got the answer is over: the pause ends with the act', async t => {
  const ctx = await setup(t);
  let answer;
  ctx.answers.push(() => new Promise(resolve => {
    answer = resolve;
  }));
  const running = ctx.act();
  while (!answer) await delay(5);
  await ctx.open();
  assertPaused(await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }, ctx.as(ctx.owner)), ctx.requestId, 'observe');
  answer({ decision: 'approved', approvalId: 'in-time', entryId: ENTRY });
  assert.notEqual((await running).code, 'approval_pending');
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }, ctx.as(ctx.owner))).status, 200);
  await ctx.decide('approved');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
});

test('approval_pending: the text ends the turn, and drops "Or ask for" once the request\'s ask joins the window', async t => {
  const ctx = await setup(t);
  const remove = ctx.offer.actions.find(action => /Remove member/.test(action.description));
  const first = await ctx.act({ actionId: remove.id });
  assert.equal(first.code, 'approval_pending');
  const text = result => directNext(result, { requestId: ctx.requestId }).text;
  assert.ok(text(first).endsWith(` ${END_TURN}`), text(first));
  assert.match(text(first), /Or ask for full/);
  await ctx.ask({ mode: 'full' });
  const second = await ctx.act({ actionId: remove.id, revision: first.revision ?? ctx.offer.revision });
  assert.equal(second.code, 'approval_pending', JSON.stringify(second).slice(0, 300));
  assert.doesNotMatch(text(second), /Or ask for/);
  assert.ok(text(second).endsWith(` ${END_TURN}`));
});

test('a bundle from another browser or tab pauses nothing; a newer version replaces the older', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.hub.emit({ type: 'bundle_open', browserId: 'b-other-browser-0002', requestId: ctx.requestId, tabId: 1,
    bundleId: 'x', version: 1, askId: null, entryIds: [ENTRY] });
  await ctx.hub.emit({ type: 'bundle_open', browserId: BROWSER, requestId: ctx.requestId, tabId: 9, bundleId: 'y',
    version: 1, askId: null, entryIds: [ENTRY] });
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId: ctx.requestId }, ctx.as(ctx.owner))).status, 200);
  await ctx.open({ version: 2, entryIds: [ENTRY, OTHER_ENTRY] });
  await ctx.open({ version: 1, entryIds: [ENTRY] });
  await ctx.decide('denied', { version: 2, entryIds: [ENTRY, OTHER_ENTRY] });
  // OTHER_ENTRY no act recorded: only the known action is named.
  assert.deepEqual((await ctx.poll(ctx.owner)).map(wake => [wake.kind, wake.items.length]), [['bundle_denied', 1]]);
});

test('MCP: a paused call returns the approval_open receipt (not an error); status and guide still answer', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-bundle-mcp-'));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES, path: '/settings' } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub });
  await daemon.listen();
  const mcp = spawnMcp({ FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port), FAI_MCP_APPROVAL_WAIT_MS: '1500' });
  t.after(async () => {
    await mcp.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  await mcp.initialize();
  hub.bridgeForTab(1).approve = async () => ({ decision: 'pending', entryId: ENTRY });
  const opening = mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Clean up the workspace', mode: 'reversible' });
  let pending;
  for (let i = 0; i < 400 && !pending; i++) {
    pending = hub.published.at(-1)?.find(item => item.state === 'pending');
    if (!pending) await delay(5);
  }
  await hub.emit({ type: 'lease', requestId: pending.requestId, tabId: 1, origin: ORIGIN, title: 'Home', level: 'reversible',
    browserId: BROWSER });
  const opened = mcpData(await opening);
  const save = opened.actions.find(action => /Save changes/.test(action.description));
  const waited = mcpData(await mcp.callTool('fai_browser_act', { requestId: pending.requestId, actionId: save.id,
    revision: opened.revision }));
  assert.equal(waited.code, 'approval_pending');
  assert.ok(waited.next.text.endsWith(END_TURN), waited.next.text);
  await hub.emit({ type: 'bundle_open', browserId: BROWSER, requestId: pending.requestId, tabId: 1, bundleId: 'b1',
    version: 1, askId: null, entryIds: [ENTRY] });
  const observes = hub.bridgeForTab(1).observes;
  for (const [tool, args] of [['fai_browser_observe', { requestId: pending.requestId }],
    ['fai_browser_act', { requestId: pending.requestId, actionId: save.id, revision: opened.revision }],
    ['fai_browser_wait', { requestId: pending.requestId, maxMs: 1000 }],
    ['fai_browser_open', { requestId: pending.requestId, mode: 'full' }],
    ['fai_browser_open', { origins: ['https://other.example'], reason: 'Another task' }]]) {
    const result = await mcp.callTool(tool, args);
    assert.notEqual(result.result?.isError, true, `${tool}: ${JSON.stringify(result).slice(0, 300)}`);
    const data = mcpData(result);
    assert.deepEqual(data.next, { kind: 'end_turn', text: approvalOpenText(pending.requestId) }, tool);
    assert.match(data.text, /^code: approval_open$/m, tool);
  }
  assert.equal(hub.bridgeForTab(1).observes, observes, 'nothing reached the page');
  const view = await call(daemon.port, 'GET', `/v1/requests/${pending.requestId}`, undefined, { token: daemon.token });
  assert.equal(view.body.ask?.level, 'full', 'the open on the same request joined the bundle');
  const status = await mcp.callTool('fai_browser_status', {});
  assert.notEqual(status.result?.isError, true);
  assert.doesNotMatch(mcpData(status).text, /approval_open/);
  const guide = await mcp.callTool('fai_browser_guide', { code: 'approval_open' });
  assert.match(mcpData(guide).text, /approval_open/);
});
