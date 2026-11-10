// Invites and wakes in the daemon (docs/REFERENCE.md "Invites and wakes"): the agent-session registry, the popup's
// invite (through the fake hub, as the extension sends it), joining, expiry, revocation, the rate limit, and the
// Approve/Resume wake addressed to the session that made the request. Browserless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, INVITES_PER_MINUTE } from '../src/daemon.js';
import { createSessionRegistry } from '../src/sessions.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { ORIGIN } from './runtime-fixtures.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const SECRET_TITLE = 'Quarterly payroll - TOP SECRET title 7731';
const PAGE_PATH = '/private/salary-report-9921';

async function setup(t, { alive = () => true, sweepIntervalMs = 60_000, clock = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-invite-'));
  const hub = createFakeHub();
  const daemon = createDaemon({ driver: 'agent', home, env: {}, port: 0, hub, isAlive: pid => alive(pid),
    sweepIntervalMs, ...(clock ? { now: () => clock.now } : {}),
    providerFactory: () => { throw new Error('no provider in agent direct'); } });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
  return { home, hub, daemon, api };
}

async function register(ctx, body = {}) {
  const response = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'my-repo', pid: process.pid,
    startedAt: new Date().toISOString(), wake: 'claude-socket', ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { sessionId, key } = response.body;
  return { sessionId, key, headers: { 'X-Fai-Session': `${sessionId}:${key}` } };
}

const poll = (ctx, session, maxMs = 0, body = {}) => ctx.api('POST', `/v1/sessions/${session.sessionId}/poll`,
  { maxMs, ...body }, { headers: session.headers });

function invite(ctx, fields = {}) {
  return ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, title: SECRET_TITLE, level: 'reversible',
    tabMode: 'single', text: '', browserId: 'browser-1', ...fields });
}

async function statusOf(ctx) {
  return (await ctx.api('GET', '/v1/status')).body;
}

test('registry: register, poll as heartbeat, update, unregister; no key in any view; the client token is required', async t => {
  const ctx = await setup(t);
  const unauth = await call(ctx.daemon.port, 'POST', '/v1/sessions', { host: 'claude', pid: process.pid });
  assert.equal(unauth.status, 401);
  const bad = await ctx.api('POST', '/v1/sessions', { host: 'claude', pid: process.pid, token: 'x' });
  assert.equal(bad.status, 400, 'closed keys');
  const session = await register(ctx, { hostSessionId: 'cc-session-1' });
  assert.match(session.sessionId, /^ses_/);
  const status = await statusOf(ctx);
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].host, 'claude');
  assert.equal(status.sessions[0].repo, 'my-repo');
  assert.equal(status.sessions[0].wake, 'claude-socket');
  assert.ok(!JSON.stringify(status).includes(session.key), 'status never carries a session key');
  const empty = await poll(ctx, session, 50, { lastToolCallAt: new Date().toISOString(), wake: 'none' });
  assert.deepEqual(empty.body, { wakes: [] });
  assert.equal((await statusOf(ctx)).sessions[0].wake, 'none', 'a poll updates the capability');
  const updated = await ctx.api('POST', `/v1/sessions/${session.sessionId}/update`, { hostSessionId: 'thread-9', wake: 'codex-queue' },
    { headers: session.headers });
  assert.equal(updated.body.session.wake, 'codex-queue');
  const gone = await ctx.api('DELETE', `/v1/sessions/${session.sessionId}`, {}, { headers: session.headers });
  assert.equal(gone.body.removed, true);
  assert.equal((await statusOf(ctx)).sessions.length, 0);
  assert.equal((await poll(ctx, session)).status, 404, 'an unknown session re-registers');
});

test('registry: a session only receives and settles its own wakes; a wrong key or another id is refused', async t => {
  const ctx = await setup(t);
  const a = await register(ctx, { repo: 'alpha' });
  const b = await register(ctx, { repo: 'beta' });
  const forged = await ctx.api('POST', `/v1/sessions/${b.sessionId}/poll`, { maxMs: 0 }, { headers: a.headers });
  assert.equal(forged.status, 403, 'a header for another session');
  const wrongKey = await ctx.api('POST', `/v1/sessions/${a.sessionId}/poll`, { maxMs: 0 },
    { headers: { 'X-Fai-Session': `${a.sessionId}:not-the-key` } });
  assert.equal(wrongKey.status, 403);
  const made = await invite(ctx, { sessionId: b.sessionId });
  assert.equal(made.invite.wake.state, 'queued');
  assert.deepEqual((await poll(ctx, a)).body.wakes, [], 'A never sees B\'s wake');
  const wakes = (await poll(ctx, b)).body.wakes;
  assert.equal(wakes.length, 1);
  const report = await ctx.api('POST', `/v1/sessions/${a.sessionId}/wakes/${wakes[0].wakeId}`, { outcome: 'delivered' },
    { headers: a.headers });
  assert.equal(report.status, 404, 'A cannot settle B\'s wake');
  const settled = await ctx.api('POST', `/v1/sessions/${b.sessionId}/wakes/${wakes[0].wakeId}`, { outcome: 'delivered' },
    { headers: b.headers });
  assert.equal(settled.body.wake.state, 'delivered');
});

test('registry: a dead pid or a session that stopped polling is dropped; its wakes fail', async () => {
  let t0 = 1_000_000;
  const alive = new Set([11, 12]);
  const registry = createSessionRegistry({ now: () => t0, isAlive: pid => alive.has(pid), staleMs: 90_000 });
  const one = registry.register({ host: 'claude', pid: 11, wake: 'claude-socket' });
  const two = registry.register({ host: 'codex', pid: 12, wake: 'none' });
  assert.equal(registry.views().length, 2);
  const sessionOne = registry.authenticate(one.sessionId, one.key);
  assert.throws(() => registry.authenticate(one.sessionId, two.key), /Wrong session key/);
  const wake = registry.queueWake(one.sessionId, { kind: 'resume', requestId: 'req_1' });
  assert.equal(registry.queueWake(two.sessionId, { kind: 'resume', requestId: 'req_1' }), null, 'capability none: no wake');
  alive.delete(11);
  registry.sweep();
  assert.deepEqual(registry.views().map(view => view.sessionId), [two.sessionId]);
  assert.equal(registry.wake(wake.wakeId).state, 'failed');
  assert.equal(registry.wake(wake.wakeId).error.code, 'session_gone');
  assert.throws(() => registry.authenticate(sessionOne.sessionId, one.key), /register again/);
  t0 += 91_000;
  registry.sweep();
  assert.equal(registry.views().length, 0, 'no poll for 90 s: gone');
  // A wake nobody picks up fails after the pickup window.
  const three = registry.register({ host: 'claude', pid: 12, wake: 'claude-socket' });
  const lonely = registry.queueWake(three.sessionId, { kind: 'invite', inviteId: 'inv-00000000' });
  t0 += 11_000;
  registry.sweep();
  assert.equal(registry.wake(lonely.wakeId).error.code, 'not_polling');
});

test('registry: a held poll returns the wake the moment it is queued', async () => {
  const registry = createSessionRegistry({});
  const reg = registry.register({ host: 'claude', pid: process.pid, wake: 'claude-socket' });
  const session = registry.authenticate(reg.sessionId, reg.key);
  const started = Date.now();
  const held = registry.poll(session, 20_000);
  setTimeout(() => registry.queueWake(reg.sessionId, { kind: 'approved', requestId: 'req_2', level: 'full' }), 30);
  const { wakes } = await held;
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.requestId, wake.level]), [['approved', 'req_2', 'full']]);
  assert.equal(wakes[0].text, undefined, 'fields only: the MCP server writes the text from its own template');
  registry.close();
});

test('invite: one click binds the user\'s tab at the chosen level on its exact origin and wakes the chosen session', async t => {
  const ctx = await setup(t);
  const session = await register(ctx);
  const reply = await invite(ctx, { sessionId: session.sessionId, text: 'Compare the two plans' });
  assert.ok(reply.leaseId, JSON.stringify(reply));
  assert.equal(reply.grant.level, 'reversible');
  assert.deepEqual(reply.origins, [ORIGIN]);
  assert.match(reply.invite.inviteId, /^inv-[0-9a-z]{8}$/);
  assert.equal(reply.invite.session.repo, 'my-repo');
  const bound = ctx.hub.bound.at(-1);
  assert.deepEqual([bound.tabId, bound.origin, bound.level, bound.allowedOrigins], [7, ORIGIN, 'reversible', [ORIGIN]]);
  const view = (await ctx.api('GET', `/v1/requests/${reply.requestId}`, undefined, { headers: session.headers })).body;
  assert.equal(view.state, 'active');
  assert.equal(view.mode, 'reversible');
  assert.equal(view.client, 'invite');
  assert.equal(view.invite.inviteId, reply.invite.inviteId);
  const { wakes } = (await poll(ctx, session)).body;
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.inviteId, wake.level, wake.userText]),
    [['invite', reply.invite.inviteId, 'reversible', 'Compare the two plans']]);
  // Deep scan: nothing about the page (title, path) is in the wake or the invite view the agent can read.
  for (const blob of [JSON.stringify(wakes), JSON.stringify(view.invite)]) {
    assert.ok(!blob.includes(SECRET_TITLE) && !blob.includes('TOP SECRET') && !blob.includes(PAGE_PATH), blob);
  }
  assert.ok(!JSON.stringify(wakes).includes(ORIGIN), 'the wake names no origin either');
  await ctx.api('POST', `/v1/sessions/${session.sessionId}/wakes/${wakes[0].wakeId}`, { outcome: 'delivered' }, { headers: session.headers });
  const published = ctx.hub.published.at(-1).find(item => item.requestId === reply.requestId);
  assert.equal(published.invite.wake.state, 'delivered', 'the popup sees the wake went through');
});

test('invite: several sessions are listed newest first; a failed or impossible wake leaves the copy fallback', async t => {
  const ctx = await setup(t);
  const older = await register(ctx, { repo: 'older' });
  await delay(5);
  const codex = await register(ctx, { host: 'codex', repo: 'newer', wake: 'none' });
  await ctx.api('POST', `/v1/sessions/${codex.sessionId}/update`, { lastToolCallAt: new Date().toISOString() }, { headers: codex.headers });
  const agents = await ctx.hub.emit({ type: 'agents', browserId: 'browser-1' });
  assert.deepEqual(agents.sessions.map(item => [item.repo, item.host, item.wake, item.ready]),
    [['newer', 'codex', 'none', false], ['older', 'claude', 'claude-socket', true]]);
  assert.ok(agents.sessions.every(item => item.key === undefined && item.pid === undefined));
  const none = await invite(ctx, { sessionId: codex.sessionId });
  assert.equal(none.invite.wake.state, 'none', 'a session that cannot be woken: copy text');
  const nobody = await invite(ctx, { tabId: 8 });
  assert.equal(nobody.invite.session, null);
  assert.equal(nobody.invite.wake.state, 'none');
  const failing = await invite(ctx, { tabId: 9, sessionId: older.sessionId });
  const wake = (await poll(ctx, older)).body.wakes[0];
  await ctx.api('POST', `/v1/sessions/${older.sessionId}/wakes/${wake.wakeId}`,
    { outcome: 'failed', code: 'refused', message: 'crossSessionInbound is refuse' }, { headers: older.headers });
  const view = (await ctx.api('GET', `/v1/requests/${failing.requestId}`, undefined, { headers: older.headers })).body;
  assert.deepEqual([view.invite.wake.state, view.invite.wake.error.code], ['failed', 'refused']);
  const gone = await invite(ctx, { tabId: 10, sessionId: 'ses_unknown' });
  assert.equal(gone.error.code, 'unknown_session');
});

test('invite: joining is single use and makes the joining session the owner (woken on Resume)', async t => {
  const ctx = await setup(t);
  const session = await register(ctx);
  const reply = await invite(ctx, { sessionId: session.sessionId, text: 'Book nothing, just look' });
  await poll(ctx, session);
  const joined = await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: session.headers });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.deepEqual(joined.body.request.owner, { sessionId: session.sessionId, host: 'claude', repo: 'my-repo' },
    'the popup sees which agent holds the tab');
  assert.equal(joined.body.requestId, reply.requestId);
  assert.equal(joined.body.level, 'reversible');
  assert.equal(joined.body.userText, 'Book nothing, just look');
  const again = await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: session.headers });
  assert.deepEqual([again.status, again.body.error.code], [409, 'invite_joined']);
  const unknown = await ctx.api('POST', '/v1/invites/inv-zzzzzzzz/join', {});
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'unknown_invite']);
  // The user pauses, then resumes on the tab: the owner is woken.
  await ctx.hub.emit({ type: 'status', leaseId: reply.leaseId, status: 'paused', reason: 'paused' });
  await ctx.hub.approve(reply.requestId, { tabId: 7, level: 'reversible' });
  const { wakes } = (await poll(ctx, session)).body;
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.requestId]), [['resume', reply.requestId]]);
});

test('invite: no client API route creates one, and an agent cannot raise its level', async t => {
  const ctx = await setup(t);
  for (const [method, path] of [['POST', '/v1/invites'], ['PUT', '/v1/invites/x'], ['POST', '/v1/invite']]) {
    const response = await ctx.api(method, path, { origin: ORIGIN, level: 'full', tabId: 7 });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  const reply = await invite(ctx, { level: 'read-only' });
  const agent = await register(ctx);
  const joined = await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: agent.headers });
  assert.equal(joined.body.request.grant.level, 'read-only');
  const observe = await ctx.api('POST', '/v1/observe', { requestId: reply.requestId, mode: 'full' }, { headers: agent.headers });
  assert.deepEqual([observe.body.permissions.granted, observe.body.permissions.effective], ['read-only', 'read-only'],
    'every guardrail applies unchanged: an observe that asks for full is clamped to the invited level');
  assert.ok(observe.body.actions.every(action => ['click', 'scroll', 'wait', 'navigate_allowed_url', 'done', 'handoff'].includes(action.type)
    && (action.type !== 'click' || action.role === 'link')), 'read-only offers links, scroll and wait only');
  assert.equal(ctx.hub.lease(reply.leaseId).level, 'read-only', 'the hub ceiling stays the user\'s choice');
  const badOrigin = await invite(ctx, { origin: 'https://*.example.com' });
  assert.equal(badOrigin.error.code, 'bad_request', 'an invite is never a domain root');
  const chromePage = await invite(ctx, { origin: 'chrome://settings' });
  assert.equal(chromePage.error.code, 'bad_request');
});

test('invite: it expires after ten minutes; then joining fails and the tab is released', async t => {
  const clock = { now: Date.now() };
  const ctx = await setup(t, { clock, sweepIntervalMs: 20 });
  const reply = await invite(ctx);
  clock.now += 10 * 60_000 + 1;
  await delay(80);
  const view = (await ctx.api('GET', `/v1/requests/${reply.requestId}`)).body;
  assert.deepEqual([view.state, view.stateReason], ['expired', 'invite_expired']);
  assert.ok(ctx.hub.updates.some(update => update.leaseId === reply.leaseId && update.state === 'expired'));
  const joined = await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {});
  assert.deepEqual([joined.status, joined.body.error.code], [409, 'invite_expired']);
});

test('invite: leaving the origin, closing the tab or the user\'s cancel revokes it before an agent joins', async t => {
  const ctx = await setup(t);
  const navigated = await invite(ctx, { tabId: 21 });
  await ctx.hub.emit({ type: 'status', leaseId: navigated.leaseId, status: 'paused', reason: 'origin_changed' });
  const left = (await ctx.api('GET', `/v1/requests/${navigated.requestId}`)).body;
  assert.deepEqual([left.state, left.stateReason], ['released', 'invite_revoked']);
  assert.equal((await ctx.api('POST', `/v1/invites/${navigated.invite.inviteId}/join`, {})).body.error.code, 'invite_revoked');

  const closed = await invite(ctx, { tabId: 22 });
  const reply = await ctx.hub.emit({ type: 'invite_cancel', requestId: closed.requestId, reason: 'tab_closed', browserId: 'browser-1' });
  assert.equal(reply.invite.state, 'revoked');
  assert.equal((await ctx.api('GET', `/v1/requests/${closed.requestId}`)).body.state, 'released');

  const cancelled = await invite(ctx, { tabId: 23 });
  const other = await ctx.hub.emit({ type: 'invite_cancel', inviteId: cancelled.invite.inviteId, browserId: 'browser-2' });
  assert.equal(other.error.code, 'unknown_invite', 'another browser cannot cancel it');
  const mine = await ctx.hub.emit({ type: 'invite_cancel', inviteId: cancelled.invite.inviteId, browserId: 'browser-1' });
  assert.equal(mine.invite.state, 'cancelled');
  assert.equal((await ctx.api('POST', `/v1/invites/${cancelled.invite.inviteId}/join`, {})).body.error.code, 'invite_cancelled');

  // A tab switch only pauses: the invite stays open and the agent can still join (it then asks the user to resume).
  const switched = await invite(ctx, { tabId: 24 });
  await ctx.hub.emit({ type: 'status', leaseId: switched.leaseId, status: 'paused', reason: 'tab_changed' });
  const agent = await register(ctx);
  assert.equal((await ctx.api('POST', `/v1/invites/${switched.invite.inviteId}/join`, {}, { headers: agent.headers })).status, 200);

  // A second invite on the same tab replaces the first.
  const first = await invite(ctx, { tabId: 25 });
  await invite(ctx, { tabId: 25 });
  assert.equal((await ctx.api('GET', `/v1/requests/${first.requestId}`)).body.state, 'released');
});

test('invite: a browser may make a few a minute', async t => {
  const ctx = await setup(t);
  for (let i = 0; i < INVITES_PER_MINUTE; i++) {
    const reply = await invite(ctx, { tabId: 100 + i });
    assert.ok(reply.leaseId, JSON.stringify(reply));
  }
  const limited = await invite(ctx, { tabId: 200 });
  assert.equal(limited.error.code, 'rate_limited');
  const elsewhere = await invite(ctx, { tabId: 201, browserId: 'browser-2' });
  assert.ok(elsewhere.leaseId, 'the limit is per browser');
});

test('Approve and Resume wake the session that made the request, and no other', async t => {
  const ctx = await setup(t);
  const owner = await register(ctx, { repo: 'owner' });
  const bystander = await register(ctx, { repo: 'bystander' });
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check', mode: 'interactive' },
    { headers: owner.headers });
  assert.equal(created.status, 201);
  const requestId = created.body.requestId;
  const lease = await ctx.hub.approve(requestId, { level: 'interactive' });
  let wakes = (await poll(ctx, owner)).body.wakes;
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.requestId, wake.level]), [['approved', requestId, 'interactive']]);
  assert.deepEqual((await poll(ctx, bystander)).body.wakes, []);
  await ctx.hub.emit({ type: 'status', leaseId: lease.leaseId, status: 'paused', reason: 'tab_changed' });
  await ctx.hub.approve(requestId, { level: 'interactive' });
  wakes = (await poll(ctx, owner)).body.wakes;
  assert.deepEqual(wakes.map(wake => [wake.kind, wake.requestId]), [['resume', requestId]]);
  assert.deepEqual((await poll(ctx, bystander)).body.wakes, []);
  // A request made without a session header (the CLI, an older MCP server) wakes nobody.
  const anonymous = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' });
  await ctx.hub.approve(anonymous.body.requestId);
  assert.deepEqual((await poll(ctx, owner)).body.wakes, []);
  // A forged session header is ignored, not an error, and makes nobody the owner.
  const forged = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' },
    { headers: { 'X-Fai-Session': `${owner.sessionId}:wrong` } });
  assert.equal(forged.status, 201);
  await ctx.hub.approve(forged.body.requestId);
  assert.deepEqual((await poll(ctx, owner)).body.wakes, []);
});

test('sessions are not client activity: polls never keep an idle daemon up', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-invite-idle-'));
  let shutdowns = 0;
  const daemon = createDaemon({ driver: 'agent', home, env: { FAI_DAEMON_IDLE_MS: '300' }, port: 0, hub: createFakeHub(),
    sweepIntervalMs: 50, onShutdownRequest: () => { shutdowns++; } });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const ctx = { api: (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra }) };
  const session = await register(ctx);
  for (let i = 0; i < 6; i++) {
    await poll(ctx, session, 50);
    await delay(50);
  }
  assert.ok(shutdowns > 0, 'the idle shutdown fired although the session kept polling');
});

test('the real hub: an invite over the paired WebSocket, validated, with a lease bound to that browser', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-invite-hub-'));
  const daemon = createDaemon({ driver: 'agent', home, env: { FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID },
    port: 0, sweepIntervalMs: 60_000, providerFactory: () => { throw new Error('no provider'); } });
  await daemon.listen();
  const ext = await FakeExtension.connect({ port: daemon.port });
  t.after(async () => {
    ext.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  assert.equal((await ext.hello()).ok, true);
  const ctx = { api: (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra }) };
  const session = await register(ctx);
  const listed = await ext.request('agents', {});
  assert.deepEqual(listed.data.sessions.map(item => [item.sessionId, item.repo, item.wake]), [[session.sessionId, 'my-repo', 'claude-socket']]);
  for (const bad of [{ tabId: 'x', origin: ORIGIN, level: 'full' }, { tabId: 7, origin: ORIGIN, level: 'root' },
    { tabId: 7, origin: ORIGIN, level: 'full', sessionId: 42 }, { tabId: 7, origin: ORIGIN, level: 'full', tabMode: 'all' }]) {
    const refused = await ext.request('invite', bad);
    assert.equal(refused.ok, false, JSON.stringify(bad));
    assert.equal(refused.error.code, 'bad_request');
  }
  const made = await ext.request('invite', { tabId: 7, origin: ORIGIN, title: SECRET_TITLE, level: 'reversible',
    sessionId: session.sessionId, text: 'Check the price' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.data.grant.level, 'reversible');
  const view = (await ctx.api('GET', `/v1/requests/${made.data.requestId}`, undefined, { headers: session.headers })).body;
  assert.equal(view.lease.tabId, 7);
  assert.ok(view.lease.browserId, 'the lease belongs to the browser that invited');
  const { wakes } = (await poll(ctx, session)).body;
  assert.equal(wakes[0].userText, 'Check the price');
  const cancelled = await ext.request('invite_cancel', { inviteId: made.data.invite.inviteId });
  assert.equal(cancelled.data.invite.state, 'cancelled');
});

// --- the invited tab is not a bearer handle (security review of feat/invite) --------------------------------------

test('review: an invite addressed to A cannot be seen or joined by B; one for nobody needs a session to join', async t => {
  const ctx = await setup(t);
  const a = await register(ctx, { repo: 'repo-a' });
  const b = await register(ctx, { repo: 'repo-b' });
  const reply = await invite(ctx, { sessionId: a.sessionId });
  const asB = (await ctx.api('GET', '/v1/status', undefined, { headers: b.headers })).body;
  assert.ok(!asB.invites.some(item => item.inviteId === reply.invite.inviteId), 'B does not see A\'s invite');
  assert.ok(!asB.requests.some(item => item.requestId === reply.requestId), 'nor its tab');
  assert.ok(!JSON.stringify(asB).includes(reply.invite.inviteId));
  const anonymous = (await ctx.api('GET', '/v1/status')).body;
  assert.ok(!JSON.stringify(anonymous).includes(reply.invite.inviteId), 'a client without a session sees neither');
  assert.ok(!(await ctx.api('GET', '/v1/requests')).body.requests.some(item => item.requestId === reply.requestId));
  const asA = (await ctx.api('GET', '/v1/status', undefined, { headers: a.headers })).body;
  assert.ok(asA.invites.some(item => item.inviteId === reply.invite.inviteId), 'A sees its own invite');
  const stolen = await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: b.headers });
  assert.deepEqual([stolen.status, stolen.body.error.code], [403, 'invite_for_another_session']);
  const bare = await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {});
  assert.deepEqual([bare.status, bare.body.error.code], [403, 'session_required']);
  const own = await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: a.headers });
  assert.equal(own.status, 200);
  // An invite for nobody in particular (the copy line): any registered session may join it, never a bare token.
  const open = await invite(ctx, { tabId: 8 });
  assert.equal((await ctx.api('POST', `/v1/invites/${open.invite.inviteId}/join`, {})).status, 403);
  assert.equal((await ctx.api('POST', `/v1/invites/${open.invite.inviteId}/join`, {}, { headers: b.headers })).status, 200);
});

test('review: nobody uses an invited tab before the join, and only its owner after', async t => {
  const ctx = await setup(t);
  const a = await register(ctx, { repo: 'repo-a' });
  const b = await register(ctx, { repo: 'repo-b' });
  const reply = await invite(ctx, { sessionId: a.sessionId });
  for (const headers of [undefined, a.headers, b.headers]) {
    const extra = headers ? { headers } : {};
    const observe = await ctx.api('POST', '/v1/observe', { requestId: reply.requestId }, extra);
    assert.deepEqual([observe.status, observe.body.error?.code], [409, 'invite_not_joined']);
    const act = await ctx.api('POST', '/v1/act', { requestId: reply.requestId, actionId: 'a0' }, extra);
    assert.equal(act.body.error?.code, 'invite_not_joined');
    const release = await ctx.api('DELETE', `/v1/requests/${reply.requestId}`, {}, extra);
    assert.equal(release.body.error?.code, 'invite_not_joined');
  }
  // The CLI's resume wait still sees the state, never the personal tab's origin or the invite id.
  const waited = (await ctx.api('POST', '/v1/wait', { requestId: reply.requestId, maxMs: 0 })).body;
  assert.equal(waited.state, 'active');
  assert.deepEqual(Object.keys(waited.request).sort(), ['invited', 'requestId', 'state', 'stateReason']);
  await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: a.headers });
  for (const extra of [{}, { headers: b.headers }]) {
    const observe = await ctx.api('POST', '/v1/observe', { requestId: reply.requestId }, extra);
    assert.deepEqual([observe.status, observe.body.error?.code], [403, 'not_owner']);
    const release = await ctx.api('DELETE', `/v1/requests/${reply.requestId}`, {}, extra);
    assert.equal(release.body.error?.code, 'not_owner');
  }
  const asB = (await ctx.api('GET', '/v1/status', undefined, { headers: b.headers })).body;
  assert.ok(!asB.requests.some(item => item.requestId === reply.requestId), 'still hidden from other sessions');
  const ok = await ctx.api('POST', '/v1/observe', { requestId: reply.requestId }, { headers: a.headers });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const asA = (await ctx.api('GET', '/v1/status', undefined, { headers: a.headers })).body;
  assert.ok(asA.requests.some(item => item.requestId === reply.requestId), 'the owner lists its tab');
  // An ordinary request stays open to any token holder, as before (the CLI, the SDK).
  const plain = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' }, { headers: a.headers });
  await ctx.hub.approve(plain.body.requestId, { tabId: 30 });
  assert.equal((await ctx.api('POST', '/v1/observe', { requestId: plain.body.requestId })).status, 200);
});

test('review: a session the daemon dropped comes back as itself with its key; a dead process never', async () => {
  let t0 = 5_000_000;
  const registry = createSessionRegistry({ now: () => t0, isAlive: pid => pid !== 99 });
  const first = registry.register({ host: 'claude', pid: 4242, wake: 'claude-socket' });
  assert.throws(() => registry.register({ host: 'claude', pid: 4242 }) && registry.register({ host: 'claude', pid: 4242 }),
    /already registered/, 'at most two entries per process');
  t0 += 91_000;
  registry.sweep();
  const forged = registry.register({ host: 'claude', pid: 4242, previous: { sessionId: first.sessionId, key: 'wrong' } });
  assert.equal(forged.replaced, undefined, 'a wrong key takes nothing over');
  const otherProcess = registry.register({ host: 'claude', pid: 8, previous: { sessionId: first.sessionId, key: first.key } });
  assert.equal(otherProcess.replaced, undefined, 'the right key from another process takes nothing over');
  const back = registry.register({ host: 'claude', pid: 4242, previous: { sessionId: first.sessionId, key: first.key } });
  assert.equal(back.replaced, first.sessionId);
  registry.unregister(registry.authenticate(forged.sessionId, forged.key));
  const again = registry.register({ host: 'claude', pid: 4242, previous: { sessionId: first.sessionId, key: first.key } });
  assert.equal(again.replaced, undefined, 'used once');
  const dead = registry.register({ host: 'claude', pid: 99 });
  registry.sweep();
  assert.equal(registry.register({ host: 'claude', pid: 99, previous: { sessionId: dead.sessionId, key: dead.key } }).replaced, undefined);
});

test('review: re-registering with the old key gives the session its requests back (Approve still wakes it)', async t => {
  const clock = { now: Date.now() };
  const ctx = await setup(t, { clock });
  const reg = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'r', pid: process.pid, wake: 'claude-socket' });
  const old = { sessionId: reg.body.sessionId, key: reg.body.key };
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' },
    { headers: { 'X-Fai-Session': `${old.sessionId}:${old.key}` } });
  clock.now += 91_000;
  (await ctx.api('GET', '/v1/sessions'));
  const back = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'r', pid: process.pid, wake: 'claude-socket', previous: old });
  assert.equal(back.status, 201);
  assert.equal(back.body.replaced, undefined, 'the answer does not echo ids');
  const headers = { 'X-Fai-Session': `${back.body.sessionId}:${back.body.key}` };
  const view = (await ctx.api('GET', `/v1/requests/${created.body.requestId}`)).body;
  assert.equal(view.owner.sessionId, back.body.sessionId);
  await ctx.hub.approve(created.body.requestId);
  const { wakes } = (await ctx.api('POST', `/v1/sessions/${back.body.sessionId}/poll`, { maxMs: 0 }, { headers })).body;
  assert.deepEqual(wakes.map(wake => wake.kind), ['approved']);
});

test('review: the health answer proves the daemon holds the client token', async t => {
  const ctx = await setup(t);
  const challenge = 'abcdefghijklmnopqrstuvwx';
  const answer = (await call(ctx.daemon.port, 'GET', `/v1/health?challenge=${challenge}`)).body;
  const { createHmac } = await import('node:crypto');
  assert.equal(answer.proof, createHmac('sha256', ctx.daemon.token).update(`fai-health:${ctx.daemon.port}:${challenge}`).digest('hex'));
  assert.equal((await call(ctx.daemon.port, 'GET', '/v1/health')).body.proof, undefined);
  assert.equal((await call(ctx.daemon.port, 'GET', '/v1/health?challenge=short')).body.proof, undefined);
});

test('re-review: runs and observes of an invited tab are the owner\'s alone: list, get, evidence, stop, status', async t => {
  const ctx = await setup(t);
  const a = await register(ctx, { repo: 'repo-a' });
  const b = await register(ctx, { repo: 'repo-b' });
  const reply = await invite(ctx, { sessionId: a.sessionId, level: 'full' });
  assert.equal((await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: a.headers })).status, 200);
  const observed = await ctx.api('POST', '/v1/observe', { requestId: reply.requestId }, { headers: a.headers });
  assert.equal(observed.status, 200);
  const id = observed.body.observeId;
  assert.ok(id);
  for (const extra of [{ headers: b.headers }, {}]) {
    const status = (await ctx.api('GET', '/v1/status', undefined, extra)).body;
    assert.ok(!JSON.stringify(status.runs).includes(reply.requestId), 'status runs');
    const list = (await ctx.api('GET', `/v1/runs?requestId=${reply.requestId}`, undefined, extra)).body;
    assert.deepEqual(list.runs, [], 'runs list');
    const got = await ctx.api('GET', `/v1/runs/${id}`, undefined, extra);
    assert.deepEqual([got.status, got.body.error?.code], [403, 'not_owner'], 'runs get');
    for (const kind of ['trace', 'screenshot']) {
      const evidence = await ctx.api('GET', `/v1/runs/${id}/evidence?kind=${kind}`, undefined, extra);
      assert.deepEqual([evidence.status, evidence.body.error?.code], [403, 'not_owner'], `evidence ${kind}`);
    }
    const stop = await ctx.api('POST', `/v1/runs/${id}/stop`, {}, extra);
    assert.deepEqual([stop.status, stop.body.error?.code], [403, 'not_owner'], 'runs stop');
    const waited = await ctx.api('POST', '/v1/wait', { runId: id, maxMs: 0 }, extra);
    assert.equal(waited.body.error?.code, 'not_owner', 'wait on the run');
  }
  // The owner: everything works, and the trace on disk carries who may read it after the request record is gone.
  const own = await ctx.api('GET', `/v1/runs/${id}`, undefined, { headers: a.headers });
  assert.equal(own.status, 200);
  const trace = await ctx.api('GET', `/v1/runs/${id}/evidence?kind=trace`, undefined, { headers: a.headers });
  assert.equal(trace.status, 200);
  assert.deepEqual([trace.body.trace.options.invite, trace.body.trace.options.ownerSession], [true, a.sessionId]);
  assert.ok((await ctx.api('GET', `/v1/runs?requestId=${reply.requestId}`, undefined, { headers: a.headers })).body.runs.length >= 1);
  // An ordinary request's observe stays readable to any token holder, as before.
  const plain = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check' });
  await ctx.hub.approve(plain.body.requestId, { tabId: 31 });
  const plainObserve = await ctx.api('POST', '/v1/observe', { requestId: plain.body.requestId });
  assert.equal((await ctx.api('GET', `/v1/runs/${plainObserve.body.observeId}`, undefined, { headers: b.headers })).status, 200);
});

test('final: a run of an invited tab stays the owner\'s after its request record is gone (the run carries the stamp)', async t => {
  const clock = { now: Date.now() };
  const home = await mkdtemp(join(tmpdir(), 'fai-invite-final-'));
  const hub = createFakeHub({ bridgeOptions: { captureDelayMs: 400 } });
  const daemon = createDaemon({ driver: 'agent', home, env: {}, port: 0, hub, isAlive: () => true, now: () => clock.now,
    sweepIntervalMs: 20, providerFactory: () => { throw new Error('no provider'); } });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const ctx = { hub, daemon, api: (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra }) };
  const a = await register(ctx, { repo: 'repo-a' });
  const b = await register(ctx, { repo: 'repo-b' });
  const reply = await invite(ctx, { sessionId: a.sessionId, level: 'full' });
  await ctx.api('POST', `/v1/invites/${reply.invite.inviteId}/join`, {}, { headers: a.headers });
  const observed = await ctx.api('POST', '/v1/observe', { requestId: reply.requestId }, { headers: a.headers });
  const started = await ctx.api('POST', '/v1/act', { requestId: reply.requestId, actionId: observed.body.actions[0].id,
    revision: observed.body.revision, waitMs: 0, capture: 'last' }, { headers: a.headers });
  const runId = started.body.runId;
  assert.ok(runId, JSON.stringify(started.body));
  // The user stops the tab while the act is still capturing: the request ends first, the run a moment later.
  await ctx.hub.emit({ type: 'status', leaseId: reply.leaseId, status: 'stopped', reason: 'stopped' });
  clock.now += 5_000;
  for (let i = 0; i < 100; i++) {
    const run = (await ctx.api('GET', `/v1/runs/${runId}`, undefined, { headers: a.headers })).body;
    if (run.state === 'done') break;
    await delay(20);
  }
  // The request record goes (an hour after it ended); the run stays a little longer.
  clock.now += 60 * 60_000 - 2_000;
  for (let i = 0; i < 50; i++) {
    if ((await ctx.api('GET', `/v1/requests/${reply.requestId}`, undefined, { headers: a.headers })).status === 404) break;
    await delay(20);
  }
  assert.equal((await ctx.api('GET', `/v1/requests/${reply.requestId}`, undefined, { headers: a.headers })).status, 404);
  for (const extra of [{ headers: b.headers }, {}]) {
    const got = await ctx.api('GET', `/v1/runs/${runId}`, undefined, extra);
    assert.deepEqual([got.status, got.body.error?.code], [403, 'not_owner']);
    assert.ok(!JSON.stringify((await ctx.api('GET', '/v1/runs', undefined, extra)).body).includes(runId));
  }
  // The owner's MCP server, dropped over that hour of silence, comes back with its old key: the run is its own again.
  const back = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'repo-a', pid: process.pid, wake: 'claude-socket',
    previous: { sessionId: a.sessionId, key: a.headers['X-Fai-Session'].split(':')[1] } });
  assert.equal(back.status, 201);
  const headers = { 'X-Fai-Session': `${back.body.sessionId}:${back.body.key}` };
  assert.equal((await ctx.api('GET', `/v1/runs/${runId}`, undefined, { headers })).status, 200);
});

