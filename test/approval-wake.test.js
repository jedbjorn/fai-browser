// An approval wakes the agent (spec #79, docs/REFERENCE.md "Invites and wakes"), daemon side: an act that ends
// approval_pending records the extension's approval entry on its request; a decision the extension reports for that
// entry (Approve once or Deny given while no act waited) queues one action_approved or action_denied wake to the
// request's owner session, with ids only. A second decision, a decision an act already picked up, another lease or
// browser, or an entry no act recorded wakes nobody. Browserless (fake hub); the extension's side is in
// test/extension-worker.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { actionDecision } from '../src/bridge.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { ORIGIN } from './runtime-fixtures.js';

const ENTRY = '0b8e5c1a-6f0d-4b6a-9c2e-1f3a5b7c9d0e';
const OTHER_ENTRY = '1c9f6d2b-7a1e-4c7b-8d3f-2a4b6c8d0e1f';
const BROWSER = 'b-lease-browser-0001';
const button = (id, label, extra = {}) => ({ id, role: 'button', label, enabled: true, visible: true, risk: 'reversible', ...extra });
const PAGES = {
  '/settings': { url: `${ORIGIN}/settings`, title: 'Settings', text: 'Workspace', controls: [
    button('3', 'Save changes', { risk: 'submit' }),
    button('4', 'Remove member', { risk: 'delete' }),
  ] },
  // A filled message field whose Enter sends it (a committing Enter: commits true asks enter_commit).
  '/contact': { url: `${ORIGIN}/contact`, title: 'Contact', text: 'Write to us', controls: [{ id: '1', role: 'textbox',
    label: 'Message', type: 'text', enabled: true, visible: true, risk: 'reversible', enter: 'submit', filled: true,
    submitHref: `${ORIGIN}/sent` }] },
  '/sent': { url: `${ORIGIN}/sent`, title: 'Sent', text: 'message sent', controls: [] },
};

// `pick(actions)`: the gated action the act sends (default: Save changes, a submit above reversible); `body`: the act's
// other fields.
async function setup(t, { path = '/settings', level = 'reversible', pick = null, body: actBody = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-approval-wake-'));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES, path } });
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
  const created = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Tidy the workspace', mode: level },
    { headers: owner.headers });
  assert.equal(created.status, 201);
  const requestId = created.body.requestId;
  // Approved in browser BROWSER: the lease is bound to it.
  const lease = await hub.emit({ type: 'lease', requestId, tabId: 1, origin: ORIGIN, title: 'Home', level,
    browserId: BROWSER });
  assert.ok(lease.leaseId, JSON.stringify(lease));
  assert.deepEqual((await poll(owner)).map(wake => wake.kind), ['approved']);
  // The extension's answers to the Approve gate, in order (default: pending, naming ENTRY).
  const answers = [];
  hub.bridgeForTab(1).approve = async () => answers.shift() ?? { decision: 'pending', entryId: ENTRY };
  const observed = await api('POST', '/v1/observe', { requestId }, { headers: owner.headers });
  assert.equal(observed.status, 200, JSON.stringify(observed.body).slice(0, 300));
  const offer = observed.body;
  const save = pick ? pick(offer.actions) : offer.actions.find(action => /Save changes/.test(action.description));
  assert.ok(save, JSON.stringify(offer.actions));
  if (!pick) assert.equal(save.needsApproval, 'submit');
  const act = (body = {}) => api('POST', '/v1/act', { requestId, actionId: save.id, revision: offer.revision, ...actBody, ...body },
    { headers: owner.headers }).then(response => response.body.result);
  const decide = (decision, entryId = ENTRY, browserId = BROWSER) => hub.emit({ type: 'action_decision', entryId, decision,
    browserId });
  return { hub, api, owner, bystander, requestId, lease, answers, save, offer, act, decide, poll };
}

test('bridge: a decision message is an entry UUID and approved or denied; anything else is dropped', () => {
  assert.deepEqual(actionDecision({ entryId: ENTRY, decision: 'approved', label: 'Pay', url: 'https://x' }),
    { entryId: ENTRY, decision: 'approved' }, 'only the two fields pass');
  assert.deepEqual(actionDecision({ entryId: ENTRY, decision: 'denied' }), { entryId: ENTRY, decision: 'denied' });
  for (const message of [{ entryId: ENTRY, decision: 'approve' }, { entryId: 'a3', decision: 'approved' },
    { entryId: `${ENTRY} x`, decision: 'denied' }, { decision: 'approved' }, null]) {
    assert.equal(actionDecision(message), null, JSON.stringify(message));
  }
});

test('a late Approve once wakes the owner session once, with the action id and revision; nobody else', async t => {
  const ctx = await setup(t);
  const pending = await ctx.act();
  assert.equal(pending.code, 'approval_pending');
  assert.equal(pending.approvalEntryId, undefined, 'the entry id never reaches the agent');
  assert.doesNotMatch(JSON.stringify(pending), new RegExp(ENTRY), 'nor anywhere in its result');
  await ctx.decide('approved');
  const wakes = await ctx.poll(ctx.owner);
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.requestId, wake.actionId, wake.revision]),
    [['action_approved', ctx.requestId, ctx.save.id, ctx.offer.revision]]);
  assert.equal(Object.hasOwn(wakes[0], 'entryId'), false);
  assert.deepEqual(await ctx.poll(ctx.bystander), []);
  // Once per entry: the same decision again (a retry, a second message) wakes nobody.
  await ctx.decide('approved');
  await ctx.decide('denied');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
  // The popup shows how that wake went (a failed one says "Tell it to continue").
  const view = (await ctx.api('GET', `/v1/requests/${ctx.requestId}`, undefined, { headers: ctx.owner.headers })).body;
  assert.equal(view.ownerWake.kind, 'action_approved');
});

test('a committing Enter (enter_commit) left pending wakes the owner with its Enter action and revision', async t => {
  const ctx = await setup(t, { path: '/contact', level: 'full', pick: actions => actions.find(action => action.type === 'submit_field'),
    body: { commits: true } });
  const pending = await ctx.act();
  assert.equal(pending.code, 'approval_pending', JSON.stringify(pending).slice(0, 300));
  assert.equal(pending.needs.approval.kind, 'enter_commit');
  await ctx.decide('approved');
  assert.deepEqual((await ctx.poll(ctx.owner)).map(wake => [wake.kind, wake.actionId, wake.revision]),
    [['action_approved', pending.needs.approval.actionId, pending.needs.approval.revision]]);
  // The woken agent's act (same actionId, revision and commits) picks the approval up and the Enter runs.
  ctx.answers.push({ decision: 'approved', approvalId: 'ext-minted', entryId: ENTRY });
  const done = await ctx.act({ actionId: pending.needs.approval.actionId, revision: pending.needs.approval.revision });
  assert.notEqual(done.code, 'approval_pending', JSON.stringify(done).slice(0, 300));
  assert.equal(ctx.hub.bridgeForTab(1).executions.at(-1).action.approvalId, 'ext-minted');
  await ctx.decide('approved');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
});

test('a late Deny wakes the owner with action_denied', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.decide('denied');
  assert.deepEqual((await ctx.poll(ctx.owner)).map(wake => [wake.kind, wake.actionId, wake.revision]),
    [['action_denied', ctx.save.id, ctx.offer.revision]]);
});

test('no wake when an act picked the decision up first, or for an entry no act recorded', async t => {
  const ctx = await setup(t);
  // Never recorded: an entry id the daemon's acts never saw (another process guessing ids) wakes nobody.
  await ctx.decide('approved', OTHER_ENTRY);
  assert.deepEqual(await ctx.poll(ctx.owner), []);
  // Pending, then the agent repeats the act and it picks the approval up: a decision message arriving after that
  // (queued while the extension was disconnected) wakes nobody.
  assert.equal((await ctx.act()).code, 'approval_pending');
  ctx.answers.push({ decision: 'approved', approvalId: 'ext-minted', entryId: ENTRY });
  const ran = await ctx.act();
  assert.notEqual(ran.code, 'approval_pending', JSON.stringify(ran).slice(0, 300));
  await ctx.decide('approved');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
});

test('a decision that arrives before the act\'s pending answer is recorded still wakes the owner once', async t => {
  const ctx = await setup(t);
  // The extension sent pending, the user clicked at once: the decision reaches the daemon before the act finishes.
  await ctx.decide('approved');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
  assert.equal((await ctx.act()).code, 'approval_pending');
  const wakes = await ctx.poll(ctx.owner);
  assert.deepEqual(wakes.map(wake => wake.kind), ['action_approved']);
});

test('a decision from another browser than the lease\'s, or after the lease ended, wakes nobody', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.act()).code, 'approval_pending');
  await ctx.decide('approved', ENTRY, 'b-other-browser-0002');
  assert.deepEqual(await ctx.poll(ctx.owner), []);
  // The tab's session ends: its approvals go with it.
  await ctx.api('DELETE', `/v1/requests/${ctx.requestId}`, undefined, { headers: ctx.owner.headers });
  await ctx.decide('approved');
  assert.deepEqual((await ctx.poll(ctx.owner)).filter(wake => wake.kind.startsWith('action_')), []);
});
