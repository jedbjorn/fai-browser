// Issues #30 and #31, the daemon's and the MCP server's side (real daemon, fake hub; no browser): an agent that needs
// more on a request it holds (a higher level, another origin) asks on that request, which keeps its id, tab, page and
// tab mode; nothing is granted before the user's Approve. And a lease code from the browser (stopped, paused, ...) is
// checked against the request itself: "the user stopped the tab" only when the request was really stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../src/daemon.js';
import { bridgeError, directNext } from '../src/result.js';
import { OTHER_SITE_TEXT, offeredActions, pointAction } from '../src/runtime.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { ORIGIN, link } from './runtime-fixtures.js';

const PARTNER = 'https://partner.example.org';
const PAGES = {
  '/': { title: 'Home', text: 'Welcome home', controls: [link('1', 'About', '/about')] },
  '/about': { title: 'About', text: 'About us', controls: [link('1', 'Home', '/')] },
};

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'fai-continuity-'));
  const hub = createFakeHub({ bridgeOptions: { pages: PAGES } });
  const daemon = createDaemon({ home, env: {}, port: 0, hub, sweepIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body, extra = {}) => call(daemon.port, method, path, body, { token: daemon.token, ...extra });
  return { home, hub, daemon, api };
}

async function active(ctx, { level = 'read-only', tabMode = 'single', mode = level } = {}) {
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], mode, reason: 'Read the page' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { requestId } = created.body;
  const reply = await ctx.hub.approve(requestId, { level, tabMode });
  assert.ok(reply.leaseId, JSON.stringify(reply));
  return { requestId, leaseId: reply.leaseId };
}

// The user's Approve on the ask card: it names the ask the card showed (by default the one waiting now).
const approveAsk = (ctx, requestId, { level, origin = ORIGIN, tabId = 1, tabMode = 'single', browserId,
  askId = ctx.daemon.request(requestId).ask?.id } = {}) => ctx.hub.emit({
  type: 'lease', requestId, tabId, origin, title: 'Home', level, tabMode, ask: true, askId, ...(browserId ? { browserId } : {}) });

test('ask: a higher level on an active request keeps its id, lease, tab and tab mode; nothing before the Approve', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx, { tabMode: 'multiple' });
  const asked = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'reversible' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.asked, true);
  assert.equal(asked.body.request.ask.level, 'reversible');
  // Nothing is granted yet; the request stays active at its level, and no second request exists.
  assert.equal(ctx.daemon.request(requestId).grant.level, 'read-only');
  assert.equal((await ctx.api('GET', '/v1/requests')).body.requests.length, 1);
  // The extension lists the ask with the request, so the popup can show it.
  assert.equal(ctx.hub.published.at(-1).find(view => view.requestId === requestId).ask.level, 'reversible');
  const reply = await approveAsk(ctx, requestId, { level: 'reversible', tabMode: 'multiple' });
  assert.equal(reply.leaseId, leaseId, 'the same lease');
  assert.equal(reply.requestId, requestId);
  const record = ctx.daemon.request(requestId);
  assert.deepEqual([record.state, record.grant.level, record.grant.tabMode, record.mode], ['active', 'reversible', 'multiple', 'reversible']);
  assert.equal(record.ask, undefined);
  assert.equal(ctx.hub.lease(leaseId).level, 'reversible');
});

test('ask: an added origin joins the request and its lease only on Approve; Decline keeps the task as it was', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx, { level: 'reversible' });
  const refused = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: ['https://*.com'] });
  assert.equal(refused.status, 400, 'origins are validated as for a new request');
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  assert.deepEqual(ctx.daemon.request(requestId).ask.origins, [PARTNER]);
  assert.deepEqual(ctx.daemon.request(requestId).origins, [ORIGIN], 'not added before the Approve');
  // Decline: the ask goes, the request is not released, and the next open after the ask says so once.
  const declined = await ctx.hub.emit({ type: 'deny', requestId, ask: true });
  assert.equal(declined.state, 'active');
  assert.equal(ctx.daemon.request(requestId).ask, undefined);
  const after = await ctx.api('POST', '/v1/observe', { requestId, afterAsk: true });
  assert.equal(after.body.result.code, 'ask_declined');
  // Review item 13: the kind and the text agree: continue at the granted level (observe), nothing to relay.
  assert.equal(after.body.result.status, 'needs_host');
  assert.equal(directNext(after.body.result, { requestId }).kind, 'observe');
  assert.match(directNext(after.body.result, { requestId }).text, /Continue at the granted level/);
  const plain = await ctx.api('POST', '/v1/observe', { requestId, afterAsk: true });
  assert.ok(plain.body.actions, 'reported once; the page reads as usual afterwards');
  // Asked again and approved: the origin joins the request and the lease (same lease id).
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  const pending = await ctx.api('POST', '/v1/observe', { requestId, afterAsk: true });
  assert.equal(pending.body.result.code, 'ask_pending', 'an open that waited in vain says the ask still waits');
  const reply = await approveAsk(ctx, requestId, { level: 'reversible' });
  assert.equal(reply.leaseId, leaseId);
  assert.ok(reply.origins.includes(PARTNER), JSON.stringify(reply));
  assert.deepEqual(ctx.daemon.request(requestId).origins, [ORIGIN, PARTNER]);
  assert.ok(ctx.hub.lease(leaseId).allowedOrigins.includes(PARTNER));
  // An approval without `ask` (an ordinary click) never adds what an ask names.
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: ['https://third.example.org'] });
  await ctx.hub.approve(requestId, { level: 'reversible' });
  assert.ok(!ctx.daemon.request(requestId).origins.includes('https://third.example.org'));
});

test('ask: a paused request (the tab left for an unlisted origin) resumes there on the same request id', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx, { level: 'reversible' });
  await ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'origin_changed', origin: PARTNER });
  const blocked = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(blocked.body.result.code, 'origin_changed');
  assert.equal(blocked.body.result.leftOrigin, PARTNER);
  assert.match(blocked.body.result.needs.message, /fai_browser_open with this requestId and it in origins/);
  assert.doesNotMatch(blocked.body.result.needs.message, /stopped|released/);
  // Without the ask the partner tab cannot be resumed (its origin is not requested).
  const early = await ctx.hub.approve(requestId, { level: 'reversible', origin: PARTNER });
  assert.equal(early.error.code, 'origin_not_requested');
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  const resumed = await approveAsk(ctx, requestId, { level: 'reversible', origin: PARTNER });
  assert.equal(resumed.requestId, requestId);
  assert.ok(resumed.leaseId);
  assert.equal(ctx.daemon.request(requestId).state, 'active');
  assert.equal(ctx.daemon.request(requestId).lease.tabId, 1, 'the same tab');
});

// Review item 2: a pending request may be on the user's screen; it never grows under the cursor.
test('ask on a pending request: a successor asks for it all; the shown one expires and its click approves nothing', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' });
  const { requestId } = created.body;
  const asked = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'full', origins: [PARTNER] });
  assert.equal(asked.body.asked, false);
  assert.notEqual(asked.body.requestId, requestId, 'a successor, not the request on screen');
  assert.equal(asked.body.replaced, requestId);
  assert.deepEqual([asked.body.request.mode, asked.body.request.origins], ['full', [ORIGIN, PARTNER]]);
  const shown = ctx.daemon.request(requestId);
  assert.deepEqual([shown.state, shown.stateReason, shown.mode, shown.origins], ['expired', 'replaced', 'read-only', [ORIGIN]]);
  // The click on the card the user was looking at: nothing is granted, least of all the wider ask.
  const late = await ctx.hub.approve(requestId, { level: 'full' });
  assert.equal(late.error.code, 'request_not_pending');
  assert.equal(ctx.daemon.request(asked.body.requestId).state, 'pending');
  const unchanged = await ctx.api('POST', `/v1/requests/${asked.body.requestId}/ask`, { origins: [PARTNER] });
  assert.equal(unchanged.body.requestId, asked.body.requestId, 'nothing new: the same request');
  await ctx.api('DELETE', `/v1/requests/${asked.body.requestId}`, {});
  const closed = await ctx.api('POST', `/v1/requests/${asked.body.requestId}/ask`, { mode: 'full' });
  assert.equal(closed.status, 409);
});

// Review item 1: the Approve applies exactly the ask its card showed.
test('ask: a click names the ask its card showed; a wider ask since then is refused (ask_changed), nothing granted', async t => {
  const ctx = await setup(t);
  const THIRD = 'https://third.example.org';
  const { requestId, leaseId } = await active(ctx, { level: 'reversible' });
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  const shown = ctx.daemon.request(requestId).ask;
  assert.deepEqual(shown.origins, [PARTNER]);
  // The agent asks for more while the card is on screen (or while the click waits for the site-access prompt).
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [THIRD] });
  const now = ctx.daemon.request(requestId).ask;
  assert.notEqual(now.id, shown.id, 'a changed ask is a new ask');
  assert.deepEqual(now.origins, [PARTNER, THIRD]);
  const stale = await approveAsk(ctx, requestId, { level: 'reversible', askId: shown.id });
  assert.equal(stale.error.code, 'ask_changed');
  assert.deepEqual(ctx.daemon.request(requestId).origins, [ORIGIN], 'nothing granted');
  assert.equal(ctx.hub.lease(leaseId).allowedOrigins.includes(THIRD), false);
  // No id at all (an older extension): refused the same way.
  assert.equal((await approveAsk(ctx, requestId, { level: 'reversible', askId: null })).error.code, 'ask_changed');
  // The card shows the new ask; its click applies exactly that.
  const fresh = await approveAsk(ctx, requestId, { level: 'reversible', askId: now.id });
  assert.equal(fresh.leaseId, leaseId);
  assert.deepEqual(ctx.daemon.request(requestId).origins, [ORIGIN, PARTNER, THIRD]);
});

// Review item 5: an origin the request lists that the browser gives no access to is an ask for its site access.
test('ask: a listed origin the extension cannot reach is asked for as site access, with a truthful refusal first', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN, PARTNER], mode: 'reversible', reason: 'Read' });
  const { requestId } = created.body;
  await ctx.hub.approve(requestId, { level: 'reversible' });
  await ctx.api('POST', '/v1/observe', { requestId });
  const refused = (await ctx.api('POST', '/v1/act', { requestId, url: `${PARTNER}/start` })).body.result;
  assert.equal(refused.code, 'cross_origin');
  assert.match(refused.needs.message, /approved for this task, but the browser has not given FAI Browser access to it/);
  const asked = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  assert.equal(asked.body.asked, true, 'not a no-op');
  assert.deepEqual([asked.body.request.ask.origins, asked.body.request.ask.access], [[], [PARTNER]]);
  // Reachable (the extension says it can follow it): nothing to ask.
  const bridge = ctx.hub.bridgeForTab(1);
  const real = bridge.observe.bind(bridge);
  bridge.observe = async (...args) => ({ ...(await real(...args)), reachable: [PARTNER] });
  await ctx.hub.emit({ type: 'deny', requestId, ask: true });
  await ctx.api('POST', '/v1/observe', { requestId });
  const none = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  assert.equal(none.body.asked, false);
});

test('wait {ask: true} returns once the user answered the ask', async t => {
  const ctx = await setup(t);
  const { requestId } = await active(ctx);
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'reversible' });
  const quick = await ctx.api('POST', '/v1/wait', { requestId, maxMs: 200, ask: true });
  assert.equal(quick.body.request.ask.level, 'reversible', 'still asking after the wait');
  const waiting = ctx.api('POST', '/v1/wait', { requestId, maxMs: 5000, ask: true });
  await delay(100);
  await approveAsk(ctx, requestId, { level: 'reversible' });
  const answered = await waiting;
  assert.equal(answered.body.state, 'active');
  assert.equal(answered.body.request.ask, undefined);
  assert.ok(answered.body.waitedMs < 4000);
});

test('#31: an approval the extension gives back (not_approved) is not a stop: the request waits again, same id', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' });
  const { requestId } = created.body;
  const { leaseId } = await ctx.hub.approve(requestId, { level: 'read-only' });
  await ctx.hub.emit({ type: 'status', leaseId, status: 'stopped', reason: 'not_approved' });
  assert.deepEqual([ctx.daemon.request(requestId).state, ctx.daemon.request(requestId).lease], ['pending', null]);
  const blocked = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(blocked.body.result.code, 'select_tab');
  // A re-approval of an active lease given back keeps the lease at its earlier grant.
  const again = await ctx.hub.approve(requestId, { level: 'read-only' });
  await ctx.api('POST', `/v1/requests/${requestId}/ask`, { mode: 'reversible' });
  await approveAsk(ctx, requestId, { level: 'reversible' });
  await ctx.hub.emit({ type: 'status', leaseId: again.leaseId, status: 'stopped', reason: 'not_approved' });
  const record = ctx.daemon.request(requestId);
  assert.deepEqual([record.state, record.grant.level, record.lease.leaseId], ['active', 'read-only', again.leaseId]);
  assert.equal(record.ask.level, 'reversible', 'the ask waits again');
  assert.equal(ctx.hub.lease(again.leaseId).state, 'active');
});

test('#31: "stopped" only for the user\'s Stop; another stop reason ends the request without blaming the user', async t => {
  const ctx = await setup(t);
  const first = await active(ctx);
  await ctx.hub.emit({ type: 'status', leaseId: first.leaseId, status: 'stopped', reason: 'stopped' });
  const stopped = await ctx.api('POST', '/v1/observe', { requestId: first.requestId });
  assert.equal(stopped.body.result.code, 'stopped');
  assert.match(stopped.body.result.needs.message, /^The user pressed Stop/);
  const second = await active(ctx);
  await ctx.hub.emit({ type: 'status', leaseId: second.leaseId, status: 'stopped', reason: 'session_ended' });
  const closed = await ctx.api('POST', '/v1/observe', { requestId: second.requestId });
  assert.equal(closed.body.result.code, 'request_closed');
  // Superseded by another approval in the same browser: said so, never "stopped".
  const third = await active(ctx);
  const fourth = await active(ctx);
  const superseded = await ctx.api('POST', '/v1/observe', { requestId: third.requestId });
  assert.equal(superseded.body.result.code, 'request_closed');
  assert.match(superseded.body.result.needs.message, /The user approved another task in this browser/);
  assert.ok(fourth.requestId);
});

test('#31: a lease code from the browser while the request is active is checked against the request', async t => {
  const ctx = await setup(t);
  const { requestId, leaseId } = await active(ctx);
  const bridge = ctx.hub.bridgeForTab(1);
  const real = bridge.observe.bind(bridge);
  // The browser answers one command with an older session's state ("stopped") while the request is active: nothing
  // ran, and the agent is told to observe again, never that the user stopped the tab.
  bridge.observe = async () => {
    bridge.observe = real;
    throw bridgeError('stopped', 'Browser session is stopped', false);
  };
  const started = Date.now();
  const first = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(first.body.result.code, 'tab_not_ready');
  assert.equal(first.body.result.status, 'needs_host');
  assert.ok(Date.now() - started >= 1000, 'it waited for a status report first');
  assert.equal(directNext(first.body.result, { requestId }).kind, 'observe');
  assert.ok((await ctx.api('POST', '/v1/observe', { requestId })).body.actions, 'the next observe reads the page');
  // A pause the extension reports right after its failed command: the request's own pause, with its reason.
  bridge.observe = async () => {
    bridge.observe = real;
    setTimeout(() => ctx.hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'child_tab', origin: PARTNER }), 100);
    throw bridgeError('paused', 'Browser session is paused', false);
  };
  const paused = await ctx.api('POST', '/v1/observe', { requestId });
  assert.equal(paused.body.result.code, 'child_tab');
  assert.equal(paused.body.result.childOrigin, PARTNER);
  assert.match(paused.body.result.needs.message, /^Paused: the page opened a tab or window/);
});

// --- issue #36: the order of hub events from a live Firefox session (daemon and extension 0.7.0) -------------------

async function agentSession(ctx) {
  const response = await ctx.api('POST', '/v1/sessions', { host: 'claude', repo: 'repo', pid: process.pid, wake: 'none' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const { sessionId, key } = response.body;
  return { sessionId, headers: { 'X-Fai-Session': `${sessionId}:${key}` } };
}

// The issue's timeline, replayed: a pending request whose Approve did not get through (tpk), an invite the agent
// joins (e_8), then either a successor request (0.7.0's MCP server) or an ask on the invited request.
async function issue36(ctx) {
  const session = await agentSession(ctx);
  const ask = (body, headers = session.headers) => ctx.api('POST', '/v1/requests', body, { headers });
  const stale = (await ask({ origins: [ORIGIN, PARTNER], mode: 'interactive', reason: 'Portal task' })).body.requestId;
  const invited = await ctx.hub.emit({ type: 'invite', tabId: 7, origin: ORIGIN, title: 'Portal', level: 'full',
    sessionId: session.sessionId, text: '', browserId: 'b1' });
  assert.ok(invited.leaseId, JSON.stringify(invited));
  const joined = await ctx.api('POST', `/v1/invites/${invited.invite.inviteId}/join`, {}, { headers: session.headers });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { session, stale, invited: invited.requestId, inviteLease: invited.leaseId, ask };
}

test('#36 item 3: a request whose approval superseded the browser\'s older session is never reported "stopped"', async t => {
  const ctx = await setup(t);
  const { session, invited, ask } = await issue36(ctx);
  // 0.7.0's MCP server minted a successor for the invited request's extra origins (still possible without requestId).
  const successor = (await ask({ origins: [ORIGIN, PARTNER], mode: 'full', reason: 'Portal with its frames' })).body.requestId;
  const bridge = ctx.hub.bridgeForTab(7);
  const real = bridge.observe.bind(bridge);
  // The worker still holds the invited tab's session, which the approval just superseded (stopped), when the
  // successor's first command arrives.
  bridge.observe = async () => {
    bridge.observe = real;
    throw bridgeError('stopped', 'Browser session is stopped', false);
  };
  const lease = await ctx.hub.emit({ type: 'lease', requestId: successor, tabId: 7, origin: ORIGIN, title: 'Portal',
    level: 'full', browserId: 'b1' });
  assert.ok(lease.leaseId, JSON.stringify(lease));
  assert.deepEqual([ctx.daemon.request(invited).state, ctx.daemon.request(invited).stateReason], ['released', 'superseded']);
  const first = await ctx.api('POST', '/v1/observe', { requestId: successor }, { headers: session.headers });
  assert.equal(first.body.result.code, 'tab_not_ready', JSON.stringify(first.body.result));
  assert.doesNotMatch(JSON.stringify(first.body.result), /stopped|released/i);
  assert.ok((await ctx.api('POST', '/v1/observe', { requestId: successor }, { headers: session.headers })).body.actions);
  // The superseded invited request says it was replaced, not stopped.
  const old = await ctx.api('POST', '/v1/observe', { requestId: invited }, { headers: session.headers });
  assert.equal(old.body.result.code, 'request_closed');
  assert.match(old.body.result.needs.message, /replaced this one/);
});

test('#36 items 4 and 5: the invite join replaces the older pending request; an ask on the invited request keeps its id', async t => {
  const ctx = await setup(t);
  const { session, stale, invited, inviteLease } = await issue36(ctx);
  // Item 4: joining makes the invited tab this agent's; its older pending request (whose Approve did not get through)
  // expires at once, so its late click (08:22:33) approves nothing.
  assert.deepEqual([ctx.daemon.request(stale).state, ctx.daemon.request(stale).stateReason], ['expired', 'replaced']);
  const early = await ctx.hub.emit({ type: 'lease', requestId: stale, tabId: 9, origin: ORIGIN, title: 'Blank',
    level: 'interactive', browserId: 'b1' });
  assert.equal(early.error.code, 'request_not_pending');
  assert.equal(ctx.daemon.request(invited).state, 'active', 'the invited request stays');
  const waited = await ctx.api('POST', '/v1/observe', { requestId: stale }, { headers: session.headers });
  assert.equal(waited.body.result.replacedBy, invited);
  assert.match(waited.body.result.needs.message, new RegExp(`Your request ${invited} replaced this one`));
  assert.equal(directNext(waited.body.result, { requestId: stale }).kind, 'observe');
  // 08:22:26: the frame origins as domain roots. A root cannot join an approved request (the lease keeps exact
  // origins; the user would approve something that never becomes usable): refused with a clear message.
  const roots = await ctx.api('POST', `/v1/requests/${invited}/ask`, { origins: ['https://*.example.org'] },
    { headers: session.headers });
  assert.equal(roots.status, 422);
  assert.equal(roots.body.error?.code ?? roots.body.code, 'ask_root');
  // Item 5: the exact frame origin, asked on the invited request: the same id, approved in place.
  const asked = await ctx.api('POST', `/v1/requests/${invited}/ask`, { origins: [PARTNER] }, { headers: session.headers });
  assert.equal(asked.body.asked, true, JSON.stringify(asked.body));
  const reply = await approveAsk(ctx, invited, { level: 'full', tabId: 7, browserId: 'b1' });
  assert.equal(reply.leaseId, inviteLease, 'the invited lease, approved again in place');
  assert.deepEqual(ctx.daemon.request(invited).origins, [ORIGIN, PARTNER]);
});

// Review item 9: an approval given back restores what it replaced, and a run on it does not blame an extension restart.
test('#36: an approval the extension gives back restores the requests it replaced', async t => {
  const ctx = await setup(t);
  const session = await agentSession(ctx);
  const make = () => ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' }, { headers: session.headers })
    .then(response => response.body.requestId);
  const older = await make();
  const newer = await make();
  const { leaseId } = await ctx.hub.approve(newer, { level: 'read-only' });
  assert.equal(ctx.daemon.request(older).state, 'expired');
  await ctx.hub.emit({ type: 'status', leaseId, status: 'stopped', reason: 'not_approved' });
  assert.equal(ctx.daemon.request(newer).state, 'pending');
  assert.equal(ctx.daemon.request(older).state, 'pending', 'the replaced request waits again');
  // A second give-back of the same lease changes nothing.
  await ctx.hub.emit({ type: 'status', leaseId, status: 'stopped', reason: 'not_approved' });
  assert.equal(ctx.daemon.request(newer).state, 'pending');
});

// Review item 7: one lease per browser, so only requests waiting in the same browser are replaced.
test('#36: an approval replaces the agent\'s older pending requests in the same browser only', async t => {
  const ctx = await setup(t);
  const session = await agentSession(ctx);
  const make = () => ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' }, { headers: session.headers })
    .then(response => response.body.requestId);
  // Two connected browsers; the request waits in the one used last (b2), not pinned there by anyone.
  const browsers = [{ id: 'b1', product: 'chrome', name: 'Chrome', usedAt: 1 }, { id: 'b2', product: 'firefox', name: 'Firefox', usedAt: 2 }];
  ctx.hub.candidates = () => browsers;
  const elsewhere = await make();
  assert.deepEqual([ctx.daemon.request(elsewhere).browser?.id, ctx.daemon.request(elsewhere).browserPinned ?? false], ['b2', false]);
  browsers[0].usedAt = 3;
  const here = await make();
  const approved = await make();
  const lease = await ctx.hub.emit({ type: 'lease', requestId: approved, tabId: 1, origin: ORIGIN, title: 'Home', level: 'read-only', browserId: 'b1' });
  assert.ok(lease);
  assert.equal(ctx.daemon.request(here).state, 'expired');
  assert.equal(ctx.daemon.request(elsewhere).state, 'pending', 'waiting in another browser');
});

// Review item 8: a request another agent's (or the user's) approval ended does not name that request.
test('#36: superseded by another session\'s request: "the user approved another task", no id, stop', async t => {
  const ctx = await setup(t);
  const mine = await agentSession(ctx);
  const theirs = await agentSession(ctx);
  const make = headers => ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' }, { headers })
    .then(response => response.body.requestId);
  const first = await make(mine.headers);
  await ctx.hub.approve(first, { level: 'read-only' });
  const other = await make(theirs.headers);
  await ctx.hub.approve(other, { level: 'read-only', tabId: 2 });
  const closed = (await ctx.api('POST', '/v1/observe', { requestId: first }, { headers: mine.headers })).body.result;
  assert.equal(closed.code, 'request_closed');
  assert.equal(closed.replacedBy, undefined);
  assert.equal(closed.needs.message, 'The user approved another task in this browser, which ended this one.');
  assert.ok(!closed.needs.message.includes(other));
  assert.equal(directNext(closed, { requestId: first }).kind, 'stop');
});

// Review item 10: tab_not_ready does not repeat forever.
test('#31: a browser that keeps answering it does not hold the lease pauses the request (session_inactive) after three', async t => {
  const ctx = await setup(t);
  const { requestId } = await active(ctx);
  const bridge = ctx.hub.bridgeForTab(1);
  bridge.observe = async () => { throw bridgeError('session_inactive', 'This browser does not hold that tab lease', false); };
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await ctx.api('POST', '/v1/observe', { requestId })).body.result.code);
  assert.deepEqual(codes, ['tab_not_ready', 'tab_not_ready', 'session_inactive']);
  const view = ctx.daemon.request(requestId);
  assert.deepEqual([view.state, view.stateReason], ['paused', 'session_inactive']);
  const blocked = (await ctx.api('POST', '/v1/observe', { requestId })).body.result;
  assert.match(blocked.needs.message, /^Paused: the browser extension no longer holds this tab/);
});

test('#36: a request the agent made after the approved one is left alone; another session\'s is too', async t => {
  const ctx = await setup(t);
  const mine = await agentSession(ctx);
  const theirs = await agentSession(ctx);
  const make = headers => ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' }, { headers })
    .then(response => response.body.requestId);
  const first = await make(mine.headers);
  const other = await make(theirs.headers);
  const second = await make(mine.headers);
  const older = await make(mine.headers);
  await ctx.hub.approve(second, { level: 'read-only' });
  assert.equal(ctx.daemon.request(first).state, 'expired', 'an older one of the same session');
  assert.equal(ctx.daemon.request(older).state, 'pending', 'asked for after the approved one');
  assert.equal(ctx.daemon.request(other).state, 'pending', 'another agent session');
});

test('#36 item 2: a request the user denied is reported as denied, with a stop that says not to ask again', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' });
  const { requestId } = created.body;
  await ctx.hub.emit({ type: 'deny', requestId });
  const blocked = await ctx.api('POST', '/v1/observe', { requestId });
  assert.deepEqual([blocked.body.result.status, blocked.body.result.code], ['stopped', 'denied']);
  assert.match(blocked.body.result.needs.message, /The user denied this tab request/);
  const next = directNext(blocked.body.result, { requestId });
  assert.equal(next.kind, 'stop');
  assert.match(next.text, /denied.*only if the user asks/);
});

// Re-review item 1: tab_not_ready counts only answers in a row; a command that reaches the page resets it.
test('#31: transient tab_not_ready answers separated by a page read never pause the request', async t => {
  const ctx = await setup(t);
  const { requestId } = await active(ctx);
  const bridge = ctx.hub.bridgeForTab(1);
  const real = bridge.observe.bind(bridge);
  let failures = 0;
  bridge.observe = async (...args) => {
    if (failures > 0) {
      failures -= 1;
      throw bridgeError('session_inactive', 'This browser does not hold that tab lease', false);
    }
    return real(...args);
  };
  const codes = [];
  const observe = async () => (await ctx.api('POST', '/v1/observe', { requestId })).body;
  failures = 2;
  codes.push((await observe()).result.code, (await observe()).result.code);
  assert.ok((await observe()).actions, 'the page reads');
  failures = 2;
  codes.push((await observe()).result.code, (await observe()).result.code);
  assert.deepEqual(codes, ['tab_not_ready', 'tab_not_ready', 'tab_not_ready', 'tab_not_ready']);
  assert.equal(ctx.daemon.request(requestId).state, 'active');
  // An act that reaches the page resets the count too.
  assert.ok((await observe()).actions);
  failures = 2;
  codes.push((await observe()).result.code, (await observe()).result.code);
  const acted = await ctx.api('POST', '/v1/act', { requestId, actionId: (await observe()).actions.find(a => a.type === 'scroll')?.id ?? 'a0' });
  assert.ok(acted.body.result, JSON.stringify(acted.body).slice(0, 200));
  failures = 2;
  codes.push((await observe()).result.code, (await observe()).result.code);
  assert.equal(ctx.daemon.request(requestId).state, 'active');
});

// Re-review item 2: a request a successor replaced (an ask while it waited) never claims the user approved something.
test('ask on a pending request without an agent session: the old one says it was replaced by a newer request', async t => {
  const ctx = await setup(t);
  const created = await ctx.api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Read' });
  const { requestId } = created.body;
  const asked = await ctx.api('POST', `/v1/requests/${requestId}/ask`, { origins: [PARTNER] });
  assert.equal(asked.body.request.replaces, requestId, 'the successor names the request it replaced');
  const old = (await ctx.api('POST', '/v1/observe', { requestId })).body.result;
  assert.equal(old.code, 'request_closed');
  assert.equal(old.needs.message, 'This request was replaced by a newer request.');
  assert.doesNotMatch(old.needs.message, /approved/);
});

// After PR #35 (links to other sites): a link to an exact origin the lease lists AND the extension reports reachable is
// an ordinary click, by action id and by point, at read-only; one the lease does not list, or lists but cannot reach,
// stays an other_site line whose act says to ask on the same request.
test('links: a reachable lease origin is a click (id and point, read-only); unlisted or unreachable ones are other-site lines', () => {
  const B = 'https://partner.example.org';
  const C = 'https://third.example.org';
  const D = 'https://far.example.org';
  const control = (id, label, href) => ({ id, role: 'link', label, href, enabled: true, visible: true, risk: 'navigation' });
  const observation = { revision: 'r1', url: `${ORIGIN}/`, title: 'Home', text: 'Home', reachable: [B],
    controls: [control('1', 'Partner page', `${B}/p`), control('2', 'Third page', `${C}/t`), control('3', 'Far page', `${D}/f`)] };
  const config = { mode: 'read-only', allowedOrigins: [ORIGIN, B, D] };
  const actions = offeredActions(observation, config).actions;
  const byLabel = label => actions.find(action => action.label === label);
  assert.equal(byLabel('Partner page').type, 'click');
  assert.equal(byLabel('Third page').type, 'other_site', 'not in the lease');
  assert.equal(byLabel('Far page').type, 'other_site', 'in the lease but the extension cannot reach it');
  // The extension's list never widens the lease: reachable but unlisted stays an other-site line.
  assert.equal(offeredActions({ ...observation, reachable: [B, C] }, config).actions.find(a => a.label === 'Third page').type, 'other_site');
  const offer = { revision: 'r1', observation, actions, config };
  const point = pointAction(offer, { id: null, control: { ...observation.controls[0], id: 'point' } }, { ...config, level: 'read-only', point: { x: 1, y: 1 } });
  assert.equal(point.action?.type, 'click', 'a point on the reachable link runs like its action id');
  const far = pointAction(offer, { id: null, control: { ...observation.controls[2], id: 'point' } }, { ...config, level: 'read-only', point: { x: 1, y: 1 } });
  assert.equal(far.refusal?.kind, 'cross_origin');
  // The fixed text names the same-request remedy and holds no page data.
  assert.match(OTHER_SITE_TEXT, /fai_browser_open with this requestId, that origin in origins/);
  assert.match(OTHER_SITE_TEXT, /the same request and tab ask for it/);
  for (const origin of [B, C, D]) assert.ok(!OTHER_SITE_TEXT.includes(origin));
});

// --- through the spawned MCP server -----------------------------------------------------------------------------

async function mcpSetup(t) {
  const ctx = await setup(t);
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home, FAI_DAEMON_PORT: String(ctx.daemon.port),
    FAI_MCP_APPROVAL_WAIT_MS: '4000', FAI_WAKE: 'off' });
  t.after(() => mcp.close());
  await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: 'test' } });
  mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { ...ctx, mcp };
}
const text = result => result.content.map(block => block.text ?? '').join('\n');
async function until(predicate, what, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

test('MCP #30: fai_browser_open with the requestId and a higher mode asks on the same request (no new request)', async t => {
  const ctx = await mcpSetup(t);
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  const { leaseId } = await ctx.hub.approve(pending.requestId, { level: 'read-only', tabMode: 'multiple' });
  assert.ok(!(await opening).isError);
  const raising = ctx.mcp.callTool('fai_browser_open', { requestId: pending.requestId, mode: 'reversible', task: 'read' });
  const asked = await until(() => ctx.hub.published.at(-1)?.find(item => item.requestId === pending.requestId && item.ask),
    'the ask');
  assert.equal(asked.ask.level, 'reversible');
  assert.equal(ctx.hub.published.at(-1).length, 1, 'the same request, no second one');
  await approveAsk(ctx, pending.requestId, { level: 'reversible', tabMode: 'multiple' });
  const raised = await raising;
  assert.ok(!raised.isError, text(raised));
  const body = text(raised);
  assert.match(body, new RegExp(`requestId: ${pending.requestId}`));
  assert.match(body, /granted: reversible.*task tabs: multiple/);
  assert.equal(ctx.daemon.request(pending.requestId).lease.leaseId, leaseId);
});

test('MCP #30: fai_browser_open with the requestId and an extra origin adds it after the user\'s Approve', async t => {
  const ctx = await mcpSetup(t);
  const opening = ctx.mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'read' });
  const pending = await until(() => ctx.hub.published.at(-1)?.find(item => item.state === 'pending'), 'the request');
  await ctx.hub.approve(pending.requestId, { level: 'read-only' });
  assert.ok(!(await opening).isError);
  // Not answered within the call: the agent is told the ask still waits, on the same request.
  const waiting = await ctx.mcp.callTool('fai_browser_open', { requestId: pending.requestId, origins: [PARTNER], task: 'read',
    allowedUrls: [`${PARTNER}/start`] });
  assert.match(text(waiting), /ask_pending/);
  assert.match(text(waiting), /next \(relay\)/);
  assert.deepEqual(ctx.daemon.request(pending.requestId).ask.origins, [PARTNER]);
  const adding = ctx.mcp.callTool('fai_browser_open', { requestId: pending.requestId, origins: [PARTNER], task: 'read',
    allowedUrls: [`${PARTNER}/start`] });
  await delay(200);
  await approveAsk(ctx, pending.requestId, { level: 'read-only' });
  const added = await adding;
  assert.ok(!added.isError, text(added));
  assert.match(text(added), /status: observed/);
  assert.deepEqual(ctx.daemon.request(pending.requestId).origins, [ORIGIN, PARTNER]);
  assert.equal(ctx.hub.published.at(-1).length, 1, 'still one request');
});
